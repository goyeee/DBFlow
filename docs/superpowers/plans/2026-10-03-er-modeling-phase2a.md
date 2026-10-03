# ER 二期 A：图上编辑建模 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ER 图上新建表/编辑列/索引/模型外键，与真实库 diff 生成 DDL（含 FK ADD/DROP）应用回库，形成正向建模闭环。

**Architecture:** 编辑过的表在 `.er.json` v2 文档按表全量存 schema（字段与后端 `TableDef` 对齐，存在即「模型为准」）；应用时前端组装 payload → 后端薄命令 `er_diff` → `compare/er_model.rs` 纯函数（复用 `diff_snapshots` + 新增 FK 对比 + DDL 依赖排序）→ `DiffItem[]` → 复用 `apply_sync` 执行与部署 UX。前端显式编辑模式开关，表设计器 Modal 编辑结构，画布拖线建模型外键。

**Tech Stack:** Tauri 2 + Rust（sqlx）、React 19 + TypeScript + Ant Design 6 + Zustand、vitest / cargo test。

**Spec:** `docs/superpowers/specs/2026-10-03-er-modeling-phase2a-design.md`（执行者先读 spec 再读本计划）

## Global Constraints

- 提交信息用中文，格式 `feat:xxx` / `fix:xxx` / `test:xxx` / `docs:xxx`；**不含任何 AI 工具署名**（无 Co-Authored-By 等字样）
- AGENTS.md：不要私自 commit——本计划每个任务末尾的提交步骤即「被要求提交」；若会话权限层拦截提交，完成任务验证后停下请示用户
- 每任务提交前对应测试必须全绿；全部完成后 `pnpm test` + `cd src-tauri && cargo test` 全绿（Task 18 统一验证）
- 不引入新依赖；前端遵循现有 React + antd 写法（小号控件、`useErTab`/`askChoice` 模式、`vi.mock('../api/commands')` 测试模式），注释密度与现有代码一致
- 工作目录：`/Users/guoyue/orca/workspaces/DBFlow/图上建模`（feature/er-modeling worktree，所有命令在此目录执行，不要 cd 去主仓库）
- 表名比较统一忽略大小写（小写键），与现有 ER 代码约定一致；标识符转义一律走 `sqlgen::quote_ident`
- Rust 命令注册在 `src-tauri/src/lib.rs` 的 `invoke_handler`（现有 er 命令在 59-66 行附近）

## Review Focus

spec 未显式覆盖、最可能咬人的五类输入（每条已把测试锚到归属任务）：

1. **payload 表名与库表仅大小写不同** → 期望按同表处理产出列差异，而不是 DROP+CREATE 两条（Task 3 测 `build_model_snapshot` 表名对齐）
2. **删除旧表 + 新建结构相同的相似名表** → `diff_snapshots` 的 rename 启发式会误报 RENAME TABLE，ER 语义应为 DROP+CREATE（Task 5 测 rename 拆解）
3. **环形外键的表一起删除** → 直接 DROP 必然报错，期望先 DROP FK 断环再删表（Task 5 排序测试 + Task 7 e2e 真库验证）
4. **同表多个列变更被 FK 项插断** → `buildDeployStatements`（`src/stores/compare.ts:245`）只合并「连续同表」列子句，排序必须保证同表列项相邻（Task 5 排序测试断言相邻性）
5. **部分应用/执行失败后的状态** → 仍有差异的表 schema 必须保留（角标仍在），零差异表才清除；mfk 边走线在应用后迁移到 fk 边 id，但未应用的 FK 不迁（Task 14 测 `refreshAfterApply`）
6. **未指定字段的收敛** → 模型里 engine/collation/列级 characterSet/collation 为 null 表示「未指定」而非「无」：与库比对时按库回填，否则应用后复跑永远有假差异（角标消不掉）、copy-on-edit 不改就存会出假「改」角标（Task 3 测 `build_model_snapshot` 回填、Task 9 测 `snapshotTableToSchema` 保留 + `schemasEqual`）

---

### Task 1: sqlgen 外键 DROP/ADD 子句

**Files:**
- Modify: `src-tauri/src/compare/sqlgen.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces（后续任务用）：
  - `pub fn drop_foreign_key_ddl(db: &str, table: &str, fk_name: &str) -> String`
  - `pub fn add_foreign_key_clause(fk: &ForeignKeyDef) -> String`（不含 `ALTER TABLE` 前缀的 `ADD CONSTRAINT ...` 子句）

- [ ] **Step 1: 写失败测试**

在 `sqlgen.rs` 的 `mod tests` 中、现有 `foreign_key_ddl_variants` 测试后追加：

```rust
    #[test]
    fn drop_and_add_foreign_key_clauses() {
        use crate::datasource::ForeignKeyDef;
        let fk = ForeignKeyDef {
            name: "fk_order".into(),
            table: "order_items".into(),
            columns: vec!["order_id".into()],
            ref_table: "orders".into(),
            ref_columns: vec!["id".into()],
            on_delete: Some("CASCADE".into()),
            on_update: None,
        };
        assert_eq!(
            drop_foreign_key_ddl("db", &fk.table, &fk.name),
            "ALTER TABLE `db`.`order_items` DROP FOREIGN KEY `fk_order`"
        );
        assert_eq!(
            add_foreign_key_clause(&fk),
            "ADD CONSTRAINT `fk_order` FOREIGN KEY (`order_id`) REFERENCES `db`.`orders` (`id`) ON DELETE CASCADE"
        );
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test drop_and_add_foreign_key_clauses`
Expected: 编译失败（函数不存在）

- [ ] **Step 3: 实现**

在 `sqlgen.rs` 的 `foreign_key_ddl` 附近新增，并把 `foreign_key_ddl` 改为复用子句（行为不变，现有测试锁定）：

```rust
/// ADD CONSTRAINT 子句（不含 ALTER TABLE 前缀），供整句与重建语句复用
pub fn add_foreign_key_clause(fk: &ForeignKeyDef) -> String {
    let cols = fk.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let ref_cols = fk.ref_columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let mut s = format!(
        "ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote_ident(&fk.name),
        cols,
        qualified(&fk.db, &fk.ref_table),
        ref_cols
    );
    if let Some(d) = &fk.on_delete {
        s.push_str(&format!(" ON DELETE {d}"));
    }
    if let Some(u) = &fk.on_update {
        s.push_str(&format!(" ON UPDATE {u}"));
    }
    s
}
```

注意：`add_foreign_key_clause` 需要库名拼 `REFERENCES db.tbl`，而 `ForeignKeyDef` 没有库名字段。改为带 `db` 参数：`pub fn add_foreign_key_clause(db: &str, fk: &ForeignKeyDef) -> String`，测试相应第一参数传 `"db"`。`foreign_key_ddl` 重写为：

```rust
pub fn foreign_key_ddl(db: &str, fk: &ForeignKeyDef) -> String {
    format!(
        "ALTER TABLE {} {}",
        qualified(db, &fk.table),
        add_foreign_key_clause(db, fk)
    )
}
```

```rust
/// DROP FOREIGN KEY 语句
pub fn drop_foreign_key_ddl(db: &str, table: &str, fk_name: &str) -> String {
    format!(
        "ALTER TABLE {} DROP FOREIGN KEY {}",
        qualified(db, table),
        quote_ident(fk_name)
    )
}
```

- [ ] **Step 4: 全量测试通过**

Run: `cd src-tauri && cargo test sqlgen`
Expected: PASS（含既有 `foreign_key_ddl_variants` 不变）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/compare/sqlgen.rs
git commit -m "feat:sqlgen 外键 DROP 语句与 ADD 子句拆分"
```

---

### Task 2: er_model payload 类型与校验

**Files:**
- Create: `src-tauri/src/compare/er_model.rs`
- Modify: `src-tauri/src/compare/mod.rs`（加 `pub mod er_model;`，在 `pub mod sqlgen;` 后一行）
- Modify: `src-tauri/src/datasource/mod.rs`（`TableDef`/`ColumnDef`/`IndexDef` 加 `Deserialize`；`ForeignKeyDef` 加 `Deserialize`；`ColumnDef.ordinal` 加 `#[serde(default)]`）
- Test: `src-tauri/src/compare/er_model.rs` 内联 `mod tests`

**Interfaces:**
- Produces（后续任务用）：
  - `pub struct ErModelTableInput { pub name: String, pub schema: Option<ErTableSchemaInput> }`（`#[serde(rename_all = "camelCase")]`）
  - `pub struct ErTableSchemaInput { #[serde(flatten)] pub table: TableDef, #[serde(default)] pub foreign_keys: Vec<ForeignKeyDef> }`
  - `pub fn validate_model_payload(tables: &[ErModelTableInput]) -> AppResult<()>`

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/compare/er_model.rs`，先只含测试与空实现骨架：

```rust
//! ER 模型（图上编辑建模）与库实时结构的对比：模型 payload → DiffItem。
//! 纯函数模块：结构差异复用 diff_snapshots，外键差异独立比较，
//! 最终按 DDL 依赖排序（DROP FK → DROP TABLE → 建表/改表 → ADD FK）。

use std::collections::HashSet;

use serde::Deserialize;

use crate::datasource::{ForeignKeyDef, TableDef};
use crate::error::{AppError, AppResult};

/// 前端传来的模型表：schema=None 表示 tombstone（待删除）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErModelTableInput {
    pub name: String,
    #[serde(default)]
    pub schema: Option<ErTableSchemaInput>,
}

/// 模型表结构：TableDef 字段 + 外键（FK 属于表定义，随表走）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTableSchemaInput {
    #[serde(flatten)]
    pub table: TableDef,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
}

pub fn validate_model_payload(_tables: &[ErModelTableInput]) -> AppResult<()> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, columns: &[(&str, &str)], fks: &[(&str, &[&str], &[&str])]) -> ErModelTableInput {
        let table = TableDef {
            name: name.into(),
            columns: columns
                .iter()
                .map(|(n, dt)| crate::datasource::ColumnDef {
                    name: n.to_string(),
                    data_type: dt.to_string(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        ErModelTableInput {
            name: name.into(),
            schema: Some(ErTableSchemaInput {
                table,
                foreign_keys: fks
                    .iter()
                    .map(|(n, cols, refs)| ForeignKeyDef {
                        name: n.to_string(),
                        table: name.into(),
                        columns: cols.iter().map(|s| s.to_string()).collect(),
                        ref_table: "other".into(),
                        ref_columns: refs.iter().map(|s| s.to_string()).collect(),
                        on_delete: None,
                        on_update: None,
                    })
                    .collect(),
            }),
        }
    }

    #[test]
    fn payload_deserializes_from_frontend_camel_case_json() {
        // 前端 schema JSON（camelCase、无 ordinal）→ ErModelTableInput
        let json = r#"[{
            "name": "orders",
            "schema": {
                "name": "orders", "engine": "InnoDB", "collation": null, "comment": "订单",
                "columns": [
                    {"name":"id","dataType":"bigint unsigned","nullable":false,"default":null,
                     "extra":"auto_increment","comment":null,"characterSet":null,"collation":null}
                ],
                "indexes": [{"name":"PRIMARY","columns":["id"],"subParts":[null],
                             "directions":[null],"unique":true,"isPrimary":true,"indexType":"BTREE"}],
                "foreignKeys": [{"name":"fk_user","table":"orders","columns":["uid"],
                                  "refTable":"users","refColumns":["id"],
                                  "onDelete":"CASCADE","onUpdate":null}]
            }
        }]"#;
        let v: Vec<ErModelTableInput> = serde_json::from_str(json).unwrap();
        assert_eq!(v.len(), 1);
        let s = v[0].schema.as_ref().unwrap();
        assert_eq!(s.table.columns[0].data_type, "bigint unsigned");
        assert_eq!(s.table.columns[0].ordinal, 0); // 缺省
        assert_eq!(s.foreign_keys[0].ref_table, "users");
    }

    #[test]
    fn tombstone_has_no_schema() {
        let v: Vec<ErModelTableInput> = serde_json::from_str(r#"[{"name":"old_t"}]"#).unwrap();
        assert!(v[0].schema.is_none());
    }

    #[test]
    fn validation_rejects_bad_payloads() {
        // 空表名
        assert!(validate_model_payload(&[input("", &[("id", "int")], &[])]).is_err());
        // 重复表名（忽略大小写）
        assert!(validate_model_payload(&[
            input("t", &[("id", "int")], &[]),
            input("T", &[("id", "int")], &[]),
        ])
        .is_err());
        // 0 列
        assert!(validate_model_payload(&[input("t", &[], &[])]).is_err());
        // 重复列名（忽略大小写）
        assert!(validate_model_payload(&[input("t", &[("id", "int"), ("ID", "int")], &[])]).is_err());
        // 空列名
        assert!(validate_model_payload(&[input("t", &[(" ", "int")], &[])]).is_err());
        // FK 列数不匹配
        assert!(validate_model_payload(&[input("t", &[("a", "int"), ("b", "int")], &[("fk1", &["a"], &["x", "y"])])]).is_err());
        // FK 空列
        assert!(validate_model_payload(&[input("t", &[("a", "int")], &[("fk1", &[], &[])])]).is_err());
        // 重复 FK 名（忽略大小写）
        assert!(validate_model_payload(&[input("t", &[("a", "int"), ("b", "int")], &[
            ("fk1", &["a"], &["x"]),
            ("FK1", &["b"], &["x"]),
        ])])
        .is_err());
    }

    #[test]
    fn validation_accepts_normal_payload() {
        assert!(validate_model_payload(&[
            input("t", &[("id", "bigint"), ("uid", "bigint")], &[("fk_uid", &["uid"], &["id"])]),
        ])
        .is_ok());
        // tombstone 不校验结构
        let mut t = input("gone", &[], &[]);
        t.schema = None;
        assert!(validate_model_payload(&[t]).is_ok());
    }
}
```

- [ ] **Step 2: 运行确认失败**

先给 `datasource/mod.rs` 补 Deserialize（编译前提）：四个结构体的 `#[derive(...)]` 里加 `Deserialize`（`use serde::{Deserialize, Serialize};`），`ColumnDef` 的 `ordinal: u32` 字段上加 `#[serde(default)]`。`compare/mod.rs` 顶部 `pub mod sqlgen;` 后加 `pub mod er_model;`。

Run: `cd src-tauri && cargo test er_model`
Expected: `payload_deserializes...`/`validation...` 系列因 `unimplemented!` 失败

- [ ] **Step 3: 实现 validate_model_payload**

替换 `unimplemented!()`：

```rust
/// payload 校验：空/重复表名、0 列表、空列名/重复列名、重复 FK 名、FK 列数匹配。
/// 全部忽略大小写（与 ER 前端表名比较约定一致）。
pub fn validate_model_payload(tables: &[ErModelTableInput]) -> AppResult<()> {
    let mut seen_tables = HashSet::new();
    for t in tables {
        let name = t.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("表名不能为空".into()));
        }
        if !seen_tables.insert(name.to_lowercase()) {
            return Err(AppError::Validation(format!("模型中存在重复表名「{name}」")));
        }
        let Some(s) = &t.schema else { continue };
        if s.table.columns.is_empty() {
            return Err(AppError::Validation(format!("表「{name}」至少需要一列")));
        }
        let mut col_names = HashSet::new();
        for c in &s.table.columns {
            if c.name.trim().is_empty() {
                return Err(AppError::Validation(format!("表「{name}」存在空列名")));
            }
            if !col_names.insert(c.name.trim().to_lowercase()) {
                return Err(AppError::Validation(format!("表「{name}」存在重复列名「{}」", c.name)));
            }
        }
        let mut fk_names = HashSet::new();
        for fk in &s.foreign_keys {
            if fk.name.trim().is_empty() {
                return Err(AppError::Validation(format!("表「{name}」存在空外键名")));
            }
            if !fk_names.insert(fk.name.trim().to_lowercase()) {
                return Err(AppError::Validation(format!("表「{name}」存在重复外键名「{}」", fk.name)));
            }
            if fk.columns.is_empty() || fk.columns.len() != fk.ref_columns.len() {
                return Err(AppError::Validation(format!(
                    "外键「{}」的列数与引用列数不匹配",
                    fk.name
                )));
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: 运行通过**

Run: `cd src-tauri && cargo test er_model`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/compare/er_model.rs src-tauri/src/compare/mod.rs src-tauri/src/datasource/mod.rs
git commit -m "feat:ER 模型 payload 类型定义与校验"
```

---

### Task 3: 模型快照构造与表名对齐

**Files:**
- Modify: `src-tauri/src/compare/er_model.rs`
- Test: 同文件 `mod tests`

**Interfaces:**
- Produces:
  - `pub struct ModelSnapshot { pub snapshot: SchemaSnapshot, pub involved: HashSet<String>, pub tombstones: HashSet<String>, pub model_fks: Vec<ForeignKeyDef> }`（involved/tombstones 内是小写表名）
  - `pub fn build_model_snapshot(db: &str, model: &[ErModelTableInput], live: &SchemaSnapshot) -> ModelSnapshot`

- [ ] **Step 1: 写失败测试**

`mod tests` 追加（沿用 Task 2 的 `input` 构造器）：

```rust
    use crate::datasource::{ColumnDef, SchemaSnapshot, TableDef};

    fn live(db: &str, names: &[&str]) -> SchemaSnapshot {
        SchemaSnapshot {
            database: db.into(),
            tables: names
                .iter()
                .map(|n| TableDef {
                    name: n.to_string(),
                    columns: vec![ColumnDef { name: "id".into(), data_type: "int".into(), ..Default::default() }],
                    ..Default::default()
                })
                .collect(),
            views: Vec::new(),
            server_version: Some("8.0.36".into()),
        }
    }

    #[test]
    fn model_snapshot_aligns_table_case_to_live() {
        // payload 名小写、库原始名首字母大写 → 对齐为库大小写，且不拆成 DROP+CREATE
        let l = live("db", &["Users"]);
        let m = build_model_snapshot(
            "db",
            &[input("users", &[("id", "int"), ("name", "varchar(20)")], &[])],
            &l,
        );
        assert_eq!(m.snapshot.tables[0].name, "Users"); // 对齐库大小写
        assert!(m.involved.contains("users"));
        assert!(m.tombstones.is_empty());
        assert_eq!(m.snapshot.server_version.as_deref(), Some("8.0.36"));
        // 复用 diff_snapshots 验证不产生表级 DROP+CREATE（列差异一条）
        let items = crate::compare::diff_snapshots(
            &m.snapshot,
            &SchemaSnapshot {
                database: "db".into(),
                tables: l.tables.clone(),
                views: vec![],
                server_version: l.server_version.clone(),
            },
            &crate::compare::CompareOptions::default(),
        );
        let ops: Vec<_> = items.iter().filter(|i| i.action != crate::compare::DiffAction::Noop).collect();
        assert!(ops.iter().all(|i| i.kind == crate::compare::DiffKind::Column), "{ops:?}");
    }

    #[test]
    fn model_snapshot_separates_tombstones_and_keeps_new_names() {
        let l = live("db", &["old_t", "keep"]);
        let mut tomb = input("old_t", &[], &[]);
        tomb.schema = None;
        let new_tbl = input("brand_new", &[("id", "int")], &[]);
        let m = build_model_snapshot("db", &[tomb, new_tbl.clone()], &l);
        // tombstone 不进 source，进 involved+tombstones
        assert!(m.snapshot.tables.iter().all(|t| t.name != "old_t"));
        assert!(m.tombstones.contains("old_t"));
        // 新表不在库里 → 保留用户输入名
        assert_eq!(m.snapshot.tables[0].name, "brand_new");
        assert!(m.involved.contains("brand_new") && m.involved.contains("old_t"));
    }

    #[test]
    fn model_snapshot_collects_fks_with_case_alignment() {
        let l = live("db", &["orders", "Users"]);
        let m = build_model_snapshot(
            "db",
            &[input("orders", &[("id", "int"), ("uid", "bigint")], &[("fk_uid", &["uid"], &["id"])])],
            &l,
        );
        assert_eq!(m.model_fks.len(), 1);
        // FK 所在表与引用表都对齐库大小写
        assert_eq!(m.model_fks[0].table, "orders");
        assert_eq!(m.model_fks[0].ref_table, "Users");
    }

    #[test]
    fn unspecified_options_backfilled_from_live() {
        // 模型 engine/collation/列级 charset 为 None = 「未指定」而非「无」：
        // 表已存在于库时按库回填，否则 diff_table 会产 tblopt 假差异、
        // cols_equal 会产逐列假 MODIFY（应用后角标永远消不掉）
        let mut lt = tbl("orders", &[("id", "int")]);
        lt.engine = Some("InnoDB".into());
        lt.collation = Some("utf8mb4_general_ci".into());
        let mut lc = crate::datasource::ColumnDef {
            name: "name".into(),
            data_type: "varchar(20)".into(),
            character_set: Some("utf8mb4".into()),
            collation: Some("utf8mb4_general_ci".into()),
            ..Default::default()
        };
        lc.ordinal = 2;
        lt.columns.push(lc);
        let l = SchemaSnapshot { database: "db".into(), tables: vec![lt], views: vec![], server_version: None };
        let model = input("orders", &[("id", "int"), ("name", "varchar(20)")], &[]);
        // 模型列未带 charset（构造器默认 None）
        let m = build_model_snapshot("db", &[model], &l);
        let t = &m.snapshot.tables[0];
        assert_eq!(t.engine.as_deref(), Some("InnoDB"));
        assert_eq!(t.collation.as_deref(), Some("utf8mb4_general_ci"));
        let name_col = t.columns.iter().find(|c| c.name == "name").unwrap();
        assert_eq!(name_col.character_set.as_deref(), Some("utf8mb4"));
        assert_eq!(name_col.collation.as_deref(), Some("utf8mb4_general_ci"));
        // 回填后与库完全一致 → 无 tblopt/列差异
        let items = crate::compare::diff_snapshots(
            &m.snapshot,
            &SchemaSnapshot { database: "db".into(), tables: l.tables.clone(), views: vec![], server_version: None },
            &crate::compare::CompareOptions::default(),
        );
        assert!(
            items.iter().all(|i| i.action == crate::compare::DiffAction::Noop),
            "未指定字段回填后不应有差异: {items:?}"
        );
        // 新表（不在库里）不回填：None 保留，CREATE 走服务器默认
        let m2 = build_model_snapshot("db", &[input("brand_new", &[("id", "int")], &[])], &l);
        assert_eq!(m2.snapshot.tables[0].engine, None);
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test model_snapshot`
Expected: 编译失败（`build_model_snapshot`/`ModelSnapshot` 不存在）

- [ ] **Step 3: 实现**

`er_model.rs` 追加：

```rust
use std::collections::HashMap;

use crate::datasource::SchemaSnapshot;

/// 模型快照组装结果：结构快照（source 用）+ 涉及表/ tombstone 集合（小写）+ 模型外键
pub struct ModelSnapshot {
    pub snapshot: SchemaSnapshot,
    pub involved: HashSet<String>,
    pub tombstones: HashSet<String>,
    pub model_fks: Vec<ForeignKeyDef>,
}

/// payload + 库实时快照 → 模型快照。payload 表名与库表忽略大小写同名时
/// 对齐为库原始大小写（diff_snapshots 按名字精确匹配，不对齐会把大小写
/// 差异误判成 DROP+CREATE）；新表不在库里，保留用户输入名。
/// 「未指定」归一化：engine/collation/列级 character_set/collation 为 None
/// 表示未指定（模型无法表达「无引擎/无字符集」），表存在于库时按库回填——
/// 否则未改这些字段的编辑会产 tblopt/列级假差异，应用后角标永远消不掉。
pub fn build_model_snapshot(db: &str, model: &[ErModelTableInput], live: &SchemaSnapshot) -> ModelSnapshot {
    let live_by_lower: HashMap<String, &TableDef> = live
        .tables
        .iter()
        .map(|t| (t.name.to_lowercase(), t))
        .collect();
    let mut tables = Vec::new();
    let mut involved = HashSet::new();
    let mut tombstones = HashSet::new();
    let mut model_fks = Vec::new();
    for t in model {
        let lower = t.name.to_lowercase();
        involved.insert(lower.clone());
        let Some(s) = &t.schema else {
            tombstones.insert(lower);
            continue;
        };
        let mut td = s.table.clone();
        if let Some(lt) = live_by_lower.get(&lower) {
            td.name = lt.name.clone();
            if td.engine.is_none() {
                td.engine = lt.engine.clone();
            }
            if td.collation.is_none() {
                td.collation = lt.collation.clone();
            }
            // 列级字符集/排序规则同名回填（新加的列不在库里，保持 None）
            for c in &mut td.columns {
                if c.character_set.is_some() && c.collation.is_some() {
                    continue;
                }
                if let Some(lc) = lt.columns.iter().find(|x| x.name.eq_ignore_ascii_case(&c.name)) {
                    if c.character_set.is_none() {
                        c.character_set = lc.character_set.clone();
                    }
                    if c.collation.is_none() {
                        c.collation = lc.collation.clone();
                    }
                }
            }
        } else {
            td.name = t.name.trim().to_string();
        }
        for fk in &s.foreign_keys {
            let mut fk = fk.clone();
            fk.table = td.name.clone();
            if let Some(orig) = live_by_lower.get(&fk.ref_table.to_lowercase()) {
                fk.ref_table = orig.name.clone();
            }
            model_fks.push(fk);
        }
        tables.push(td);
    }
    ModelSnapshot {
        snapshot: SchemaSnapshot {
            database: db.to_string(),
            tables,
            views: Vec::new(),
            server_version: live.server_version.clone(),
        },
        involved,
        tombstones,
        model_fks,
    }
}
```

- [ ] **Step 4: 运行通过**

Run: `cd src-tauri && cargo test er_model`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/compare/er_model.rs
git commit -m "feat:ER 模型快照构造（表名对齐库大小写、tombstone 分离、FK 收集）"
```

---

### Task 4: 外键对比（diff_foreign_keys）

**Files:**
- Modify: `src-tauri/src/compare/er_model.rs`
- Test: 同文件 `mod tests`

**Interfaces:**
- Consumes: Task 1 的 `drop_foreign_key_ddl`/`add_foreign_key_clause`、`foreign_key_ddl`；`crate::compare::{DiffItem, DiffKind, DiffAction}`
- Produces: `pub fn diff_foreign_keys(db: &str, model_tables: &HashSet<String>, model_fks: &[ForeignKeyDef], db_fks: &[ForeignKeyDef], tombstones: &HashSet<String>) -> Vec<DiffItem>`（model_tables/tombstones 为小写表名集合）
- FK 项约定：`id = "fk:{表}:{约束名}"`，`kind = DiffKind::ForeignKey`，DROP 类 `dangerous: true`；ADD 项 `source_ddl = Some(foreign_key_ddl(模型形态))`、`target_ddl = None`，DROP 项反之，rebuild 项双侧都有

- [ ] **Step 1: 写失败测试**

`mod tests` 追加：

```rust
    fn fkd(name: &str, table: &str, cols: &[&str], rt: &str, rc: &[&str]) -> ForeignKeyDef {
        ForeignKeyDef {
            name: name.into(),
            table: table.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            ref_table: rt.into(),
            ref_columns: rc.iter().map(|s| s.to_string()).collect(),
            on_delete: None,
            on_update: None,
        }
    }

    fn fk_ids(items: &[crate::compare::DiffItem]) -> Vec<String> {
        items.iter().map(|i| i.id.clone()).collect()
    }

    #[test]
    fn fk_add_when_model_only() {
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let items = diff_foreign_keys(
            "db",
            &model_tables,
            &[fkd("fk_uid", "orders", &["uid"], "users", &["id"])],
            &[],
            &HashSet::new(),
        );
        assert_eq!(fk_ids(&items), vec!["fk:orders:fk_uid"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Create);
        assert!(!items[0].dangerous);
        assert_eq!(
            items[0].sql.as_deref(),
            Some("ALTER TABLE `db`.`orders` ADD CONSTRAINT `fk_uid` FOREIGN KEY (`uid`) REFERENCES `db`.`users` (`id`)")
        );
        assert!(items[0].source_ddl.is_some() && items[0].target_ddl.is_none());
        // FK 项带 ref_table：前端「删表 → 前置删 FK」勾选联动用它
        assert_eq!(items[0].ref_table.as_deref(), Some("users"));
    }

    #[test]
    fn fk_drop_when_model_table_edited_and_fk_removed() {
        // 模型编辑了 orders 但删掉了它的 FK → DROP（dangerous）
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let items = diff_foreign_keys(
            "db",
            &model_tables,
            &[],
            &[fkd("fk_uid", "orders", &["uid"], "users", &["id"])],
            &HashSet::new(),
        );
        assert_eq!(fk_ids(&items), vec!["fk:orders:fk_uid"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Drop);
        assert!(items[0].dangerous);
        assert_eq!(
            items[0].sql.as_deref(),
            Some("ALTER TABLE `db`.`orders` DROP FOREIGN KEY `fk_uid`")
        );
    }

    #[test]
    fn fk_untouched_tables_are_ignored() {
        // FK 所在表不在模型集合、也不引用 tombstone → 完全不动（别人表的外键）
        let empty: HashSet<String> = HashSet::new();
        let items = diff_foreign_keys(
            "db",
            &empty,
            &[],
            &[fkd("fk_x", "other_tbl", &["uid"], "users", &["id"])],
            &HashSet::new(),
        );
        assert!(items.is_empty());
    }

    #[test]
    fn fk_referencing_tombstone_dropped_regardless_of_owner() {
        // 非模型表上的 FK 引用了 tombstone 表 → 也必须 DROP（否则删表必失败）
        let empty: HashSet<String> = HashSet::new();
        let tombs: HashSet<String> = ["old_ref"].iter().map(|s| s.to_string()).collect();
        let items = diff_foreign_keys(
            "db",
            &empty,
            &[],
            &[fkd("fk_o", "other_tbl", &["x"], "Old_Ref", &["id"])],
            &tombs,
        );
        assert_eq!(fk_ids(&items), vec!["fk:other_tbl:fk_o"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Drop);
        assert!(items[0].dangerous);
    }

    #[test]
    fn fk_definition_change_rebuilds_in_one_alter() {
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let mut m = fkd("fk_uid", "orders", &["uid"], "users", &["id"]);
        m.on_delete = Some("CASCADE".into());
        let d = fkd("fk_uid", "orders", &["uid"], "users", &["id"]);
        let items = diff_foreign_keys("db", &model_tables, &[m], &[d], &HashSet::new());
        assert_eq!(fk_ids(&items), vec!["fk:orders:fk_uid"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Modify);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("DROP FOREIGN KEY `fk_uid`"), "{sql}");
        assert!(sql.contains("ADD CONSTRAINT `fk_uid` FOREIGN KEY (`uid`) REFERENCES `db`.`users` (`id`) ON DELETE CASCADE"), "{sql}");
        // 一条 ALTER
        assert!(sql.starts_with("ALTER TABLE `db`.`orders`"), "{sql}");
    }

    #[test]
    fn identical_fk_no_diff() {
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let fk = fkd("fk_uid", "orders", &["uid"], "users", &["id"]);
        let items = diff_foreign_keys("db", &model_tables, &[fk.clone()], &[fk], &HashSet::new());
        assert!(items.is_empty());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test fk_`
Expected: 编译失败（`diff_foreign_keys` 不存在）

- [ ] **Step 3: 实现**

`er_model.rs` 追加：

```rust
use std::collections::BTreeMap;

use crate::compare::sqlgen::{add_foreign_key_clause, drop_foreign_key_ddl, foreign_key_ddl};
use crate::compare::{DiffAction, DiffItem, DiffKind};

/// FK 形态描述（UI 差异树用）
fn describe_fk(fk: &ForeignKeyDef) -> String {
    let mut s = format!(
        "{}({}) → {}({})",
        fk.table,
        fk.columns.join(","),
        fk.ref_table,
        fk.ref_columns.join(",")
    );
    if let Some(d) = &fk.on_delete {
        s.push_str(&format!(" ON DELETE {d}"));
    }
    if let Some(u) = &fk.on_update {
        s.push_str(&format!(" ON UPDATE {u}"));
    }
    s
}

fn fk_item(
    action: DiffAction,
    fk: &ForeignKeyDef,
    sql: String,
    dangerous: bool,
    source_ddl: Option<String>,
    target_ddl: Option<String>,
    source_desc: Option<String>,
    target_desc: Option<String>,
) -> DiffItem {
    DiffItem {
        id: format!("fk:{}:{}", fk.table, fk.name),
        kind: DiffKind::ForeignKey,
        action,
        table: fk.table.clone(),
        name: fk.name.clone(),
        source_desc,
        target_desc,
        sql: Some(sql),
        sql_clause: None,
        dangerous,
        source_ddl,
        target_ddl,
        // 前端「勾选删表 → 自动勾选其前置 DROP FK」联动依赖此字段
        ref_table: Some(fk.ref_table.clone()),
    }
}

/// 模型外键 vs 库外键：
/// - FK 所在表 ∈ 模型 schema 表集：按（表, 约束名）匹配，模型有库无 → ADD，
///   库有模型无 → DROP（dangerous），都有但定义不同 → 一条 ALTER DROP+ADD 重建
/// - 库 FK 引用任一 tombstone 表 → 一律 DROP（删表的必然后果；所在表可以不是模型表）
/// - 其余（非模型表且不引用 tombstone）→ 不动
pub fn diff_foreign_keys(
    db: &str,
    model_tables: &HashSet<String>,
    model_fks: &[ForeignKeyDef],
    db_fks: &[ForeignKeyDef],
    tombstones: &HashSet<String>,
) -> Vec<DiffItem> {
    let model_idx: BTreeMap<(String, String), &ForeignKeyDef> = model_fks
        .iter()
        .map(|fk| ((fk.table.to_lowercase(), fk.name.to_lowercase()), fk))
        .collect();
    let mut handled: HashSet<(String, String)> = HashSet::new();
    let mut items = Vec::new();

    for fk in db_fks {
        let key = (fk.table.to_lowercase(), fk.name.to_lowercase());
        match model_idx.get(&key) {
            Some(m) => {
                handled.insert(key);
                if m != fk {
                    // 定义变化：一条 ALTER 同时 DROP 旧 + ADD 新（照索引重建模式）
                    items.push(fk_item(
                        DiffAction::Modify,
                        m,
                        format!(
                            "ALTER TABLE {} DROP FOREIGN KEY {}, {}",
                            crate::compare::sqlgen::qualified(db, &m.table),
                            crate::compare::sqlgen::quote_ident(&fk.name),
                            add_foreign_key_clause(db, m)
                        ),
                        false,
                        Some(foreign_key_ddl(db, m)),
                        Some(foreign_key_ddl(db, fk)),
                        Some(describe_fk(m)),
                        Some(describe_fk(fk)),
                    ));
                }
            }
            None => {
                let in_model_table = model_tables.contains(&fk.table.to_lowercase());
                let refs_tombstone = tombstones.contains(&fk.ref_table.to_lowercase());
                if in_model_table || refs_tombstone {
                    items.push(fk_item(
                        DiffAction::Drop,
                        fk,
                        drop_foreign_key_ddl(db, &fk.table, &fk.name),
                        true,
                        None,
                        Some(foreign_key_ddl(db, fk)),
                        None,
                        Some(describe_fk(fk)),
                    ));
                }
            }
        }
    }
    for (key, m) in &model_idx {
        if handled.contains(key) {
            continue;
        }
        items.push(fk_item(
            DiffAction::Create,
            m,
            foreign_key_ddl(db, m),
            false,
            Some(foreign_key_ddl(db, m)),
            None,
            Some(describe_fk(m)),
            None,
        ));
    }
    items
}
```

同时给 `compare/mod.rs` 做两处结构扩展：

1. `DiffKind` 加变体（`View` 前）：

```rust
    #[serde(rename = "foreignKey")]
    ForeignKey,
```

2. `DiffItem` 加可选字段（放 `sql_clause` 字段后）——FK 项的引用表，供前端删表勾选联动；普通结构对比恒不设置，序列化省略，不影响既有前端：

```rust
    /// 外键项专用：引用的表名（其余 kind 恒 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_table: Option<String>,
```

`compare/mod.rs` 里所有 `DiffItem { ... }` 结构体字面量（table_rename/table_create/table_noop/table_drop/diff_table 的 mk 闭包/diff_views 等约 8 处）需补 `ref_table: None,`——以编译器报错为清单逐一补齐，不改任何行为（Task 5 的 rename 拆解构造同理，代码块里已带上）。

- [ ] **Step 4: 运行通过**

Run: `cd src-tauri && cargo test`
Expected: PASS 全部（含既有测试无回归）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/compare/er_model.rs src-tauri/src/compare/mod.rs
git commit -m "feat:ER 模型外键对比（ADD/DROP/重建与 tombstone 引用外键清理）"
```

---

### Task 5: diff_model_vs_db 组装、rename 拆解与 DDL 排序

**Files:**
- Modify: `src-tauri/src/compare/er_model.rs`
- Test: 同文件 `mod tests`

**Interfaces:**
- Consumes: Task 2/3/4 全部产出、`diff_snapshots`、`CompareOptions`
- Produces: `pub fn diff_model_vs_db(db: &str, model: &[ErModelTableInput], live: &SchemaSnapshot, live_fks: &[ForeignKeyDef]) -> AppResult<Vec<DiffItem>>`

- [ ] **Step 1: 写失败测试**

`mod tests` 追加：

```rust
    fn full_model_diff(db: &str, model: &[ErModelTableInput], l: &SchemaSnapshot, fks: &[ForeignKeyDef]) -> Vec<crate::compare::DiffItem> {
        diff_model_vs_db(db, model, l, fks).unwrap()
    }

    fn snap_of(db: &str, tables: Vec<TableDef>) -> SchemaSnapshot {
        SchemaSnapshot { database: db.into(), tables, views: vec![], server_version: Some("8.0.36".into()) }
    }

    fn tbl(name: &str, cols: &[(&str, &str)]) -> TableDef {
        TableDef {
            name: name.into(),
            columns: cols
                .iter()
                .map(|(n, dt)| ColumnDef { name: n.to_string(), data_type: dt.to_string(), ..Default::default() })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn assemble_end_to_end_new_edit_tombstone() {
        // 库：keep(id,name) + legacy(id)；模型：编辑 keep(加列) + 新建 fresh + tombstone legacy
        let l = snap_of("db", vec![
            tbl("keep", &[("id", "int"), ("name", "varchar(20)")]),
            tbl("legacy", &[("id", "int")]),
        ]);
        let model = vec![
            input("keep", &[("id", "int"), ("name", "varchar(20)"), ("memo", "text")], &[]),
            input("fresh", &[("id", "int")], &[]),
            { let mut t = input("legacy", &[], &[]); t.schema = None; t },
        ];
        let items = full_model_diff("db", &model, &l, &[]);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"col:keep:memo"), "{ids:?}");
        assert!(ids.contains(&"tbl:fresh"), "{ids:?}");
        assert!(ids.contains(&"tbl:legacy"), "{ids:?}");
        let legacy = items.iter().find(|i| i.id == "tbl:legacy").unwrap();
        assert!(legacy.dangerous);
    }

    #[test]
    fn rename_heuristic_split_into_drop_and_create() {
        // 结构相同、名字像 rename（tbl_old → tbl_new）：ER 语义必须是 DROP+CREATE，
        // 不是 RENAME（模型不支持改名，删旧建新就是两个独立操作）
        let same_cols = [("id", "int")];
        let l = snap_of("db", vec![tbl("tbl_old", &same_cols)]);
        let model = vec![
            { let mut t = input("tbl_old", &[], &[]); t.schema = None; t },
            input("tbl_new", &same_cols, &[]),
        ];
        let items = full_model_diff("db", &model, &l, &[]);
        assert!(items.iter().all(|i| i.action != crate::compare::DiffAction::Rename), "{items:?}");
        assert!(items.iter().any(|i| i.id == "tbl:tbl_new" && i.action == crate::compare::DiffAction::Create));
        let drop = items.iter().find(|i| i.id == "tbl:tbl_old").unwrap();
        assert_eq!(drop.action, crate::compare::DiffAction::Drop);
        assert_eq!(drop.sql.as_deref(), Some("DROP TABLE `db`.`tbl_old`"));
    }

    #[test]
    fn ddl_order_drop_fk_first_add_fk_last() {
        // tombstone b 被库 FK（在保留表 c 上）引用 → 先 DROP FK；新表 + 新 FK 最后
        let l = snap_of("db", vec![tbl("b", &[("id", "int")]), tbl("c", &[("bid", "int")])]);
        let fks = vec![fkd("fk_cb", "c", &["bid"], "b", &["id"])];
        let model = vec![
            { let mut t = input("b", &[], &[]); t.schema = None; t },
            input("c", &[("bid", "int")], &[("fk_cb", &["bid"], &["id"])]),
        ];
        let items = full_model_diff("db", &model, &l, &fks);
        // 库 FK 与模型 FK 定义一致 → 只有 DROP TABLE b 与引用清理
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["fk:c:fk_cb", "tbl:b"], "{ids:?}");
        let drop_fk = &items[0];
        assert_eq!(drop_fk.sql.as_deref(), Some("ALTER TABLE `db`.`c` DROP FOREIGN KEY `fk_cb`"));
    }

    #[test]
    fn ddl_order_keeps_same_table_column_items_adjacent() {
        // 同表多个列变更 + FK 项并存：同表列项必须连续（前端 buildDeployStatements
        // 只合并连续同表子句；被 FK 项插断会产生多条 ALTER）
        let l = snap_of("db", vec![tbl("t", &[("id", "int")])]);
        let model = vec![input("t", &[("id", "int"), ("a", "int"), ("b", "int")], &[])];
        let items = full_model_diff("db", &model, &l, &[]);
        let seq: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(seq, vec!["col:t:a", "col:t:b"], "{seq:?}");
        // 加上 FK 后：FK 项必须排在列项之后（组序 ④），不打断连续性
        let fks = vec![fkd("fk_self", "t", &["a"], "u", &["id"])];
        let model2 = vec![input("t", &[("id", "int"), ("a", "int"), ("b", "int")], &[("fk_self", &["a"], &["id"])])];
        let items2 = full_model_diff("db", &model2, &l, &fks);
        let seq2: Vec<&str> = items2.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(seq2, vec!["col:t:a", "col:t:b", "fk:t:fk_self"], "{seq2:?}");
    }

    #[test]
    fn noop_items_filtered_out() {
        // 库与模型一致的表不出现在结果里（ER 应用只关心要执行的差异）
        let l = snap_of("db", vec![tbl("same", &[("id", "int")])]);
        let model = vec![input("same", &[("id", "int")], &[])];
        let items = full_model_diff("db", &model, &l, &[]);
        assert!(items.is_empty(), "{items:?}");
    }

    #[test]
    fn circular_tombstone_fks_all_dropped_before_tables() {
        // a ↔ b 环形互引且都被删除：两条 DROP FK 都在两条 DROP TABLE 之前
        let l = snap_of("db", vec![tbl("a", &[("id", "int"), ("bid", "int")]), tbl("b", &[("id", "int"), ("aid", "int")])]);
        let fks = vec![
            fkd("fk_ab", "a", &["bid"], "b", &["id"]),
            fkd("fk_ba", "b", &["aid"], "a", &["id"]),
        ];
        let model = vec![
            { let mut t = input("a", &[], &[]); t.schema = None; t },
            { let mut t = input("b", &[], &[]); t.schema = None; t },
        ];
        let items = full_model_diff("db", &model, &l, &fks);
        let kinds: Vec<&str> = items
            .iter()
            .map(|i| if i.kind == DiffKind::ForeignKey { "fk" } else if i.kind == crate::compare::DiffKind::Table { "tbl" } else { "other" })
            .collect();
        assert_eq!(kinds, vec!["fk", "fk", "tbl", "tbl"], "{items:?}");
        assert!(items.iter().take(2).all(|i| i.action == DiffAction::Drop));
        assert!(items.iter().skip(2).all(|i| i.action == crate::compare::DiffAction::Drop && i.kind == crate::compare::DiffKind::Table));
    }

    #[test]
    fn validation_error_propagates() {
        let l = snap_of("db", vec![]);
        assert!(diff_model_vs_db("db", &[input("", &[], &[])], &l, &[]).is_err());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd src-tauri && cargo test assemble_ ddl_order rename_heuristic circular noop_items validation_error_propagates`
Expected: 编译失败（`diff_model_vs_db` 不存在）

- [ ] **Step 3: 实现**

`er_model.rs` 追加：

```rust
use crate::compare::{diff_snapshots, CompareOptions};

/// 模型 vs 库实时结构 → 按依赖排序的差异清单（应用回库的完整 DDL 序列）。
/// 排序：① DROP FK（断环/解除引用）→ ② DROP TABLE → ③ 建表/改表（列子句同表
/// 连续，前端可合并为一条 ALTER）→ ④ ADD/重建 FK。每组内按表名、id 稳定排序。
pub fn diff_model_vs_db(
    db: &str,
    model: &[ErModelTableInput],
    live: &SchemaSnapshot,
    live_fks: &[ForeignKeyDef],
) -> AppResult<Vec<DiffItem>> {
    validate_model_payload(model)?;
    let m = build_model_snapshot(db, model, live);
    let model_tables: HashSet<String> = m.snapshot.tables.iter().map(|t| t.name.to_lowercase()).collect();

    // 目标快照：实时快照过滤到涉及表（库里其他表永不参与）
    let target = SchemaSnapshot {
        database: db.to_string(),
        tables: live
            .tables
            .iter()
            .filter(|t| m.involved.contains(&t.name.to_lowercase()))
            .cloned()
            .collect(),
        views: Vec::new(),
        server_version: live.server_version.clone(),
    };

    let opts = CompareOptions { compare_indexes: true, compare_views: false };
    let mut items: Vec<DiffItem> = diff_snapshots(&m.snapshot, &target, &opts)
        .into_iter()
        .filter(|i| i.action != DiffAction::Noop)
        .flat_map(|i| {
            // ER 不做重命名推断：rename 项拆回 DROP(旧) + CREATE(新)，与模型表达一致。
            // 两端同库，source_ddl 就是可直接执行的 CREATE 语句
            if i.action == DiffAction::Rename {
                vec![
                    DiffItem {
                        id: format!("tbl:{}", i.table),
                        kind: DiffKind::Table,
                        action: DiffAction::Drop,
                        table: i.table.clone(),
                        name: i.table.clone(),
                        source_desc: None,
                        target_desc: i.target_desc.clone(),
                        sql: Some(format!(
                            "DROP TABLE {}",
                            crate::compare::sqlgen::qualified(db, &i.table)
                        )),
                        sql_clause: None,
                        dangerous: true,
                        source_ddl: None,
                        target_ddl: i.target_ddl.clone(),
                        ref_table: None,
                    },
                    DiffItem {
                        id: format!("tbl:{}", i.name),
                        kind: DiffKind::Table,
                        action: DiffAction::Create,
                        table: i.name.clone(),
                        name: i.name.clone(),
                        source_desc: i.source_desc.clone(),
                        target_desc: None,
                        sql: i.source_ddl.clone(),
                        sql_clause: None,
                        dangerous: false,
                        source_ddl: i.source_ddl.clone(),
                        target_ddl: None,
                        ref_table: None,
                    },
                ]
            } else {
                vec![i]
            }
        })
        .collect();

    items.extend(diff_foreign_keys(db, &model_tables, &m.model_fks, live_fks, &m.tombstones));

    // 分组排序：DROP FK(0) → DROP TABLE(1) → 结构项(2) → ADD/rebuild FK(3)
    let group = |i: &DiffItem| match (i.kind, i.action) {
        (DiffKind::ForeignKey, DiffAction::Drop) => 0,
        (DiffKind::Table, DiffAction::Drop) => 1,
        (DiffKind::ForeignKey, _) => 3,
        _ => 2,
    };
    items.sort_by(|a, b| {
        group(a)
            .cmp(&group(b))
            .then_with(|| a.table.to_lowercase().cmp(&b.table.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(items)
}
```

注意：组内 `table` 再 `id` 排序保证同表列项连续（Review Focus 第 4 条）。列的 AFTER 链依赖 `diff_snapshots` 内部顺序，但 id 排序 `col:t:a < col:t:b < col:t:c` 与列名字典序一致——若模型列名字典序与列序不一致（如 `b, a` 两列都新增），合并成一条 ALTER 时子句顺序为 a 后 b，AFTER 链断裂。**因此结构组（2）内不能用 id 排序破坏列序**，改法：组 2 内保持 `diff_snapshots` 原始顺序（已按表名 BTreeMap 分组、列按源序），只做稳定分段——用 `sort_by_cached_key` 的替代方案：

```rust
    // 组 2 依赖 diff_snapshots 的表内列序（AFTER 链），排序时保持组内原始相对顺序：
    // 先记原始下标做稳定 tie-break，组 2 内只按表名分段不按 id 重排
    let original: Vec<usize> = (0..items.len()).collect();
```

实现上更简单可靠的做法：先给每项算 `group`，再做一次**稳定排序只按 (group, table_lower)**（Rust `sort_by` 是稳定的）：

```rust
    items.sort_by(|a, b| {
        group(a)
            .cmp(&group(b))
            .then_with(|| a.table.to_lowercase().cmp(&b.table.to_lowercase()))
    });
```

稳定排序下组 2 内同表项保持 diff_snapshots 产出顺序（列序 = 源序，AFTER 链正确），同表列项也连续（同表相邻）。FK 组按表名排序即可。上面测试 `ddl_order_keeps_same_table_column_items_adjacent` 断言的就是这个行为。最终实现采用稳定排序版本（无 `then_with(a.id.cmp(&b.id))`），并把此理由写成代码注释。

- [ ] **Step 4: 运行通过**

Run: `cd src-tauri && cargo test`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/compare/er_model.rs
git commit -m "feat:ER 模型 vs 库 diff 组装（rename 拆解、DDL 依赖排序）"
```

---

### Task 6: er_diff / preview_table_ddl 命令与注册

**Files:**
- Modify: `src-tauri/src/commands/er.rs`
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册）

**Interfaces:**
- Consumes: Task 5 的 `diff_model_vs_db`、`ErModelTableInput`/`ErTableSchemaInput`
- Produces（前端 Task 8 对接）：
  - `#[tauri::command] pub async fn er_diff(registry, connection_id: Uuid, database: String, model: Vec<ErModelTableInput>) -> AppResult<Vec<DiffItem>>`
  - `#[tauri::command] pub async fn preview_table_ddl(database: String, schema: ErTableSchemaInput) -> AppResult<String>`

- [ ] **Step 1: 实现命令（薄 IO，无新单测——纯函数已在 Task 2-5 覆盖）**

`commands/er.rs` 追加（`export_tables_ddl` 之后）：

```rust
use crate::compare::er_model::{diff_model_vs_db, ErModelTableInput, ErTableSchemaInput};
use crate::compare::DiffItem;

/// ER 图上建模的「应用变更」第一步：模型 payload vs 库实时结构 → 差异清单。
/// 只比较模型涉及的表；库里其他表永不参与
#[tauri::command]
pub async fn er_diff(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
    model: Vec<ErModelTableInput>,
) -> AppResult<Vec<DiffItem>> {
    let conn = live(&registry, connection_id).await?;
    let involved: Vec<String> = model.iter().map(|t| t.name.clone()).collect();
    let snap = conn.snapshot_tables(&database, Some(&involved)).await?;
    let fks = conn.list_foreign_keys(&database).await?;
    diff_model_vs_db(&database, &model, &snap, &fks)
}

/// 表设计器底部实时 DDL 预览（不落库）。外键作为独立 ALTER 追加——
/// 外键 Tab 的编辑在预览里必须可见，否则用户以为没生效
#[tauri::command]
pub async fn preview_table_ddl(database: String, schema: ErTableSchemaInput) -> AppResult<String> {
    let mut out = create_table_sql(&database, &schema.table);
    for fk in &schema.foreign_keys {
        out.push_str(";\n\n");
        out.push_str(&foreign_key_ddl(&database, fk));
    }
    Ok(out)
}
```

import 处补 `foreign_key_ddl`（现有 `create_table_sql` 旁）。

`lib.rs` 的 `invoke_handler` 中 `commands::er::export_tables_ddl,` 之后追加：

```rust
            commands::er::er_diff,
            commands::er::preview_table_ddl,
```

- [ ] **Step 2: 编译与全量测试**

Run: `cd src-tauri && cargo test`
Expected: PASS（编译通过即命令可注册；`cargo clippy` 如项目有配置也应干净）

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/commands/er.rs src-tauri/src/lib.rs
git commit -m "feat:er_diff 与 preview_table_ddl 命令"
```

---

### Task 7: Rust e2e——真库建模闭环与环形删除

**Files:**
- Modify: `src-tauri/src/compare/er_model.rs`（`mod tests` 内新增 `mod e2e`）

**Interfaces:**
- Consumes: `diff_model_vs_db`、`MySqlLive::execute`（照 `compare/mod.rs` 的 `mod e2e` 模式）
- 环境约定：`DBFLOW_E2E=1` 时连 `127.0.0.1:3306`（本地 docker mysql5.6，root/123123，即 demo_fk 所在实例；若该环境端口不同以 README/实际为准）。测试自建独立库、用后即删，不触碰 demo_fk

- [ ] **Step 1: 写 e2e 测试**

`mod tests` 末尾追加（模式照抄 `compare/mod.rs` e2e：`enabled()` 判 `DBFLOW_E2E`）：

```rust
    mod e2e {
        use super::*;
        use crate::compare::DiffAction;
        use crate::config::model::{ConnectionProfile, DatabaseKind};
        use crate::datasource::mysql::{self, ConnectEndpoint, MySqlLive};
        use crate::datasource::LiveConnection;

        fn enabled() -> bool {
            std::env::var("DBFLOW_E2E").is_ok()
        }

        /// 双版本端点：本地 docker mysql5.6（demo_fk 所在实例）与 docker/testenv 的 mysql-a（8.4）。
        /// information_schema 的表名 IN 过滤/排序规则回填等行为在 5.6 与 8.x 都要验一遍
        async fn conn(port: u16, password: &str) -> MySqlLive {
            let profile = ConnectionProfile {
                id: uuid::Uuid::new_v4(),
                name: "e2e-er-model".into(),
                db: DatabaseKind::MySql,
                host: "127.0.0.1".into(),
                port,
                user: "root".into(),
                has_password: true,
                ..Default::default()
            };
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port };
            let pool = mysql::open_pool(&profile, &endpoint, Some(password))
                .await
                .unwrap_or_else(|e| panic!("连接 127.0.0.1:{port} 失败（容器没起？）: {e}"));
            MySqlLive::new(pool, None)
        }

        /// 完整闭环：模型（新表+编辑表+tombstone+模型FK）→ diff → 执行 → 复跑零差异。
        /// 5.6（demo_fk 所在实例）与 8.4（docker/testenv mysql-a）都跑
        #[tokio::test]
        async fn e2e_er_model_roundtrip() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            for (port, pw) in [(3306u16, "123123"), (3308u16, "dbflow-a-2026")] {
                let live = conn(port, pw).await;
                run_roundtrip(&live).await;
                live.shutdown().await;
            }
        }

        async fn run_roundtrip(live: &MySqlLive) {
            for sql in [
                "DROP DATABASE IF EXISTS `dbflow_er_e2e`",
                "CREATE DATABASE `dbflow_er_e2e` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `dbflow_er_e2e`.`keep` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(20) NOT NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
                "CREATE TABLE `dbflow_er_e2e`.`legacy` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB",
                "CREATE TABLE `dbflow_er_e2e`.`parent` (`id` bigint unsigned NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ] {
                live.execute(sql).await.unwrap();
            }

            // 模型：编辑 keep 加列；新建 child 带 FK 引用 parent；tombstone legacy
            let keep = input("keep", &[("id", "bigint unsigned"), ("name", "varchar(20)"), ("memo", "varchar(200)")], &[]);
            let child = {
                let mut t = input("child", &[("id", "bigint unsigned"), ("pid", "bigint unsigned")], &[]);
                // 手工补主键索引（input 构造器不带索引）
                if let Some(s) = &mut t.schema {
                    s.table.indexes = vec![crate::datasource::IndexDef {
                        name: "PRIMARY".into(),
                        columns: vec!["id".into()],
                        sub_parts: vec![None],
                        directions: vec![None],
                        unique: true,
                        is_primary: true,
                        index_type: Some("BTREE".into()),
                    }];
                    s.foreign_keys = vec![ForeignKeyDef {
                        name: "fk_child_parent".into(),
                        table: "child".into(),
                        columns: vec!["pid".into()],
                        ref_table: "parent".into(),
                        ref_columns: vec!["id".into()],
                        on_delete: None,
                        on_update: None,
                    }];
                }
                t
            };
            let mut legacy = input("legacy", &[], &[]);
            legacy.schema = None;

            let snap = live.snapshot_tables("dbflow_er_e2e", None).await.unwrap();
            let fks = live.list_foreign_keys("dbflow_er_e2e").await.unwrap();
            let items = diff_model_vs_db("dbflow_er_e2e", &[keep, child, legacy], &snap, &fks).unwrap();
            let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
            assert!(ids.contains(&"col:keep:memo")
                && ids.contains(&"tbl:child")
                && ids.contains(&"tbl:legacy")
                && ids.contains(&"fk:child:fk_child_parent"), "{ids:?}");
            // FK 建表之后
            let pos_child = ids.iter().position(|x| *x == "tbl:child").unwrap();
            let pos_fk = ids.iter().position(|x| *x == "fk:child:fk_child_parent").unwrap();
            assert!(pos_fk > pos_child);

            for item in &items {
                let sql = item.sql.as_deref().expect("每项都应有 SQL");
                live.execute(sql).await.unwrap_or_else(|e| panic!("执行失败 [{sql}]: {e}"));
            }

            // 复跑：模型态已与库一致（legacy 已删不再出现在模型里→不传）→ 零差异
            let keep2 = input("keep", &[("id", "bigint unsigned"), ("name", "varchar(20)"), ("memo", "varchar(200)")], &[]);
            let child2 = {
                let mut t = input("child", &[("id", "bigint unsigned"), ("pid", "bigint unsigned")], &[]);
                if let Some(s) = &mut t.schema {
                    s.table.indexes = vec![crate::datasource::IndexDef {
                        name: "PRIMARY".into(),
                        columns: vec!["id".into()],
                        sub_parts: vec![None],
                        directions: vec![None],
                        unique: true,
                        is_primary: true,
                        index_type: Some("BTREE".into()),
                    }];
                    s.foreign_keys = vec![ForeignKeyDef {
                        name: "fk_child_parent".into(),
                        table: "child".into(),
                        columns: vec!["pid".into()],
                        ref_table: "parent".into(),
                        ref_columns: vec!["id".into()],
                        on_delete: None,
                        on_update: None,
                    }];
                }
                t
            };
            let snap2 = live.snapshot_tables("dbflow_er_e2e", None).await.unwrap();
            let fks2 = live.list_foreign_keys("dbflow_er_e2e").await.unwrap();
            let remain = diff_model_vs_db("dbflow_er_e2e", &[keep2, child2], &snap2, &fks2).unwrap();
            assert!(remain.is_empty(), "应用后仍有差异: {:?}", remain.iter().map(|i| &i.id).collect::<Vec<_>>());

            live.execute("DROP DATABASE `dbflow_er_e2e`").await.unwrap();
        }

        /// 环形外键的两张表一起删除：先 DROP FK 断环再 DROP TABLE，真实可执行
        #[tokio::test]
        async fn e2e_circular_fk_drop() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let live = conn(3306, "123123").await;
            for sql in [
                "DROP DATABASE IF EXISTS `dbflow_er_circ`",
                "CREATE DATABASE `dbflow_er_circ` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `dbflow_er_circ`.`a` (`id` int NOT NULL, `bid` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB",
                "CREATE TABLE `dbflow_er_circ`.`b` (`id` int NOT NULL, `aid` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB",
                "ALTER TABLE `dbflow_er_circ`.`a` ADD CONSTRAINT `fk_ab` FOREIGN KEY (`bid`) REFERENCES `b` (`id`)",
                "ALTER TABLE `dbflow_er_circ`.`b` ADD CONSTRAINT `fk_ba` FOREIGN KEY (`aid`) REFERENCES `a` (`id`)",
            ] {
                live.execute(sql).await.unwrap();
            }
            let mut a = input("a", &[], &[]);
            a.schema = None;
            let mut b = input("b", &[], &[]);
            b.schema = None;
            let snap = live.snapshot_tables("dbflow_er_circ", None).await.unwrap();
            let fks = live.list_foreign_keys("dbflow_er_circ").await.unwrap();
            let items = diff_model_vs_db("dbflow_er_circ", &[a, b], &snap, &fks).unwrap();
            // FK 全在 DROP TABLE 之前
            let last_fk = items.iter().rposition(|i| i.kind == DiffKind::ForeignKey).unwrap();
            let first_tbl = items.iter().position(|i| i.kind == crate::compare::DiffKind::Table).unwrap();
            assert!(last_fk < first_tbl, "{items:?}");
            for item in &items {
                live.execute(item.sql.as_deref().unwrap()).await.unwrap();
            }
            live.execute("DROP DATABASE `dbflow_er_circ`").await.unwrap();
            live.shutdown().await;
        }
    }
```

注意 `ConnectionProfile` 字段集与 `compare/mod.rs` e2e 的 profile 构造保持一致（那里多了 group_id/color 等 `..Default::default()` 能省就省，编译报缺什么补什么，以实际 struct 为准）。

- [ ] **Step 2: 本地跑通（需 docker mysql5.6 在 3306）**

Run: `cd src-tauri && DBFLOW_E2E=1 cargo test e2e_er_model_roundtrip e2e_circular_fk_drop -- --test-threads=1`
Expected: PASS。若 5.6 因 FK 建表顺序/语法报错，按错误信息修正模型构造（如 FK 需要索引列，MySQL 会自动建）

- [ ] **Step 3: 无环境时确认默认跳过**

Run: `cd src-tauri && cargo test e2e`
Expected: PASS（打印「跳过（未设置 DBFLOW_E2E）」）

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/compare/er_model.rs
git commit -m "test:ER 建模闭环与环形外键删除 e2e"
```

---

### Task 8: 前端类型与 api 封装

**Files:**
- Modify: `src/api/types.ts`
- Modify: `src/api/commands.ts`

**Interfaces:**
- Consumes: Task 6 的 `er_diff`/`preview_table_ddl` 命令（参数/返回形态）
- Produces（后续任务全部依赖）：
  - types.ts：`ErTableSchema`/`ErColumnSchema`/`ErIndexSchema`/`ErFkSchema`/`ErModelTableInput`；`ErModelDoc.formatVersion: 1 | 2`、`ErDocTable`（含 `status?`/`schema?`）、`ErDocEdge.kind` 加 `'mfk'`、`DiffKind` 加 `'foreignKey'`
  - api：`erDiff(connectionId, database, model)`、`previewTableDdl(database, schema)`

- [ ] **Step 1: types.ts 扩展**

`DiffKind`（types.ts:142）改为：

```ts
export type DiffKind = 'table' | 'column' | 'index' | 'foreignKey' | 'view'
```

`DiffItem`（types.ts:152）加可选字段（`sqlClause` 之后）：

```ts
  /** 外键项专用：引用的表名（删表勾选联动用）；其余 kind 无此字段 */
  refTable?: string | null
```

`ErModelDoc` 一节（types.ts:363 附近）替换为：

```ts
/** ER 模型文档（.er.json）：布局/关系裁决 + 建模表结构（v2）。
 *  未编辑的表不存结构（实时取）；schema 存在即「模型为准」。纯文本可 git diff/合并 */
export interface ErModelDoc {
  /** 读取接受 1/2，写出恒 2；v1 打开按无 schema 的 v2 处理（惰性迁移） */
  formatVersion: 1 | 2
  kind: DatabaseKind
  database: string
  origin: { connectionName: string; capturedAt: string }
  tables: ErDocTable[]
  edges: ErDocEdge[]
}

export interface ErDocTable {
  id: string
  name: string
  x: number
  y: number
  collapsed: boolean
  /** 仅 tombstone：待删除（应用前可恢复） */
  status?: 'deleted'
  /** 完整表结构；仅新建/编辑过的表有 */
  schema?: ErTableSchema
}

/** 模型表结构：字段与后端 TableDef 对齐（payload 直接透传） */
export interface ErTableSchema {
  name: string
  engine: string | null
  collation: string | null
  comment: string | null
  columns: ErColumnSchema[]
  indexes: ErIndexSchema[]
  foreignKeys: ErFkSchema[]
}

export interface ErColumnSchema {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  extra: string
  comment: string | null
  characterSet: string | null
  collation: string | null
}

export interface ErIndexSchema {
  name: string
  columns: string[]
  subParts: (number | null)[]
  directions: (string | null)[]
  unique: boolean
  isPrimary: boolean
  indexType: string | null
}

/** 模型外键（回库生成 DDL 的那种；与纯标注的手动关联区分） */
export interface ErFkSchema {
  name: string
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: string | null
  onUpdate: string | null
}

/** er_diff 的模型 payload：schema 缺省/null = tombstone（待删除） */
export interface ErModelTableInput {
  name: string
  schema?: ErTableSchema | null
}
```

`ErDocEdge.kind` 类型改为 `'fk' | 'inferred' | 'manual' | 'mfk'`，并在其注释处补一行：

```ts
  /** mfk = 模型外键（表 schema.foreignKeys 的显示层条目，真源在 schema） */
```

- [ ] **Step 2: commands.ts 扩展**

`api` 对象的 ER 一节（`exportTablesDdl` 后）追加：

```ts
  erDiff: (connectionId: string, database: string, model: ErModelTableInput[]) =>
    invoke<DiffItem[]>('er_diff', { connectionId, database, model }),
  previewTableDdl: (database: string, schema: ErTableSchema) =>
    invoke<string>('preview_table_ddl', { database, schema }),
```

`import type` 列表补 `ErModelTableInput, ErTableSchema`。

- [ ] **Step 3: 类型检查通过**

Run: `pnpm build`（或 `pnpm exec tsc --noEmit`）
Expected: 无类型错误（ErModelDoc 用到 formatVersion: 1 字面量的地方兼容 `1 | 2`）

- [ ] **Step 4: 提交**

```bash
git add src/api/types.ts src/api/commands.ts
git commit -m "feat:ER 建模前端类型（文档 v2/模型 schema）与 er_diff api 封装"
```

---

### Task 9: modelSchema.ts 模型纯函数

**Files:**
- Create: `src/components/er/modelSchema.ts`
- Test: `src/components/er/modelSchema.test.ts`

**Interfaces:**
- Consumes: Task 8 的类型、`transform.ts` 的 `ErTable`
- Produces（后续任务依赖）：
  - `export interface ModelTableState { schema: ErTableSchema | null; deleted: boolean }`
  - `schemaToErTable(schema: ErTableSchema): ErTable`
  - `snapshotTableToSchema(t: ErTableDef, fks: ForeignKeyDef[]): ErTableSchema`（**必须带该表的库外键**——copy-on-edit 丢外键会让 diff 把全部真实 FK 判成待 DROP、画布隐藏真实 FK 边）
  - `schemasEqual(a: ErTableSchema, b: ErTableSchema): boolean`（语义化深比较，替代 JSON.stringify——key 顺序脆弱）
  - `newTableSchema(name: string): ErTableSchema`、`nextNewTableName(existing: string[]): string`
  - `validateTableSchema(schema: ErTableSchema, existingOthers: Set<string>): string | null`
  - `validateDeleteTable(targetLower: string, modelTables: Record<string, ModelTableState>): string | null`
  - `buildErDiffPayload(modelTables: Record<string, ModelTableState>, serverNames: Record<string, string>): ErModelTableInput[]`

- [ ] **Step 1: 写失败测试**

创建 `src/components/er/modelSchema.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import type { ErTableDef, ErTableSchema } from '../../api/types'
import {
  buildErDiffPayload,
  newTableSchema,
  nextNewTableName,
  schemaToErTable,
  schemasEqual,
  snapshotTableToSchema,
  validateDeleteTable,
  validateTableSchema,
} from './modelSchema'

function col(name: string, extra?: Partial<ErTableSchema['columns'][number]>) {
  return { name, dataType: 'int', nullable: true, default: null, extra: '', comment: null, characterSet: null, collation: null, ...extra }
}
function schema(name: string, over?: Partial<ErTableSchema>): ErTableSchema {
  return {
    name,
    engine: 'InnoDB',
    collation: null,
    comment: null,
    columns: [col('id', { nullable: false }), col('name', { dataType: 'varchar(20)' })],
    indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
    foreignKeys: [],
    ...over,
  }
}

describe('schemaToErTable', () => {
  it('主键/单列唯一分类与快照转换同规则', () => {
    const s = schema('t', {
      indexes: [
        { name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
        { name: 'uk_name', columns: ['name'], subParts: [null], directions: [null], unique: true, isPrimary: false, indexType: 'BTREE' },
      ],
    })
    const t = schemaToErTable(s)
    expect(t.name).toBe('t')
    expect(t.columns[0].key).toBe('pk')
    expect(t.columns[1].key).toBe('unique')
    expect(t.singlePrimaryKey).toBe('id')
  })
})

describe('snapshotTableToSchema / newTableSchema / nextNewTableName', () => {
  it('快照表全量拷贝为模型 schema（含该表的库外键——丢了会被 diff 判成待 DROP）', () => {
    const t: ErTableDef = {
      name: 'orders',
      engine: 'InnoDB',
      collation: 'utf8mb4_general_ci',
      comment: '订单',
      columns: [{ name: 'id', dataType: 'bigint unsigned', nullable: false, default: null, extra: 'auto_increment', comment: '主键', ordinal: 1, characterSet: null, collation: null }],
      indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
    }
    const fk = { name: 'fk_u', table: 'orders', columns: ['id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: null }
    const s = snapshotTableToSchema(t, [fk, { ...fk, name: 'other', table: 'other_tbl' }])
    expect(s.name).toBe('orders')
    expect(s.columns[0].extra).toBe('auto_increment')
    expect(s.collation).toBe('utf8mb4_general_ci')
    // 只收本表的外键，原样拷贝
    expect(s.foreignKeys).toEqual([fk])
  })

  it('schemasEqual：字段级深比较（含 cs/collation/FK），key 顺序无关', () => {
    const a = schema('t')
    const b = JSON.parse(JSON.stringify(a)) as typeof a
    // 打乱对象 key 顺序不影响
    const shuffled = { indexes: b.indexes, foreignKeys: b.foreignKeys, comment: b.comment, collation: b.collation, engine: b.engine, name: b.name, columns: b.columns.map((c: typeof b.columns[number]) => JSON.parse(JSON.stringify({ default: c.default, comment: c.comment, characterSet: c.characterSet, collation: c.collation, nullable: c.nullable, extra: c.extra, dataType: c.dataType, name: c.name }))) } as typeof a
    expect(schemasEqual(a, shuffled)).toBe(true)
    // 任一字段不同即不等
    expect(schemasEqual(a, { ...b, collation: 'utf8mb4_bin' })).toBe(false)
    expect(schemasEqual(a, { ...b, columns: [...b.columns, { name: 'x', dataType: 'int', nullable: true, default: null, extra: '', comment: null, characterSet: null, collation: null }] })).toBe(false)
    expect(schemasEqual(a, { ...b, foreignKeys: [{ name: 'f', table: 't', columns: ['id'], refTable: 'u', refColumns: ['id'], onDelete: null, onUpdate: null }] })).toBe(false)
    // 表名忽略大小写（服务器大小写差异不算改动）
    expect(schemasEqual(a, { ...b, name: 'T' })).toBe(true)
  })
  it('新表预填 id 主键', () => {
    const s = newTableSchema('t_new')
    expect(s.columns).toHaveLength(1)
    expect(s.columns[0]).toMatchObject({ name: 'id', dataType: 'bigint unsigned', extra: 'auto_increment' })
    expect(s.indexes[0].isPrimary).toBe(true)
  })
  it('默认名递增且避开既有表（忽略大小写）', () => {
    expect(nextNewTableName([])).toBe('new_table_1')
    expect(nextNewTableName(['new_table_1', 'New_Table_2'])).toBe('new_table_3')
  })
})

describe('validateTableSchema', () => {
  const others = new Set(['users'])
  it('正常 schema 通过', () => {
    expect(validateTableSchema(schema('orders'), others)).toBeNull()
  })
  it('重名（忽略大小写）/空名/0列/重复列名/空类型拒绝', () => {
    expect(validateTableSchema(schema('Users'), others)).toContain('同名')
    expect(validateTableSchema(schema(' '), others)).toContain('表名')
    expect(validateTableSchema(schema('t', { columns: [] }))).toContain('至少需要一列')
    expect(validateTableSchema(schema('t', { columns: [col('id'), col('ID')] }))).toContain('重复列名')
    expect(validateTableSchema(schema('t', { columns: [col('id', { dataType: ' ' })] }))).toContain('类型')
  })
  it('索引引用不存在的列 / 双主键 / 重复索引名拒绝', () => {
    expect(
      validateTableSchema(schema('t', { indexes: [{ name: 'idx_x', columns: ['nope'], subParts: [null], directions: [null], unique: false, isPrimary: false, indexType: 'BTREE' }] })),
    ).toContain('不存在的列')
    const p = { name: 'P2', columns: ['name'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' } as const
    expect(validateTableSchema(schema('t', { indexes: [schema('t').indexes[0], p] }))).toContain('一个主键')
  })
  it('FK 列数不匹配 / 引用本表不存在列 / 重复外键名拒绝', () => {
    const fk = (name: string, cols: string[], rc: string[]) => ({ name, table: 't', columns: cols, refTable: 'u', refColumns: rc, onDelete: null, onUpdate: null })
    expect(validateTableSchema(schema('t', { foreignKeys: [fk('f1', ['id'], ['a', 'b'])] }))).toContain('不匹配')
    expect(validateTableSchema(schema('t', { foreignKeys: [fk('f1', ['ghost'], ['a'])] }))).toContain('不存在的列')
    expect(validateTableSchema(schema('t', { foreignKeys: [fk('f1', ['id'], ['a']), fk('F1', ['id'], ['a'])] }))).toContain('重复外键名')
  })
})

describe('validateDeleteTable', () => {
  it('被其他模型表外键引用时阻止', () => {
    const fk = { name: 'f1', table: 'child', columns: ['pid'], refTable: 'parent', refColumns: ['id'], onDelete: null, onUpdate: null }
    const modelTables = { child: { schema: schema('child', { foreignKeys: [fk] }), deleted: false } }
    expect(validateDeleteTable('parent', modelTables)).toContain('先删除')
    expect(validateDeleteTable('other', modelTables)).toBeNull()
  })
})

describe('buildErDiffPayload', () => {
  it('只含有建模痕迹的表；tombstone 的 schema 为 null；表名用服务器原始大小写', () => {
    const modelTables = {
      orders: { schema: schema('orders'), deleted: false },
      legacy: { schema: null, deleted: true },
    }
    const payload = buildErDiffPayload(modelTables, { orders: 'Orders', legacy: 'legacy' })
    expect(payload).toEqual([
      { name: 'Orders', schema: modelTables.orders.schema },
      { name: 'legacy', schema: null },
    ])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- modelSchema`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 modelSchema.ts**

创建 `src/components/er/modelSchema.ts`：

```ts
import type {
  ErFkSchema,
  ErModelTableInput,
  ErTableDef,
  ErTableSchema,
  ForeignKeyDef,
} from '../../api/types'
import type { ErTable } from './transform'

/** 图上建模的表状态：schema 存在即「模型为准」；deleted=true 为待删除 tombstone */
export interface ModelTableState {
  schema: ErTableSchema | null
  deleted: boolean
}

/** 模型 schema → 画布表结构（主键/单列唯一分类与快照转换同规则） */
export function schemaToErTable(schema: ErTableSchema): ErTable {
  const pkIndex = schema.indexes.find((i) => i.isPrimary)
  const pkCols = new Set(pkIndex?.columns ?? [])
  const singleUniqueCols = new Set(
    schema.indexes
      .filter((i) => i.unique && !i.isPrimary && i.columns.length === 1)
      .flatMap((i) => i.columns),
  )
  return {
    name: schema.name,
    comment: schema.comment,
    singlePrimaryKey: pkIndex && pkIndex.columns.length === 1 ? pkIndex.columns[0] : null,
    indexes: schema.indexes.map((i) => ({
      name: i.name,
      columns: i.columns,
      unique: i.unique,
      primary: i.isPrimary,
      indexType: i.indexType,
    })),
    columns: schema.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      key: pkCols.has(c.name) ? 'pk' : singleUniqueCols.has(c.name) ? 'unique' : 'none',
      default: c.default,
      comment: c.comment,
    })),
  }
}

/** 实时快照表 → 模型 schema（copy-on-edit 的拷贝源）。
 *  fks = 该表在库里的外键（调用方从 snapshot.foreignKeys 按 table 过滤）——
 *  必须带上：丢掉会被 diff 判成「模型删了这些 FK」→ 待 DROP 危险项 + 画布隐藏真实 FK 边 */
export function snapshotTableToSchema(t: ErTableDef, fks: ForeignKeyDef[]): ErTableSchema {
  return {
    name: t.name,
    engine: t.engine,
    collation: t.collation,
    comment: t.comment,
    columns: t.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      default: c.default,
      extra: c.extra,
      comment: c.comment,
      characterSet: c.characterSet,
      collation: c.collation,
    })),
    indexes: t.indexes.map((i) => ({
      name: i.name,
      columns: [...i.columns],
      subParts: [...i.subParts],
      directions: [...i.directions],
      unique: i.unique,
      isPrimary: i.isPrimary,
      indexType: i.indexType,
    })),
    foreignKeys: fks.map((f) => ({
      name: f.name,
      table: f.table,
      columns: [...f.columns],
      refTable: f.refTable,
      refColumns: [...f.refColumns],
      onDelete: f.onDelete,
      onUpdate: f.onUpdate,
    })),
  }
}

/** 两份模型 schema 语义等价：字段级深比较（表名忽略大小写），不依赖 key 顺序 */
export function schemasEqual(a: ErTableSchema, b: ErTableSchema): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false
  if (a.engine !== b.engine || a.collation !== b.collation || a.comment !== b.comment) return false
  if (a.columns.length !== b.columns.length) return false
  for (let i = 0; i < a.columns.length; i++) {
    const x = a.columns[i]
    const y = b.columns[i]
    if (
      x.name !== y.name || x.dataType !== y.dataType || x.nullable !== y.nullable ||
      x.default !== y.default || x.extra !== y.extra || x.comment !== y.comment ||
      x.characterSet !== y.characterSet || x.collation !== y.collation
    ) return false
  }
  if (a.indexes.length !== b.indexes.length) return false
  for (let i = 0; i < a.indexes.length; i++) {
    const x = a.indexes[i]
    const y = b.indexes[i]
    if (
      x.name !== y.name || x.unique !== y.unique || x.isPrimary !== y.isPrimary ||
      x.indexType !== y.indexType ||
      x.columns.length !== y.columns.length ||
      x.columns.some((c, k) => c !== y.columns[k]) ||
      JSON.stringify(x.subParts) !== JSON.stringify(y.subParts) ||
      JSON.stringify(x.directions) !== JSON.stringify(y.directions)
    ) return false
  }
  if (a.foreignKeys.length !== b.foreignKeys.length) return false
  for (let i = 0; i < a.foreignKeys.length; i++) {
    const x = a.foreignKeys[i]
    const y = b.foreignKeys[i]
    if (
      x.name !== y.name || x.table !== y.table || x.refTable !== y.refTable ||
      x.onDelete !== y.onDelete || x.onUpdate !== y.onUpdate ||
      x.columns.length !== y.columns.length ||
      x.columns.some((c, k) => c !== y.columns[k]) ||
      x.refColumns.some((c, k) => c !== y.refColumns[k])
    ) return false
  }
  return true
}

/** 新建表初始 schema：预填 id 主键（可改可删） */
export function newTableSchema(name: string): ErTableSchema {
  return {
    name,
    engine: 'InnoDB',
    collation: null,
    comment: null,
    columns: [
      { name: 'id', dataType: 'bigint unsigned', nullable: false, default: null, extra: 'auto_increment', comment: null, characterSet: null, collation: null },
    ],
    indexes: [
      { name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
    ],
    foreignKeys: [],
  }
}

/** 下一个可用新表名 new_table_N（忽略大小写避开既有表名） */
export function nextNewTableName(existing: string[]): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()))
  let n = 1
  while (taken.has(`new_table_${n}`)) n++
  return `new_table_${n}`
}

/** 表 schema 保存校验：返回错误文案，null = 通过。existingOthers = 其余表名（小写） */
export function validateTableSchema(schema: ErTableSchema, existingOthers: Set<string>): string | null {
  const name = schema.name.trim()
  if (!name) return '表名不能为空'
  if (existingOthers.has(name.toLowerCase())) return `已存在同名表「${name}」`
  if (schema.columns.length === 0) return '至少需要一列'
  const colNames = new Set<string>()
  for (const c of schema.columns) {
    if (!c.name.trim()) return '列名不能为空'
    if (!c.dataType.trim()) return `列「${c.name}」缺少类型`
    if (colNames.has(c.name.trim().toLowerCase())) return `存在重复列名「${c.name}」`
    colNames.add(c.name.trim().toLowerCase())
  }
  const idxNames = new Set<string>()
  let primaryCount = 0
  for (const i of schema.indexes) {
    if (!i.name.trim()) return '索引名不能为空'
    if (i.columns.length === 0) return `索引「${i.name}」至少需要一列`
    if (idxNames.has(i.name.trim().toLowerCase())) return `存在重复索引名「${i.name}」`
    for (const col of i.columns) {
      if (!colNames.has(col.trim().toLowerCase())) return `索引「${i.name}」引用了不存在的列「${col}」`
    }
    if (i.isPrimary) primaryCount++
    idxNames.add(i.name.trim().toLowerCase())
  }
  if (primaryCount > 1) return '只能有一个主键索引'
  const fkNames = new Set<string>()
  for (const fk of schema.foreignKeys) {
    if (!fk.name.trim()) return '外键名不能为空'
    if (!fk.refTable.trim()) return `外键「${fk.name}」缺少引用表`
    if (fkNames.has(fk.name.trim().toLowerCase())) return `存在重复外键名「${fk.name}」`
    if (fk.columns.length === 0 || fk.columns.length !== fk.refColumns.length)
      return `外键「${fk.name}」的列数与引用列数不匹配`
    for (const col of fk.columns) {
      if (!colNames.has(col.trim().toLowerCase())) return `外键「${fk.name}」引用了不存在的列「${col}」`
    }
    fkNames.add(fk.name.trim().toLowerCase())
  }
  return null
}

/** 删除表校验：其他模型表的外键引用该表时阻止（返回文案，null=允许） */
export function validateDeleteTable(
  targetLower: string,
  modelTables: Record<string, ModelTableState>,
): string | null {
  for (const mt of Object.values(modelTables)) {
    if (!mt.schema) continue
    const hit = mt.schema.foreignKeys.find((fk) => fk.refTable.toLowerCase() === targetLower)
    if (hit) return `模型表「${mt.schema.name}」的外键「${hit.name}」引用了该表，请先删除此外键`
  }
  return null
}

/** store 状态 → er_diff payload（serverNames：小写 → 服务器原始大小写表名） */
export function buildErDiffPayload(
  modelTables: Record<string, ModelTableState>,
  serverNames: Record<string, string>,
): ErModelTableInput[] {
  return Object.entries(modelTables).map(([lower, mt]) => ({
    name: serverNames[lower] ?? lower,
    schema: mt.deleted ? null : mt.schema,
  }))
}

/** 拖线建模型外键的输入（画布列行拖拽得到，弹框补齐其余字段） */
export interface ModelFkInput {
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
  name?: string
  onDelete?: string | null
  onUpdate?: string | null
}

/** 拖线输入 → ErFkSchema（表名/列名用图里的服务器原始大小写） */
export function makeModelFk(input: ModelFkInput): ErFkSchema {
  return {
    name: input.name?.trim() || `fk_${input.table.toLowerCase()}_${input.columns[0].toLowerCase()}`,
    table: input.table,
    columns: [...input.columns],
    refTable: input.refTable,
    refColumns: [...input.refColumns],
    onDelete: input.onDelete ?? null,
    onUpdate: input.onUpdate ?? null,
  }
}
```

- [ ] **Step 4: 运行通过**

Run: `pnpm test -- modelSchema`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/er/modelSchema.ts src/components/er/modelSchema.test.ts
git commit -m "feat:ER 建模 schema 纯函数（转换/校验/payload 组装）"
```

---

### Task 10: buildErGraph 融合模型表与 mfk 边

**Files:**
- Modify: `src/components/er/transform.ts`
- Modify: `src/components/er/transform.test.ts`
- Modify: `src/stores/er.ts`、`src/components/er/layout.ts`（如调用点签名需同步——见 Step 3 说明）

**Interfaces:**
- Consumes: Task 9 的 `ModelTableState`/`schemaToErTable`
- Produces:
  - `ErTable` 增 `modelStatus?: 'new' | 'edited' | 'deleted'`
  - `ErGraph` 增 `mfkEdges: ErEdgeInfo[]`；`ErEdgeInfo.kind` 加 `'mfk'`
  - `buildErGraph(snapshot: ErSnapshot, modelTables?: Record<string, ModelTableState>): ErGraph`（第二参可缺省 = 纯浏览态，行为与现在完全一致）

- [ ] **Step 1: 写失败测试**

`transform.test.ts` 追加（文件里已有 snapshot 构造 helper，命名跟随现有测试风格；若不同按现有 helper 改写）：

```ts
describe('buildErGraph 模型表融合', () => {
  const snap: ErSnapshot = {
    tables: [
      {
        name: 'orders', engine: null, collation: null, comment: null,
        columns: [
          { name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null },
          { name: 'uid', dataType: 'bigint', nullable: true, default: null, extra: '', comment: null, ordinal: 2, characterSet: null, collation: null },
        ],
        indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
      },
      {
        name: 'users', engine: null, collation: null, comment: null,
        columns: [{ name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null }],
        indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
      },
    ],
    foreignKeys: [
      { name: 'fk_ou', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: null, onUpdate: null },
    ],
    serverVersion: '8.0.36',
  }

  it('无 modelTables 时行为不变（纯浏览态）', () => {
    const g = buildErGraph(snap)
    expect(Object.keys(g.tables)).toHaveLength(2)
    expect(g.fkEdges).toHaveLength(1)
    expect(g.mfkEdges).toEqual([])
    expect(g.tables.orders.modelStatus).toBeUndefined()
  })

  it('编辑表以文档 schema 渲染并标 edited；tombstone 标 deleted', () => {
    const editedSchema: ErTableSchema = {
      name: 'orders', engine: null, collation: null, comment: '改过',
      columns: [
        { name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, characterSet: null, collation: null },
      ],
      indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
      foreignKeys: [],
    }
    const modelTables: Record<string, ModelTableState> = {
      orders: { schema: editedSchema, deleted: false },
      users: { schema: null, deleted: true },
    }
    const g = buildErGraph(snap, modelTables)
    expect(g.tables.orders.modelStatus).toBe('edited')
    expect(g.tables.orders.comment).toBe('改过')
    expect(g.tables.orders.columns).toHaveLength(1) // 以 schema 为准
    expect(g.tables.users.modelStatus).toBe('deleted')
    expect(g.tables.users.columns).toHaveLength(1)  // 结构仍来自快照
  })

  it('模型表删掉的库 FK 不再出边；新增模型 FK 出 mfk 边；保留的 FK 仍是 fk 边', () => {
    // orders 被 copy-on-edit 且 schema.foreignKeys 为空 → 库里的 fk_ou 应消失（待应用 DROP）
    const dropped = buildErGraph(snap, { orders: { schema: {
      name: 'orders', engine: null, collation: null, comment: null,
      columns: snap.tables[0].columns.map((c) => ({ name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default, extra: c.extra, comment: c.comment, characterSet: c.characterSet, collation: c.collation })),
      indexes: snap.tables[0].indexes.map((i) => ({ name: i.name, columns: [...i.columns], subParts: [...i.subParts], directions: [...i.directions], unique: i.unique, isPrimary: i.isPrimary, indexType: i.indexType })),
      foreignKeys: [],
    }, deleted: false } })
    expect(dropped.fkEdges).toHaveLength(0)

    // schema 保留同名 FK → 仍是 fk 边（真实存在于库）
    const kept = buildErGraph(snap, { orders: { schema: {
      name: 'orders', engine: null, collation: null, comment: null,
      columns: [], indexes: [],
      foreignKeys: [{ name: 'fk_ou', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: null, onUpdate: null }],
    }, deleted: false } })
    expect(kept.fkEdges).toHaveLength(1)

    // 模型新 FK（库没有）→ mfk 边，id 为 mfk:{表}:{约束名}
    const added = buildErGraph(snap, { orders: { schema: {
      name: 'orders', engine: null, collation: null, comment: null,
      columns: [], indexes: [],
      foreignKeys: [{ name: 'fk_new', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: null }],
    }, deleted: false } })
    expect(added.mfkEdges).toHaveLength(1)
    expect(added.mfkEdges[0]).toMatchObject({ id: 'mfk:orders:fk_new', kind: 'mfk', onDelete: 'CASCADE' })
  })

  it('新建表（库没有）来自 schema 并标 new', () => {
    const g = buildErGraph(snap, {
      brand_new: { schema: {
        name: 'brand_new', engine: 'InnoDB', collation: null, comment: null,
        columns: [{ name: 'id', dataType: 'int', nullable: false, default: null, extra: '', comment: null, characterSet: null, collation: null }],
        indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
        foreignKeys: [],
      }, deleted: false },
    })
    expect(g.tables.brand_new.modelStatus).toBe('new')
    expect(g.tables.brand_new.singlePrimaryKey).toBe('id')
  })

  it('tombstone 且库里已不存在的条目被丢弃', () => {
    const g = buildErGraph(snap, { ghost: { schema: null, deleted: true } })
    expect(g.tables.ghost).toBeUndefined()
  })
})
```

测试文件头部 import 补：`import type { ErTableSchema } from '../../api/types'` 与 `import type { ModelTableState } from './modelSchema'`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- transform`
Expected: FAIL（`mfkEdges`/`modelStatus` 不存在、第二参不接受）

- [ ] **Step 3: 实现**

`transform.ts` 修改：

1. `ErColumnDisplay` 不动；`ErTable` 加字段：

```ts
export interface ErTable {
  name: string
  comment: string | null
  columns: ErColumnDisplay[]
  indexes: ErIndexDisplay[]
  singlePrimaryKey: string | null
  /** 图上建模状态：new=库没有；edited=文档 schema 为准；deleted=tombstone */
  modelStatus?: 'new' | 'edited' | 'deleted'
}
```

2. `ErEdgeInfo.kind` 类型改 `'fk' | 'inferred' | 'manual' | 'mfk'`；`ErGraph` 加 `mfkEdges: ErEdgeInfo[]`。

3. `buildErGraph` 签名与逻辑改造（快照循环里按 modelTables 分流；FK 边过滤规则：表有 schema 时，库 FK 仅当 schema.foreignKeys 有同名（小写）时保留；mfk 边 = schema FK 中库里没有同名的）：

```ts
export function buildErGraph(
  snapshot: ErSnapshot,
  modelTables?: Record<string, ModelTableState>,
): ErGraph {
  const models = modelTables ?? {}
  const tables: Record<string, ErTable> = {}
  const keepTable = (t: ErSnapshot['tables'][number], overlay?: ModelTableState): ErTable => {
    const base = toDisplayTable(t)   // 原 buildErGraph 的单表转换逻辑抽出来
    if (overlay?.deleted) base.modelStatus = 'deleted'
    return base
  }
  for (const t of snapshot.tables) {
    const key = t.name.toLowerCase()
    if (tables[key]) throw new Error(/* 原大小写冲突报错保留 */)
    tables[key] = keepTable(t, models[key])
    const overlay = models[key]
    if (overlay?.schema && !overlay.deleted) {
      // 文档 schema 为准：展示结构换成模型形态
      const mt = schemaToErTable(overlay.schema)
      mt.modelStatus = 'edited'
      tables[key] = mt
    }
  }
  // 新建表：只在 modelTables 里、快照没有
  for (const [key, m] of Object.entries(models)) {
    if (tables[key] || !m.schema) continue
    const mt = schemaToErTable(m.schema)
    mt.modelStatus = 'new'
    tables[key] = mt
  }
  // FK 边：表被模型接管时按 schema 决定去留；模型新增 FK → mfk 边
  const fkEdges: ErEdgeInfo[] = []
  const mfkEdges: ErEdgeInfo[] = []
  for (const fk of snapshot.foreignKeys) {
    const tKey = fk.table.toLowerCase()
    const schemaFks = models[tKey]?.schema?.foreignKeys
    const owned = models[tKey]?.schema ? schemaFks : null
    if (owned && !owned.some((f) => f.name.toLowerCase() === fk.name.toLowerCase())) {
      continue // 模型明确删掉了这个 FK，应用前不再展示
    }
    fkEdges.push(toFkEdge(fk))   // 原 map 逻辑抽成小函数
  }
  for (const [key, m] of Object.entries(models)) {
    for (const fk of m.schema?.foreignKeys ?? []) {
      const inDb = snapshot.foreignKeys.some(
        (d) => d.table.toLowerCase() === key && d.name.toLowerCase() === fk.name.toLowerCase(),
      )
      if (inDb) continue
      mfkEdges.push({
        id: `mfk:${fk.table}:${fk.name}`,
        kind: 'mfk',
        fkName: fk.name,
        sourceTable: fk.table,
        sourceColumns: fk.columns,
        targetTable: fk.refTable,
        targetColumns: fk.refColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      })
    }
  }
  return { tables, fkEdges, mfkEdges }
}
```

`toDisplayTable` 即现有循环体里构造 ErTable 的代码原样抽出（不改行为）；`toFkEdge` 即现有 `snapshot.foreignKeys.map(...)` 的回调体原样抽出。

4. 调用点同步：`src/stores/er.ts` 的 `buildErGraph(snapshot)` → `buildErGraph(snapshot, modelTables)`（Task 12 接入真实数据，本任务先传 `undefined` 保持行为）；`src/components/er/` 下其他直接调用 `buildErGraph` 的测试按新签名兼容（第二参可缺省，无需改）。

- [ ] **Step 4: 运行通过**

Run: `pnpm test`
Expected: PASS 全部（含既有 transform/infer/er store 测试无回归）

- [ ] **Step 5: 提交**

```bash
git add src/components/er/transform.ts src/components/er/transform.test.ts src/stores/er.ts
git commit -m "feat:ER 图融合模型表（schema 渲染/状态标记/mfk 边）"
```

---

### Task 11: 模型文档 v2 读写

**Files:**
- Modify: `src/components/er/transform.ts`（`docOverlay`/`buildModelDoc`）
- Modify: `src/components/er/transform.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `ModelTableState`
- Produces:
  - `ErDocOverlay` 增 `modelTables: Record<string, ModelTableState>`
  - `ModelDocInput` 增 `modelTables: Record<string, ModelTableState>`；`buildModelDoc` 写出 `formatVersion: 2`、`tables[].schema/status`
  - `ErDocEdge.kind` 支持 `'mfk'` 条目（via/锚点随边保存）

- [ ] **Step 1: 写失败测试**

`transform.test.ts` 追加：

```ts
describe('模型文档 v2 读写', () => {
  const fkEdge = { id: 'fk:orders:fk_ou', kind: 'fk' as const, source: { table: 'orders', column: 'uid' }, target: { table: 'users', column: 'id' } }
  const schema: ErTableSchema = {
    name: 'brand_new', engine: 'InnoDB', collation: null, comment: null,
    columns: [{ name: 'id', dataType: 'int', nullable: false, default: null, extra: '', comment: null, characterSet: null, collation: null }],
    indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
    foreignKeys: [],
  }

  it('buildModelDoc 写 v2：schema/status 落 tables 条目；mfk 边随 edges 保存', () => {
    const modelTables: Record<string, ModelTableState> = {
      brand_new: { schema, deleted: false },
      legacy: { schema: null, deleted: true },
    }
    const doc = buildModelDoc({
      kind: 'mysql', database: 'db1', connectionName: '本地',
      positions: { brand_new: { x: 10, y: 20 }, legacy: { x: 0, y: 0 } },
      collapsed: {},
      fkEdges: [], inferredEdges: [], manualEdges: [], inferredStatus: {},
      edgeRoutes: {}, edgeAnchors: {}, mfkEdges: [],
      modelTables,
    })
    expect(doc.formatVersion).toBe(2)
    const bn = doc.tables.find((t) => t.name === 'brand_new')!
    expect(bn.schema).toEqual(schema)
    expect(bn.status).toBeUndefined()
    const legacy = doc.tables.find((t) => t.name === 'legacy')!
    expect(legacy.status).toBe('deleted')
    expect(legacy.schema).toBeUndefined()
  })

  it('docOverlay 读 v2：schema/status 恢复为 modelTables', () => {
    const doc: ErModelDoc = {
      formatVersion: 2, kind: 'mysql', database: 'db1',
      origin: { connectionName: '', capturedAt: '' },
      tables: [
        { id: 'brand_new', name: 'brand_new', x: 0, y: 0, collapsed: false, schema },
        { id: 'legacy', name: 'legacy', x: 0, y: 0, collapsed: false, status: 'deleted' },
      ],
      edges: [],
    }
    const o = docOverlay(doc)
    expect(o.modelTables.brand_new).toEqual({ schema, deleted: false })
    expect(o.modelTables.legacy).toEqual({ schema: null, deleted: true })
  })

  it('v1 文档照常叠加（惰性迁移）：无 schema 字段 = 无 modelTables', () => {
    const doc: ErModelDoc = {
      formatVersion: 1, kind: 'mysql', database: 'db1',
      origin: { connectionName: '', capturedAt: '' },
      tables: [{ id: 'users', name: 'users', x: 0, y: 0, collapsed: false }],
      edges: [],
    }
    const o = docOverlay(doc)
    expect(o.modelTables).toEqual({})
    expect(o.positions.users).toEqual({ x: 0, y: 0 })
  })

  it('mfk 边条目随文档保存与恢复 via', () => {
    const doc = buildModelDoc({
      kind: 'mysql', database: 'db1', connectionName: '',
      positions: { orders: { x: 0, y: 0 }, users: { x: 100, y: 0 } },
      collapsed: {},
      fkEdges: [], manualEdges: [], inferredEdges: [], inferredStatus: {},
      edgeRoutes: { 'mfk:orders:fk_new': [{ x: 5, y: 5 }] },
      edgeAnchors: {},
      mfkEdges: [{
        id: 'mfk:orders:fk_new', kind: 'mfk', fkName: 'fk_new',
        sourceTable: 'orders', sourceColumns: ['uid'],
        targetTable: 'users', targetColumns: ['id'],
      }],
      modelTables: {
        orders: { schema: { ...schema, name: 'orders', foreignKeys: [
          { name: 'fk_new', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: null, onUpdate: null },
        ] }, deleted: false },
      },
    })
    const mfkEdge = doc.edges.find((e) => e.kind === 'mfk')
    expect(mfkEdge?.id).toBe('mfk:orders:fk_new')
    expect(mfkEdge?.via).toEqual([{ x: 5, y: 5 }])
    const o = docOverlay(doc)
    expect(o.edgeRoutes['mfk:orders:fk_new']).toEqual([{ x: 5, y: 5 }])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- transform`
Expected: FAIL（`modelTables` 字段不存在等）

- [ ] **Step 3: 实现**

`transform.ts`：

1. `ErDocOverlay` 加 `modelTables: Record<string, ModelTableState>`；`empty` 对象加 `modelTables: {}`。`docOverlay` 的 tables 循环里：

```ts
  const modelTables: Record<string, ModelTableState> = {}
  for (const t of doc.tables) {
    positions[t.name.toLowerCase()] = { x: t.x, y: t.y }
    if (t.collapsed) collapsed[t.name.toLowerCase()] = true
    if (t.status === 'deleted') {
      // tombstone 保留 schema：先编辑后删的表恢复时找回编辑内容
      modelTables[t.name.toLowerCase()] = { schema: t.schema ?? null, deleted: true }
    } else if (t.schema) {
      modelTables[t.name.toLowerCase()] = { schema: t.schema, deleted: false }
    }
  }
```

返回对象补 `modelTables`。`ErModelTableInput` 类型的 `schema?: ErTableSchema` 与 v1 文档（无该字段）天然兼容，无需迁移代码。

2. `ModelDocInput` 加 `modelTables: Record<string, ModelTableState>`；`buildModelDoc` 的 tables 映射改为：

```ts
  const tables = Object.entries(input.positions).map(([lower, p]) => {
    const m = input.modelTables[lower]
    return {
      id: lower,
      name: lower,
      x: Math.round(p.x),
      y: Math.round(p.y),
      collapsed: !!input.collapsed[lower],
      // tombstone 保留 schema（恢复时找回编辑内容）；status 与 schema 独立
      ...(m?.deleted ? { status: 'deleted' as const } : {}),
      ...(m?.schema ? { schema: m.schema } : {}),
    }
  })
```

`formatVersion: 1` 改 `formatVersion: 2`。

3. mfk 边写入：`buildModelDoc` 的 `toDocEdge` 支持第三种 kind——新增：

```ts
  const mfkEdges = input.mfkEdges.map((e) => toDocEdge(e, 'mfk'))
```

`ModelDocInput` 加 `mfkEdges: ErEdgeInfo[]`；返回 `edges: [...fkEdges, ...manualEdges, ...mfkEdges, ...inferred]`。`toDocEdge` 的 kind 参数类型放宽为 `'fk' | 'manual' | 'mfk'`。

4. `src/stores/er.ts` 的 `save()` 与 `ErToolbar.tsx` 的 `doExportDoc` 中 `buildModelDoc({...})` 调用补两个新参数（`modelTables: t.modelTables`、`mfkEdges: t.graph.mfkEdges`；Toolbar 用 `useErStore.getState().tabs[tabKey]` 同理）——本任务先加占位（store 的 `modelTables` 字段 Task 12 才有），因此这两个调用点本任务传 `modelTables: {}`、`mfkEdges: t.graph.mfkEdges ?? []`，Task 12/13 再替换为真实字段。`buildModelDoc` 的输入类型是必填，故本任务就同步改调用点。

- [ ] **Step 4: 运行通过**

Run: `pnpm test`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src/components/er/transform.ts src/components/er/transform.test.ts src/stores/er.ts src/components/er/ErToolbar.tsx
git commit -m "feat:ER 模型文档 v2 读写（schema/tombstone/mfk 边）"
```

---

### Task 12: store 建模状态与编辑动作

**Files:**
- Modify: `src/stores/er.ts`
- Modify: `src/stores/er.test.ts`

**Interfaces:**
- Consumes: Task 9 全部函数、Task 10/11 的 transform 产物
- Produces（组件任务依赖）：
  - `ErTabState` 增：`snapshot: ErSnapshot | null`、`editMode: boolean`、`modelTables: Record<string, ModelTableState>`、`designerTable: string | null`
  - 动作：`setEditMode(tabKey, v)`、`createTable(tabKey): string | null`（新建并把 designerTable 指向它）、`saveTableSchema(tabKey, lower, schema): { ok: boolean; error?: string }`（支持未应用新表改名 rekey）、`deleteTable(tabKey, lower)`、`restoreTable(tabKey, lower)`、`addModelFk(tabKey, input: ModelFkInput): { ok: boolean; error?: string }`（子表 copy-on-edit）、`removeModelFk(tabKey, tableLower, fkName)`、`setDesignerTable(tabKey, lower | null)`

- [ ] **Step 1: 写失败测试**

`er.test.ts` 追加（沿用文件既有的 `mockApi`/`snapWith` helper；`api` mock 需补 `erDiff`/`applySync`/`previewTableDdl` 三个空函数供后续任务，本任务先补上避免 undefined 调用）：

```ts
describe('ER store：图上建模', () => {
  it('createTable 建新表（默认名避开既有表）并打开设计器、置脏', () => {
    mockApi(snapWith(true), null)
    return useErStore.getState().load(KEY_A, 'c1', 'db1', '本地').then(() => {
      const lower = useErStore.getState().createTable(KEY_A)
      expect(lower).toBe('new_table_1')
      const t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.new_table_1.schema?.columns[0].name).toBe('id')
      expect(t.modelTables.new_table_1.deleted).toBe(false)
      expect(t.dirty).toBe(true)
      expect(t.designerTable).toBe('new_table_1')
      expect(t.graph.tables.new_table_1.modelStatus).toBe('new')
    })
  })

  it('saveTableSchema：copy-on-edit 同步表落 schema；与库一致时不落（无假角标）', () => {
    mockApi(snapWith(true), null)
    return useErStore.getState().load(KEY_A, 'c1', 'db1', '本地').then(() => {
      const store = useErStore.getState()
      // users 表原样保存 → 不产生 modelTables 条目
      const src = store.tabs[KEY_A]!.snapshot!.tables.find((x) => x.name === 'users')!
      const same = snapshotTableToSchema(src, [])
      const r = store.saveTableSchema(KEY_A, 'users', same)
      expect(r.ok).toBe(true)
      expect(useErStore.getState().tabs[KEY_A]!.modelTables.users).toBeUndefined()
      // 加一列再存 → 落 schema 且 graph 立即以模型为准
      const changed = { ...same, columns: [...same.columns, { name: 'memo', dataType: 'varchar(50)', nullable: true, default: null, extra: '', comment: null, characterSet: null, collation: null }] }
      useErStore.getState().saveTableSchema(KEY_A, 'users', changed)
      const t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.users?.schema).toEqual(changed)
      expect(t.graph.tables.users.modelStatus).toBe('edited')
      expect(t.graph.tables.users.columns.some((c) => c.name === 'memo')).toBe(true)
    })
  })

  it('saveTableSchema 校验失败返回错误不落库；未应用新表改名 rekey', () => {
    mockApi(snapWith(true), null)
    return useErStore.getState().load(KEY_A, 'c1', 'db1', '本地').then(async () => {
      const store = useErStore.getState()
      store.createTable(KEY_A)
      // 空列
      let r = store.saveTableSchema(KEY_A, 'new_table_1', { ...newTableSchema('new_table_1'), columns: [] })
      expect(r.ok).toBe(false)
      // 与库表重名
      const renamed = { ...newTableSchema('users') }
      r = useErStore.getState().saveTableSchema(KEY_A, 'new_table_1', renamed)
      expect(r.ok).toBe(false)
      // 改名成功：条目/位置/折叠迁移到新键
      r = useErStore.getState().saveTableSchema(KEY_A, 'new_table_1', newTableSchema('orders_v2'))
      expect(r.ok).toBe(true)
      const t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.new_table_1).toBeUndefined()
      expect(t.modelTables.orders_v2?.schema?.name).toBe('orders_v2')
      expect(t.positions.orders_v2).toBeDefined()
      expect(t.positions.new_table_1).toBeUndefined()
      expect(t.designerTable).toBe('orders_v2')
    })
  })

  it('deleteTable/restoreTable：同步表转 tombstone（保留编辑），新建表直接移除；被引用阻止', () => {
    mockApi(snapWith(true), null)
    return useErStore.getState().load(KEY_A, 'c1', 'db1', '本地').then(() => {
      const store = useErStore.getState()
      // 先给 user_roles 建一个引用 users 的模型 FK → 删 users 应被阻止
      const r = store.addModelFk(KEY_A, { table: 'user_roles', columns: ['usersID'], refTable: 'users', refColumns: ['usersID'] })
      expect(r.ok).toBe(true)
      expect(store.deleteTable(KEY_A, 'users').ok).toBe(false) // 被阻止
      let t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.users).toBeUndefined()
      expect(t.graph.tables.users.modelStatus).not.toBe('deleted')
      // 删引用方 user_roles（已编辑）→ tombstone 且保留 schema
      useErStore.getState().deleteTable(KEY_A, 'user_roles')
      t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.user_roles?.deleted).toBe(true)
      expect(t.modelTables.user_roles?.schema?.foreignKeys.length).toBeGreaterThan(0)
      expect(t.graph.tables.user_roles.modelStatus).toBe('deleted')
      // 恢复：有编辑内容 → 恢复为已编辑态（编辑不丢）
      useErStore.getState().restoreTable(KEY_A, 'user_roles')
      t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.user_roles).toMatchObject({ deleted: false })
      expect(t.modelTables.user_roles?.schema).toBeDefined()
      expect(t.graph.tables.user_roles.modelStatus).toBe('edited')
      // 未编辑过的表：tombstone → 恢复 = 回到无痕
      useErStore.getState().deleteTable(KEY_A, 'orders')
      expect(useErStore.getState().tabs[KEY_A]!.modelTables.orders).toEqual({ schema: null, deleted: true })
      useErStore.getState().restoreTable(KEY_A, 'orders')
      expect(useErStore.getState().tabs[KEY_A]!.modelTables.orders).toBeUndefined()
      // 新建表删除 → 直接消失
      useErStore.getState().createTable(KEY_A)
      useErStore.getState().deleteTable(KEY_A, 'new_table_1')
      t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.new_table_1).toBeUndefined()
      expect(t.graph.tables.new_table_1).toBeUndefined()
    })
  })

  it('addModelFk：子表 copy-on-edit + mfk 边出现；removeModelFk 移除', () => {
    mockApi(snapWith(true), null)
    return useErStore.getState().load(KEY_A, 'c1', 'db1', '本地').then(() => {
      const store = useErStore.getState()
      const r = store.addModelFk(KEY_A, { table: 'user_roles', columns: ['usersID'], refTable: 'users', refColumns: ['usersID'], onDelete: 'CASCADE' })
      expect(r.ok).toBe(true)
      let t = useErStore.getState().tabs[KEY_A]!
      // 子表 copy-on-edit：结构来自快照 + FK 追加
      expect(t.modelTables.user_roles?.schema?.foreignKeys).toHaveLength(1)
      expect(t.modelTables.user_roles?.schema?.foreignKeys[0].onDelete).toBe('CASCADE')
      expect(t.graph.mfkEdges).toHaveLength(1)
      expect(t.graph.mfkEdges[0].id).toBe('mfk:user_roles:fk_user_roles_usersid')
      // 重复外键名拒绝
      const r2 = useErStore.getState().addModelFk(KEY_A, { table: 'user_roles', columns: ['usersID'], refTable: 'users', refColumns: ['usersID'] })
      expect(r2.ok).toBe(false)
      // 删除
      useErStore.getState().removeModelFk(KEY_A, 'user_roles', 'fk_user_roles_usersid')
      t = useErStore.getState().tabs[KEY_A]!
      expect(t.modelTables.user_roles?.schema?.foreignKeys).toHaveLength(0)
      expect(t.graph.mfkEdges).toHaveLength(0)
      // schema 与库一致 → 条目整体清除（无假角标）
      expect(t.modelTables.user_roles).toBeUndefined()
    })
  })
})
```

测试文件 import 补：`import { newTableSchema, snapshotTableToSchema } from '../components/er/modelSchema'`；`mockApi` 里补三个空 mock：

```ts
  ;(api as Record<string, unknown>).erDiff = vi.fn().mockResolvedValue([])
  ;(api as Record<string, unknown>).applySync = vi.fn().mockResolvedValue([])
  ;(api as Record<string, unknown>).previewTableDdl = vi.fn().mockResolvedValue('')
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- er.test`
Expected: FAIL（动作不存在）

- [ ] **Step 3: 实现**

`src/stores/er.ts`：

1. `ErTabState` 加字段（含注释）：

```ts
  /** 逆向快照原样保留（copy-on-edit 的拷贝源 + apply 后刷新） */
  snapshot: ErSnapshot | null
  /** 编辑模式（显式开关；关闭只是隐藏编辑入口） */
  editMode: boolean
  /** 图上建模状态：小写表名 → schema/tombstone */
  modelTables: Record<string, ModelTableState>
  /** 表设计器正在编辑的表（小写；null=关） */
  designerTable: string | null
```

2. `load` 的初始分片补 `snapshot: null, editMode: false, modelTables: {}, designerTable: null`（`editMode`/`search` 同样保留前值：`editMode: prev?.editMode ?? false`）。成功分支里 `commit` 前保存快照并在 `buildErGraph` 传入 modelTables——这部分 Task 13 完整接入，本任务先在成功 commit 里加 `snapshot`，`buildErGraph(snapshot, undefined)` 保持行为。**注意**：本任务所有动作里重建 graph 用统一小助手，避免各动作重复拼装：

```ts
  /** 以当前 modelTables 重建派生图（编辑动作后调用） */
  const rebuildGraph = (tabKey: string) => {
    const t = get().tabs[tabKey]
    if (!t?.snapshot) return
    patchTab(tabKey, { graph: buildErGraph(t.snapshot, t.modelTables) })
  }
```

3. 动作实现（加入 store 返回对象）：

```ts
    setEditMode: (tabKey, v) => patchTab(tabKey, { editMode: v }),
    setDesignerTable: (tabKey, table) => patchTab(tabKey, { designerTable: table }),

    createTable: (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return null
      const name = nextNewTableName([...Object.keys(t.graph.tables), ...Object.keys(t.modelTables)])
      const lower = name.toLowerCase()
      // 位置：现有布局左侧堆叠区起点（与 placeFreshTables 同风格）
      const xs = Object.values(t.positions).map((p) => p.x)
      const minX = xs.length ? Math.min(...xs) : 0
      const ys = Object.values(t.positions).map((p) => p.y)
      const minY = ys.length ? Math.min(...ys) : 0
      const modelTables = { ...t.modelTables, [lower]: { schema: newTableSchema(name), deleted: false } }
      patchTab(tabKey, {
        modelTables,
        positions: { ...t.positions, [lower]: { x: minX - 460, y: minY } },
        designerTable: lower,
        dirty: true,
      })
      rebuildGraph(tabKey)
      return lower
    },

    saveTableSchema: (tabKey, lower, schema) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return { ok: false, error: 'ER 图尚未加载' }
      // 改名只允许未应用的新表（已同步表名在设计器中只读）
      const inDb = t.snapshot.tables.some((s) => s.name.toLowerCase() === lower)
      const newLower = schema.name.trim().toLowerCase()
      if (newLower !== lower && inDb) return { ok: false, error: '已存在于库中的表不能改名' }
      const others = new Set(
        [...Object.keys(t.graph.tables), ...Object.keys(t.modelTables)]
          .filter((n) => n !== lower)
      )
      const err = validateTableSchema(schema, others)
      if (err) return { ok: false, error: err }
      let modelTables = { ...t.modelTables }
      let positions = t.positions
      let collapsed = t.collapsed
      if (newLower !== lower) {
        delete modelTables[lower]
        positions = { ...t.positions }
        collapsed = { ...t.collapsed }
        positions[newLower] = { ...(positions[lower] ?? { x: 0, y: 0 }) }
        delete positions[lower]
        if (collapsed[lower]) {
          collapsed[newLower] = true
          delete collapsed[lower]
        }
      }
      // 与库结构完全一致的同步表 → 不落 schema（不留假「已编辑」角标）。
      // 比较必须含该表的库外键（copy-on-edit 同源），用 schemasEqual 而非 JSON
      const src = t.snapshot.tables.find((s) => s.name.toLowerCase() === newLower)
      const srcFks = src
        ? t.snapshot.foreignKeys.filter((f) => f.table.toLowerCase() === newLower)
        : []
      const sameAsDb = !!src && schemasEqual(schema, snapshotTableToSchema(src, srcFks))
      const wasDeleted = !!modelTables[newLower]?.deleted
      if (sameAsDb && !wasDeleted) {
        delete modelTables[newLower]
      } else {
        // 防御：tombstone 表理论上进不了设计器；万一保存，保持 deleted 标记
        modelTables[newLower] = { schema, deleted: wasDeleted }
      }
      patchTab(tabKey, { modelTables, positions, collapsed, designerTable: newLower, dirty: true })
      rebuildGraph(tabKey)
      return { ok: true }
    },

    deleteTable: (tabKey, lower) => {
      const t = get().tabs[tabKey]
      if (!t?.graph) return
      const blocked = validateDeleteTable(lower, t.modelTables)
      if (blocked) {
        message?.warning(blocked)  // 见下方说明：不引 antd，动作返回值交给调用方提示
        return
      }
      ...
    },
```

**修正**：store 文件不 import antd（现有 store 无 UI 依赖，保持边界）——`deleteTable` 改为返回 `{ ok: boolean; error?: string }`，阻止时 `{ ok: false, error: blocked }`，由调用方（ErCanvas 右键菜单）弹提示。测试相应断言返回值而非 UI。继续：

```ts
    deleteTable: (tabKey, lower) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return { ok: false, error: 'ER 图尚未加载' }
      const blocked = validateDeleteTable(lower, t.modelTables)
      if (blocked) return { ok: false, error: blocked }
      const inDb = t.snapshot.tables.some((s) => s.name.toLowerCase() === lower)
      const modelTables = { ...t.modelTables }
      if (inDb) {
        // tombstone：保留原 schema（先编辑后删的表，恢复时找回编辑内容）
        modelTables[lower] = { schema: t.modelTables[lower]?.schema ?? null, deleted: true }
      } else {
        delete modelTables[lower] // 新建表直接移除
      }
      patchTab(tabKey, { modelTables, dirty: true })
      rebuildGraph(tabKey)
      return { ok: true }
    },

    restoreTable: (tabKey, lower) => {
      const t = get().tabs[tabKey]
      if (!t) return
      const mt = t.modelTables[lower]
      const modelTables = { ...t.modelTables }
      if (mt?.schema) {
        // 有编辑内容：撤销删除、恢复为已编辑态
        modelTables[lower] = { schema: mt.schema, deleted: false }
      } else {
        // 未编辑过：恢复 = 回到「无建模痕迹」
        delete modelTables[lower]
      }
      patchTab(tabKey, { modelTables, dirty: true })
      rebuildGraph(tabKey)
    },

    addModelFk: (tabKey, input) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return { ok: false, error: 'ER 图尚未加载' }
      const childLower = input.table.toLowerCase()
      const existing = t.modelTables[childLower]
      // copy-on-edit：子表未有 schema 时从快照全量拷贝（含该表的库外键）
      const base =
        existing?.schema ??
        (() => {
          const src = t.snapshot!.tables.find((s) => s.name.toLowerCase() === childLower)
          if (!src) return null
          const srcFks = t
            .snapshot!.foreignKeys.filter((f) => f.table.toLowerCase() === childLower)
          return snapshotTableToSchema(src, srcFks)
        })()
      if (!base) return { ok: false, error: '找不到子表结构' }
      const fk = makeModelFk(input)
      if (base.foreignKeys.some((f) => f.name.toLowerCase() === fk.name.toLowerCase()))
        return { ok: false, error: `外键名「${fk.name}」已存在` }
      // 引用列/本表列存在性由 validateTableSchema 统一把关：先组装再校验
      const schema = { ...base, foreignKeys: [...base.foreignKeys, fk] }
      const others = new Set(
        [...Object.keys(t.graph.tables), ...Object.keys(t.modelTables)].filter(
          (n) => n !== childLower,
        ),
      )
      const err = validateTableSchema(schema, others)
      if (err) return { ok: false, error: err }
      patchTab(tabKey, {
        modelTables: { ...t.modelTables, [childLower]: { schema, deleted: false } },
        dirty: true,
      })
      rebuildGraph(tabKey)
      return { ok: true }
    },

    removeModelFk: (tabKey, tableLower, fkName) => {
      const t = get().tabs[tabKey]
      if (!t?.snapshot) return
      const mt = t.modelTables[tableLower]
      if (!mt?.schema) return
      const fks = mt.schema.foreignKeys.filter(
        (f) => f.name.toLowerCase() !== fkName.toLowerCase(),
      )
      const schema = { ...mt.schema, foreignKeys: fks }
      const modelTables = { ...t.modelTables }
      // 删完与库一致 → 条目整体清除
      const src = t.snapshot.tables.find((s) => s.name.toLowerCase() === tableLower)
      const srcFks = src
        ? t.snapshot.foreignKeys.filter((f) => f.table.toLowerCase() === tableLower)
        : []
      const sameAsDb = !!src && schemasEqual(schema, snapshotTableToSchema(src, srcFks))
      if (sameAsDb) delete modelTables[tableLower]
      else modelTables[tableLower] = { schema, deleted: false }
      patchTab(tabKey, { modelTables, dirty: true })
      rebuildGraph(tabKey)
    },
```

store 文件头部 import 补：

```ts
import {
  makeModelFk,
  newTableSchema,
  nextNewTableName,
  schemasEqual,
  snapshotTableToSchema,
  validateDeleteTable,
  validateTableSchema,
  type ModelFkInput,
  type ModelTableState,
} from '../components/er/modelSchema'
```

`ErStore` 接口类型同步补以上动作签名（`deleteTable` 返回 `{ ok: boolean; error?: string }`）。

测试里 `store.deleteTable(KEY_A, 'users')` 相应改为断言返回值：`expect(store.deleteTable(KEY_A, 'users').ok).toBe(false)`。

- [ ] **Step 4: 运行通过**

Run: `pnpm test`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src/stores/er.ts src/stores/er.test.ts
git commit -m "feat:ER store 建模状态与编辑动作（建表/copy-on-edit/tombstone/模型外键）"
```

---

### Task 13: store load 恢复 v2 文档与角标推导

**Files:**
- Modify: `src/stores/er.ts`（`load`/`save`）
- Modify: `src/stores/er.test.ts`

**Interfaces:**
- Consumes: Task 11 的 `docOverlay().modelTables`、Task 12 的状态字段
- Produces: `load` 按 v2 文档恢复 `modelTables`（含 new/edited 角标推导由 buildErGraph 完成）；版本号不受支持时置 `docIssue`；`save` 写真实 `modelTables`/`mfkEdges`

- [ ] **Step 1: 写失败测试**

`er.test.ts` 追加：

```ts
describe('ER store：v2 文档恢复与保存', () => {
  const v2Doc: ErModelDoc = {
    formatVersion: 2,
    kind: 'mysql',
    database: 'db1',
    origin: { connectionName: '本地', capturedAt: '2026-01-01T00:00:00Z' },
    tables: [
      { id: 'users', name: 'users', x: 100, y: 200, collapsed: false },
      { id: 'user_roles', name: 'user_roles', x: 300, y: 200, collapsed: false, schema: {
        name: 'user_roles', engine: null, collation: null, comment: null,
        columns: [
          { name: 'user_rolesID', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, characterSet: null, collation: null },
        ],
        indexes: [{ name: 'PRIMARY', columns: ['user_rolesID'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
        foreignKeys: [{ name: 'fk_x', table: 'user_roles', columns: ['user_rolesID'], refTable: 'users', refColumns: ['usersID'], onDelete: null, onUpdate: null }],
      } },
      { id: 'legacy', name: 'legacy', x: 500, y: 200, collapsed: false, status: 'deleted' },
    ],
    edges: [],
  }

  it('v2 文档：schema 表标 edited、tombstone 标 deleted、mfk 边恢复', async () => {
    mockApi(snapWith(true), v2Doc)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]!
    expect(t.graph.tables.user_roles.modelStatus).toBe('edited')
    expect(t.graph.tables.legacy.modelStatus).toBe('deleted')
    expect(t.graph.mfkEdges.map((e) => e.id)).toEqual(['mfk:user_roles:fk_x'])
    expect(t.docIssue).toBeNull()
  })

  it('不受支持的版本号 → docIssue 提示、按无文档处理', async () => {
    mockApi(snapWith(true), { ...v2Doc, formatVersion: 99 as 1 | 2 })
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]!
    expect(t.docIssue).toContain('99')
    expect(t.modelTables).toEqual({})
  })

  it('v1 文档照常加载（惰性迁移），保存后升为 v2', async () => {
    mockApi(snapWith(true), savedDoc)  // 文件里已有的 v1 文档 fixture
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    await useErStore.getState().save(KEY_A)
    const doc = (api.saveErModel as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2] as ErModelDoc
    expect(doc.formatVersion).toBe(2)
    expect(doc.tables.every((t) => t.schema === undefined && t.status === undefined)).toBe(true)
  })

  it('孤儿条目清洗：tombstone/新表在快照与模型外无意义时丢弃；快照保留', async () => {
    mockApi(snapWith(true), v2Doc)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]!
    expect(t.snapshot).not.toBeNull()
    // legacy 不在库里但文档标记 deleted：仍是有效 tombstone（要 DROP），保留
    expect(t.modelTables.legacy).toEqual({ schema: null, deleted: true })
  })
})
```

注意 `snapWith` 的快照里没有 `legacy` 表，`legacy` tombstone 指向不存在的库表——保留（应用时 er_diff 产不出 DROP 项，刷新后由 refreshAfterApply 清理）；只有「既不在快照、也无 schema、又非 tombstone」的条目才无意义，`docOverlay` 天然不会产出。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- er.test`
Expected: FAIL

- [ ] **Step 3: 实现**

`load` 成功分支修改：

```ts
        const doc = ...  // 现有读取 + try/catch
        // 版本号校验：只认 1/2；其他版本不按无文档静默处理，要显式提示
        let overlayInput = doc
        if (doc && doc.formatVersion !== 1 && doc.formatVersion !== 2) {
          docIssue = `文档版本 ${doc.formatVersion} 不受支持`
          overlayInput = null
        }
        const overlay = docOverlay(overlayInput)
        const modelTables = overlay.modelTables
        const graph = buildErGraph(snapshot, modelTables)
```

（`docIssue` 变量在现有代码已有，赋值点从 catch 扩展到版本检查。）`commit` 里补 `snapshot`。`save` 里 `buildModelDoc` 的 `modelTables: t.modelTables`、`mfkEdges: t.graph.mfkEdges`（替换 Task 11 的占位 `{}`）。`ErToolbar.tsx` 的 `doExportDoc` 同样把 `modelTables: {}` 占位换成真实值（从 `useErStore.getState().tabs[tabKey]` 取）。

- [ ] **Step 4: 运行通过**

Run: `pnpm test`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src/stores/er.ts src/stores/er.test.ts src/components/er/ErToolbar.tsx
git commit -m "feat:ER store 恢复 v2 模型文档（schema/tombstone/mfk 与版本校验）"
```

---

### Task 14: store 应用闭环（runErDiff / refreshAfterApply）

**Files:**
- Modify: `src/stores/er.ts`
- Modify: `src/stores/er.test.ts`

**Interfaces:**
- Consumes: `api.erDiff`/`api.applySync`/`api.getErSnapshot`；Task 9 的 `buildErDiffPayload`
- Produces:
  - `runErDiff(tabKey): Promise<DiffItem[]>`——当前模型 vs 库的差异（无建模表时返回 `[]`）
  - `refreshAfterApply(tabKey): Promise<DiffItem[]>`——刷新快照、按剩余差异自清理 modelTables、mfk→fk 走线迁移、自动保存文档、返回剩余差异
  - 清理规则：表在剩余差异中出现 → 保留条目；不在 → 删除条目（含 tombstone）；`edgeRoutes`/`edgeAnchors` 键 `mfk:{t}:{n}` → `fk:{t}:{n}` 迁移（同名时）

- [ ] **Step 1: 写失败测试**

`er.test.ts` 追加：

```ts
import type { DiffItem } from '../api/types'

function diffItem(over: Partial<DiffItem>): DiffItem {
  return {
    id: 'tbl:x', kind: 'table', action: 'create', table: 'x', name: 'x',
    sourceDesc: null, targetDesc: null, sql: 'CREATE ...', sqlClause: null,
    dangerous: false, sourceDdl: null, targetDdl: null,
    ...over,
  }
}

describe('ER store：应用闭环', () => {
  it('runErDiff 组装 payload 并返回差异；无建模表返回空', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    // 无建模表
    let items = await useErStore.getState().runErDiff(KEY_A)
    expect(items).toEqual([])
    expect(api.erDiff).not.toHaveBeenCalled()
    // 建表后：payload 只含新表，表名用服务器大小写
    useErStore.getState().createTable(KEY_A)
    ;(api.erDiff as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      diffItem({ id: 'tbl:new_table_1', table: 'new_table_1' }),
    ])
    items = await useErStore.getState().runErDiff(KEY_A)
    expect((api.erDiff as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toEqual([
      { name: 'new_table_1', schema: expect.objectContaining({ name: 'new_table_1' }) },
    ])
    expect(items).toHaveLength(1)
  })

  it('refreshAfterApply：零差异表清条目；仍有差异的保留；tombstone 移除；走线迁移；自动保存', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const store = useErStore.getState()
    store.createTable(KEY_A)                       // new_table_1 → 应 CREATE（应用成功 → 清除）
    store.addModelFk(KEY_A, { table: 'user_roles', columns: ['usersID'], refTable: 'users', refColumns: ['usersID'] })
    // 手拖走线挂在 mfk 边上
    useErStore.getState().setEdgeRoute(KEY_A, 'mfk:user_roles:fk_user_roles_usersid', [{ x: 9, y: 9 }])
    // 库快照刷新后与模型一致（模拟已应用）
    ;(api.getErSnapshot as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(snapWith(true))  // refresh 拉的新快照
    ;(api.erDiff as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])              // 复跑：全部零差异

    const remain = await useErStore.getState().refreshAfterApply(KEY_A)
    expect(remain).toEqual([])
    const t = useErStore.getState().tabs[KEY_A]!
    expect(t.modelTables).toEqual({})                  // 零差异全部清除
    expect(t.graph.tables.new_table_1).toBeUndefined() // 新表已不在快照 → 消失
    expect(t.dirty).toBe(false)                        // 已自动保存
    expect(t.edgeRoutes['fk:user_roles:fk_user_roles_usersid']).toEqual([{ x: 9, y: 9 }])
    expect(t.edgeRoutes['mfk:user_roles:fk_user_roles_usersid']).toBeUndefined()
  })

  it('refreshAfterApply：仍有差异的表保留条目（部分应用/失败场景）', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    useErStore.getState().createTable(KEY_A)
    ;(api.getErSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(snapWith(true))
    ;(api.erDiff as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      diffItem({ id: 'tbl:new_table_1', table: 'new_table_1' }),  // 未应用（用户没勾）
    ])
    const remain = await useErStore.getState().refreshAfterApply(KEY_A)
    expect(remain).toHaveLength(1)
    const t = useErStore.getState().tabs[KEY_A]!
    expect(t.modelTables.new_table_1).toBeDefined()  // 保留
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- er.test`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/stores/er.ts` 追加两个动作（`ErStore` 接口同步）：

```ts
    /** 应用变更第一步：模型 vs 库实时结构 diff */
    runErDiff: async (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t?.graph) throw new Error('ER 图尚未加载')
      const serverNames = Object.fromEntries(
        Object.entries(t.graph.tables).map(([k, v]) => [k, v.name]),
      )
      const payload = buildErDiffPayload(t.modelTables, serverNames)
      if (payload.length === 0) return []
      return withSessionReconnect(t.connectionId, () =>
        api.erDiff(t.connectionId, t.database, payload),
      )
    },

    /** 应用后刷新：拉新快照重建图 → 复跑 diff → 零差异表清条目（角标消失），
     *  mfk 走线迁移到 fk 边 id → 自动保存文档。返回剩余差异（弹窗「重新比较」用） */
    refreshAfterApply: async (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t) return []
      const seq = t.requestSeq
      const snapshot = await withSessionReconnect(t.connectionId, () =>
        api.getErSnapshot(t.connectionId, t.database),
      )
      // 图以「新快照 + 现有 modelTables」重建（布局/折叠/走线等全部保留）
      const graph = buildErGraph(snapshot, t.modelTables)
      const inferredEdges = inferEdges(graph)
      commit(tabKey, seq, { snapshot, graph, inferredEdges })

      // 复跑 diff 决定清理范围
      const cur = get().tabs[tabKey]
      if (!cur) return []
      const serverNames = Object.fromEntries(
        Object.entries(cur.graph.tables).map(([k, v]) => [k, v.name]),
      )
      const payload = buildErDiffPayload(cur.modelTables, serverNames)
      let remain: DiffItem[] = []
      if (payload.length > 0) {
        remain = await withSessionReconnect(cur.connectionId, () =>
          api.erDiff(cur.connectionId, cur.database, payload),
        )
      }
      // 有差异项的表保留条目；零差异/tombstone 已消失的清除
      const tablesWithDiff = new Set(remain.map((i) => i.table.toLowerCase()))
      const modelTables: typeof cur.modelTables = {}
      for (const [lower, mt] of Object.entries(cur.modelTables)) {
        if (tablesWithDiff.has(lower)) modelTables[lower] = mt
      }
      // 库里已不存在的 tombstone（DROP 已执行）也不会出现在 remain → 自动清除；
      // 但新建表可能已存在库里（CREATE 执行过）而 remain 为空 → 同样清除
      // mfk → fk 走线/锚点迁移：仅迁移「复跑差异里已无对应 FK 项」的边
      // （该 FK 已应用/收敛，真实 FK 边即将出现）；未应用的 FK 边保留 mfk 键，
      // 否则用户没勾选的模型外键走线会丢
      const pendingFkIds = new Set(
        remain.filter((i) => i.kind === 'foreignKey').map((i) => i.id.toLowerCase()),
      )
      const edgeRoutes = { ...cur.edgeRoutes }
      const edgeAnchors = { ...cur.edgeAnchors }
      for (const key of Object.keys(edgeRoutes)) {
        const m = key.match(/^mfk:(.+):(.+)$/)
        if (!m) continue
        const fkKey = `fk:${m[1]}:${m[2]}`
        if (pendingFkIds.has(fkKey.toLowerCase())) continue
        if (!(fkKey in edgeRoutes)) edgeRoutes[fkKey] = edgeRoutes[key]
        delete edgeRoutes[key]
      }
      for (const key of Object.keys(edgeAnchors)) {
        const m = key.match(/^mfk:(.+):(.+)$/)
        if (!m) continue
        const fkKey = `fk:${m[1]}:${m[2]}`
        if (pendingFkIds.has(fkKey.toLowerCase())) continue
        if (!(fkKey in edgeAnchors)) edgeAnchors[fkKey] = edgeAnchors[key]
        delete edgeAnchors[key]
      }
      const graph2 = buildErGraph(snapshot, modelTables)
      commit(tabKey, seq, {
        modelTables,
        graph: graph2,
        inferredEdges: inferEdges(graph2),
        edgeRoutes,
        edgeAnchors,
        dirty: true,
      })
      await get().save(tabKey) // 应用成功后的文档变化直接落盘，不留给用户手动保存
      return remain
    },
```

`import type { DiffItem } from '../api/types'` 补进 store 头部；`withSessionReconnect` 已有。再补一个未应用不迁移的测试：

```ts
  it('refreshAfterApply：未应用的模型外键走线不迁移（mfk 键保留）', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    useErStore.getState().addModelFk(KEY_A, { table: 'user_roles', columns: ['usersID'], refTable: 'users', refColumns: ['usersID'] })
    useErStore.getState().setEdgeRoute(KEY_A, 'mfk:user_roles:fk_user_roles_usersid', [{ x: 3, y: 3 }])
    ;(api.getErSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(snapWith(true))
    ;(api.erDiff as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      diffItem({ id: 'fk:user_roles:fk_user_roles_usersid', kind: 'foreignKey', action: 'modify', table: 'user_roles', name: 'fk_user_roles_usersid' }),  // 用户没勾，未应用
    ])
    await useErStore.getState().refreshAfterApply(KEY_A)
    const t = useErStore.getState().tabs[KEY_A]!
    expect(t.edgeRoutes['mfk:user_roles:fk_user_roles_usersid']).toEqual([{ x: 3, y: 3 }])
    expect(t.edgeRoutes['fk:user_roles:fk_user_roles_usersid']).toBeUndefined()
  })
```

- [ ] **Step 4: 运行通过**

Run: `pnpm test`
Expected: PASS 全部

- [ ] **Step 5: 提交**

```bash
git add src/stores/er.ts src/stores/er.test.ts
git commit -m "feat:ER 应用闭环 store（diff/刷新自清理/走线迁移/自动保存）"
```

---

### Task 15: 表设计器 Modal（ErTableDesigner）

**Files:**
- Create: `src/components/er/ErTableDesigner.tsx`

UI 组件，无组件测试（校验/转换逻辑已在 Task 9/12 覆盖）；验证方式 = `pnpm test` 无回归 + `pnpm build` 类型通过 + Task 18 手工验收。

**Interfaces:**
- Consumes: `useErTab`（`designerTable`/`graph`/`snapshot`/`modelTables`）、store 动作 `saveTableSchema`/`setDesignerTable`、`api.previewTableDdl`
- Produces: `<ErTableDesigner />`（挂载在 ErView，Task 17 接线；designerTable 非空即打开）

- [ ] **Step 1: 实现组件**

创建 `src/components/er/ErTableDesigner.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Tabs, Table, message } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'

import { api } from '../../api/commands'
import { errText } from '../connection/ConnectionTree'
import { useErStore } from '../../stores/er'
import { useErTab, useErTabKey } from './erTabContext'
import { snapshotTableToSchema } from './modelSchema'
import { SqlView } from '../compare/SqlView'
import type { ErColumnSchema, ErFkSchema, ErIndexSchema, ErTableSchema } from '../../api/types'

/** 单行草稿的唯一键（antd Table rowKey + 增删行稳定） */
let uidSeq = 0
const nextUid = () => `u${++uidSeq}`

interface ColDraft {
  uid: string
  name: string
  dataType: string
  nullable: boolean
  default: string
  autoInc: boolean
  comment: string
  extraRest: string // 除 auto_increment 外的 extra 原样保留（如 on update current_timestamp）
  /** 列级字符集/排序规则：设计器不提供编辑 UI，但必须透传——
   *  剥成 null 会让 copy-on-edit 后的「不改就存」出假「改」角标、
   *  每个字符串列在 diff 里出假 MODIFY */
  characterSet: string | null
  collation: string | null
}
interface IdxDraft {
  uid: string
  name: string
  columns: string[]
  unique: boolean
  indexType: string
  isPrimary: boolean
  subParts: (number | null)[]
  directions: (string | null)[]
}
interface FkDraft {
  uid: string
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: string | null
  onUpdate: string | null
}

const TYPE_SUGGESTIONS = [
  'int', 'int unsigned', 'bigint', 'bigint unsigned', 'tinyint', 'smallint',
  'varchar(64)', 'varchar(255)', 'text', 'longtext',
  'decimal(10,2)', 'double', 'date', 'datetime', 'timestamp', 'json',
]

function colToDraft(c: ErColumnSchema): ColDraft {
  const hasAi = c.extra.toLowerCase().includes('auto_increment')
  return {
    uid: nextUid(),
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    default: c.default ?? '',
    autoInc: hasAi,
    comment: c.comment ?? '',
    extraRest: c.extra.split(/\s+/).filter((t) => t.toLowerCase() !== 'auto_increment').join(' '),
    characterSet: c.characterSet,
    collation: c.collation,
  }
}
function draftToCol(c: ColDraft): ErColumnSchema {
  const extra = [c.extraRest.trim(), c.autoInc ? 'auto_increment' : ''].filter(Boolean).join(' ')
  return {
    name: c.name.trim(),
    dataType: c.dataType.trim(),
    nullable: c.nullable,
    default: c.default === '' ? null : c.default,
    extra,
    comment: c.comment === '' ? null : c.comment,
    characterSet: c.characterSet,
    collation: c.collation,
  }
}
function idxToDraft(i: ErIndexSchema): IdxDraft {
  return { uid: nextUid(), name: i.name, columns: [...i.columns], unique: i.unique, indexType: i.indexType ?? 'BTREE', isPrimary: i.isPrimary, subParts: [...i.subParts], directions: [...i.directions] }
}
function draftToIdx(i: IdxDraft): ErIndexSchema {
  return { name: i.name.trim(), columns: i.columns, unique: i.isPrimary || i.unique, isPrimary: i.isPrimary, indexType: i.indexType, subParts: i.columns.map((_, k) => i.subParts[k] ?? null), directions: i.columns.map((_, k) => i.directions[k] ?? null) }
}
function fkToDraft(f: ErFkSchema): FkDraft {
  return { uid: nextUid(), name: f.name, columns: [...f.columns], refTable: f.refTable, refColumns: [...f.refColumns], onDelete: f.onDelete, onUpdate: f.onUpdate }
}
function draftToFk(f: FkDraft, tableName: string): ErFkSchema {
  return { name: f.name.trim(), table: tableName, columns: f.columns, refTable: f.refTable, refColumns: f.refColumns, onDelete: f.onDelete, onUpdate: f.onUpdate }
}

const FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION']

/** 表设计器：列/索引/外键/表选项四个 Tab + 底部实时 DDL 预览。
 *  打开已同步表 = copy-on-edit（保存时与库一致则不落 schema） */
export function ErTableDesigner() {
  const tabKey = useErTabKey()
  const designerTable = useErTab((t) => t.designerTable)
  const graph = useErTab((t) => t.graph)
  const snapshot = useErTab((t) => t.snapshot)
  const modelTables = useErTab((t) => t.modelTables)
  const database = useErTab((t) => t.database)

  const lower = designerTable ?? null
  // 草稿初始化：模型 schema 优先，否则从快照 copy-on-edit，再否则（新表）空模板在 Task 12 已建
  const [draft, setDraft] = useState<{
    name: string
    comment: string
    engine: string
    collation: string
    cols: ColDraft[]
    idxs: IdxDraft[]
    fks: FkDraft[]
  } | null>(null)
  const [ddl, setDdl] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!lower || !graph || !snapshot) {
      setDraft(null)
      return
    }
    const src =
      modelTables[lower]?.schema ??
      (() => {
        const t = snapshot.tables.find((s) => s.name.toLowerCase() === lower)
        if (!t) return null
        const fks = snapshot.foreignKeys.filter((f) => f.table.toLowerCase() === lower)
        return snapshotTableToSchema(t, fks)
      })()
    if (!src) {
      setDraft(null)
      return
    }
    setDraft({
      name: src.name,
      comment: src.comment ?? '',
      engine: src.engine ?? '',
      collation: src.collation ?? '',
      cols: src.columns.map(colToDraft),
      idxs: src.indexes.map(idxToDraft),
      fks: src.foreignKeys.map(fkToDraft),
    })
  }, [lower]) // 打开/切换表时重建草稿；graph/snapshot 只读一次

  const toSchema = useMemo(
    () =>
      draft
        ? {
            name: draft.name.trim(),
            engine: draft.engine === '' ? null : draft.engine,
            collation: draft.collation === '' ? null : draft.collation,
            comment: draft.comment === '' ? null : draft.comment,
            columns: draft.cols.map(draftToCol),
            indexes: draft.idxs.map(draftToIdx),
            foreignKeys: draft.fks.map((f) => draftToFk(f, draft.name.trim())),
          }
        : null,
    [draft],
  )

  // 实时 DDL 预览（防抖 300ms）
  useEffect(() => {
    if (!toSchema || !database || !draft) return
    const h = setTimeout(() => {
      api.previewTableDdl(database, toSchema).then(setDdl).catch(() => setDdl(''))
    }, 300)
    return () => clearTimeout(h)
  }, [toSchema, database, draft])

  if (!lower || !draft || !graph) return null
  const modelStatus = graph.tables[lower]?.modelStatus
  const inDb = !!snapshot?.tables.some((s) => s.name.toLowerCase() === lower)
  const close = () => useErStore.getState().setDesignerTable(tabKey, null)

  const colNameOptions = draft.cols.map((c) => ({ value: c.name, label: c.name }))
  const tableOptions = Object.values(graph.tables).map((t) => ({ value: t.name, label: t.name }))
  const refColOptions = (tableName: string) =>
    (graph.tables[tableName.toLowerCase()]?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name} ${c.dataType}` }))

  const save = async () => {
    if (!toSchema) return
    setSaving(true)
    try {
      const r = useErStore.getState().saveTableSchema(tabKey, lower, toSchema as ErTableSchema)
      if (!r.ok) message.warning(r.error ?? '保存失败')
      else {
        message.success('已保存到模型（未应用至库）')
        close()
      }
    } finally {
      setSaving(false)
    }
  }

  const moveCol = (i: number, dir: -1 | 1) => {
    setDraft((d) => {
      if (!d) return d
      const j = i + dir
      if (j < 0 || j >= d.cols.length) return d
      const cols = [...d.cols]
      ;[cols[i], cols[j]] = [cols[j], cols[i]]
      return { ...d, cols }
    })
  }

  const colTab = (
    <div>
      <Table<ColDraft>
        size="small"
        rowKey="uid"
        dataSource={draft.cols}
        pagination={false}
        components={{ body: { row: () => null } }} /* 占位：行渲染在 columns? 不——见下 */
      />
    </div>
  )
  void colTab

  // 列编辑用受控小表格（antd Table 行内编辑繁琐，直接用轻量行渲染保持简单可控）
  const colRows = draft.cols.map((c, i) => (
    <div className="erd-row" key={c.uid}>
      <Input size="small" style={{ width: 140 }} placeholder="列名" value={c.name}
        onChange={(e) => setDraft((d) => d && ({ ...d, cols: d.cols.map((x) => (x.uid === c.uid ? { ...x, name: e.target.value } : x)) }))} />
      <Input size="small" style={{ width: 150 }} list="erd-type-suggest" placeholder="类型"
        value={c.dataType}
        onChange={(e) => setDraft((d) => d && ({ ...d, cols: d.cols.map((x) => (x.uid === c.uid ? { ...x, dataType: e.target.value } : x)) }))} />
      <datalist id="erd-type-suggest">
        {TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
      </datalist>
      <Checkbox size="small" checked={c.nullable}
        onChange={(e) => setDraft((d) => d && ({ ...d, cols: d.cols.map((x) => (x.uid === c.uid ? { ...x, nullable: e.target.checked } : x)) }))}>
        NULL
      </Checkbox>
      <Input size="small" style={{ width: 110 }} placeholder="默认值" value={c.default}
        onChange={(e) => setDraft((d) => d && ({ ...d, cols: d.cols.map((x) => (x.uid === c.uid ? { ...x, default: e.target.value } : x)) }))} />
      <Checkbox size="small" checked={c.autoInc}
        onChange={(e) => setDraft((d) => d && ({ ...d, cols: d.cols.map((x) => (x.uid === c.uid ? { ...x, autoInc: e.target.checked } : x)) }))}>
        自增
      </Checkbox>
      <Input size="small" style={{ flex: 1 }} placeholder="注释" value={c.comment}
        onChange={(e) => setDraft((d) => d && ({ ...d, cols: d.cols.map((x) => (x.uid === c.uid ? { ...x, comment: e.target.value } : x)) }))} />
      <Space size={2}>
        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => moveCol(i, -1)} />
        <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === draft.cols.length - 1} onClick={() => moveCol(i, 1)} />
        <Button size="small" type="text" danger icon={<DeleteOutlined />}
          onClick={() => setDraft((d) => d && ({ ...d, cols: d.cols.filter((x) => x.uid !== c.uid) }))} />
      </Space>
    </div>
  ))

  const idxRows = draft.idxs.map((ix) => (
    <div className="erd-row" key={ix.uid}>
      <Input size="small" style={{ width: 150 }} placeholder="索引名" value={ix.name} disabled={ix.isPrimary}
        onChange={(e) => setDraft((d) => d && ({ ...d, idxs: d.idxs.map((x) => (x.uid === ix.uid ? { ...x, name: e.target.value } : x)) }))} />
      <Select mode="multiple" size="small" style={{ flex: 1 }} placeholder="列" value={ix.columns} options={colNameOptions}
        onChange={(v) => setDraft((d) => d && ({ ...d, idxs: d.idxs.map((x) => (x.uid === ix.uid ? { ...x, columns: v, subParts: [], directions: [] } : x)) }))} />
      {ix.isPrimary ? (
        <span className="erd-tag">PRIMARY</span>
      ) : (
        <>
          <Checkbox size="small" checked={ix.unique}
            onChange={(e) => setDraft((d) => d && ({ ...d, idxs: d.idxs.map((x) => (x.uid === ix.uid ? { ...x, unique: e.target.checked } : x)) }))}>
            唯一
          </Checkbox>
          <Select size="small" style={{ width: 100 }} value={ix.indexType}
            options={['BTREE', 'HASH', 'FULLTEXT'].map((t) => ({ value: t, label: t }))}
            onChange={(v) => setDraft((d) => d && ({ ...d, idxs: d.idxs.map((x) => (x.uid === ix.uid ? { ...x, indexType: v } : x)) }))} />
          <Button size="small" type="text" danger icon={<DeleteOutlined />}
            onClick={() => setDraft((d) => d && ({ ...d, idxs: d.idxs.filter((x) => x.uid !== ix.uid) }))} />
        </>
      )}
    </div>
  ))

  const fkRows = draft.fks.map((f) => (
    <div className="erd-row" key={f.uid}>
      <Input size="small" style={{ width: 150 }} placeholder="外键名" value={f.name}
        onChange={(e) => setDraft((d) => d && ({ ...d, fks: d.fks.map((x) => (x.uid === f.uid ? { ...x, name: e.target.value } : x)) }))} />
      <Select mode="multiple" size="small" style={{ flex: 1 }} placeholder="本表列" value={f.columns} options={colNameOptions}
        onChange={(v) => setDraft((d) => d && ({ ...d, fks: d.fks.map((x) => (x.uid === f.uid ? { ...x, columns: v } : x)) }))} />
      <Select size="small" style={{ width: 140 }} showSearch placeholder="引用表" value={f.refTable || undefined} options={tableOptions}
        onChange={(v) => setDraft((d) => d && ({ ...d, fks: d.fks.map((x) => (x.uid === f.uid ? { ...x, refTable: v, refColumns: [] } : x)) }))} />
      <Select mode="multiple" size="small" style={{ flex: 1 }} placeholder="引用列" value={f.refColumns} options={refColOptions(f.refTable)}
        onChange={(v) => setDraft((d) => d && ({ ...d, fks: d.fks.map((x) => (x.uid === f.uid ? { ...x, refColumns: v } : x)) }))} />
      <Select size="small" allowClear style={{ width: 110 }} placeholder="ON DELETE" value={f.onDelete ?? undefined}
        options={FK_ACTIONS.map((a) => ({ value: a, label: `删除 ${a}` }))}
        onChange={(v) => setDraft((d) => d && ({ ...d, fks: d.fks.map((x) => (x.uid === f.uid ? { ...x, onDelete: v ?? null } : x)) }))} />
      <Select size="small" allowClear style={{ width: 110 }} placeholder="ON UPDATE" value={f.onUpdate ?? undefined}
        options={FK_ACTIONS.map((a) => ({ value: a, label: `更新 ${a}` }))}
        onChange={(v) => setDraft((d) => d && ({ ...d, fks: d.fks.map((x) => (x.uid === f.uid ? { ...x, onUpdate: v ?? null } : x)) }))} />
      <Button size="small" type="text" danger icon={<DeleteOutlined />}
        onClick={() => setDraft((d) => d && ({ ...d, fks: d.fks.filter((x) => x.uid !== f.uid) }))} />
    </div>
  ))

  return (
    <Modal
      open
      title={`表设计器 · ${draft.name || '（未命名）'}${modelStatus ? ` · ${modelStatus === 'new' ? '新建（未应用）' : modelStatus === 'edited' ? '已编辑（未应用）' : '待删除'}` : ''}`}
      width={960}
      onCancel={close}
      destroyOnHidden
      footer={[
        <Button key="c" onClick={close}>取消</Button>,
        <Button key="s" type="primary" loading={saving} onClick={save}>保存到模型</Button>,
      ]}
    >
      <div className="erd-head">
        <span className="erd-field">
          表名
          <Input size="small" style={{ width: 180 }} value={draft.name} disabled={inDb}
            onChange={(e) => setDraft((d) => d && ({ ...d, name: e.target.value }))} />
        </span>
      </div>
      {inDb && <Alert type="info" showIcon style={{ margin: '8px 0' }} message="已存在于库中的表不能改名；保存后需在「应用变更」中执行才会修改数据库" />}
      <Tabs
        size="small"
        items={[
          {
            key: 'cols',
            label: `列（${draft.cols.length}）`,
            children: (
              <div className="erd-rows">
                {colRows}
                <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ width: 120 }}
                  onClick={() => setDraft((d) => d && ({ ...d, cols: [...d.cols, { uid: nextUid(), name: '', dataType: '', nullable: true, default: '', autoInc: false, comment: '', extraRest: '', characterSet: null, collation: null }] }))}>
                  加列
                </Button>
              </div>
            ),
          },
          {
            key: 'idxs',
            label: `索引（${draft.idxs.length}）`,
            children: (
              <div className="erd-rows">
                {idxRows}
                <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ width: 120 }}
                  onClick={() => setDraft((d) => d && ({ ...d, idxs: [...d.idxs, { uid: nextUid(), name: '', columns: [], unique: false, indexType: 'BTREE', isPrimary: false, subParts: [], directions: [] }] }))}>
                  加索引
                </Button>
              </div>
            ),
          },
          {
            key: 'fks',
            label: `外键（${draft.fks.length}）`,
            children: (
              <div className="erd-rows">
                {fkRows}
                <Button size="small" type="dashed" icon={<PlusOutlined />} style={{ width: 120 }}
                  onClick={() => setDraft((d) => d && ({ ...d, fks: [...d.fks, { uid: nextUid(), name: '', columns: [], refTable: '', refColumns: [], onDelete: null, onUpdate: null }] }))}>
                  加外键
                </Button>
              </div>
            ),
          },
          {
            key: 'opts',
            label: '表选项',
            children: (
              <div className="erd-rows">
                <div className="erd-row">
                  <span className="erd-field">引擎
                    <Select size="small" style={{ width: 110 }} value={draft.engine || 'InnoDB'}
                      options={['InnoDB', 'MyISAM', 'MEMORY'].map((v) => ({ value: v, label: v }))}
                      onChange={(v) => setDraft((d) => d && ({ ...d, engine: v }))} />
                  </span>
                  <span className="erd-field">排序规则
                    <Input size="small" style={{ width: 170 }} placeholder="utf8mb4_general_ci" value={draft.collation}
                      onChange={(e) => setDraft((d) => d && ({ ...d, collation: e.target.value }))} />
                  </span>
                </div>
                <div className="erd-row">
                  <span className="erd-field">注释
                    <Input size="small" style={{ width: 400 }} value={draft.comment}
                      onChange={(e) => setDraft((d) => d && ({ ...d, comment: e.target.value }))} />
                  </span>
                </div>
              </div>
            ),
          },
        ]}
      />
      <div className="erd-ddl-title">DDL 预览</div>
      <SqlView sql={ddl || null} emptyText="（填写列后显示建表语句）" />
    </Modal>
  )
}
```

实现注意：上面 `colTab` 变量是草稿期占位，**删掉它**（`colRows` 直接用）；`setDraft((d) => d && ({...}))` 的模式注意 TS 类型——用非空断言或显式判空均可，保持与项目风格一致。CSS 类（`erd-row`/`erd-rows`/`erd-head`/`erd-field`/`erd-tag`/`erd-ddl-title`）在 Task 17 一并加进 `src/styles.css`。

- [ ] **Step 2: 类型与全量测试通过**

Run: `pnpm build && pnpm test`
Expected: 编译通过、测试全绿（组件未挂载不影响）

- [ ] **Step 3: 提交**

```bash
git add src/components/er/ErTableDesigner.tsx
git commit -m "feat:ER 表设计器（列/索引/外键编辑与实时 DDL 预览）"
```

---

### Task 16: 应用变更弹窗（ErApplyModal）

**Files:**
- Create: `src/components/er/ErApplyModal.tsx`

**Interfaces:**
- Consumes: `store.runErDiff`/`refreshAfterApply`、`api.applySync`、`buildDeployStatements`（`src/stores/compare.ts` 导出）、`SqlView`、`DiffItem` 类型
- Produces: `export function ErApplyModal({ open, onClose }: { open: boolean; onClose: () => void })`

- [ ] **Step 1: 实现组件**

创建 `src/components/er/ErApplyModal.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Empty, Modal, Space, Spin, Tabs, message } from 'antd'

import { api } from '../../api/commands'
import type { ApplyResultItem, DiffItem } from '../../api/types'
import { errText } from '../connection/ConnectionTree'
import { useErStore } from '../../stores/er'
import { buildDeployStatements } from '../../stores/compare'
import { useErTabKey } from './erTabContext'
import { SqlView } from '../compare/SqlView'

type Step = 'diff' | 'done'

/** 应用变更：差异确认（按表分组勾选，dangerous 默认不勾）→ 部署执行 → 完成态。
 *  diff 来源是「模型 vs 库实时结构」，执行走既有 apply_sync 逐条回报 */
export function ErApplyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tabKey = useErTabKey()
  const [items, setItems] = useState<DiffItem[] | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeItem, setActiveItem] = useState<DiffItem | null>(null)
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<ApplyResultItem[] | null>(null)
  const [step, setStep] = useState<Step>('diff')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setItems(null)
    setSelectedIds([])
    setResults(null)
    setActiveItem(null)
    setStep('diff')
    setError(null)
    useErStore
      .getState()
      .runErDiff(tabKey)
      .then((r) => {
        setItems(r)
        // 危险项默认不勾
        setSelectedIds(r.filter((i) => !i.dangerous).map((i) => i.id))
      })
      .catch((e) => setError(errText(e)))
  }, [open, tabKey])

  const selected = useMemo(
    () => (items ?? []).filter((i) => selectedIds.includes(i.id)),
    [items, selectedIds],
  )
  const sqls = useMemo(() => buildDeployStatements(selected), [selected])
  const dangerousCount = selected.filter((i) => i.dangerous).length

  const byTable = useMemo(() => {
    const groups = new Map<string, DiffItem[]>()
    for (const i of items ?? []) {
      const list = groups.get(i.table) ?? []
      list.push(i)
      groups.set(i.table, list)
    }
    return [...groups.entries()]
  }, [items])

  /** 勾选「删表」时自动勾选其前置 DROP FK（引用该表的库外键）——
   *  只勾删表不勾删 FK 会执行失败（MySQL 拒绝删除被引用的表） */
  const toggle = (ids: string[], on: boolean) =>
    setSelectedIds((prev) => {
      const set = new Set(prev)
      for (const id of ids) (on ? set.add : set.delete).bind(set)(id)
      if (on) {
        for (const t of (items ?? []).filter(
          (i) => ids.includes(i.id) && i.kind === 'table' && i.action === 'drop',
        )) {
          for (const fk of items ?? []) {
            if (
              fk.kind === 'foreignKey' &&
              fk.action === 'drop' &&
              (fk.refTable ?? '').toLowerCase() === t.table.toLowerCase()
            )
              set.add(fk.id)
          }
        }
      }
      return [...set]
    })

  /** 部署前校验：勾了删表但配套 DROP FK 被手动取消勾选 → 拦下并点名 */
  const missingFkDeps = (): string[] => {
    const sel = new Set(selectedIds)
    const out: string[] = []
    for (const t of selected.filter((i) => i.kind === 'table' && i.action === 'drop')) {
      for (const fk of items ?? []) {
        if (
          fk.kind === 'foreignKey' &&
          fk.action === 'drop' &&
          !sel.has(fk.id) &&
          (fk.refTable ?? '').toLowerCase() === t.table.toLowerCase()
        )
          out.push(`${fk.table}.${fk.name}`)
      }
    }
    return out
  }

  const actionText: Record<string, string> = {
    create: '新建', drop: '删除', modify: '修改', rename: '改名', noop: '无操作',
  }

  const deploy = async () => {
    const t = useErStore.getState().tabs[tabKey]
    if (!t) return
    const missing = missingFkDeps()
    if (missing.length > 0) {
      message.error(`删除表前需先删除引用它的外键：${missing.join('、')}（请一并勾选）`)
      return
    }
    setApplying(true)
    try {
      const rs = await api.applySync(t.connectionId, sqls)
      setResults(rs)
      setStep('done')
      // 刷新快照 + 自清理（零差异表清 schema、tombstone 移除、走线迁移）并自动保存
      await useErStore.getState().refreshAfterApply(tabKey)
      message.success(
        `执行完成：成功 ${rs.filter((r) => r.ok).length} 条，失败 ${rs.filter((r) => !r.ok).length} 条`,
      )
    } catch (e) {
      message.error(errText(e))
    } finally {
      setApplying(false)
    }
  }

  const diffBody = (
    <>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {items === null ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin tip="正在与数据库比对…" />
        </div>
      ) : items.length === 0 ? (
        <Empty description="模型与数据库结构一致，无需应用" style={{ padding: 40 }} />
      ) : (
        <div className="er-apply-list">
          {byTable.map(([table, list]) => {
            const ids = list.map((i) => i.id)
            const sel = ids.filter((id) => selectedIds.includes(id)).length
            return (
              <div key={table} className="er-apply-group">
                <div className="er-apply-group-head">
                  <Checkbox
                    checked={sel === ids.length}
                    indeterminate={sel > 0 && sel < ids.length}
                    onChange={(e) => toggle(ids, e.target.checked)}
                  />
                  <span className="er-apply-table">{table}</span>
                </div>
                {list.map((i) => (
                  <div
                    key={i.id}
                    className={`er-apply-item${activeItem?.id === i.id ? ' active' : ''}`}
                    onClick={() => setActiveItem(i)}
                  >
                    <Checkbox
                      checked={selectedIds.includes(i.id)}
                      onChange={(e) => toggle([i.id], e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className={`er-apply-action ${i.dangerous ? 'danger' : ''}`}>
                      {actionText[i.action] ?? i.action}
                    </span>
                    <span className="er-apply-desc">{i.name}</span>
                    <span className="er-apply-desc dim">
                      {i.sourceDesc ?? ''} {i.targetDesc ? `→ ${i.targetDesc}` : ''}
                    </span>
                    {i.dangerous && <span className="er-apply-danger">危险</span>}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </>
  )

  const doneBody = results && (
    <>
      <Alert
        type={results.every((r) => r.ok) ? 'success' : 'error'}
        showIcon
        message={`执行完成：成功 ${results.filter((r) => r.ok).length} 条，失败 ${results.filter((r) => !r.ok).length} 条（DDL 不可回滚，结果以数据库为准）`}
      />
      <div style={{ marginTop: 8 }}>
        <SqlView
          sql={
            sqls.length > 0
              ? sqls
                  .map((sql, i) => {
                    const r = results[i]
                    return `${r ? (r.ok ? '-- ✓ 执行成功' : '-- ✗ 执行失败') : ''}\n${sql}`
                  })
                  .join(';\n\n')
              : null
          }
          emptyText="没有勾选任何语句"
        />
      </div>
    </>
  )

  return (
    <Modal
      open={open}
      title="应用变更（模型 → 数据库）"
      width={980}
      onCancel={() => !applying && onClose()}
      maskClosable={false}
      destroyOnHidden
      footer={
        step === 'diff' ? (
          <Space>
            <Button onClick={onClose} disabled={applying}>取消</Button>
            <Button
              type="primary"
              danger={dangerousCount > 0}
              loading={applying}
              disabled={sqls.length === 0}
              onClick={deploy}
            >
              开始执行{sqls.length > 0 ? `（${sqls.length} 条${dangerousCount ? `，含 ${dangerousCount} 条危险操作` : ''}）` : ''}
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <Button
              onClick={async () => {
                setStep('diff')
                setItems(null)
                try {
                  const r = await useErStore.getState().runErDiff(tabKey)
                  setItems(r)
                  setSelectedIds(r.filter((i) => !i.dangerous).map((i) => i.id))
                } catch (e) {
                  setError(errText(e))
                }
              }}
            >
              重新比较
            </Button>
          </Space>
        )
      }
    >
      {step === 'diff' ? (
        <div className="er-apply-body">
          <div className="er-apply-top">{diffBody}</div>
          <Tabs
            className="er-apply-bottom"
            size="small"
            items={[
              {
                key: 'ddl',
                label: 'DDL 比较',
                children: activeItem ? (
                  <div className="er-apply-ddl">
                    <div>
                      <div className="er-apply-ddl-title">模型（源）</div>
                      <SqlView sql={activeItem.sourceDdl} emptyText="（不存在）" />
                    </div>
                    <div>
                      <div className="er-apply-ddl-title">数据库（目标）</div>
                      <SqlView sql={activeItem.targetDdl} emptyText="（不存在）" />
                    </div>
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点击差异项查看两侧 DDL" style={{ paddingTop: 24 }} />
                ),
              },
              {
                key: 'sql',
                label: '部署脚本',
                children: (
                  <SqlView
                    sql={sqls.length > 0 ? `${sqls.join(';\n\n')};` : null}
                    emptyText="未勾选任何对象（勾选后此处显示将要执行的全部语句）"
                  />
                ),
              },
            ]}
          />
        </div>
      ) : (
        doneBody
      )}
    </Modal>
  )
}
```

CSS 类（`er-apply-*`）在 Task 17 一并加。

- [ ] **Step 2: 类型与全量测试通过**

Run: `pnpm build && pnpm test`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/components/er/ErApplyModal.tsx
git commit -m "feat:ER 应用变更弹窗（差异勾选/DDL 对比/部署执行）"
```

---

### Task 17: 画布/工具栏/抽屉集成与样式

**Files:**
- Create: `src/components/er/ErFkModal.tsx`
- Modify: `src/components/er/ErToolbar.tsx`
- Modify: `src/components/er/ErCanvas.tsx`
- Modify: `src/components/er/ErDrawer.tsx`
- Modify: `src/components/er/ErView.tsx`
- Modify: `src/components/er/TableNode.tsx`
- Modify: `src/components/er/layout.ts`（`layoutGraph` 参与边，见 Step 6——实际该函数在 `src/stores/er.ts` 内，改 store）
- Modify: `src/styles.css`
- Modify: `src/stores/er.ts`（`layoutGraph` 补 mfk 边）

- [ ] **Step 1: ErFkModal（拖线建模型外键的确认弹框）**

创建 `src/components/er/ErFkModal.tsx`：

```tsx
import { useMemo, useState } from 'react'
import { Input, Modal, Select, message } from 'antd'

import { errText } from '../connection/ConnectionTree'
import { useErStore } from '../../stores/er'
import { useErTab, useErTabKey } from './erTabContext'

const FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION']

/** 编辑态拖线建「模型外键」：确认约束名与 ON 规则（浏览态拖线仍走手动关联） */
export function ErFkModal(props: {
  open: boolean
  pending: { sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string } | null
  onClose: () => void
}) {
  const tabKey = useErTabKey()
  const graph = useErTab((t) => t.graph)
  const [name, setName] = useState('')
  const [refCol, setRefCol] = useState('')
  const [onDelete, setOnDelete] = useState<string | null>(null)
  const [onUpdate, setOnUpdate] = useState<string | null>(null)

  const p = props.pending
  const defaultName = useMemo(
    () => (p ? `fk_${p.sourceTable.toLowerCase()}_${p.sourceColumn.toLowerCase()}` : ''),
    [p],
  )
  // 每次新的拖线会话重置全部字段（组件常驻，state 不会自动清）
  useEffect(() => {
    if (p) {
      setName('')
      setRefCol(p.targetColumn)
      setOnDelete(null)
      setOnUpdate(null)
    }
  }, [p])
  const effectiveName = name === '' ? defaultName : name

  // 方向：拖拽源 = 子表（外键所在表），目标 = 被引用表（主键端）
  const refColumns = (p ? graph?.tables[p.targetTable.toLowerCase()]?.columns : undefined) ?? []
  const refOptions = refColumns.map((c) => ({ value: c.name, label: `${c.name} ${c.dataType}` }))

  const submit = () => {
    if (!p) return
    const r = useErStore.getState().addModelFk(tabKey, {
      table: p.sourceTable,
      columns: [p.sourceColumn],
      refTable: p.targetTable,
      refColumns: [refCol || p.targetColumn],
      name: effectiveName,
      onDelete,
      onUpdate,
    })
    if (!r.ok) message.warning(r.error ?? '无法添加外键')
    else message.success('已添加模型外键（未应用至库）')
    props.onClose()
  }

  // Hook 全部在前；未打开/无 pending 用条件渲染
  if (!props.open || !p) return null
  return (
    <Modal
      open
      title="添加模型外键"
      width={480}
      onCancel={props.onClose}
      onOk={submit}
      okText="添加"
      destroyOnHidden
    >
      <div className="er-fk-form">
        <div className="er-fk-line">
          {p.sourceTable}.{p.sourceColumn} → {p.targetTable}.
          <Select size="small" style={{ width: 160 }} value={refCol} options={refOptions} onChange={setRefCol} />
        </div>
        <label>
          约束名
          <Input size="small" value={effectiveName} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          ON DELETE
          <Select size="small" allowClear style={{ width: 140 }} value={onDelete ?? undefined}
            options={FK_ACTIONS.map((a) => ({ value: a, label: a }))}
            onChange={(v) => setOnDelete(v ?? null)} />
        </label>
        <label>
          ON UPDATE
          <Select size="small" allowClear style={{ width: 140 }} value={onUpdate ?? undefined}
            options={FK_ACTIONS.map((a) => ({ value: a, label: a }))}
            onChange={(v) => setOnUpdate(v ?? null)} />
        </label>
        <div className="er-fk-hint">应用变更时将在子表上生成 ADD FOREIGN KEY；紫色手动关联仍走画布拖线（浏览模式）。</div>
      </div>
    </Modal>
  )
}
```

import 需补 `useEffect`（react）。

- [ ] **Step 2: ErToolbar 加编辑开关/新建表/应用变更**

`ErToolbar.tsx`：

1. 顶部订阅补：

```tsx
  const editMode = useErTab((t) => t.editMode)
  const modelTables = useErTab((t) => t.modelTables)
  const [applyOpen, setApplyOpen] = useState(false)
  const modelCount = Object.keys(modelTables ?? {}).length
```

2. import 补 `ErApplyModal`、`EditOutlined`、`PlusOutlined`、`ThunderboltOutlined`（或项目已有图标集里等价的）。

3. Space 里「推断」开关之前插入编辑区（放最前）：

```tsx
        <Tooltip title="进入编辑模式：新建表、修改结构、建立模型外键，并可应用回库">
          <span className="er-toolbar-switch">
            编辑 <Switch size="small" checked={editMode} onChange={(v) => useErStore.getState().setEditMode(tabKey, v)} />
          </span>
        </Tooltip>
        {editMode && (
          <>
            <Tooltip title="在画布左侧新建表（预填 id 主键，可在设计器中修改）">
              <Button size="small" icon={<PlusOutlined />} onClick={() => useErStore.getState().createTable(tabKey)}>
                新建表
              </Button>
            </Tooltip>
            <Tooltip title="把模型结构变更与数据库比对，生成 DDL 应用回库">
              <Badge count={modelCount} size="small" offset={[-2, 2]}>
                <Button size="small" type={modelCount > 0 ? 'primary' : 'default'} icon={<ThunderboltOutlined />}
                  disabled={modelCount === 0} onClick={() => setApplyOpen(true)}>
                  应用变更
                </Button>
              </Badge>
            </Tooltip>
          </>
        )}
```

4. 组件末尾渲染 `<ErApplyModal open={applyOpen} onClose={() => setApplyOpen(false)} />`。

- [ ] **Step 3: ErCanvas 集成**

`ErCanvas.tsx`：

1. `buildEdges` 加 mfk 边：签名加 `mfkEdges: ErEdgeInfo[]`，返回数组加 `const mfk = mfkEdges.map((e) => toEdge(e, 'er-edge-mfk'))` 与拼接；调用点传 `graph.mfkEdges`。
2. `buildNodes` 的 data 加 `modelStatus: t.modelStatus`（`TableNodeData` 类型同步加 `modelStatus?: 'new' | 'edited' | 'deleted'`）。
3. `edgeTipLines`：`if (info.kind === 'mfk') lines.push('模型外键（未应用）')`（在 fkName 之后）。
4. `onNodeDoubleClick`：

```tsx
  const onNodeDoubleClick = (_: unknown, node: Node) => {
    const t = useErStore.getState().tabs[tabKey]
    const lower = node.id
    if (t?.editMode) {
      // tombstone 表不可编辑；其余直接进设计器
      if (t.modelTables[lower]?.deleted) return
      useErStore.getState().setDesignerTable(tabKey, lower)
    } else {
      useErStore.getState().setDrawerTable(tabKey, lower)
    }
  }
```

5. `onConnect` 分流：函数开头加

```tsx
    const tab = useErStore.getState().tabs[tabKey]
    if (tab?.editMode) {
      // 编辑态：拖线建模型外键（子表 = 拖拽源端）
      setFkPending({
        sourceTable: conn.source,
        sourceColumn: conn.sourceHandle,
        targetTable: conn.target,
        targetColumn: conn.targetHandle,
      })
      return
    }
```

组件加本地状态 `const [fkPending, setFkPending] = useState<...>(null)`（类型同 ErFkModal props.pending），JSX 末尾渲染：

```tsx
      <ErFkModal
        open={!!fkPending}
        pending={fkPending}
        onClose={() => setFkPending(null)}
      />
```

import `ErFkModal`。原手动关联逻辑保持在 else 分支不变。
6. `showEdgeMenu` 加 mfk 分支（放在 fk 分支之后）：

```tsx
    if (info.kind === 'mfk') {
      const answer = await askChoice<'remove' | 'resetRoute'>({
        title: `模型外键 · ${info.fkName ?? ''}`,
        content: infoContent('建模添加的外键，尚未应用到数据库；应用变更时生成 ADD FOREIGN KEY。'),
        choices: [
          { value: 'remove', label: '删除模型外键', danger: true },
          ...(canReset ? [resetRouteChoice] : []),
          closeChoice,
        ],
      })
      if (answer === 'remove')
        store.removeModelFk(tabKey, info.sourceTable.toLowerCase(), info.fkName ?? '')
      else if (answer === 'resetRoute') resetRoute()
      return
    }
```

7. 节点右键菜单（编辑态）：替换 `suppressContextMenu` 对 `onNodeContextMenu` 的用法——

```tsx
  const onNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    const t = useErStore.getState().tabs[tabKey]
    if (!t?.editMode) return
    const lower = node.id
    const tombstone = !!t.modelTables[lower]?.deleted
    void (async () => {
      const answer = await askChoice<'design' | 'del' | 'restore'>({
        title: `表 · ${t.graph?.tables[lower]?.name ?? lower}`,
        content: tombstone ? '该表已标记删除（未应用）。' : '编辑结构或标记删除（应用变更时生效）。',
        choices: [
          ...(tombstone
            ? [{ value: 'restore' as const, label: '恢复表', primary: true }]
            : [
                { value: 'design' as const, label: '编辑结构', primary: true },
                { value: 'del' as const, label: '删除表', danger: true },
              ]),
          { value: null, label: '关闭' },
        ],
      })
      if (answer === 'design') useErStore.getState().setDesignerTable(tabKey, lower)
      else if (answer === 'restore') useErStore.getState().restoreTable(tabKey, lower)
      else if (answer === 'del') {
        const r = useErStore.getState().deleteTable(tabKey, lower)
        if (!r.ok) message.warning(r.error ?? '无法删除')
      }
    })()
  }
```

`ReactFlow` 的 `onNodeContextMenu={onNodeContextMenu}`（`onPaneContextMenu` 保持 suppress）。
8. 布局参与边：`src/stores/er.ts` 的 `layoutGraph` 边数组补 `...graph.mfkEdges`；`relayout` 同 `layoutGraph` 一处即可（函数共用）。

- [ ] **Step 4: TableNode 状态角标与 tombstone 样式**

`TableNode.tsx` 的 `TableNodeData` 加 `modelStatus?: 'new' | 'edited' | 'deleted'`；表头渲染（表名前）加角标：

```tsx
          {modelStatus && (
            <span className={`er-model-badge er-model-badge-${modelStatus}`}>
              {modelStatus === 'new' ? '新' : modelStatus === 'edited' ? '改' : '删'}
            </span>
          )}
```

解构处补 `modelStatus`。

- [ ] **Step 5: ErDrawer 编辑入口 + ErView 挂载**

`ErDrawer.tsx`（已核实结构：函数组件 + `Drawer`，`drawerTable` 为小写表名键）：

1. 订阅补：

```tsx
  const editMode = useErTab((t) => t.editMode)
  const modelTables = useErTab((t) => t.modelTables)
  const tombstoned = drawerTable ? !!modelTables?.[drawerTable]?.deleted : false
```

import 补 `Alert, Button`（antd）。

2. `Drawer` 加 `extra`（编辑态且非 tombstone 才显示——tombstone 表不允许进设计器，保存会静默绕过恢复语义）：

```tsx
      extra={
        editMode && table && !tombstoned ? (
          <Button
            size="small"
            onClick={() => {
              useErStore.getState().setDesignerTable(tabKey, drawerTable!)
              useErStore.getState().setDrawerTable(tabKey, null)
            }}
          >
            编辑结构
          </Button>
        ) : undefined
      }
```

3. `{table && (<>` 内第一行加 tombstone 提示：

```tsx
          {tombstoned && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
              message="该表已标记删除（未应用）——在画布右键可恢复" />
          )}
```

`ErView.tsx`：`<ErTabProvider>` 内 `<ErDrawer />` 之后挂 `<ErTableDesigner />`（designerTable 非空才渲染内容，组件内部已判空）；import 补。

- [ ] **Step 6: styles.css**

`src/styles.css` 的 ER 样式区追加（颜色与现有 er-edge-fk 蓝/manual 紫协调）：

```css
/* ───── ER 图上建模（二期 A）───── */
/* 模型外键：实线青绿（区别于真实 FK 蓝、手动关联紫、推断虚线） */
.er-edge-mfk .react-flow__edge-path { stroke: #13a8a8; stroke-width: 1.6px; }
.er-edge-mfk.er-edge-selected .react-flow__edge-path { stroke: #0e8484; stroke-width: 2.4px; }

/* 建模状态角标 */
.er-model-badge {
  display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 8px;
  font-size: 11px; line-height: 16px; color: #fff; vertical-align: middle;
}
.er-model-badge-new { background: #52a86e; }
.er-model-badge-edited { background: #d9822b; }
.er-model-badge-deleted { background: #c04040; }

/* 新建表虚线边框；tombstone 灰显 + 删除线 */
.er-node-new .er-table-node { border: 1.5px dashed #52a86e; }
.er-node-deleted .er-table-node { opacity: 0.55; background: #f5f5f5; }
.er-node-deleted .er-table-name { text-decoration: line-through; }

/* 表设计器 */
.erd-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.erd-field { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #666; }
.erd-rows { display: flex; flex-direction: column; gap: 6px; }
.erd-row { display: flex; gap: 6px; align-items: center; }
.erd-tag { font-size: 11px; color: #999; padding: 0 6px; }
.erd-ddl-title { font-size: 12px; color: #666; margin: 10px 0 4px; }

/* 应用变更弹窗 */
.er-apply-body { display: flex; flex-direction: column; height: 560px; }
.er-apply-top { flex: 1.4; overflow: auto; min-height: 200px; }
.er-apply-bottom { flex: 1; min-height: 160px; }
.er-apply-group { margin-bottom: 10px; }
.er-apply-group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.er-apply-table { font-weight: 600; }
.er-apply-item { display: flex; align-items: center; gap: 8px; padding: 2px 4px 2px 24px; cursor: pointer; border-radius: 4px; }
.er-apply-item:hover { background: #f5f5f5; }
.er-apply-item.active { background: #e8f1fb; }
.er-apply-action { width: 36px; font-size: 12px; color: #1677ff; }
.er-apply-action.danger { color: #d94040; }
.er-apply-desc { font-size: 12px; }
.er-apply-desc.dim { color: #999; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.er-apply-danger { font-size: 11px; color: #d94040; border: 1px solid #d94040; border-radius: 8px; padding: 0 5px; }
.er-apply-ddl { display: flex; gap: 8px; height: 100%; }
.er-apply-ddl > div { flex: 1; overflow: auto; }
.er-apply-ddl-title { font-size: 12px; color: #666; margin-bottom: 4px; }

/* 模型外键弹框 */
.er-fk-form { display: flex; flex-direction: column; gap: 10px; }
.er-fk-form label { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.er-fk-line { font-size: 13px; }
.er-fk-hint { font-size: 12px; color: #999; }
```

`buildNodes` 里把 `modelStatus` 映射到节点 className：`er-node-new`/`er-node-deleted`（edited 用角标即可，不加类）——在 `className` 拼接处补：

```ts
      className: [
        mark?.node.length ? mark.node.map((k) => `er-node-${k}`).join(' ') : undefined,
        t.modelStatus === 'new' ? 'er-node-new' : undefined,
        t.modelStatus === 'deleted' ? 'er-node-deleted' : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
```

- [ ] **Step 7: 全量验证**

Run: `pnpm build && pnpm test`
Expected: 编译通过、测试全绿

- [ ] **Step 8: 提交**

```bash
git add src/components/er/ErFkModal.tsx src/components/er/ErToolbar.tsx src/components/er/ErCanvas.tsx src/components/er/ErDrawer.tsx src/components/er/ErView.tsx src/components/er/TableNode.tsx src/stores/er.ts src/styles.css
git commit -m "feat:ER 编辑模式画布集成（开关/新建表/模型外键拖线/删除表/状态角标/应用入口）"
```

---

### Task 18: README 更新与全量验证

**Files:**
- Modify: `README.md`（「ER 图」章节）

- [ ] **Step 1: README ER 章节补充建模小节**

在「ER 图」章节的「导出」条目之前插入（文字风格与现有条目一致）：

```markdown
- **图上建模（编辑模式）**：工具栏「编辑」开关进入——「新建表」在画布左侧创建空表（预填 id 主键）并弹出表设计器；双击表打开设计器（浏览模式仍是详情抽屉，抽屉内也可点「编辑结构」），可编辑列（上下箭头调列序）、索引（含主键）、模型外键、表注释/引擎/排序规则，底部实时预览建表 DDL。编辑已存在的表会把当前结构拷入本地模型文档（与库一致时不留痕迹）；表结构改动仅保存在模型文档，点「应用变更」才会修改数据库
- **模型外键**：编辑模式下从列行拖线到目标列（浏览模式拖线仍是纯标注的手动关联），确认约束名与 ON DELETE/ON UPDATE 后记入子表结构——实线青绿展示、参与自动布局；应用变更时生成 ADD/DROP FOREIGN KEY。手动关联（紫色）永不生成 DDL
- **应用变更（模型 → 数据库）**：把建模结构（新建/编辑/标记删除的表）与库实时结构比对，按表分组勾选差异（删除类红色默认不勾），可查看双侧 DDL 与部署脚本，逐条执行并内联标注成败；执行后自动刷新并清除已一致的建模痕迹（角标消失）。右键表可「删除表」（应用前可恢复，灰显删除线标示）或「恢复表」；删除被模型外键引用的表会被阻止。模型没有的表永不参与比对，不会因「模型里没有」被误删
```

- [ ] **Step 2: 全量验证**

Run: `pnpm test && pnpm build && cd src-tauri && cargo test`
Expected: 全绿。docker 环境在：`cd src-tauri && DBFLOW_E2E=1 cargo test -- --test-threads=1`

- [ ] **Step 3: 手工验收（demo_fk 库，21 表全关系形态）**

`pnpm tauri dev` 起应用，连接 mysql5.6（127.0.0.1:3306 root/123123）打开 demo_fk 的 ER 图，走一遍：开编辑模式 → 新建表（加列/索引）→ 拖线建模型外键（引用既有表）→ 编辑一张既有表（加列/改注释）→ 右键删除一张无关表 → 应用变更（核对差异清单与脚本）→ 执行后核对：库结构已变更（DESCRIBE 验证）、角标消失、tombstone 表消失、mfk 边变蓝（真实 FK）。GUI 验证约束：合成点击可能被拒，优先用键盘/菜单路径，或 `screencapture -l <windowid>` 截图核对。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs:README 补充 ER 图上建模与应用变更说明"
```

---

## 计划自审记录

- **Spec 覆盖**：编辑模式开关（T17）、仅模型涉及表 diff（T3/T5）、manual/mfk 区分（T10/T17）、仅回源库（T14/T16）、表设计器 Modal（T15）、文档 v2 全量 schema + 惰性迁移（T11/T13）、er_model 纯函数 + FK 对比 + DDL 排序（T2-T5）、preview_table_ddl（T6）、rename 拆解（T5）、tombstone FK 规则（T4/T5）、应用自清理 + 走线迁移（T14）、冲突与危险项口径（T16 UI + 引擎 dangerous 标记）、README（T18）——全部有对应任务
- **Review Focus**：五条分别锚到 T3/T5/T5/T5/T14 的测试
- **类型一致性**：`ErModelTableInput`（前端）/`ErModelTableInput`（Rust，camelCase serde）字段对齐；`mfk` 边 id 前缀约定在 T10/T14/T17 一致；`DiffKind::ForeignKey` serde 名 `foreignKey` 与前端联合类型一致
- **已知实现注意点**（执行者留意，不改变设计）：T15 设计器代码中 `colTab` 占位需删除；ErFkModal 的 Hook 前置约束已注明；T5 排序采用稳定排序（不按 id 重排）以保列序

## 评审修订记录（2026-10-03，外部评审后）

对照代码逐条核实后采纳的修订（全部已改进上方任务正文）：

1. **copy-on-edit 保留库外键**（必修）：`snapshotTableToSchema(t, fks)` 带该表库 FK；T9/T12/T15 调用点与测试同步。丢外键会让 diff 把全部真实 FK 判成待 DROP、画布隐藏真实 FK 边、设计器外键 Tab 缺数据
2. **未指定字段归一化**（必修）：`build_model_snapshot` 对已存在于库的表回填 engine/collation 与列级 characterSet/collation 的 None（None = 未指定 ≠ 无）；设计器 ColDraft 透传列级 cs/collation；`schemasEqual` 语义化比较替代 JSON.stringify。否则：不改就存出假「改」角标、每个字符串列假 MODIFY、应用后角标永远消不掉（收敛失败）
3. **mfk→fk 走线迁移改为条件执行**：复跑差异里已无对应 FK 项才迁（未应用的走线保留在 mfk 键上）
4. **删表↔删 FK 勾选联动**：FK DiffItem 加 `refTable` 字段（serde `refTable`，普通对比恒缺省）；ErApplyModal 勾选删表自动勾选前置 DROP FK，部署前校验拦截漏勾
5. **e2e 双版本**：闭环用例在 5.6(3306) 与 8.4 mysql-a(3308) 各跑一遍；preview_table_ddl 追加外键 DDL（外键 Tab 编辑在预览可见）
6. **tombstone 防护与编辑保留**：tombstone 不能从抽屉进设计器（右键只提供恢复）；`deleteTable` 保留原 schema，`restoreTable` 有编辑则恢复为已编辑态；文档 v2 读写支持 schema+status 并存；`saveTableSchema` 防御性保持 deleted 标记
7. **ErFkModal 状态重置**：pending 变化时 useEffect 重置全部字段（组件常驻不重挂载）
8. **表选项回归独立 Tab**（对齐 spec），设计器头部只留表名

