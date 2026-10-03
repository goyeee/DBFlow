//! 差异项 → 目标端可执行 SQL 生成。
//! 规则：
//! - 所有标识符用反引号包裹（内部反引号转义为两个）
//! - 字符串字面量/注释用单引号包裹（内部单引号转义为两个）
//! - 默认值按列类型决定是否加引号（information_schema 返回的是裸值文本）
//! - 生成 5.6 / 8.x 都可执行的语法
use crate::datasource::{ColumnDef, ForeignKeyDef, IndexDef, TableDef};

/// 标识符转义：`a``b` 形式
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// 库.表 全限定
pub fn qualified(db: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(db), quote_ident(table))
}

/// 字符串字面量：'a''b'
pub fn quote_string(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// 数值/时间原生类型——默认值不需要引号
fn is_unquoted_default_type(data_type: &str) -> bool {
    let t = data_type
        .split('(')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        t.as_str(),
        "int" | "integer" | "tinyint" | "smallint" | "mediumint" | "bigint"
            | "decimal" | "numeric" | "float" | "double" | "bit" | "year"
    )
}

/// 默认值字面量：归一化后的 current_timestamp 或表达式（含函数调用的）不加引号；
/// 字符串/枚举/时间字面量类型的默认值加引号
fn default_literal(data_type: &str, default: &str) -> String {
    let d = default.trim();
    let looks_expression = d.eq_ignore_ascii_case("current_timestamp")
        || d.eq_ignore_ascii_case("now()")
        || d.ends_with(')')
        || d.starts_with('(');
    if looks_expression || is_unquoted_default_type(data_type) {
        d.to_string()
    } else {
        quote_string(d)
    }
}

/// 单列完整 DDL 片段：`name` type [CHARACTER SET .. COLLATE ..] [NOT NULL|NULL] [DEFAULT ..] [extra] [COMMENT '..']
pub fn column_ddl(c: &ColumnDef) -> String {
    let mut s = format!("{} {}", quote_ident(&c.name), c.data_type);
    if let Some(coll) = &c.collation {
        let charset = c.character_set.as_deref().unwrap_or_else(|| coll.split('_').next().unwrap_or(coll));
        s.push_str(&format!(
            " CHARACTER SET {} COLLATE {}",
            quote_ident(charset),
            quote_ident(coll)
        ));
    } else if let Some(cs) = &c.character_set {
        s.push_str(&format!(" CHARACTER SET {}", quote_ident(cs)));
    }
    s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
    if let Some(d) = &c.default {
        s.push_str(&format!(" DEFAULT {}", default_literal(&c.data_type, d)));
    }
    if !c.extra.is_empty() {
        s.push(' ');
        s.push_str(&c.extra.to_uppercase());
    }
    if let Some(cm) = &c.comment {
        s.push_str(&format!(" COMMENT {}", quote_string(cm)));
    }
    s
}

/// UI 差异描述：不带列名的形态（类型/字符集/可空/默认值/extra/注释）
pub fn describe_column(c: &ColumnDef) -> String {
    let mut s = c.data_type.clone();
    if let Some(coll) = &c.collation {
        let charset = c.character_set.as_deref().unwrap_or_else(|| coll.split('_').next().unwrap_or(coll));
        s.push_str(&format!(" CHARSET={} COLLATE={}", charset, coll));
    } else if let Some(cs) = &c.character_set {
        s.push_str(&format!(" CHARSET={}", cs));
    }
    s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
    if let Some(d) = &c.default {
        s.push_str(&format!(" DEFAULT {}", default_literal(&c.data_type, d)));
    }
    if !c.extra.is_empty() {
        s.push(' ');
        s.push_str(&c.extra);
    }
    if let Some(cm) = &c.comment {
        s.push_str(&format!(" COMMENT {}", quote_string(cm)));
    }
    s
}

pub fn describe_index(i: &IndexDef) -> String {
    let kind = if i.is_primary {
        "PRIMARY KEY"
    } else if i.unique {
        "UNIQUE"
    } else if i.index_type.as_deref() == Some("FULLTEXT") {
        "FULLTEXT"
    } else {
        "INDEX"
    };
    let cols = index_column_specs(i);
    format!("{} ({})", kind, cols.join(","))
}

fn index_column_specs(i: &IndexDef) -> Vec<String> {
    i.columns
        .iter()
        .enumerate()
        .map(|(idx, c)| {
            let mut s = quote_ident(c);
            if let Some(Some(len)) = i.sub_parts.get(idx) {
                s.push_str(&format!("({len})"));
            }
            if let Some(Some(dir)) = i.directions.get(idx) {
                s.push(' ');
                s.push_str(dir);
            }
            s
        })
        .collect()
}

pub fn describe_table_options(t: &TableDef) -> String {
    let mut parts = vec![format!(
        "ENGINE={}",
        t.engine.as_deref().unwrap_or("-")
    )];
    if let Some(coll) = &t.collation {
        let charset = coll.split('_').next().unwrap_or(coll);
        parts.push(format!("CHARSET={charset}"));
        parts.push(format!("COLLATE={coll}"));
    }
    parts.push(format!(
        "COMMENT={}",
        t.comment.as_deref().unwrap_or("")
    ));
    parts.join(" ")
}

/// 索引 DDL 片段：PRIMARY KEY (`id`) / UNIQUE KEY `uk` / FULLTEXT KEY / SPATIAL KEY / KEY
fn index_ddl(i: &IndexDef) -> String {
    let cols = index_column_specs(i).join(",");
    if i.is_primary {
        format!("PRIMARY KEY ({cols})")
    } else {
        // FULLTEXT/SPATIAL 必须保留其类型前缀，否则会被建成普通二级索引、语义改变
        let kind = match i.index_type.as_deref() {
            Some("FULLTEXT") => "FULLTEXT ",
            Some("SPATIAL") => "SPATIAL ",
            _ => {
                if i.unique {
                    "UNIQUE "
                } else {
                    ""
                }
            }
        };
        format!("{kind}KEY {} ({cols})", quote_ident(&i.name))
    }
}

fn index_kind_prefix(i: &IndexDef) -> String {
    if i.is_primary {
        "PRIMARY KEY".to_string()
    } else if i.index_type.as_deref() == Some("FULLTEXT") {
        format!("FULLTEXT INDEX {}", quote_ident(&i.name))
    } else if i.unique {
        format!("UNIQUE INDEX {}", quote_ident(&i.name))
    } else {
        format!("INDEX {}", quote_ident(&i.name))
    }
}

/// 完整建表（源表在目标端重建）
pub fn create_table_sql(db: &str, t: &TableDef) -> String {
    let mut parts: Vec<String> = t.columns.iter().map(column_ddl).collect();
    parts.extend(t.indexes.iter().map(index_ddl));
    let mut sql = format!(
        "CREATE TABLE {} (\n  {}\n)",
        qualified(db, &t.name),
        parts.join(",\n  ")
    );
    if let Some(engine) = &t.engine {
        sql.push_str(&format!(" ENGINE={engine}"));
    }
    if let Some(collation) = &t.collation {
        // collation（如 utf8mb4_0900_ai_ci）→ charset 取第一个 '_' 前
        let charset = collation.split('_').next().unwrap_or(collation);
        sql.push_str(&format!(" DEFAULT CHARSET={charset} COLLATE={collation}"));
    }
    if let Some(comment) = &t.comment {
        sql.push_str(&format!(" COMMENT={}", quote_string(comment)));
    }
    sql
}

/// 外键 DDL（ER 图导出 DDL / ER 建模应用用）
pub fn foreign_key_ddl(db: &str, fk: &ForeignKeyDef) -> String {
    format!(
        "ALTER TABLE {} {}",
        qualified(db, &fk.table),
        add_foreign_key_clause(db, fk)
    )
}

/// ADD CONSTRAINT 子句（不含 ALTER TABLE 前缀），供整句与重建语句复用
pub fn add_foreign_key_clause(db: &str, fk: &ForeignKeyDef) -> String {
    let cols = fk.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let ref_cols = fk.ref_columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let mut s = format!(
        "ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote_ident(&fk.name),
        cols,
        qualified(db, &fk.ref_table),
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

/// DROP FOREIGN KEY 语句
pub fn drop_foreign_key_ddl(db: &str, table: &str, fk_name: &str) -> String {
    format!(
        "ALTER TABLE {} DROP FOREIGN KEY {}",
        qualified(db, table),
        quote_ident(fk_name)
    )
}

/// ADD 子句（不含 ALTER TABLE 前缀），供同表多个列变更合并为一条 ALTER 时复用
pub fn add_column_clause(c: &ColumnDef, after: Option<&str>) -> String {    let mut sql = format!("ADD COLUMN {}", column_ddl(c));
    match after {
        Some(prev) => sql.push_str(&format!(" AFTER {}", quote_ident(prev))),
        None => sql.push_str(" FIRST"),
    }
    sql
}

/// MODIFY 子句（不含 ALTER TABLE 前缀）。
/// after：None = 不带位置；Some(None) = FIRST；Some(Some("col")) = AFTER col。
pub fn modify_column_clause(c: &ColumnDef, after: Option<Option<&str>>) -> String {
    let mut sql = format!("MODIFY COLUMN {}", column_ddl(c));
    match after {
        None => {}
        Some(None) => sql.push_str(" FIRST"),
        Some(Some(prev)) => sql.push_str(&format!(" AFTER {}", quote_ident(prev))),
    }
    sql
}

/// DROP 子句（不含 ALTER TABLE 前缀），供同表列变更合并为一条 ALTER 时复用
pub fn drop_column_clause(column: &str) -> String {
    format!("DROP COLUMN {}", quote_ident(column))
}

pub fn add_index_sql(db: &str, table: &str, i: &IndexDef) -> String {
    let cols = index_column_specs(i).join(",");
    format!(
        "ALTER TABLE {} ADD {} ({})",
        qualified(db, table),
        index_kind_prefix(i),
        cols
    )
}

pub fn create_view_sql(db: &str, v: &crate::datasource::ViewDef) -> String {
    format!(
        "CREATE VIEW {} AS {}",
        qualified(db, &v.name),
        v.definition
    )
}

pub fn alter_view_sql(db: &str, v: &crate::datasource::ViewDef) -> String {
    format!(
        "ALTER VIEW {} AS {}",
        qualified(db, &v.name),
        v.definition
    )
}

pub fn drop_view_sql(db: &str, v: &crate::datasource::ViewDef) -> String {
    format!("DROP VIEW {}", qualified(db, &v.name))
}

pub fn describe_view(v: &crate::datasource::ViewDef) -> String {
    v.definition.trim().to_string()
}

pub fn drop_index_sql(db: &str, table: &str, i: &IndexDef) -> String {
    if i.is_primary {
        format!("ALTER TABLE {} DROP PRIMARY KEY", qualified(db, table))
    } else {
        format!(
            "ALTER TABLE {} DROP INDEX {}",
            qualified(db, table),
            quote_ident(&i.name)
        )
    }
}

/// 同名索引列/唯一性变化：一条 ALTER 同时 DROP + ADD
/// 当主键重建且目标表存在 AUTO_INCREMENT 列时，会先把 AUTO_INCREMENT 去掉、改完主键再加回来，
/// 避免 MySQL "there can be only one auto column and it must be defined as a key" 错误。
pub fn rebuild_index_sql(
    db: &str,
    table: &str,
    i: &IndexDef,
    auto_inc_col: Option<&ColumnDef>,
) -> String {
    let cols = index_column_specs(i).join(",");
    let drop_part = if i.is_primary {
        "DROP PRIMARY KEY".to_string()
    } else {
        format!("DROP INDEX {}", quote_ident(&i.name))
    };

    let mut clauses: Vec<String> = Vec::new();
    if let Some(c) = auto_inc_col {
        let without_ai = ColumnDef {
            extra: strip_auto_increment(&c.extra),
            ..c.clone()
        };
        clauses.push(format!("MODIFY COLUMN {}", column_ddl(&without_ai)));
    }
    clauses.push(format!(
        "{} , ADD {} ({})",
        drop_part,
        index_kind_prefix(i),
        cols
    ));
    if let Some(c) = auto_inc_col {
        clauses.push(format!("MODIFY COLUMN {}", column_ddl(c)));
    }
    format!(
        "ALTER TABLE {} {}",
        qualified(db, table),
        clauses.join(", ")
    )
}

fn strip_auto_increment(extra: &str) -> String {
    extra
        .split_whitespace()
        .filter(|t| *t != "auto_increment")
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(name: &str, dt: &str, nullable: bool, default: Option<&str>) -> ColumnDef {
        ColumnDef {
            name: name.into(),
            data_type: dt.into(),
            nullable,
            default: default.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn quote_escapes() {
        assert_eq!(quote_ident("a`b"), "`a``b`");
        assert_eq!(quote_string("it's"), "'it''s'");
    }

    #[test]
    fn foreign_key_ddl_variants() {
        use crate::datasource::ForeignKeyDef;
        let fk = |name: &str, table: &str, cols: &[&str], rt: &str, rc: &[&str], del: Option<&str>, upd: Option<&str>| ForeignKeyDef {
            name: name.into(),
            table: table.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            ref_table: rt.into(),
            ref_columns: rc.iter().map(|s| s.to_string()).collect(),
            on_delete: del.map(str::to_string),
            on_update: upd.map(str::to_string),
        };
        // 单列 + 完整规则
        assert_eq!(
            foreign_key_ddl("db", &fk("fk_order", "order_items", &["order_id"], "orders", &["id"], Some("CASCADE"), Some("RESTRICT"))),
            "ALTER TABLE `db`.`order_items` ADD CONSTRAINT `fk_order` FOREIGN KEY (`order_id`) REFERENCES `db`.`orders` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT"
        );
        // 复合列、无规则
        assert_eq!(
            foreign_key_ddl("db", &fk("fk_multi", "t1", &["a", "b"], "t2", &["x", "y"], None, None)),
            "ALTER TABLE `db`.`t1` ADD CONSTRAINT `fk_multi` FOREIGN KEY (`a`, `b`) REFERENCES `db`.`t2` (`x`, `y`)"
        );
    }

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
            add_foreign_key_clause("db", &fk),
            "ADD CONSTRAINT `fk_order` FOREIGN KEY (`order_id`) REFERENCES `db`.`orders` (`id`) ON DELETE CASCADE"
        );
    }

    #[test]
    fn column_ddl_variants() {
        assert_eq!(column_ddl(&c("id", "bigint unsigned", false, None)), "`id` bigint unsigned NOT NULL");
        // 字符串默认值加引号
        assert_eq!(
            column_ddl(&c("name", "varchar(64)", false, Some("abc"))),
            "`name` varchar(64) NOT NULL DEFAULT 'abc'"
        );
        // 数值默认值不加引号
        assert_eq!(
            column_ddl(&c("level", "tinyint", false, Some("1"))),
            "`level` tinyint NOT NULL DEFAULT 1"
        );
        // current_timestamp 不加引号
        assert_eq!(
            column_ddl(&c("created", "datetime", false, Some("current_timestamp"))),
            "`created` datetime NOT NULL DEFAULT current_timestamp"
        );
        // 表达式默认值（8.0）不加引号
        assert_eq!(
            column_ddl(&c("v", "int", true, Some("(uuid_short())"))),
            "`v` int NULL DEFAULT (uuid_short())"
        );
    }

    #[test]
    fn create_table_full() {
        let t = TableDef {
            name: "customer".into(),
            engine: Some("InnoDB".into()),
            collation: Some("utf8mb4_general_ci".into()),
            comment: Some("客户'表'".into()),
            columns: vec![
                ColumnDef {
                    name: "id".into(),
                    data_type: "bigint unsigned".into(),
                    nullable: false,
                    extra: "auto_increment".into(),
                    ..Default::default()
                },
                c("name", "varchar(64)", false, None),
            ],
            indexes: vec![
                IndexDef { name: "PRIMARY".into(), columns: vec!["id".into()], sub_parts: vec![], directions: vec![], unique: true, is_primary: true, index_type: Some("BTREE".into()) },
                IndexDef { name: "uk_name".into(), columns: vec!["name".into()], sub_parts: vec![], directions: vec![], unique: true, is_primary: false, index_type: Some("BTREE".into()) },
            ],
        };
        let sql = create_table_sql("db", &t);
        assert!(sql.starts_with("CREATE TABLE `db`.`customer` ("), "{sql}");
        assert!(sql.contains("`id` bigint unsigned NOT NULL AUTO_INCREMENT"), "{sql}");
        assert!(sql.contains("PRIMARY KEY (`id`)"), "{sql}");
        assert!(sql.contains("UNIQUE KEY `uk_name` (`name`)"), "{sql}");
        assert!(sql.contains("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci"), "{sql}");
        assert!(sql.contains("COMMENT='客户''表'''"), "{sql}");
    }

    #[test]
    fn add_column_positioning() {
        assert_eq!(
            add_column_clause(&c("x", "int", true, None), Some("id")),
            "ADD COLUMN `x` int NULL AFTER `id`"
        );
        assert_eq!(
            add_column_clause(&c("x", "int", true, None), None),
            "ADD COLUMN `x` int NULL FIRST"
        );
    }

    #[test]
    fn index_ddl_special_types() {
        let mk = |name: &str, ty: &str| IndexDef {
            name: name.into(),
            columns: vec!["c".into()],
            sub_parts: vec![],
            directions: vec![],
            unique: false,
            is_primary: false,
            index_type: Some(ty.into()),
        };
        // FULLTEXT/SPATIAL 不得降级为普通 KEY
        assert_eq!(index_ddl(&mk("ft_body", "FULLTEXT")), "FULLTEXT KEY `ft_body` (`c`)");
        assert_eq!(index_ddl(&mk("sp_loc", "SPATIAL")), "SPATIAL KEY `sp_loc` (`c`)");
        // 普通 BTREE 仍为 KEY
        assert_eq!(index_ddl(&mk("k", "BTREE")), "KEY `k` (`c`)");
    }
}
