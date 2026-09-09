//! 结构对比引擎：双端快照 → 差异项列表（纯函数，可单测；一源多目标时可直接复用）。
pub mod sqlgen;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::datasource::{ColumnDef, IndexDef, SchemaSnapshot, TableDef, ViewDef};
use sqlgen::{
    add_column_clause, create_table_sql, describe_column, describe_index, describe_table_options,
    drop_column_clause, modify_column_clause, qualified,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Table,
    Column,
    Index,
    View,
}

/// 对比范围选项：表永远对比；索引默认对比；视图等非常用对象默认不对比。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareOptions {
    pub compare_indexes: bool,
    pub compare_views: bool,
}

impl Default for CompareOptions {
    fn default() -> Self {
        Self {
            compare_indexes: true,
            compare_views: false,
        }
    }
}

impl CompareOptions {
    pub fn default_for_command() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffAction {
    Create,
    Drop,
    Modify,
    Rename,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffItem {
    /// 稳定标识：tbl:{表} / tblopt:{表} / col:{表}:{列} / idx:{表}:{索引} / view:{视图}
    pub id: String,
    pub kind: DiffKind,
    pub action: DiffAction,
    pub table: String,
    pub name: String,
    /// 源端形态描述（drop 类为 None）
    pub source_desc: Option<String>,
    /// 目标端形态描述（create 类为 None）
    pub target_desc: Option<String>,
    /// 在目标端执行的 SQL
    pub sql: Option<String>,
    /// 列变更的 ALTER 子句（不含 "ALTER TABLE 库.表" 前缀），
    /// 如 "ADD COLUMN `x` int NULL AFTER `id`"。前端把同表勾选的列子句
    /// 合并为一条 ALTER；None 表示该项不参与列合并（表/索引/视图等独立语句）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql_clause: Option<String>,
    /// 破坏性操作（DROP 表/列/索引）→ 前端红色标注 + 默认不勾选
    pub dangerous: bool,
    /// 源端该表完整建表 DDL（DDL 对比视图用；表在源端不存在时为 None）
    pub source_ddl: Option<String>,
    /// 目标端该表完整建表 DDL（表在目标端不存在时为 None）
    pub target_ddl: Option<String>,
}

/// 源快照 vs 目标快照 → 差异项（目标端如何变更才能与源一致）
pub fn diff_snapshots(
    source: &SchemaSnapshot,
    target: &SchemaSnapshot,
    options: &CompareOptions,
) -> Vec<DiffItem> {
    let src: BTreeMap<&str, &TableDef> = source.tables.iter().map(|t| (t.name.as_str(), t)).collect();
    let tgt: BTreeMap<&str, &TableDef> = target.tables.iter().map(|t| (t.name.as_str(), t)).collect();

    let mut items = Vec::new();

    // 先找出结构完全相同且名字看起来是重命名的未匹配表对（避免 DROP + CREATE 丢数据）
    let src_unmatched: Vec<&TableDef> = src
        .values()
        .filter(|t| !tgt.contains_key(t.name.as_str()))
        .copied()
        .collect();
    let mut tgt_unmatched: Vec<&TableDef> = tgt
        .values()
        .filter(|t| !src.contains_key(t.name.as_str()))
        .copied()
        .collect();
    let mut renamed_old_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut renamed_new_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for s_tbl in &src_unmatched {
        if let Some(pos) = tgt_unmatched.iter().position(|t_tbl| {
            tables_structurally_equal(s_tbl, t_tbl) && names_look_renamed(&s_tbl.name, &t_tbl.name)
        }) {
            let t_tbl = tgt_unmatched.remove(pos);
            renamed_old_names.insert(t_tbl.name.clone());
            renamed_new_names.insert(s_tbl.name.clone());
            let src_ddl = create_table_sql(&source.database, s_tbl);
            let tgt_ddl = create_table_sql(&target.database, t_tbl);
            items.push(table_rename(&target.database, s_tbl, t_tbl, &src_ddl, &tgt_ddl));
        }
    }

    // 所有生成的 SQL 都在目标端执行 → 库前缀一律用目标库名；
    // DDL 对比视图用各端真实库名生成完整建表语句
    for (name, s) in &src {
        if renamed_new_names.contains(*name) {
            continue;
        }
        let src_ddl = create_table_sql(&source.database, s);
        match tgt.get(*name) {
            None => items.push(table_create(&target.database, s, &src_ddl)),
            Some(t) => {
                let tgt_ddl = create_table_sql(&target.database, t);
                items.extend(diff_table(&target.database, s, t, &src_ddl, &tgt_ddl, options));
            }
        }
    }
    for (name, t) in &tgt {
        if renamed_old_names.contains(*name) || src.contains_key(*name) {
            continue;
        }
        let tgt_ddl = create_table_sql(&target.database, t);
        items.push(table_drop(&target.database, t, &tgt_ddl));
    }

    if options.compare_views {
        items.extend(diff_views(&source.views, &target.views, &target.database));
    }

    items
}

fn tables_structurally_equal(a: &TableDef, b: &TableDef) -> bool {
    a.engine == b.engine
        && a.collation == b.collation
        && a.comment == b.comment
        && a.columns == b.columns
        && a.indexes == b.indexes
}

/// 判断两个表名是否像一次重命名（避免把结构相同的两个无关表误判为 rename）。
/// 规则：忽略大小写后相同；或公共前缀长度 >=3 且 >= 较短名长度的 40%。
fn names_look_renamed(a: &str, b: &str) -> bool {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    if a == b {
        return true;
    }
    let lcp = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let min_len = a.chars().count().min(b.chars().count());
    lcp >= 3 && lcp >= (min_len as f64 * 0.4) as usize
}

fn table_rename(db: &str, s: &TableDef, t: &TableDef, src_ddl: &str, tgt_ddl: &str) -> DiffItem {
    DiffItem {
        id: format!("rename:{}:{}", t.name, s.name),
        kind: DiffKind::Table,
        action: DiffAction::Rename,
        table: t.name.clone(),
        name: s.name.clone(),
        source_desc: Some(describe_table_options(s)),
        target_desc: Some(describe_table_options(t)),
        sql: Some(format!(
            "RENAME TABLE {} TO {}",
            sqlgen::qualified(db, &t.name),
            sqlgen::qualified(db, &s.name)
        )),
        sql_clause: None,
        dangerous: false,
        source_ddl: Some(src_ddl.to_string()),
        target_ddl: Some(tgt_ddl.to_string()),
    }
}

fn table_create(db: &str, s: &TableDef, src_ddl: &str) -> DiffItem {
    DiffItem {
        id: format!("tbl:{}", s.name),
        kind: DiffKind::Table,
        action: DiffAction::Create,
        table: s.name.clone(),
        name: s.name.clone(),
        source_desc: Some(describe_table_options(s)),
        target_desc: None,
        sql: Some(create_table_sql(db, s)),
        sql_clause: None,
        dangerous: false,
        source_ddl: Some(src_ddl.to_string()),
        target_ddl: None,
    }
}

fn table_drop(db: &str, t: &TableDef, tgt_ddl: &str) -> DiffItem {
    DiffItem {
        id: format!("tbl:{}", t.name),
        kind: DiffKind::Table,
        action: DiffAction::Drop,
        table: t.name.clone(),
        name: t.name.clone(),
        source_desc: None,
        target_desc: Some(format!("{} 个列，待删除", t.columns.len())),
        sql: Some(format!("DROP TABLE {}", sqlgen::qualified(db, &t.name))),
        sql_clause: None,
        dangerous: true,
        source_ddl: None,
        target_ddl: Some(tgt_ddl.to_string()),
    }
}

fn diff_table(
    db: &str,
    s: &TableDef,
    t: &TableDef,
    src_ddl: &str,
    tgt_ddl: &str,
    options: &CompareOptions,
) -> Vec<DiffItem> {
    let mut items = Vec::new();
    let mk = |id: String, kind: DiffKind, action: DiffAction, name: String,
              source_desc: Option<String>, target_desc: Option<String>,
              sql: Option<String>, sql_clause: Option<String>, dangerous: bool| DiffItem {
        id, kind, action,
        table: s.name.clone(),
        name,
        source_desc, target_desc, sql, sql_clause, dangerous,
        source_ddl: Some(src_ddl.to_string()),
        target_ddl: Some(tgt_ddl.to_string()),
    };

    // 表选项（ENGINE / COMMENT / COLLATION；表级字符集随排序规则推导）
    if s.engine != t.engine || s.comment != t.comment || s.collation != t.collation {
        let mut alter = format!("ALTER TABLE {}", sqlgen::qualified(db, &s.name));
        if s.engine != t.engine {
            if let Some(e) = &s.engine {
                alter.push_str(&format!(" ENGINE={e}"));
            }
        }
        if s.collation != t.collation {
            if let Some(coll) = &s.collation {
                let charset = coll.split('_').next().unwrap_or(coll);
                alter.push_str(&format!(
                    " DEFAULT CHARACTER SET {} COLLATE {}",
                    sqlgen::quote_ident(charset),
                    sqlgen::quote_ident(coll)
                ));
            }
        }
        if s.comment != t.comment {
            alter.push_str(&format!(
                " COMMENT={}",
                sqlgen::quote_string(s.comment.as_deref().unwrap_or(""))
            ));
        }
        items.push(mk(
            format!("tblopt:{}", s.name),
            DiffKind::Table,
            DiffAction::Modify,
            "(表选项)".to_string(),
            Some(describe_table_options(s)),
            Some(describe_table_options(t)),
            Some(alter),
            None,
            false,
        ));
    }

    // ── 列差异：每个字段一条独立 DiffItem（可单独勾选/部署）──
    let src_cols: BTreeMap<&str, &ColumnDef> =
        s.columns.iter().map(|c| (c.name.as_str(), c)).collect();
    let tgt_cols: BTreeMap<&str, &ColumnDef> =
        t.columns.iter().map(|c| (c.name.as_str(), c)).collect();

    // 位置规划的模拟起点：目标列剔除"待删除列"后的当前列序。
    // 快照按 ORDINAL_POSITION 返回，Vec 顺序就是真实物理列序。
    let mut cur_order: Vec<&str> = t
        .columns
        .iter()
        .filter(|tc| src_cols.contains_key(tc.name.as_str()))
        .map(|tc| tc.name.as_str())
        .collect();

    // 按源列顺序逐个"固定"到前驱之后：
    // - 目标缺失的列 → ADD（带 AFTER/FIRST，按源顺序产出，AFTER 引用的前驱一定已就位）
    // - 两端都有的列 → 仅当当前没有紧跟前驱时才 MODIFY 移动；类型变化时 MODIFY 新定义。
    //   这是贪心的最长公共子序列：天然在位的列保持不动，移动数量最小——
    //   中间插入一个新列不会把其后的列误判成变更，纯换位只动真正错位的列。
    let mut prev: Option<&str> = None;
    for sc in &s.columns {
        match tgt_cols.get(sc.name.as_str()) {
            None => {
                let after = prev.map(str::to_string);
                let clause = add_column_clause(sc, after.as_deref());
                items.push(mk(
                    format!("col:{}:{}", s.name, sc.name),
                    DiffKind::Column,
                    DiffAction::Create,
                    sc.name.clone(),
                    Some(describe_column(sc)),
                    None,
                    Some(format!("ALTER TABLE {} {}", qualified(db, &s.name), clause)),
                    Some(clause),
                    false,
                ));
                match prev {
                    Some(p) => {
                        let i = cur_order.iter().position(|n| *n == p).unwrap();
                        cur_order.insert(i + 1, sc.name.as_str());
                    }
                    None => cur_order.insert(0, sc.name.as_str()),
                }
            }
            Some(tc) => {
                let type_changed = !cols_equal(sc, tc);
                let in_place = match prev {
                    None => cur_order.first() == Some(&sc.name.as_str()),
                    Some(p) => cur_order
                        .iter()
                        .position(|n| *n == sc.name.as_str())
                        .is_some_and(|i| i > 0 && cur_order[i - 1] == p),
                };
                if type_changed || !in_place {
                    // 已在位 → MODIFY 不带位置子句；错位 → 同一条 MODIFY 带上 AFTER/FIRST
                    let after: Option<Option<&str>> =
                        if in_place { None } else { Some(prev) };
                    let clause = modify_column_clause(sc, after);
                    items.push(mk(
                        format!("col:{}:{}", s.name, sc.name),
                        DiffKind::Column,
                        DiffAction::Modify,
                        sc.name.clone(),
                        Some(describe_column(sc)),
                        Some(describe_column(tc)),
                        Some(format!("ALTER TABLE {} {}", qualified(db, &s.name), clause)),
                        Some(clause),
                        false,
                    ));
                }
                if !in_place {
                    cur_order.retain(|n| *n != sc.name.as_str());
                    match prev {
                        Some(p) => {
                            let i = cur_order.iter().position(|n| *n == p).unwrap();
                            cur_order.insert(i + 1, sc.name.as_str());
                        }
                        None => cur_order.insert(0, sc.name.as_str()),
                    }
                }
            }
        }
        prev = Some(sc.name.as_str());
    }

    // 删除列：目标端独有，逐条独立 DROP（破坏性，前端默认不勾选）
    for tc in &t.columns {
        if !src_cols.contains_key(tc.name.as_str()) {
            let clause = drop_column_clause(&tc.name);
            items.push(mk(
                format!("col:{}:{}", s.name, tc.name),
                DiffKind::Column,
                DiffAction::Drop,
                tc.name.clone(),
                None,
                Some(describe_column(tc)),
                Some(format!("ALTER TABLE {} {}", qualified(db, &s.name), clause)),
                Some(clause),
                true,
            ));
        }
    }

    // 索引（可按配置跳过）
    if options.compare_indexes {
        let src_idx: BTreeMap<&str, &IndexDef> =
            s.indexes.iter().map(|i| (i.name.as_str(), i)).collect();
        let tgt_idx: BTreeMap<&str, &IndexDef> =
            t.indexes.iter().map(|i| (i.name.as_str(), i)).collect();

        for (name, si) in &src_idx {
            match tgt_idx.get(*name) {
                None => items.push(mk(
                    format!("idx:{}:{}", s.name, name),
                    DiffKind::Index,
                    DiffAction::Create,
                    name.to_string(),
                    Some(describe_index(si)),
                    None,
                    Some(sqlgen::add_index_sql(db, &s.name, si)),
                    None,
                    false,
                )),
                Some(ti) if si != ti => {
                    // 主键重建时若目标表有 AUTO_INCREMENT 列，需先去掉再改主键，最后加回
                    let auto_inc_col = si.is_primary.then(|| {
                        t.columns.iter().find(|c| c.extra.split_whitespace().any(|e| e == "auto_increment"))
                    }).flatten();
                    items.push(mk(
                        format!("idx:{}:{}", s.name, name),
                        DiffKind::Index,
                        DiffAction::Modify,
                        name.to_string(),
                        Some(describe_index(si)),
                        Some(describe_index(ti)),
                        Some(sqlgen::rebuild_index_sql(db, &s.name, si, auto_inc_col)),
                        None,
                        false,
                    ))
                }
                _ => {}
            }
        }
        for (name, ti) in &tgt_idx {
            if !src_idx.contains_key(*name) {
                items.push(mk(
                    format!("idx:{}:{}", s.name, name),
                    DiffKind::Index,
                    DiffAction::Drop,
                    name.to_string(),
                    None,
                    Some(describe_index(ti)),
                    Some(sqlgen::drop_index_sql(db, &s.name, ti)),
                    None,
                    true,
                ));
            }
        }
    }

    items
}

/// 列语义等价（忽略 ordinal —— 位置差异不算修改）
fn cols_equal(a: &ColumnDef, b: &ColumnDef) -> bool {
    a.name == b.name
        && a.data_type == b.data_type
        && a.nullable == b.nullable
        && a.default == b.default
        && a.extra == b.extra
        && a.comment == b.comment
        && a.character_set == b.character_set
        && a.collation == b.collation
}

fn diff_views(src: &[ViewDef], tgt: &[ViewDef], db: &str) -> Vec<DiffItem> {
    let src_map: BTreeMap<&str, &ViewDef> =
        src.iter().map(|v| (v.name.as_str(), v)).collect();
    let tgt_map: BTreeMap<&str, &ViewDef> =
        tgt.iter().map(|v| (v.name.as_str(), v)).collect();

    let mut items = Vec::new();
    for (name, sv) in &src_map {
        match tgt_map.get(*name) {
            None => items.push(DiffItem {
                id: format!("view:{name}"),
                kind: DiffKind::View,
                action: DiffAction::Create,
                table: name.to_string(),
                name: name.to_string(),
                source_desc: Some(sqlgen::describe_view(sv)),
                target_desc: None,
                sql: Some(sqlgen::create_view_sql(db, sv)),
                sql_clause: None,
                dangerous: false,
                source_ddl: Some(sqlgen::create_view_sql(db, sv)),
                target_ddl: None,
            }),
            Some(tv) if !view_defs_equal(sv, tv) => {
                let source_ddl = sqlgen::create_view_sql(db, sv);
                let target_ddl = sqlgen::create_view_sql(db, tv);
                items.push(DiffItem {
                    id: format!("view:{name}"),
                    kind: DiffKind::View,
                    action: DiffAction::Modify,
                    table: name.to_string(),
                    name: name.to_string(),
                    source_desc: Some(sqlgen::describe_view(sv)),
                    target_desc: Some(sqlgen::describe_view(tv)),
                    sql: Some(sqlgen::alter_view_sql(db, sv)),
                    sql_clause: None,
                    dangerous: false,
                    source_ddl: Some(source_ddl),
                    target_ddl: Some(target_ddl),
                })
            }
            _ => {}
        }
    }
    for (name, tv) in &tgt_map {
        if !src_map.contains_key(*name) {
            items.push(DiffItem {
                id: format!("view:{name}"),
                kind: DiffKind::View,
                action: DiffAction::Drop,
                table: name.to_string(),
                name: name.to_string(),
                source_desc: None,
                target_desc: Some(sqlgen::describe_view(tv)),
                sql: Some(sqlgen::drop_view_sql(db, tv)),
                sql_clause: None,
                dangerous: true,
                source_ddl: None,
                target_ddl: Some(sqlgen::create_view_sql(db, tv)),
            });
        }
    }
    items
}

fn view_defs_equal(a: &ViewDef, b: &ViewDef) -> bool {
    a.definition.trim() == b.definition.trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, dt: &str, nullable: bool) -> ColumnDef {
        ColumnDef { name: name.into(), data_type: dt.into(), nullable, ..Default::default() }
    }

    fn table(name: &str, columns: Vec<ColumnDef>, indexes: Vec<IndexDef>) -> TableDef {
        TableDef { name: name.into(), engine: Some("InnoDB".into()), ..Default::default() }
            .with_columns(columns)
            .with_indexes(indexes)
    }

    fn diff(a: &SchemaSnapshot, b: &SchemaSnapshot) -> Vec<DiffItem> {
        diff_snapshots(a, b, &CompareOptions::default())
    }

    // 小构造器
    impl TableDef {
        fn with_columns(mut self, cols: Vec<ColumnDef>) -> Self {
            self.columns = cols
                .into_iter()
                .enumerate()
                .map(|(i, mut c)| {
                    c.ordinal = (i + 1) as u32;
                    c
                })
                .collect();
            self
        }
        fn with_indexes(mut self, idx: Vec<IndexDef>) -> Self {
            self.indexes = idx;
            self
        }
    }

    fn snap(db: &str, tables: Vec<TableDef>) -> SchemaSnapshot {
        SchemaSnapshot {
            database: db.into(),
            tables,
            views: Vec::new(),
        }
    }

    #[test]
    fn identical_snapshots_produce_no_diff() {
        let a = snap(
            "src",
            vec![table(
                "t1",
                vec![col("id", "bigint unsigned", false), col("name", "varchar(64)", true)],
                vec![IndexDef { name: "PRIMARY".into(), is_primary: true, columns: vec!["id".into()], sub_parts: vec![], directions: vec![], unique: true, index_type: Some("BTREE".into()) }],
            )],
        );
        let b = snap("tgt", a.tables.clone());
        assert!(diff(&a, &b).is_empty());
    }

    #[test]
    fn table_create_and_drop() {
        let src = snap("src", vec![table("t1", vec![col("id", "int", false)], vec![])]);
        let tgt = snap("tgt", vec![table("extra", vec![col("id", "int", false)], vec![])]);
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 2);
        let create = items.iter().find(|i| i.id == "tbl:t1").unwrap();
        assert_eq!(create.action, DiffAction::Create);
        assert!(!create.dangerous);
        assert!(create.sql.as_ref().unwrap().starts_with("CREATE TABLE `tgt`.`t1`"));
        let drop = items.iter().find(|i| i.id == "tbl:extra").unwrap();
        assert_eq!(drop.action, DiffAction::Drop);
        assert!(drop.dangerous);
        assert_eq!(drop.sql.as_deref(), Some("DROP TABLE `tgt`.`extra`"));
    }

    #[test]
    fn table_rename_detected_when_structures_match() {
        // 结构完全相同且名字有公共前缀 → 应识别为重命名，而不是 DROP + CREATE
        let src = snap(
            "src",
            vec![table(
                "tbl_new",
                vec![col("id", "int", false), col("name", "varchar(64)", true)],
                vec![IndexDef {
                    name: "PRIMARY".into(),
                    columns: vec!["id".into()],
                    sub_parts: vec![None],
                    directions: vec![None],
                    unique: true,
                    is_primary: true,
                    index_type: Some("BTREE".into()),
                }],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "tbl_old",
                vec![col("id", "int", false), col("name", "varchar(64)", true)],
                vec![IndexDef {
                    name: "PRIMARY".into(),
                    columns: vec!["id".into()],
                    sub_parts: vec![None],
                    directions: vec![None],
                    unique: true,
                    is_primary: true,
                    index_type: Some("BTREE".into()),
                }],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        let r = &items[0];
        assert_eq!(r.id, "rename:tbl_old:tbl_new");
        assert_eq!(r.action, DiffAction::Rename);
        assert!(!r.dangerous);
        let sql = r.sql.as_deref().unwrap();
        assert!(
            sql.contains("RENAME TABLE `tgt`.`tbl_old` TO `tgt`.`tbl_new`"),
            "{sql}"
        );
    }

    #[test]
    fn column_add_modify_drop_are_separate_items() {
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![
                    col("id", "bigint", false),
                    col("name", "varchar(255)", false),
                    col("remark", "text", true),
                ],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![
                    col("id", "bigint", false),
                    col("name", "varchar(64)", false), // 类型不同 → Modify
                    col("legacy", "int", true),         // 目标多余 → Drop
                ],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        // 每个字段一条独立 DiffItem，按源列顺序：name 修改、remark 新增、legacy 删除
        assert_eq!(items.len(), 3, "{items:?}");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["col:t:name", "col:t:remark", "col:t:legacy"]);

        let modify = &items[0];
        assert_eq!(modify.action, DiffAction::Modify);
        let modify_sql = modify.sql.as_deref().unwrap();
        assert!(modify_sql.starts_with("ALTER TABLE `tgt`.`t` MODIFY COLUMN"), "{modify_sql}");
        assert!(modify_sql.contains("varchar(255)"), "{modify_sql}");
        // 仅类型变化、位置未动 → 不带 AFTER/FIRST
        assert!(!modify_sql.contains("AFTER") && !modify_sql.contains("FIRST"), "{modify_sql}");

        let add = &items[1];
        assert_eq!(add.action, DiffAction::Create);
        assert_eq!(
            add.sql.as_deref(),
            Some("ALTER TABLE `tgt`.`t` ADD COLUMN `remark` text NULL AFTER `name`")
        );
        // 子句不含表前缀，供前端与同表其他勾选项合并为一条 ALTER
        assert_eq!(
            add.sql_clause.as_deref(),
            Some("ADD COLUMN `remark` text NULL AFTER `name`")
        );

        let drop = &items[2];
        assert_eq!(drop.action, DiffAction::Drop);
        assert!(drop.dangerous);
        assert_eq!(drop.sql.as_deref(), Some("ALTER TABLE `tgt`.`t` DROP COLUMN `legacy`"));
    }

    #[test]
    fn multiple_added_columns_each_become_independent_items() {
        // 源表：id, a, b, c；目标表：id
        // 每个新增列都是独立项、独立 ALTER，AFTER 指向源中前一列，按源顺序逐条执行即到位
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![
                    col("id", "int", false),
                    col("a", "int", true),
                    col("b", "int", true),
                    col("c", "int", true),
                ],
                vec![],
            )],
        );
        let tgt = snap("tgt", vec![table("t", vec![col("id", "int", false)], vec![])]);
        let items = diff(&src, &tgt);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["col:t:a", "col:t:b", "col:t:c"], "{items:?}");
        assert!(items.iter().all(|i| i.action == DiffAction::Create));
        assert_eq!(
            items[0].sql.as_deref(),
            Some("ALTER TABLE `tgt`.`t` ADD COLUMN `a` int NULL AFTER `id`")
        );
        assert_eq!(
            items[1].sql.as_deref(),
            Some("ALTER TABLE `tgt`.`t` ADD COLUMN `b` int NULL AFTER `a`")
        );
        assert_eq!(
            items[2].sql.as_deref(),
            Some("ALTER TABLE `tgt`.`t` ADD COLUMN `c` int NULL AFTER `b`")
        );
    }

    #[test]
    fn inserted_column_does_not_flag_following_columns() {
        // 用户反馈：中间新增一列时，它后面的列不应被当作"位置变更"。
        // 源：id, x, y, z；目标：id, y, z → 只应有 ADD x 一条，y/z 天然在位
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![
                    col("id", "int", false),
                    col("x", "int", true),
                    col("y", "int", true),
                    col("z", "int", true),
                ],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("id", "int", false), col("y", "int", true), col("z", "int", true)],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["col:t:x"], "{items:?}");
        assert_eq!(
            items[0].sql.as_deref(),
            Some("ALTER TABLE `tgt`.`t` ADD COLUMN `x` int NULL AFTER `id`")
        );
    }

    #[test]
    fn each_type_modified_column_is_independently_selectable() {
        // 两列类型同时变化 → 两条独立 Modify，各自带完整列定义
        let col_v = |name: &str, len: &str| col(name, &format!("varchar({len})"), false);
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("id", "int", false), col_v("a", "20"), col_v("b", "50")],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("id", "int", false), col_v("a", "60"), col_v("b", "80")],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["col:t:a", "col:t:b"], "{items:?}");
        assert!(items.iter().all(|i| i.action == DiffAction::Modify));
        assert!(items[0].sql.as_deref().unwrap().contains("varchar(20)"));
        assert!(items[1].sql.as_deref().unwrap().contains("varchar(50)"));
    }

    #[test]
    fn empty_string_default_add_and_remove_detected() {
        // 源：name DEFAULT ''；目标：name 无默认值 → 应产出 Modify，SQL 带 DEFAULT ''
        let col_with_default = |default: Option<&str>| ColumnDef {
            name: "name".into(),
            data_type: "varchar(64)".into(),
            nullable: false,
            default: default.map(str::to_string),
            ..Default::default()
        };
        let src = snap(
            "src",
            vec![table("t", vec![col("id", "int", false), col_with_default(Some(""))], vec![])],
        );
        let tgt = snap(
            "tgt",
            vec![table("t", vec![col("id", "int", false), col_with_default(None)], vec![])],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].id, "col:t:name");
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("MODIFY COLUMN `name` varchar(64) NOT NULL DEFAULT ''"), "{sql}");

        // 反向：源无默认值、目标 DEFAULT '' → Modify 不带 DEFAULT（部署时移除该默认值）
        let items2 = diff(&tgt, &src);
        assert_eq!(items2.len(), 1, "{items2:?}");
        let sql2 = items2[0].sql.as_deref().unwrap();
        assert!(sql2.contains("MODIFY COLUMN `name` varchar(64) NOT NULL"), "{sql2}");
        assert!(!sql2.contains("DEFAULT"), "移除默认值时不应再带 DEFAULT: {sql2}");
    }

    #[test]
    fn type_and_position_change_emits_single_modify_with_after() {        // 列既改类型又错位：一条 MODIFY 同时带新定义与 AFTER
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![
                    col("a", "int", false),
                    col("b", "varchar(255)", false),
                    col("c", "int", true),
                ],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![
                    col("a", "int", false),
                    col("c", "int", true),
                    col("b", "varchar(64)", false),
                ],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].id, "col:t:b");
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("MODIFY COLUMN `b` varchar(255) NOT NULL AFTER `a`"), "{sql}");
    }

    #[test]
    fn table_drop_describes_columns_not_tables() {
        let src = snap("src", vec![]);
        let tgt = snap("tgt", vec![table("t", vec![col("id", "int", false), col("name", "varchar(64)", true)], vec![])]);
        let items = diff(&src, &tgt);
        let drop = items.iter().find(|i| i.id == "tbl:t").unwrap();
        assert_eq!(drop.target_desc.as_deref(), Some("2 个列，待删除"));
    }

    #[test]
    fn first_added_column_uses_first_clause() {
        // 源里 a 是第一列 → 新增到目标时用 FIRST；
        // ADD a FIRST 之后 id 天然落到 a 之后，不需要冗余的 MODIFY id AFTER a
        let src = snap("src", vec![table("t", vec![col("a", "int", true), col("id", "int", false)], vec![])]);
        let tgt = snap("tgt", vec![table("t", vec![col("id", "int", false)], vec![])]);
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].id, "col:t:a");
        assert!(items[0].sql.as_deref().unwrap().contains("ADD COLUMN `a` int NULL FIRST"), "{}", items[0].sql.as_deref().unwrap());
        // id 已在正确相对位置，不应产生差异项
        assert!(!items.iter().any(|i| i.id == "col:t:id"), "id 不应有差异项: {items:?}");
    }

    #[test]
    fn index_diffs() {
        let idx = |name: &str, cols: &[&str], unique: bool| IndexDef {
            name: name.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            sub_parts: vec![None; cols.len()],
            directions: vec![None; cols.len()],
            unique,
            is_primary: name == "PRIMARY",
            index_type: Some("BTREE".into()),
        };
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("id", "int", false), col("a", "int", true), col("b", "int", true)],
                vec![idx("PRIMARY", &["id"], true), idx("idx_new", &["a"], false)],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("id", "int", false), col("a", "int", true), col("b", "int", true)],
                vec![idx("PRIMARY", &["id"], true), idx("idx_old", &["b"], false)],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 2);
        let add = items.iter().find(|i| i.id == "idx:t:idx_new").unwrap();
        assert!(add.sql.as_deref().unwrap().contains("ADD INDEX `idx_new` (`a`)"));
        let drop = items.iter().find(|i| i.id == "idx:t:idx_old").unwrap();
        assert!(drop.dangerous);

        // 同名不同列 → Modify（DROP+ADD 同语句）
        let tgt2 = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("id", "int", false), col("a", "int", true), col("b", "int", true)],
                vec![idx("PRIMARY", &["id"], true), idx("idx_new", &["b"], false)],
            )],
        );
        let items2 = diff(&src, &tgt2);
        assert_eq!(items2.len(), 1);
        let m = &items2[0];
        assert_eq!(m.action, DiffAction::Modify);
        let sql = m.sql.as_deref().unwrap();
        assert!(sql.contains("DROP INDEX `idx_new`") && sql.contains("ADD INDEX `idx_new` (`a`)"), "{sql}");
    }

    #[test]
    fn index_prefix_diff_detected() {
        let idx = |name: &str, cols: &[&str], sub_parts: &[Option<u32>]| IndexDef {
            name: name.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            sub_parts: sub_parts.to_vec(),
            directions: vec![None; cols.len()],
            unique: false,
            is_primary: false,
            index_type: Some("BTREE".into()),
        };
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("a", "varchar(255)", true)],
                vec![idx("idx_a", &["a"], &[None])],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("a", "varchar(255)", true)],
                vec![idx("idx_a", &["a"], &[Some(10)])],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("DROP INDEX `idx_a`"), "{sql}");
        assert!(sql.contains("ADD INDEX `idx_a` (`a`)"), "{sql}");
    }

    #[test]
    fn index_direction_diff_detected() {
        let idx = |name: &str, cols: &[&str], dirs: &[Option<&str>]| IndexDef {
            name: name.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            sub_parts: vec![None; cols.len()],
            directions: dirs.iter().map(|d| d.map(|s| s.to_string())).collect(),
            unique: false,
            is_primary: false,
            index_type: Some("BTREE".into()),
        };
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("a", "int", true)],
                vec![idx("idx_a", &["a"], &[Some("DESC")])],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("a", "int", true)],
                vec![idx("idx_a", &["a"], &[None])],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("DROP INDEX `idx_a`"), "{sql}");
        assert!(sql.contains("ADD INDEX `idx_a` (`a` DESC)"), "{sql}");
    }

    #[test]
    fn index_diffs_skipped_when_compare_indexes_false() {
        let idx = |name: &str, cols: &[&str]| IndexDef {
            name: name.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            sub_parts: vec![None; cols.len()],
            directions: vec![None; cols.len()],
            unique: false,
            is_primary: false,
            index_type: Some("BTREE".into()),
        };
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("a", "int", true)],
                vec![idx("idx_a", &["a"])],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table("t", vec![col("a", "int", true)], vec![])],
        );
        let opts = CompareOptions {
            compare_indexes: false,
            ..Default::default()
        };
        let items = diff_snapshots(&src, &tgt, &opts);
        assert!(items.is_empty(), "索引对比关闭时不应产生差异: {items:?}");
    }

    fn view(name: &str, definition: &str) -> ViewDef {
        ViewDef {
            name: name.into(),
            definition: definition.into(),
        }
    }

    fn snap_with_views(
        db: &str,
        tables: Vec<TableDef>,
        views: Vec<ViewDef>,
    ) -> SchemaSnapshot {
        SchemaSnapshot {
            database: db.into(),
            tables,
            views,
        }
    }

    #[test]
    fn view_diffs() {
        let src = snap_with_views(
            "src",
            vec![],
            vec![
                view("v1", "SELECT `id` FROM `users`"),
                view("v2", "SELECT 1"),
            ],
        );
        let tgt = snap_with_views(
            "tgt",
            vec![],
            vec![
                view("v1", "SELECT `id`, `name` FROM `users`"),
                view("v3", "SELECT 2"),
            ],
        );
        let opts = CompareOptions {
            compare_views: true,
            ..Default::default()
        };
        let items = diff_snapshots(&src, &tgt, &opts);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["view:v1", "view:v2", "view:v3"], "差异清单: {ids:?}");

        let create = items.iter().find(|i| i.id == "view:v2").unwrap();
        assert_eq!(create.action, DiffAction::Create);
        assert!(
            create.sql.as_deref().unwrap().contains("CREATE VIEW `tgt`.`v2`"),
            "{}",
            create.sql.as_deref().unwrap()
        );

        let alter = items.iter().find(|i| i.id == "view:v1").unwrap();
        assert_eq!(alter.action, DiffAction::Modify);
        assert!(
            alter.sql.as_deref().unwrap().contains("ALTER VIEW `tgt`.`v1`"),
            "{}",
            alter.sql.as_deref().unwrap()
        );

        let drop = items.iter().find(|i| i.id == "view:v3").unwrap();
        assert_eq!(drop.action, DiffAction::Drop);
        assert!(drop.dangerous);
    }

    #[test]
    fn view_diffs_skipped_by_default() {
        let src = snap_with_views("src", vec![], vec![view("v1", "SELECT 1")]);
        let tgt = snap_with_views("tgt", vec![], vec![]);
        // 默认 compare_views = false
        let items = diff(&src, &tgt);
        assert!(items.is_empty(), "视图默认不参与对比: {items:?}");
    }

    #[test]
    fn primary_key_rebuild_preserves_auto_increment() {
        let idx =
            |name: &str, cols: &[&str], unique: bool, primary: bool| IndexDef {
                name: name.into(),
                columns: cols.iter().map(|s| s.to_string()).collect(),
                sub_parts: vec![None; cols.len()],
                directions: vec![None; cols.len()],
                unique,
                is_primary: primary,
                index_type: Some("BTREE".into()),
            };
        let mut id_col = col("id", "int", false);
        id_col.extra = "auto_increment".into();
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![id_col.clone(), col("a", "int", false)],
                vec![idx("PRIMARY", &["id", "a"], true, true)],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![id_col.clone(), col("a", "int", false)],
                vec![idx("PRIMARY", &["id"], true, true)],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        let sql = items[0].sql.as_deref().unwrap();
        // 先去掉 AUTO_INCREMENT，改主键，再加回 AUTO_INCREMENT
        assert!(sql.contains("MODIFY COLUMN `id` int NOT NULL"), "{sql}");
        assert!(sql.contains("DROP PRIMARY KEY"), "{sql}");
        assert!(sql.contains("ADD PRIMARY KEY (`id`,`a`)"), "{sql}");
        assert!(sql.contains("MODIFY COLUMN `id` int NOT NULL AUTO_INCREMENT"), "{sql}");
    }

    #[test]
    fn column_order_change_moves_only_misplaced_column() {
        // 源：a, b, c；目标：a, c, b → 只移动 b 到 a 后面；c 天然在位不动
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("a", "int", false), col("b", "int", true), col("c", "int", true)],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("a", "int", false), col("c", "int", true), col("b", "int", true)],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].id, "col:t:b");
        let sql = items[0].sql.as_deref().unwrap();
        assert_eq!(sql, "ALTER TABLE `tgt`.`t` MODIFY COLUMN `b` int NULL AFTER `a`");
    }

    #[test]
    fn column_swap_moves_only_misplaced_column() {
        // 纯换位：源 a,b,c,d；目标 a,c,b,d → 只动 b 一条
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![
                    col("a", "int", false),
                    col("b", "int", true),
                    col("c", "int", true),
                    col("d", "int", true),
                ],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![
                    col("a", "int", false),
                    col("c", "int", true),
                    col("b", "int", true),
                    col("d", "int", true),
                ],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].id, "col:t:b");
    }

    #[test]
    fn table_options_diff() {
        let mut src_t = table("t", vec![col("id", "int", false)], vec![]);
        src_t.comment = Some("新注释".into());
        let mut tgt_t = table("t", vec![col("id", "int", false)], vec![]);
        tgt_t.comment = Some("旧注释".into());
        tgt_t.engine = Some("MyISAM".into());
        let items = diff(&snap("src", vec![src_t]), &snap("tgt", vec![tgt_t]));
        assert_eq!(items.len(), 1);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("ENGINE=InnoDB") && sql.contains("COMMENT='新注释'"), "{sql}");
    }

    #[test]
    fn table_collation_diff() {
        let mut src_t = table("t", vec![col("id", "int", false)], vec![]);
        src_t.collation = Some("utf8mb4_general_ci".into());
        let mut tgt_t = table("t", vec![col("id", "int", false)], vec![]);
        tgt_t.collation = Some("utf8mb4_0900_ai_ci".into());
        let items = diff(&snap("src", vec![src_t]), &snap("tgt", vec![tgt_t]));
        assert_eq!(items.len(), 1);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(
            sql.contains("DEFAULT CHARACTER SET `utf8mb4` COLLATE `utf8mb4_general_ci`"),
            "{sql}"
        );
    }

    #[test]
    fn column_collation_diff_detected() {
        let col_coll = |name: &str, dt: &str, nullable: bool, collation: &str| ColumnDef {
            name: name.into(),
            data_type: dt.into(),
            nullable,
            collation: Some(collation.into()),
            ..Default::default()
        };
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col_coll("name", "varchar(64)", false, "utf8mb4_general_ci")],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col_coll("name", "varchar(64)", false, "utf8mb4_0900_ai_ci")],
                vec![],
            )],
        );
        let items = diff(&src, &tgt);
        assert_eq!(items.len(), 1);
        let m = &items[0];
        assert_eq!(m.id, "col:t:name");
        let sql = m.sql.as_deref().unwrap();
        assert!(sql.contains("COLLATE `utf8mb4_general_ci`"), "{sql}");
        assert!(m.source_desc.as_deref().unwrap().contains("COLLATE=utf8mb4_general_ci"));
        assert!(m.target_desc.as_deref().unwrap().contains("COLLATE=utf8mb4_0900_ai_ci"));
    }

    #[test]
    fn ordinal_change_alone_is_not_a_diff() {
        // 列对比忽略 ordinal：相同列集合（无论顺序）不产生差异
        let t = table("t", vec![col("id", "int", false), col("x", "int", true)], vec![]);
        let items = diff(&snap("s", vec![t.clone()]), &snap("t", vec![t]));
        assert!(items.is_empty());
    }

    #[test]
    fn zero_ordinal_does_not_panic() {
        // 回归：ordinal 兜底为 0 时位置检测不得 u32 下溢 panic
        // （真实库里 ORDINAL_POSITION 类型转换失败的兜底值曾导致对比挂死）
        let cols = || {
            vec![
                ColumnDef { name: "id".into(), data_type: "int".into(), nullable: false, ordinal: 0, ..Default::default() },
                ColumnDef { name: "name".into(), data_type: "varchar(64)".into(), nullable: true, ordinal: 0, ..Default::default() },
            ]
        };
        let src = snap("src", vec![TableDef { name: "t".into(), columns: cols(), ..Default::default() }]);
        let tgt = snap("tgt", vec![TableDef { name: "t".into(), columns: cols(), ..Default::default() }]);
        // 只要不平 panic 即可；ordinal 全 0 时无法判断位置，不产生位置差异
        let items = diff(&src, &tgt);
        assert!(items.is_empty(), "{items:?}");
    }

    // ───────────────── e2e：docker/testenv（DBFLOW_E2E=1） ─────────────────

    mod e2e {
        use super::diff;
        use crate::config::model::{ConnectionProfile, DatabaseKind, SshAuth, SshTunnelConfig};
        use crate::datasource::mysql::{self, ConnectEndpoint, MySqlLive};
        use crate::datasource::LiveConnection;
        use crate::tunnel::{HostKeyPolicy, SshCredential, TunnelManager};

        fn enabled() -> bool {
            std::env::var("DBFLOW_E2E").is_ok()
        }

        fn profile(host: &str, port: u16, _pw: &str) -> ConnectionProfile {
            ConnectionProfile {
                id: uuid::Uuid::new_v4(),
                name: "e2e-compare".into(),
                group_id: None,
                color: None,
                db: DatabaseKind::MySql,
                host: host.into(),
                port,
                user: "root".into(),
                default_database: None,
                has_password: true,
                ssh_has_password: false,
                remember_password: false,
                options: Default::default(),
                ssh: None,
                created_at: 0,
                updated_at: 0,
            }
        }

        /// mysql-a(直连) 作为源，经 SSH 隧道连 mysql-b 作为目标：
        /// 测试自建 db_shop_old（源库的"旧版本"），对比 → 全量部署 → 复比为空
        #[tokio::test]
        async fn e2e_compare_roundtrip_via_tunnel() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            // 源：mysql-a 直连
            let endpoint_a = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
            let pool_a = mysql::open_pool(&profile("127.0.0.1", 3306, ""), &endpoint_a, Some("dbflow-a-2026"))
                .await
                .expect("连接 mysql-a 失败");
            let src = MySqlLive::new(pool_a, None);

            // 目标：mysql-b 经跳板
            let manager = TunnelManager::default();
            let ssh_cfg = SshTunnelConfig {
                host: "127.0.0.1".into(),
                port: 2222,
                user: "dbjump".into(),
                auth: SshAuth::Password,
                target_host_override: Some("mysql-b".into()),
            };
            let cred = SshCredential::Password("dbflow-jump-2026".into());
            let no_policy = HostKeyPolicy { trusted_fingerprint: None, use_known_hosts: false };
            let fingerprint = match manager.acquire(&ssh_cfg, "mysql-b", 3306, &cred, no_policy).await {
                Err(crate::error::AppError::HostKeyUnknown { fingerprint }) => fingerprint,
                other => panic!("首次未信任应报 HostKeyUnknown，实际 {:?}", other.map(|_| ())),
            };
            let lease = manager
                .acquire(&ssh_cfg, "mysql-b", 3306, &cred, HostKeyPolicy {
                    trusted_fingerprint: Some(fingerprint),
                    use_known_hosts: false,
                })
                .await
                .expect("隧道建立失败");
            let (t_host, t_port) = lease.endpoint();
            let endpoint_b = ConnectEndpoint { host: t_host, port: t_port };
            let pool_b = mysql::open_pool(&profile("mysql-b", 3306, ""), &endpoint_b, Some("dbflow-b-2026"))
                .await
                .expect("经隧道连接 mysql-b 失败");
            let tgt = MySqlLive::new(pool_b, Some(lease));

            // 在目标端自建"旧版 db_shop"差异样本（幂等：先删后建）
            let fixture = [
                "DROP DATABASE IF EXISTS `db_shop_old`",
                "CREATE DATABASE `db_shop_old` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_shop_old`.`customer` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',\
                   `name` varchar(64) NOT NULL COMMENT '客户姓名',\
                   `phone` varchar(32) DEFAULT NULL COMMENT '手机号',\
                   `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',\
                   PRIMARY KEY (`id`), UNIQUE KEY `uk_phone` (`phone`)\
                 ) ENGINE=InnoDB COMMENT='客户表'",
                "CREATE TABLE `db_shop_old`.`orders` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '订单号',\
                   `customer_id` bigint unsigned NOT NULL COMMENT '客户ID',\
                   `amount` decimal(12,2) NOT NULL DEFAULT '0.00' COMMENT '金额',\
                   `remark` varchar(255) DEFAULT NULL COMMENT '备注',\
                   PRIMARY KEY (`id`), KEY `idx_amount` (`amount`)\
                 ) ENGINE=InnoDB COMMENT='订单'",
                "CREATE TABLE `db_shop_old`.`promo` (`id` int NOT NULL, `title` varchar(64), PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ];
            for sql in fixture {
                tgt.execute(sql).await.expect("建差异样本失败");
            }

            // 对比
            let snap_src = src.snapshot_schema("db_shop").await.expect("源快照");
            let snap_tgt = tgt.snapshot_schema("db_shop_old").await.expect("目标快照");
            let items = diff(&snap_src, &snap_tgt);
            let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
            assert_eq!(
                ids,
                vec![
                    "col:customer:phone",        // phone 类型不同 → 单独一条 MODIFY
                    "col:customer:level",        // 缺列 → 单独一条 ADD（AFTER phone）
                    "tblopt:orders",             // 表注释不同
                    "col:orders:status",         // 缺列 → 新增
                    "col:orders:remark",         // 目标多余列 → 删除
                    "idx:orders:idx_customer",   // 缺索引 → 新增
                    "idx:orders:idx_amount",     // 目标多余索引 → 删除
                    "tbl:promo",                 // 目标多余表 → 删除
                ],
                "差异清单不符: {ids:?}"
            );
            assert!(items.iter().filter(|i| i.dangerous).count() == 3);

            // DDL 对比视图数据：每项带两端完整建表语句，缺端为 None
            let promo = items.iter().find(|i| i.id == "tbl:promo").unwrap();
            assert!(promo.source_ddl.is_none(), "目标独有表不应有源 DDL");
            assert!(promo.target_ddl.as_deref().unwrap().contains("CREATE TABLE `db_shop_old`.`promo`"));
            let phone = items.iter().find(|i| i.id == "col:customer:phone").unwrap();
            assert!(
                phone.source_ddl.as_deref().unwrap().contains("CREATE TABLE `db_shop`.`customer`")
                    && phone.source_ddl.as_deref().unwrap().contains("varchar(20)"),
                "源 DDL 应为源库名与源形态"
            );
            assert!(
                phone.target_ddl.as_deref().unwrap().contains("CREATE TABLE `db_shop_old`.`customer`")
                    && phone.target_ddl.as_deref().unwrap().contains("varchar(32)"),
                "目标 DDL 应为目标库名与目标形态"
            );

            // 全量部署（含危险项）→ 每条都应成功
            for item in &items {
                let sql = item.sql.as_deref().expect("每项都应有 SQL");
                tgt.execute(sql).await.unwrap_or_else(|e| panic!("执行失败 [{sql}]: {e}"));
            }

            // 复比应为空
            let snap_after = tgt.snapshot_schema("db_shop_old").await.expect("复比快照");
            let remain = diff(&snap_src, &snap_after);
            assert!(remain.is_empty(), "部署后仍有差异: {:?}", remain.iter().map(|i| &i.id).collect::<Vec<_>>());

            // 清理
            tgt.execute("DROP DATABASE `db_shop_old`").await.unwrap();
            tgt.shutdown().await;
            src.shutdown().await;
        }

        /// 回归：5.6 上 list_databases/list_tables/describe_table 三件套
        /// （历史 bug：5.6 结果列名按 SELECT 原文回显，按大写名取值会静默丢行返回空）
        #[tokio::test]
        async fn e2e_mysql56_browse() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint, Some("123123"))
                .await
                .expect("连接 mysql56 失败");
            let live = MySqlLive::new(pool, None);

            let dbs = live.list_databases().await.expect("list_databases 失败");
            let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
            assert!(names.contains(&"db_shop"), "5.6 库列表不含 db_shop: {names:?}");

            let tables = live.list_tables("db_shop").await.expect("list_tables 失败");
            let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
            assert!(tnames.contains(&"customer") && tnames.contains(&"orders"), "{tnames:?}");
            let customer = tables.iter().find(|t| t.name == "customer").unwrap();
            assert_eq!(customer.comment.as_deref(), Some("客户表"), "中文注释: {customer:?}");

            let cols = live.describe_table("db_shop", "customer").await.expect("describe_table 失败");
            assert!(cols.len() >= 5, "列数异常: {cols:?}");
            assert!(cols.iter().any(|c| c.key == "PRI" && c.name == "id"));

            live.shutdown().await;
        }

        /// 字段级差异检测回归：只改 varchar 长度 / decimal 精度，必须逐条比出来
        /// （用户反馈"字段长度不一样没对比出来"——本测试锁定该能力）。
        /// 同版本（8.x vs 8.x）与跨版本（8.x vs 5.6）两组都验。
        #[tokio::test]
        async fn e2e_field_level_diff_detected() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint_a = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
            let pool_a = mysql::open_pool(&profile("127.0.0.1", 3306, ""), &endpoint_a, Some("dbflow-a-2026"))
                .await
                .expect("连接 mysql-a 失败");
            let a = MySqlLive::new(pool_a, None);

            // 同版本样本：两边仅 name 长度与 price 精度不同
            let fixture = [
                "DROP DATABASE IF EXISTS `db_len_a`",
                "DROP DATABASE IF EXISTS `db_len_b`",
                "CREATE DATABASE `db_len_a` DEFAULT CHARACTER SET utf8mb4",
                "CREATE DATABASE `db_len_b` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_len_a`.`t1` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(50) NOT NULL COMMENT '名字',\
                   `price` decimal(10,2) NOT NULL DEFAULT 0.00,\
                   `note` varchar(255) NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
                "CREATE TABLE `db_len_b`.`t1` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(200) NOT NULL COMMENT '名字',\
                   `price` decimal(12,4) NOT NULL DEFAULT 0.00,\
                   `note` varchar(255) NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ];
            for sql in fixture {
                a.execute(sql).await.unwrap();
            }

            let s = a.snapshot_schema("db_len_a").await.unwrap();
            let t = a.snapshot_schema("db_len_b").await.unwrap();
            let items = diff(&s, &t);
            eprintln!("同版本差异: {items:#?}");
            let name_diff = items.iter().find(|i| i.id == "col:t1:name")
                .unwrap_or_else(|| panic!("varchar(50) vs varchar(200) 没比出来！全部: {items:?}"));
            assert!(name_diff.sql.as_deref().unwrap().contains("varchar(50)"));
            let price_diff = items.iter().find(|i| i.id == "col:t1:price")
                .unwrap_or_else(|| panic!("decimal(10,2) vs decimal(12,4) 没比出来！全部: {items:?}"));
            assert!(price_diff.sql.as_deref().unwrap().contains("decimal(10,2)"));
            assert!(!items.iter().any(|i| i.id == "col:t1:id" || i.id == "col:t1:note"),
                "无差异的列不应出现: {items:?}");

            // 跨版本样本：5.6 上建同构表，仅 name 是真实长度差异 varchar(50) vs varchar(60)
            let endpoint56 = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool56 = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint56, Some("123123"))
                .await
                .expect("连接 mysql56 失败");
            let l56 = MySqlLive::new(pool56, None);
            let fixture56 = [
                "DROP DATABASE IF EXISTS `db_len_c`",
                "CREATE DATABASE `db_len_c` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_len_c`.`t1` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(60) NOT NULL COMMENT '名字',\
                   `price` decimal(10,2) NOT NULL DEFAULT 0.00,\
                   `note` varchar(255) NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ];
            for sql in fixture56 {
                l56.execute(sql).await.unwrap();
            }
            let t56 = l56.snapshot_schema("db_len_c").await.unwrap();
            let items_xv = diff(&s, &t56);
            eprintln!("跨版本差异: {items_xv:#?}");
            assert_eq!(items_xv.len(), 1, "跨版本应只有 name 一项真实差异: {items_xv:?}");
            assert_eq!(items_xv[0].id, "col:t1:name");
            assert!(items_xv[0].sql.as_deref().unwrap().contains("varchar(50)"));

            // 清理
            a.execute("DROP DATABASE `db_len_a`").await.unwrap();
            a.execute("DROP DATABASE `db_len_b`").await.unwrap();
            l56.execute("DROP DATABASE `db_len_c`").await.unwrap();
            a.shutdown().await;
            l56.shutdown().await;
        }

        /// 跨版本归一化回归：同一份 DDL 在 8.4 与 5.6 上各自建好后，
        /// 对比应为零差异（整数显示宽度 int(11) vs int 等已归一化）。
        /// 5.6 侧的 db_shop 由本测试自建（幂等）。
        #[tokio::test]
        async fn e2e_cross_version_normalized() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint56 = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool56 = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint56, Some("123123"))
                .await
                .expect("连接 mysql56 失败");
            let l56 = MySqlLive::new(pool56, None);

            // 用独立库名 db_shop_xv，避免与并行的 browse 测试争用 db_shop
            let fixture = [
                "SET NAMES utf8mb4",
                "DROP DATABASE IF EXISTS `db_shop_xv`",
                "CREATE DATABASE `db_shop_xv` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_shop_xv`.`customer` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',\
                   `name` varchar(64) NOT NULL COMMENT '客户姓名',\
                   `phone` varchar(20) DEFAULT NULL COMMENT '手机号',\
                   `level` tinyint NOT NULL DEFAULT '1' COMMENT '等级 1普通 2VIP 3SVIP',\
                   `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',\
                   PRIMARY KEY (`id`), UNIQUE KEY `uk_phone` (`phone`)\
                 ) ENGINE=InnoDB COMMENT='客户表'",
                "CREATE TABLE `db_shop_xv`.`orders` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '订单号',\
                   `customer_id` bigint unsigned NOT NULL COMMENT '客户ID',\
                   `amount` decimal(12,2) NOT NULL DEFAULT '0.00' COMMENT '金额',\
                   `status` varchar(16) NOT NULL DEFAULT 'created' COMMENT '状态',\
                   PRIMARY KEY (`id`), KEY `idx_customer` (`customer_id`)\
                 ) ENGINE=InnoDB COMMENT='订单表'",
            ];
            for sql in fixture {
                l56.execute(sql).await.expect("5.6 建同构样本失败");
            }

            // 源：8.4 的 db_shop_xv（init-a.sql 建的）
            let endpoint_a = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
            let pool_a = mysql::open_pool(&profile("127.0.0.1", 3306, ""), &endpoint_a, Some("dbflow-a-2026"))
                .await
                .expect("连接 mysql-a 失败");
            let l8 = MySqlLive::new(pool_a, None);

            let s8 = l8.snapshot_schema("db_shop_xv").await.unwrap();
            let s56 = l56.snapshot_schema("db_shop_xv").await.unwrap();
            let items = diff(&s8, &s56);
            assert!(
                items.is_empty(),
                "8.4 vs 5.6 同构库出现假差异: {:?}",
                items.iter().map(|i| format!("{} [{}|{}]", i.id, i.source_desc.clone().unwrap_or_default(), i.target_desc.clone().unwrap_or_default())).collect::<Vec<_>>()
            );

            l56.shutdown().await;
            l8.shutdown().await;
        }

        /// MySQL 5.6 冒烟：建两个差异库 → 对比 → 部署 → 复比为空（验证旧版兼容性）
        #[tokio::test]
        async fn e2e_mysql56_compare_smoke() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint, Some("123123"))
                .await
                .expect("连接 mysql56 失败（容器没起？）");
            let live = MySqlLive::new(pool, None);

            let setup = [
                "DROP DATABASE IF EXISTS `dbflow_cmp_a`",
                "DROP DATABASE IF EXISTS `dbflow_cmp_b`",
                "CREATE DATABASE `dbflow_cmp_a` DEFAULT CHARACTER SET utf8mb4",
                "CREATE DATABASE `dbflow_cmp_b` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `dbflow_cmp_a`.`t` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(64) NOT NULL DEFAULT '' COMMENT '名称',\
                   `flag` tinyint(1) NOT NULL DEFAULT '0',\
                   PRIMARY KEY (`id`), KEY `idx_name` (`name`)\
                 ) ENGINE=InnoDB COMMENT='测试表'",
            ];
            for sql in setup {
                live.execute(sql).await.expect("5.6 建样本失败");
            }

            let a = live.snapshot_schema("dbflow_cmp_a").await.expect("5.6 源快照");
            let b = live.snapshot_schema("dbflow_cmp_b").await.expect("5.6 目标快照");
            let items = diff(&a, &b);
            assert_eq!(items.len(), 1, "{items:?}");
            assert_eq!(items[0].id, "tbl:t");

            live.execute(items[0].sql.as_deref().unwrap()).await.expect("5.6 建表部署失败");

            let b2 = live.snapshot_schema("dbflow_cmp_b").await.unwrap();
            assert!(diff(&a, &b2).is_empty(), "5.6 部署后仍有差异");

            // 中文注释经 5.6 往返无损
            assert_eq!(b2.tables[0].comment.as_deref(), Some("测试表"));

            live.execute("DROP DATABASE `dbflow_cmp_a`").await.unwrap();
            live.execute("DROP DATABASE `dbflow_cmp_b`").await.unwrap();
            live.shutdown().await;
        }
    }
}
