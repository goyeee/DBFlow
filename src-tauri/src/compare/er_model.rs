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
                return Err(AppError::Validation(format!(
                    "表「{name}」存在重复列名「{}」",
                    c.name
                )));
            }
        }
        let mut fk_names = HashSet::new();
        for fk in &s.foreign_keys {
            if fk.name.trim().is_empty() {
                return Err(AppError::Validation(format!("表「{name}」存在空外键名")));
            }
            if !fk_names.insert(fk.name.trim().to_lowercase()) {
                return Err(AppError::Validation(format!(
                    "表「{name}」存在重复外键名「{}」",
                    fk.name
                )));
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
