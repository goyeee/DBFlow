//! 差异项 → 目标端可执行 SQL 生成。
//! 规则：
//! - 所有标识符用反引号包裹（内部反引号转义为两个）
//! - 字符串字面量/注释用单引号包裹（内部单引号转义为两个）
//! - 默认值按列类型决定是否加引号（information_schema 返回的是裸值文本）
//! - 生成 5.6 / 8.x 都可执行的语法
use crate::datasource::{ColumnDef, IndexDef, TableDef};

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

/// 单列完整 DDL 片段：`name` type [NOT NULL|NULL] [DEFAULT ..] [extra] [COMMENT '..']
pub fn column_ddl(c: &ColumnDef) -> String {
    let mut s = format!("{} {}", quote_ident(&c.name), c.data_type);
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

/// UI 差异描述：不带列名的形态（类型/可空/默认值/extra/注释）
pub fn describe_column(c: &ColumnDef) -> String {
    let mut s = c.data_type.clone();
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
    let cols: Vec<String> = i.columns.iter().map(|c| quote_ident(c)).collect();
    format!("{} ({})", kind, cols.join(","))
}

pub fn describe_table_options(t: &TableDef) -> String {
    format!(
        "ENGINE={} COMMENT={}",
        t.engine.as_deref().unwrap_or("-"),
        t.comment.as_deref().unwrap_or(""),
    )
}

/// 索引 DDL 片段：PRIMARY KEY (`id`) / UNIQUE KEY `uk` (`a`,`b`) / KEY `k` (`a`)
fn index_ddl(i: &IndexDef) -> String {
    let cols: Vec<String> = i.columns.iter().map(|c| quote_ident(c)).collect();
    let cols = cols.join(",");
    if i.is_primary {
        format!("PRIMARY KEY ({cols})")
    } else {
        let prefix = if i.unique { "UNIQUE " } else { "" };
        format!("{prefix}KEY {} ({cols})", quote_ident(&i.name))
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

pub fn add_column_sql(db: &str, table: &str, c: &ColumnDef, after: Option<&str>) -> String {
    let mut sql = format!(
        "ALTER TABLE {} ADD COLUMN {}",
        qualified(db, table),
        column_ddl(c)
    );
    match after {
        Some(prev) => sql.push_str(&format!(" AFTER {}", quote_ident(prev))),
        None => sql.push_str(" FIRST"),
    }
    sql
}

pub fn modify_column_sql(db: &str, table: &str, c: &ColumnDef) -> String {
    format!(
        "ALTER TABLE {} MODIFY COLUMN {}",
        qualified(db, table),
        column_ddl(c)
    )
}

pub fn drop_column_sql(db: &str, table: &str, column: &str) -> String {
    format!(
        "ALTER TABLE {} DROP COLUMN {}",
        qualified(db, table),
        quote_ident(column)
    )
}

pub fn add_index_sql(db: &str, table: &str, i: &IndexDef) -> String {
    let cols: Vec<String> = i.columns.iter().map(|c| quote_ident(c)).collect();
    format!(
        "ALTER TABLE {} ADD {} ({})",
        qualified(db, table),
        index_kind_prefix(i),
        cols.join(",")
    )
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
pub fn rebuild_index_sql(db: &str, table: &str, i: &IndexDef) -> String {
    let cols: Vec<String> = i.columns.iter().map(|c| quote_ident(c)).collect();
    let drop_part = if i.is_primary {
        "DROP PRIMARY KEY".to_string()
    } else {
        format!("DROP INDEX {}", quote_ident(&i.name))
    };
    format!(
        "ALTER TABLE {} {} , ADD {} ({})",
        qualified(db, table),
        drop_part,
        index_kind_prefix(i),
        cols.join(",")
    )
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
                IndexDef { name: "PRIMARY".into(), columns: vec!["id".into()], unique: true, is_primary: true, index_type: Some("BTREE".into()) },
                IndexDef { name: "uk_name".into(), columns: vec!["name".into()], unique: true, is_primary: false, index_type: Some("BTREE".into()) },
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
        let sql = add_column_sql("db", "t", &c("x", "int", true, None), Some("id"));
        assert_eq!(sql, "ALTER TABLE `db`.`t` ADD COLUMN `x` int NULL AFTER `id`");
        let sql_first = add_column_sql("db", "t", &c("x", "int", true, None), None);
        assert!(sql_first.ends_with("FIRST"));
    }
}
