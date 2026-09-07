//! 行差异 → 目标端可执行 DML 生成。
//! 规则：
//! - 所有标识符用反引号包裹（内部反引号转义为两个）
//! - 字符串/时间字面量用单引号 + 反斜杠转义（\' \\ \n \r \0 \Z）
//! - BLOB 用 0x 十六进制字面量；NULL 原样
//! - Insert 多行合并（每 100 行一条）；Update 仅 SET 变更列；Update/Delete 按键定位
use super::{RowAction, RowDiffData, TableDataInternal};
use crate::compare::sqlgen::quote_ident;
use crate::datasource::Value;

/// 每条 INSERT 语句合并的行数
const INSERT_BATCH: usize = 100;

/// 值 → SQL 字面量
pub fn literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Int(x) => x.to_string(),
        Value::UInt(x) => x.to_string(),
        // f64 Display 输出为可往返的最短十进制；NaN/Inf 不可能来自 MySQL
        Value::Float(x) => x.to_string(),
        // 归一化十进制文本本身就是合法数值字面量
        Value::Decimal(s) => s.clone(),
        Value::Text(s) | Value::Date(s) | Value::DateTime(s) | Value::Time(s) => quote_value(s),
        Value::Bytes(b) => {
            let mut s = String::with_capacity(2 + b.len() * 2);
            s.push_str("0x");
            for byte in b {
                s.push_str(&format!("{byte:02X}"));
            }
            s
        }
    }
}

/// 字符串字面量：反斜杠转义（MySQL 默认 SQL 模式下通用）
fn quote_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\0' => out.push_str("\\0"),
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\x1a' => out.push_str("\\Z"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn where_key(t: &TableDataInternal, key_idx: &[usize], key: &[Value]) -> String {
    let conds = key_idx
        .iter()
        .zip(key)
        .map(|(&i, v)| format!("{} = {}", quote_ident(&t.columns[i]), literal(v)))
        .collect::<Vec<_>>()
        .join(" AND ");
    format!("WHERE {conds}")
}

/// 从缓存的行差异生成同步语句（按选中的动作类别过滤）
pub fn build_statements(
    target_db: &str,
    t: &TableDataInternal,
    key_idx: &[usize],
    actions: &[RowAction],
) -> Vec<String> {
    let qt = format!("{}.{}", quote_ident(target_db), quote_ident(&t.table));
    let mut out: Vec<String> = Vec::new();

    if actions.contains(&RowAction::Insert) {
        let col_list = t
            .columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let inserts: Vec<&RowDiffData> = t
            .rows_data
            .iter()
            .filter(|r| r.action == RowAction::Insert)
            .collect();
        for batch in inserts.chunks(INSERT_BATCH) {
            let values = batch
                .iter()
                .map(|r| {
                    let row = r.source.as_ref().expect("insert 必有源行");
                    format!(
                        "({})",
                        row.iter().map(literal).collect::<Vec<_>>().join(", ")
                    )
                })
                .collect::<Vec<_>>()
                .join(",\n");
            out.push(format!("INSERT INTO {qt} ({col_list}) VALUES\n{values}"));
        }
    }

    if actions.contains(&RowAction::Update) {
        for r in t.rows_data.iter().filter(|r| r.action == RowAction::Update) {
            let src = r.source.as_ref().expect("update 必有源行");
            let sets = r
                .changed
                .iter()
                .map(|&i| format!("{} = {}", quote_ident(&t.columns[i]), literal(&src[i])))
                .collect::<Vec<_>>()
                .join(", ");
            out.push(format!(
                "UPDATE {qt} SET {sets} {}",
                where_key(t, key_idx, &r.key)
            ));
        }
    }

    if actions.contains(&RowAction::Delete) {
        for r in t.rows_data.iter().filter(|r| r.action == RowAction::Delete) {
            out.push(format!(
                "DELETE FROM {qt} {}",
                where_key(t, key_idx, &r.key)
            ));
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_escaping() {
        assert_eq!(literal(&Value::Null), "NULL");
        assert_eq!(literal(&Value::Int(-5)), "-5");
        assert_eq!(literal(&Value::UInt(5)), "5");
        assert_eq!(literal(&Value::Decimal("1.5".into())), "1.5");
        assert_eq!(literal(&Value::Text("a'b\\c\n".into())), "'a\\'b\\\\c\\n'");
        assert_eq!(literal(&Value::Bytes(vec![0xDE, 0xAD])), "0xDEAD");
        assert_eq!(literal(&Value::DateTime("2026-09-04 10:00:00.000000".into())), "'2026-09-04 10:00:00.000000'");
    }

    fn table_with_rows(rows: Vec<RowDiffData>) -> TableDataInternal {
        TableDataInternal {
            table: "t".into(),
            status: super::super::TableStatus::Different,
            skip_reason: None,
            key_columns: vec!["id".into()],
            columns: vec!["id".into(), "name".into()],
            counts: Default::default(),
            truncated: false,
            rows_data: rows,
        }
    }

    #[test]
    fn statements_insert_update_delete() {
        let t = table_with_rows(vec![
            RowDiffData {
                key: vec![Value::Int(1)],
                action: RowAction::Insert,
                source: Some(vec![Value::Int(1), Value::Text("新".into())]),
                target: None,
                changed: vec![],
            },
            RowDiffData {
                key: vec![Value::Int(2)],
                action: RowAction::Update,
                source: Some(vec![Value::Int(2), Value::Text("改后".into())]),
                target: Some(vec![Value::Int(2), Value::Text("改前".into())]),
                changed: vec![1],
            },
            RowDiffData {
                key: vec![Value::Int(3)],
                action: RowAction::Delete,
                source: None,
                target: Some(vec![Value::Int(3), Value::Text("多余".into())]),
                changed: vec![],
            },
        ]);
        let all = [RowAction::Insert, RowAction::Update, RowAction::Delete];
        let sqls = build_statements("tgt", &t, &[0], &all);
        assert_eq!(sqls.len(), 3);
        assert_eq!(
            sqls[0],
            "INSERT INTO `tgt`.`t` (`id`, `name`) VALUES\n(1, '新')"
        );
        assert_eq!(sqls[1], "UPDATE `tgt`.`t` SET `name` = '改后' WHERE `id` = 2");
        assert_eq!(sqls[2], "DELETE FROM `tgt`.`t` WHERE `id` = 3");

        // 只选 delete 类别
        let d = build_statements("tgt", &t, &[0], &[RowAction::Delete]);
        assert_eq!(d.len(), 1);
        assert!(d[0].starts_with("DELETE FROM"));
    }
}
