//! 数据对比引擎：主键分块流式对比。
//! - 两端按对比键 keyset 分页拉取（`WHERE (k) > (last) ORDER BY k LIMIT n`）
//! - 双新鲜满块且块哈希一致 → 整块跳过（大表一致数据的快路径）
//! - 否则块内 merge-join 逐行对比，Update 记录字段级前后值
//! 内存占用 O(块大小 + 明细上限)，与表大小无关。
//! merge-join 与归一化为纯逻辑（ChunkSource 可注入假数据），可单测。
pub mod sqlgen;

use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::compare::sqlgen::quote_ident;
use crate::datasource::{ColumnDef, LiveConnection, TableDef, Value};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompareOptions {
    pub chunk_size: u32,
    pub max_detail_rows: usize,
}

impl Default for DataCompareOptions {
    fn default() -> Self {
        Self {
            chunk_size: 5000,
            max_detail_rows: 1000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableStatus {
    Equal,
    Different,
    Skipped,
    MissingOnTarget,
    MissingOnSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RowAction {
    Insert,
    Update,
    Delete,
    /// 两端一致（仅行级预览使用，不参与对比计数与同步）
    Equal,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCounts {
    pub insert: u64,
    pub update: u64,
    pub delete: u64,
    /// 两端一致的行数（Navicat 式「相同」列展示用；跳过/缺表为 0）
    pub equal: u64,
}

impl RowCounts {
    pub fn any(&self) -> bool {
        self.insert > 0 || self.update > 0 || self.delete > 0
    }
}

// ───────────────────────── 前端视图模型 ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellDiff {
    pub column: String,
    pub source: String,
    pub target: String,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDiff {
    pub key: Vec<String>,
    pub action: RowAction,
    /// Update：逐列前后值；Insert/Delete 为空（看 source_row/target_row）
    pub cells: Vec<CellDiff>,
    pub source_row: Option<Vec<String>>,
    pub target_row: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataDiff {
    pub table: String,
    pub status: TableStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    pub key_columns: Vec<String>,
    /// 参与对比的列名（与明细行值一一对应）
    pub columns: Vec<String>,
    pub counts: RowCounts,
    /// 明细因上限被截断（counts 仍是精确值）
    pub truncated: bool,
    pub rows: Vec<RowDiff>,
}

// ───────────────────────── 内部模型（保留真实值，SQL 生成用） ─────────────────────────

#[derive(Debug, Clone)]
pub struct RowDiffData {
    pub key: Vec<Value>,
    pub action: RowAction,
    pub source: Option<Vec<Value>>,
    pub target: Option<Vec<Value>>,
    /// Update 时变更列的下标（列集合内的位置，非键列）
    pub changed: Vec<usize>,
}

/// 一张表的完整对比结果（后端缓存；rows 可能很大，不直接整体序列化给前端）
#[derive(Debug, Clone)]
pub struct TableDataInternal {
    pub table: String,
    pub status: TableStatus,
    pub skip_reason: Option<String>,
    pub key_columns: Vec<String>,
    pub columns: Vec<String>,
    pub counts: RowCounts,
    pub truncated: bool,
    pub rows_data: Vec<RowDiffData>,
}

impl TableDataInternal {
    fn simple(table: &str, status: TableStatus, reason: Option<String>) -> Self {
        Self {
            table: table.into(),
            status,
            skip_reason: reason,
            key_columns: vec![],
            columns: vec![],
            counts: RowCounts::default(),
            truncated: false,
            rows_data: vec![],
        }
    }

    pub fn key_idx(&self) -> Vec<usize> {
        self.key_columns
            .iter()
            .filter_map(|k| self.columns.iter().position(|c| c == k))
            .collect()
    }

    /// 输出视图：with_rows=false 为摘要（行明细留空，compare 响应用）
    pub fn to_view(&self, with_rows: bool) -> TableDataDiff {
        let rows = if with_rows {
            self.rows_data.iter().map(|r| self.row_view(r)).collect()
        } else {
            vec![]
        };
        TableDataDiff {
            table: self.table.clone(),
            status: self.status,
            skip_reason: self.skip_reason.clone(),
            key_columns: self.key_columns.clone(),
            columns: self.columns.clone(),
            counts: self.counts,
            truncated: self.truncated,
            rows,
        }
    }

    fn row_view(&self, r: &RowDiffData) -> RowDiff {
        let disp = |row: &Option<Vec<Value>>| {
            row.as_ref()
                .map(|vs| vs.iter().map(|v| v.display()).collect::<Vec<_>>())
        };
        let cells = if r.action == RowAction::Update {
            let (s, t) = (&r.source, &r.target);
            self.columns
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let sv = s.as_ref().and_then(|r| r.get(i));
                    let tv = t.as_ref().and_then(|r| r.get(i));
                    CellDiff {
                        column: c.clone(),
                        source: sv.map(Value::display).unwrap_or_default(),
                        target: tv.map(Value::display).unwrap_or_default(),
                        changed: r.changed.contains(&i),
                    }
                })
                .collect()
        } else {
            vec![]
        };
        RowDiff {
            key: r.key.iter().map(Value::display).collect(),
            action: r.action,
            cells,
            source_row: disp(&r.source),
            target_row: disp(&r.target),
        }
    }
}

// ───────────────────────── 对比键选择 ─────────────────────────

/// 可作为对比键的列类型（需要可靠的排序与等值比较）
fn key_type_ok(data_type: &str) -> bool {
    !matches!(
        base_type(data_type).as_str(),
        "float" | "double" | "real" | "json" | "geometry" | "point" | "linestring" | "polygon"
            | "multipoint" | "multilinestring" | "multipolygon" | "geometrycollection" | "set"
    ) && !base_type(data_type).contains("text")
        && !base_type(data_type).contains("blob")
}

fn base_type(data_type: &str) -> String {
    data_type
        .split(|c: char| c == '(' || c == ' ')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// 选择对比键：主键优先，否则第一个全 NOT NULL 唯一索引（不含前缀列）。
/// 返回 (键列名, 键列在 columns 中的下标)；不可用给出中文原因。
pub fn choose_key(t: &TableDef) -> Result<(Vec<String>, Vec<usize>), String> {
    let col_at = |name: &str| t.columns.iter().enumerate().find(|(_, c)| c.name == name);

    let mut candidates: Vec<&crate::datasource::IndexDef> = Vec::new();
    if let Some(pk) = t.indexes.iter().find(|i| i.is_primary) {
        candidates.push(pk);
    }
    candidates.extend(
        t.indexes
            .iter()
            .filter(|i| i.unique && !i.is_primary),
    );

    let mut last_err = "无主键或唯一索引，无法可靠匹配行".to_string();
    for idx in candidates {
        if idx.sub_parts.iter().any(|p| p.is_some()) {
            last_err = format!("索引 {} 含前缀列，不能作为对比键", idx.name);
            continue;
        }
        let mut cols = Vec::with_capacity(idx.columns.len());
        let mut pos = Vec::with_capacity(idx.columns.len());
        let mut bad: Option<String> = None;
        for name in &idx.columns {
            match col_at(name) {
                Some((_i, c)) if c.nullable => {
                    bad = Some(format!("唯一索引 {} 的列 {} 可空，不能作为对比键", idx.name, name));
                    break;
                }
                Some((i, c)) if !key_type_ok(&c.data_type) => {
                    bad = Some(format!(
                        "键列 {} 类型 {} 不支持可靠比较",
                        name, c.data_type
                    ));
                    let _ = i;
                    break;
                }
                Some((i, _)) => {
                    cols.push(name.clone());
                    pos.push(i);
                }
                None => {
                    bad = Some(format!("索引 {} 的列 {} 不存在", idx.name, name));
                    break;
                }
            }
        }
        if let Some(e) = bad {
            last_err = e;
            continue;
        }
        if !cols.is_empty() {
            return Ok((cols, pos));
        }
    }
    Err(last_err)
}

// ───────────────────────── SELECT 包装与行归一化 ─────────────────────────

/// 列的拉取方式：时间/小数/BIT/JSON 在 SQL 里包装成规范化文本，其余原样
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColKind {
    Raw,
    DecimalText,
    DateText,
    DateTimeText,
    TimeText,
    /// CAST AS CHAR 后按文本（year/json 等）
    PlainText,
}

fn select_expr(c: &ColumnDef) -> (String, ColKind) {
    let q = quote_ident(&c.name);
    match base_type(&c.data_type).as_str() {
        "datetime" | "timestamp" => (
            format!("DATE_FORMAT({q}, '%Y-%m-%d %H:%i:%s.%f')"),
            ColKind::DateTimeText,
        ),
        "date" => (format!("DATE_FORMAT({q}, '%Y-%m-%d')"), ColKind::DateText),
        "time" => (format!("CAST({q} AS CHAR)"), ColKind::TimeText),
        "decimal" | "numeric" => (format!("CAST({q} AS CHAR)"), ColKind::DecimalText),
        "bit" => (format!("CAST({q} AS UNSIGNED)"), ColKind::Raw),
        "year" | "json" => (format!("CAST({q} AS CHAR)"), ColKind::PlainText),
        _ => (q, ColKind::Raw),
    }
}

/// 十进制文本归一化：去尾零/前导零，"-0"→"0"，消除 1.10 vs 1.1 之类假差异
pub fn normalize_decimal(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        return s.to_string();
    }
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, f.trim_end_matches('0')),
        None => (body, ""),
    };
    let int_norm = int_part.trim_start_matches('0');
    let int_norm = if int_norm.is_empty() { "0" } else { int_norm };
    let mut out = String::new();
    let zero = int_norm == "0" && frac_part.is_empty();
    if neg && !zero {
        out.push('-');
    }
    out.push_str(int_norm);
    if !frac_part.is_empty() {
        out.push('.');
        out.push_str(frac_part);
    }
    out
}

fn finalize_row(row: Vec<Value>, kinds: &[ColKind]) -> Vec<Value> {
    row.into_iter()
        .zip(kinds)
        .map(|(v, k)| match (v, k) {
            (Value::Text(s), ColKind::DecimalText) => Value::Decimal(normalize_decimal(&s)),
            (Value::Text(s), ColKind::DateText) => Value::Date(s),
            (Value::Text(s), ColKind::DateTimeText) => Value::DateTime(s),
            (Value::Text(s), ColKind::TimeText) => Value::Time(s),
            (v, _) => v,
        })
        .collect()
}

// ───────────────────────── 值比较（键排序用） ─────────────────────────

fn cmp_value(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a, b) {
        (Value::Int(x), Value::Int(y)) => x.cmp(y),
        (Value::UInt(x), Value::UInt(y)) => x.cmp(y),
        // 两端同列类型应一致；符号/无符号混合时按数值比较兜底
        (Value::Int(x), Value::UInt(y)) => {
            if *x < 0 { Less } else { (*x as u64).cmp(y) }
        }
        (Value::UInt(x), Value::Int(y)) => {
            if *y < 0 { Greater } else { x.cmp(&(*y as u64)) }
        }
        (Value::Float(x), Value::Float(y)) => x.partial_cmp(y).unwrap_or(Equal),
        (Value::Decimal(x), Value::Decimal(y)) => cmp_decimal(x, y),
        (Value::Text(x), Value::Text(y))
        | (Value::Date(x), Value::Date(y))
        | (Value::DateTime(x), Value::DateTime(y))
        | (Value::Time(x), Value::Time(y)) => x.cmp(y),
        (Value::Bytes(x), Value::Bytes(y)) => x.cmp(y),
        (Value::Null, Value::Null) => Equal,
        // 类型不一致的异常组合：按展示文本兜底，保证全序不 panic
        _ => a.display().cmp(&b.display()),
    }
}

/// 归一化后的十进制文本做数值比较（"10" > "9"，"-2" < "1"）
fn cmp_decimal(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    fn split(s: &str) -> (bool, &str, &str) {
        let (neg, body) = match s.strip_prefix('-') {
            Some(r) => (true, r),
            None => (false, s),
        };
        let (i, f) = body.split_once('.').unwrap_or((body, ""));
        (neg, i, f)
    }
    let (an, ai, af) = split(a);
    let (bn, bi, bf) = split(b);
    let a_zero = ai == "0" && af.is_empty();
    let b_zero = bi == "0" && bf.is_empty();
    if a_zero && b_zero {
        return Equal;
    }
    match (an, bn) {
        // 归一化后 -0 已统一为 0，符号不同则负 < 非负
        (true, false) => return Less,
        (false, true) => return Greater,
        _ => {}
    }
    // 同号：先比整数部分长度，再逐位；小数部分按位比（短者补零）
    let mag = ai
        .len()
        .cmp(&bi.len())
        .then_with(|| ai.cmp(bi))
        .then_with(|| {
            let mut it = af.chars().zip(bf.chars());
            loop {
                match it.next() {
                    Some((x, y)) if x != y => return x.cmp(&y),
                    Some(_) => continue,
                    None => break,
                }
            }
            af.len().cmp(&bf.len())
        });
    if an { mag.reverse() } else { mag }
}

fn cmp_key(a: &[Value], b: &[Value]) -> std::cmp::Ordering {
    for (x, y) in a.iter().zip(b) {
        let o = cmp_value(x, y);
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    std::cmp::Ordering::Equal
}

fn block_hash(rows: &VecDeque<Vec<Value>>) -> [u8; 20] {
    let mut h = Sha1::new();
    let mut buf = Vec::new();
    for row in rows {
        for v in row {
            v.hash_bytes(&mut buf);
        }
    }
    h.update(&buf);
    h.finalize().into()
}

// ───────────────────────── 流式 merge-join 对比 ─────────────────────────

/// 行块来源：真实实现走 fetch_rows_chunk，测试注入内存数据
#[async_trait]
pub trait ChunkSource: Send {
    /// 返回下一块（按键升序）；None 表示耗尽
    async fn next_chunk(&mut self) -> AppResult<Option<Vec<Vec<Value>>>>;
}

pub struct Cursor<S: ChunkSource> {
    src: S,
    buf: VecDeque<Vec<Value>>,
    done: bool,
    /// 本块拉取后尚未被消费过（块哈希跳过的前提）
    fresh: bool,
    limit: usize,
}

impl<S: ChunkSource> Cursor<S> {
    fn new(src: S, limit: usize) -> Self {
        Self {
            src,
            buf: VecDeque::new(),
            done: false,
            fresh: false,
            limit,
        }
    }

    async fn ensure(&mut self) -> AppResult<()> {
        if self.buf.is_empty() && !self.done {
            match self.src.next_chunk().await? {
                Some(rows) if !rows.is_empty() => {
                    let full = rows.len() >= self.limit;
                    self.done = !full; // 不足一块说明已到末尾
                    self.buf = rows.into();
                    self.fresh = true;
                }
                _ => {
                    self.done = true;
                }
            }
        }
        Ok(())
    }

    fn peek(&self) -> Option<&Vec<Value>> {
        self.buf.front()
    }

    fn pop(&mut self) -> Option<Vec<Value>> {
        self.fresh = false;
        self.buf.pop_front()
    }
}

pub struct MergeOutcome {
    pub counts: RowCounts,
    pub rows: Vec<RowDiffData>,
    pub truncated: bool,
}

/// 两端有序行流的 merge-join 对比。key_idx 为键列下标。
pub async fn compare_streams<S: ChunkSource>(
    src: Cursor<S>,
    tgt: Cursor<S>,
    key_idx: &[usize],
    max_detail: usize,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> AppResult<MergeOutcome> {
    let mut src = src;
    let mut tgt = tgt;
    let mut counts = RowCounts::default();
    let mut rows: Vec<RowDiffData> = Vec::new();
    let mut compared: u64 = 0;

    let key_of = |row: &[Value]| key_idx.iter().map(|&i| row[i].clone()).collect::<Vec<_>>();

    let push = |rows: &mut Vec<RowDiffData>, counts: &RowCounts, d: RowDiffData| {
        // 每类别封顶：计数精确，明细限量
        let cat = match d.action {
            RowAction::Insert => counts.insert,
            RowAction::Update => counts.update,
            RowAction::Delete => counts.delete,
            // 一致行不进明细（仅预览接口产出）
            RowAction::Equal => 0,
        };
        if cat as usize <= max_detail {
            rows.push(d);
        }
    };

    loop {
        src.ensure().await?;
        tgt.ensure().await?;

        // 快路径：双新鲜满块且内容哈希一致 → 整块跳过
        if src.fresh
            && tgt.fresh
            && src.buf.len() == src.limit
            && tgt.buf.len() == tgt.limit
            && block_hash(&src.buf) == block_hash(&tgt.buf)
        {
            compared += src.buf.len() as u64;
            on_progress(compared);
            src.buf.clear();
            tgt.buf.clear();
            continue;
        }

        match (src.peek(), tgt.peek()) {
            (None, None) => break,
            (None, Some(_)) => {
                // 源端耗尽：目标剩余全部为 Delete
                while let Some(row) = tgt.pop() {
                    counts.delete += 1;
                    compared += 1;
                    push(&mut rows, &counts, RowDiffData {
                        key: key_of(&row),
                        action: RowAction::Delete,
                        source: None,
                        target: Some(row),
                        changed: vec![],
                    });
                }
            }
            (Some(_), None) => {
                while let Some(row) = src.pop() {
                    counts.insert += 1;
                    compared += 1;
                    push(&mut rows, &counts, RowDiffData {
                        key: key_of(&row),
                        action: RowAction::Insert,
                        source: Some(row),
                        target: None,
                        changed: vec![],
                    });
                }
            }
            (Some(s), Some(t)) => {
                let sk = key_of(s);
                let tk = key_of(t);
                match cmp_key(&sk, &tk) {
                    std::cmp::Ordering::Equal => {
                        if s != t {
                            let changed: Vec<usize> = (0..s.len())
                                .filter(|&i| !key_idx.contains(&i) && s[i] != t[i])
                                .collect();
                            if !changed.is_empty() {
                                counts.update += 1;
                                let sd = src.pop().unwrap();
                                let td = tgt.pop().unwrap();
                                push(&mut rows, &counts, RowDiffData {
                                    key: sk,
                                    action: RowAction::Update,
                                    source: Some(sd),
                                    target: Some(td),
                                    changed,
                                });
                            } else {
                                src.pop();
                                tgt.pop();
                            }
                        } else {
                            src.pop();
                            tgt.pop();
                        }
                        compared += 1;
                    }
                    std::cmp::Ordering::Less => {
                        let row = src.pop().unwrap();
                        counts.insert += 1;
                        compared += 1;
                        push(&mut rows, &counts, RowDiffData {
                            key: key_of(&row),
                            action: RowAction::Insert,
                            source: Some(row),
                            target: None,
                            changed: vec![],
                        });
                    }
                    std::cmp::Ordering::Greater => {
                        let row = tgt.pop().unwrap();
                        counts.delete += 1;
                        compared += 1;
                        push(&mut rows, &counts, RowDiffData {
                            key: key_of(&row),
                            action: RowAction::Delete,
                            source: None,
                            target: Some(row),
                            changed: vec![],
                        });
                    }
                }
            }
        }
        if compared % 4096 == 0 {
            on_progress(compared);
        }
    }
    on_progress(compared);

    let truncated = counts.insert as usize > max_detail
        || counts.update as usize > max_detail
        || counts.delete as usize > max_detail;
    // compared 含全部已比对行（快路径整块 + 逐行）；差额即两端一致的行数
    counts.equal = compared - counts.insert - counts.update - counts.delete;
    Ok(MergeOutcome {
        counts,
        rows,
        truncated,
    })
}

// ───────────────────────── 表级对比编排 ─────────────────────────

struct MysqlChunkSource<'a> {
    conn: &'a Arc<dyn LiveConnection>,
    database: &'a str,
    table: &'a str,
    select_exprs: &'a [String],
    key_columns: &'a [String],
    /// 键列在行内的下标（推进 keyset 游标用）
    key_idx: &'a [usize],
    kinds: &'a [ColKind],
    after_key: Option<Vec<Value>>,
    limit: u32,
}

#[async_trait]
impl ChunkSource for MysqlChunkSource<'_> {
    async fn next_chunk(&mut self) -> AppResult<Option<Vec<Vec<Value>>>> {
        let rows = self
            .conn
            .fetch_rows_chunk(
                self.database,
                self.table,
                self.select_exprs,
                self.key_columns,
                self.after_key.as_deref(),
                self.limit,
            )
            .await?;
        if rows.is_empty() {
            return Ok(None);
        }
        let rows: Vec<Vec<Value>> = rows
            .into_iter()
            .map(|r| finalize_row(r, self.kinds))
            .collect();
        let last = rows.last().expect("已判空");
        self.after_key = Some(self.key_idx.iter().map(|&i| last[i].clone()).collect());
        Ok(Some(rows))
    }
}

/// 对比一张表。src_def/tgt_def 为两端结构快照中该表的定义（None = 该端缺表）。
pub async fn compare_table(
    src_conn: &Arc<dyn LiveConnection>,
    tgt_conn: &Arc<dyn LiveConnection>,
    src_db: &str,
    tgt_db: &str,
    table: &str,
    src_def: Option<&TableDef>,
    tgt_def: Option<&TableDef>,
    opts: &DataCompareOptions,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> AppResult<TableDataInternal> {
    let (Some(s), Some(t)) = (src_def, tgt_def) else {
        let status = if src_def.is_none() {
            TableStatus::MissingOnSource
        } else {
            TableStatus::MissingOnTarget
        };
        let mut out = TableDataInternal::simple(table, status, None);
        // 缺端对比：列信息取存在的一侧供前端展示
        if let Some(d) = src_def.or(tgt_def) {
            out.columns = d.columns.iter().map(|c| c.name.clone()).collect();
        }
        return Ok(out);
    };

    // 列集合必须一致（数据对比以同构为前提；列不一致先走结构同步）
    let src_cols: Vec<&str> = s.columns.iter().map(|c| c.name.as_str()).collect();
    let mut tgt_cols: Vec<&str> = t.columns.iter().map(|c| c.name.as_str()).collect();
    tgt_cols.sort();
    let mut src_sorted = src_cols.clone();
    src_sorted.sort();
    if src_sorted != tgt_cols {
        return Ok(TableDataInternal::simple(
            table,
            TableStatus::Skipped,
            Some("两端列不一致，请先执行结构同步".into()),
        ));
    }

    let (key_columns, key_idx) = match choose_key(s) {
        Ok(k) => k,
        Err(reason) => {
            return Ok(TableDataInternal::simple(
                table,
                TableStatus::Skipped,
                Some(reason),
            ))
        }
    };

    let (select_exprs, kinds): (Vec<String>, Vec<ColKind>) =
        s.columns.iter().map(select_expr).unzip();
    let columns: Vec<String> = s.columns.iter().map(|c| c.name.clone()).collect();

    let src_cursor = Cursor::new(
        MysqlChunkSource {
            conn: src_conn,
            database: src_db,
            table,
            select_exprs: &select_exprs,
            key_columns: &key_columns,
            key_idx: &key_idx,
            kinds: &kinds,
            after_key: None,
            limit: opts.chunk_size,
        },
        opts.chunk_size as usize,
    );
    let tgt_cursor = Cursor::new(
        MysqlChunkSource {
            conn: tgt_conn,
            database: tgt_db,
            table,
            select_exprs: &select_exprs,
            key_columns: &key_columns,
            key_idx: &key_idx,
            kinds: &kinds,
            after_key: None,
            limit: opts.chunk_size,
        },
        opts.chunk_size as usize,
    );

    let outcome = compare_streams(src_cursor, tgt_cursor, &key_idx, opts.max_detail_rows, on_progress).await?;

    Ok(TableDataInternal {
        table: table.into(),
        status: if outcome.counts.any() {
            TableStatus::Different
        } else {
            TableStatus::Equal
        },
        skip_reason: None,
        key_columns,
        columns,
        counts: outcome.counts,
        truncated: outcome.truncated,
        rows_data: outcome.rows,
    })
}

// ───────────────────────── 行级预览（Navicat 式结果页） ─────────────────────────

/// 行级预览的一行：展示值均为格式化字符串（Bytes 用占位符）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowPreviewView {
    pub action: RowAction,
    pub key: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Vec<String>>,
    /// 与 source 等长的逐列变更标记（update 行有 true，其余全 false）
    pub changed: Vec<bool>,
}

/// 一张表的行级预览：按键归并的两端全行（含一致行）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowsPreview {
    pub table: String,
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    /// 超出 limit 被截断
    pub truncated: bool,
    pub rows: Vec<RowPreviewView>,
}

fn preview_insert(key: &[Value], row: &[Value]) -> RowPreviewView {
    RowPreviewView {
        action: RowAction::Insert,
        key: key.iter().map(Value::display).collect(),
        source: Some(row.iter().map(Value::display).collect()),
        target: None,
        changed: vec![],
    }
}

fn preview_delete(key: &[Value], row: &[Value]) -> RowPreviewView {
    RowPreviewView {
        action: RowAction::Delete,
        key: key.iter().map(Value::display).collect(),
        source: None,
        target: Some(row.iter().map(Value::display).collect()),
        changed: vec![],
    }
}

/// 行级预览：与 compare 同构的流式归并，但不做块哈希/明细/SQL，
/// 输出两端对齐的展示行（含 equal），内存 O(块大小 + limit)。
pub async fn rows_preview(
    src_conn: &Arc<dyn LiveConnection>,
    tgt_conn: &Arc<dyn LiveConnection>,
    src_db: &str,
    tgt_db: &str,
    table: &str,
    limit: usize,
) -> AppResult<TableRowsPreview> {
    let src_snap = src_conn
        .snapshot_tables(src_db, Some(std::slice::from_ref(&table.to_string())))
        .await?;
    let tgt_snap = tgt_conn
        .snapshot_tables(tgt_db, Some(std::slice::from_ref(&table.to_string())))
        .await?;
    let (Some(sd), Some(td)) = (src_snap.tables.first(), tgt_snap.tables.first()) else {
        return Err(AppError::Validation(format!("表 {table} 在某一端不存在")));
    };
    let mut src_names: Vec<&str> = sd.columns.iter().map(|c| c.name.as_str()).collect();
    src_names.sort_unstable();
    let mut tgt_names: Vec<&str> = td.columns.iter().map(|c| c.name.as_str()).collect();
    tgt_names.sort_unstable();
    if src_names != tgt_names {
        return Err(AppError::Validation("两端列不一致，请先执行结构同步".into()));
    }
    let (key_columns, key_idx) = choose_key(sd).map_err(AppError::Validation)?;

    let (select_exprs, kinds): (Vec<String>, Vec<ColKind>) =
        sd.columns.iter().map(select_expr).unzip();
    let columns: Vec<String> = sd.columns.iter().map(|c| c.name.clone()).collect();
    let chunk = 5000u32;

    let mut sc = Cursor::new(
        MysqlChunkSource {
            conn: src_conn,
            database: src_db,
            table,
            select_exprs: &select_exprs,
            key_columns: &key_columns,
            key_idx: &key_idx,
            kinds: &kinds,
            after_key: None,
            limit: chunk,
        },
        chunk as usize,
    );
    let mut tc = Cursor::new(
        MysqlChunkSource {
            conn: tgt_conn,
            database: tgt_db,
            table,
            select_exprs: &select_exprs,
            key_columns: &key_columns,
            key_idx: &key_idx,
            kinds: &kinds,
            after_key: None,
            limit: chunk,
        },
        chunk as usize,
    );

    let key_of = |row: &[Value]| key_idx.iter().map(|&i| row[i].clone()).collect::<Vec<_>>();
    let key_str = |row: &[Value]| key_idx.iter().map(|&i| row[i].display()).collect::<Vec<_>>();
    let display_row = |row: &[Value]| row.iter().map(Value::display).collect::<Vec<_>>();

    let mut rows: Vec<RowPreviewView> = Vec::new();
    let mut truncated = false;
    loop {
        sc.ensure().await?;
        tc.ensure().await?;
        if rows.len() >= limit {
            // 还有剩余行则标记截断
            truncated = sc.peek().is_some() || tc.peek().is_some();
            break;
        }
        match (sc.peek(), tc.peek()) {
            (None, None) => break,
            (None, Some(_)) => {
                if let Some(row) = tc.pop() {
                    let key = key_of(&row);
                    rows.push(preview_delete(&key, &row));
                }
            }
            (Some(_), None) => {
                if let Some(row) = sc.pop() {
                    let key = key_of(&row);
                    rows.push(preview_insert(&key, &row));
                }
            }
            (Some(sv), Some(tv)) => {
                let sk = key_of(sv);
                let tk = key_of(tv);
                match cmp_key(&sk, &tk) {
                    std::cmp::Ordering::Equal => {
                        let changed: Vec<bool> =
                            (0..sv.len()).map(|i| sv[i] != tv[i]).collect();
                        let action = if changed.iter().any(|c| *c) {
                            RowAction::Update
                        } else {
                            RowAction::Equal
                        };
                        rows.push(RowPreviewView {
                            action,
                            key: key_str(sv),
                            source: Some(display_row(sv)),
                            target: Some(display_row(tv)),
                            changed,
                        });
                        sc.pop();
                        tc.pop();
                    }
                    std::cmp::Ordering::Less => {
                        let row = sc.pop().expect("peek 过必有行");
                        rows.push(preview_insert(&sk, &row));
                    }
                    std::cmp::Ordering::Greater => {
                        let row = tc.pop().expect("peek 过必有行");
                        rows.push(preview_delete(&tk, &row));
                    }
                }
            }
        }
    }
    Ok(TableRowsPreview {
        table: table.to_string(),
        columns,
        key_columns,
        truncated,
        rows,
    })
}

#[cfg(test)]

#[cfg(test)]
mod tests {
    use super::*;

    // ── 归一化 ──

    #[test]
    fn decimal_normalization() {
        assert_eq!(normalize_decimal("1.10"), "1.1");
        assert_eq!(normalize_decimal("0.00"), "0");
        assert_eq!(normalize_decimal("-0.00"), "0");
        assert_eq!(normalize_decimal("007.50"), "7.5");
        assert_eq!(normalize_decimal("-12.000"), "-12");
        assert_eq!(normalize_decimal("42"), "42");
        assert_eq!(normalize_decimal("+3.0"), "3");
    }

    #[test]
    fn decimal_ordering() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp_decimal("9", "10"), Less);
        assert_eq!(cmp_decimal("1.5", "1.45"), Greater);
        assert_eq!(cmp_decimal("-2", "1"), Less);
        assert_eq!(cmp_decimal("-10", "-9"), Less);
        assert_eq!(cmp_decimal("0", "-0"), Equal);
        assert_eq!(cmp_decimal("3.14", "3.14"), Equal);
    }

    // ── 键选择 ──

    fn col(name: &str, dt: &str, nullable: bool) -> ColumnDef {
        ColumnDef { name: name.into(), data_type: dt.into(), nullable, ..Default::default() }
    }

    fn idx(name: &str, cols: &[&str], unique: bool) -> crate::datasource::IndexDef {
        crate::datasource::IndexDef {
            name: name.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            sub_parts: vec![None; cols.len()],
            directions: vec![None; cols.len()],
            unique,
            is_primary: name == "PRIMARY",
            index_type: Some("BTREE".into()),
        }
    }

    #[test]
    fn choose_key_prefers_primary() {
        let t = TableDef {
            name: "t".into(),
            columns: vec![col("id", "bigint", false), col("code", "varchar(20)", false)],
            indexes: vec![idx("PRIMARY", &["id"], true), idx("uk_code", &["code"], true)],
            ..Default::default()
        };
        let (keys, pos) = choose_key(&t).unwrap();
        assert_eq!(keys, vec!["id"]);
        assert_eq!(pos, vec![0]);
    }

    #[test]
    fn choose_key_falls_back_to_not_null_unique() {
        let t = TableDef {
            name: "t".into(),
            columns: vec![
                col("a", "int", false),
                col("b", "varchar(20)", true), // 可空 → uk_b 不可用
                col("c", "varchar(20)", false),
            ],
            indexes: vec![idx("uk_b", &["b"], true), idx("uk_c", &["c"], true)],
            ..Default::default()
        };
        let (keys, _) = choose_key(&t).unwrap();
        assert_eq!(keys, vec!["c"]);
    }

    #[test]
    fn choose_key_rejects_no_key_and_bad_types() {
        let t = TableDef {
            name: "t".into(),
            columns: vec![col("a", "int", false)],
            indexes: vec![],
            ..Default::default()
        };
        assert!(choose_key(&t).is_err());

        let t2 = TableDef {
            name: "t".into(),
            columns: vec![col("f", "double", false)],
            indexes: vec![idx("PRIMARY", &["f"], true)],
            ..Default::default()
        };
        let err = choose_key(&t2).unwrap_err();
        assert!(err.contains("不支持可靠比较"), "{err}");
    }

    // ── merge-join（内存假源） ──

    struct VecSource {
        chunks: std::collections::VecDeque<Vec<Vec<Value>>>,
    }

    impl VecSource {
        fn of(rows: Vec<Vec<Value>>, chunk: usize) -> Self {
            let chunks = rows.chunks(chunk).map(|c| c.to_vec()).collect();
            Self { chunks }
        }
        fn empty() -> Self {
            Self { chunks: Default::default() }
        }
    }

    #[async_trait]
    impl ChunkSource for VecSource {
        async fn next_chunk(&mut self) -> AppResult<Option<Vec<Vec<Value>>>> {
            Ok(self.chunks.pop_front())
        }
    }

    fn row(id: i64, name: &str) -> Vec<Value> {
        vec![Value::Int(id), Value::Text(name.into())]
    }

    async fn merge(
        src: Vec<Vec<Value>>,
        tgt: Vec<Vec<Value>>,
        chunk: usize,
    ) -> MergeOutcome {
        let s = Cursor::new(VecSource::of(src, chunk), chunk);
        let t = Cursor::new(VecSource::of(tgt, chunk), chunk);
        compare_streams(s, t, &[0], 1000, &mut |_| {})
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn merge_identical() {
        let a = vec![row(1, "a"), row(2, "b"), row(3, "c")];
        let out = merge(a.clone(), a, 2).await;
        assert_eq!(out.counts, RowCounts { insert: 0, update: 0, delete: 0, equal: 3 });
        assert!(out.rows.is_empty());
    }

    #[tokio::test]
    async fn merge_insert_update_delete() {
        let src = vec![row(1, "a"), row(2, "改后"), row(4, "d")];
        let tgt = vec![row(1, "a"), row(2, "改前"), row(3, "多余")];
        let out = merge(src, tgt, 100).await;
        assert_eq!(out.counts, RowCounts { insert: 1, update: 1, delete: 1, equal: 1 });
        let ins = out.rows.iter().find(|r| r.action == RowAction::Insert).unwrap();
        assert_eq!(ins.key, vec![Value::Int(4)]);
        let upd = out.rows.iter().find(|r| r.action == RowAction::Update).unwrap();
        assert_eq!(upd.changed, vec![1]); // name 列
        let del = out.rows.iter().find(|r| r.action == RowAction::Delete).unwrap();
        assert_eq!(del.target.as_ref().unwrap()[1], Value::Text("多余".into()));
    }

    #[tokio::test]
    async fn merge_across_chunk_boundaries() {
        // 块大小 2，制造跨块的插入错位
        let src: Vec<_> = (1..=5).map(|i| row(i, "x")).collect();
        let mut tgt: Vec<_> = (1..=5).map(|i| row(i, "x")).collect();
        tgt.remove(1); // 目标缺 id=2
        let out = merge(src, tgt, 2).await;
        assert_eq!(out.counts, RowCounts { insert: 1, update: 0, delete: 0, equal: 4 });
        assert_eq!(out.rows[0].key, vec![Value::Int(2)]);
    }

    #[tokio::test]
    async fn merge_target_only_rows_all_deleted_when_source_empty() {
        let out = merge(vec![], vec![row(1, "a"), row(2, "b")], 10).await;
        assert_eq!(out.counts.delete, 2);
    }

    #[tokio::test]
    async fn merge_both_empty() {
        let s = Cursor::new(VecSource::empty(), 4);
        let t = Cursor::new(VecSource::empty(), 4);
        let out = compare_streams(s, t, &[0], 1000, &mut |_| {}).await.unwrap();
        assert_eq!(out.counts, RowCounts::default());
    }

    #[tokio::test]
    async fn merge_detail_capped_but_counts_exact() {
        let src: Vec<_> = (1..=50).map(|i| row(i, "s")).collect();
        let tgt: Vec<_> = (1..=50).map(|i| row(i, "t")).collect(); // 50 行 update
        let s = Cursor::new(VecSource::of(src, 100), 100);
        let t = Cursor::new(VecSource::of(tgt, 100), 100);
        let out = compare_streams(s, t, &[0], 10, &mut |_| {}).await.unwrap();
        assert_eq!(out.counts.update, 50);
        assert_eq!(out.rows.len(), 10);
        assert!(out.truncated);
    }

    #[tokio::test]
    async fn merge_multi_column_key() {
        let r = |a: i64, b: i64, v: &str| vec![Value::Int(a), Value::Int(b), Value::Text(v.into())];
        let src = vec![r(1, 1, "x"), r(1, 2, "y"), r(2, 1, "z")];
        let tgt = vec![r(1, 1, "x"), r(1, 2, "改"), r(2, 2, "w")];
        let s = Cursor::new(VecSource::of(src, 100), 100);
        let t = Cursor::new(VecSource::of(tgt, 100), 100);
        let out = compare_streams(s, t, &[0, 1], 1000, &mut |_| {}).await.unwrap();
        assert_eq!(out.counts, RowCounts { insert: 1, update: 1, delete: 1, equal: 1 });
        // (2,1) 为 insert（源有目标无），(2,2) 为 delete
        assert_eq!(out.rows.iter().find(|r| r.action == RowAction::Insert).unwrap().key,
            vec![Value::Int(2), Value::Int(1)]);
        assert_eq!(out.rows.iter().find(|r| r.action == RowAction::Delete).unwrap().key,
            vec![Value::Int(2), Value::Int(2)]);
    }

    #[tokio::test]
    async fn fast_path_skips_identical_full_chunks() {
        // 双满块一致 → 走块哈希跳过；结果与逐行对比一致
        let a: Vec<_> = (1..=10).map(|i| row(i, "x")).collect();
        let out = merge(a.clone(), a, 5).await;
        assert_eq!(out.counts, RowCounts { insert: 0, update: 0, delete: 0, equal: 10 });
    }

    // ── 键类型判断 ──

    #[test]
    fn key_type_rules() {
        assert!(key_type_ok("bigint unsigned"));
        assert!(key_type_ok("varchar(64)"));
        assert!(key_type_ok("datetime"));
        assert!(!key_type_ok("float"));
        assert!(!key_type_ok("double"));
        assert!(!key_type_ok("text"));
        assert!(!key_type_ok("mediumblob"));
        assert!(!key_type_ok("json"));
    }
}


// ───────────────── e2e：docker/testenv（DBFLOW_E2E=1） ─────────────────

#[cfg(test)]
mod e2e {
    use crate::config::model::{ConnectionProfile, DatabaseKind};
    use crate::datasource::mysql::{self, ConnectEndpoint, MySqlLive};
    use crate::datasource::LiveConnection;
    use std::sync::Arc;

    fn enabled() -> bool {
        std::env::var("DBFLOW_E2E").is_ok()
    }

    fn profile(port: u16) -> ConnectionProfile {
        ConnectionProfile {
            id: uuid::Uuid::new_v4(),
            name: "e2e-datacmp".into(),
            group_id: None,
            color: None,
            db: DatabaseKind::MySql,
            host: "127.0.0.1".into(),
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

    async fn connect(port: u16, password: &str) -> Arc<dyn LiveConnection> {
        let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port };
        let pool = mysql::open_pool(&profile(port), &endpoint, Some(password))
            .await
            .expect("连接失败");
        Arc::new(MySqlLive::new(pool, None))
    }

    const DDL: &str = "(`id` bigint unsigned NOT NULL AUTO_INCREMENT,\
        `name` varchar(64) NOT NULL,\
        `price` decimal(12,2) DEFAULT NULL,\
        `score` double DEFAULT NULL,\
        `note` text,\
        `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\
        PRIMARY KEY (`id`)) ENGINE=InnoDB";

    /// 造差异 → 对比断言计数 → 全量同步（含 DELETE）→ 复比零差异
    #[tokio::test]
    async fn e2e_data_compare_roundtrip() {
        if !enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let a = connect(3306, "dbflow-a-2026").await;
        let setup = [
            "DROP DATABASE IF EXISTS `dc_src`",
            "DROP DATABASE IF EXISTS `dc_tgt`",
            "CREATE DATABASE `dc_src` DEFAULT CHARACTER SET utf8mb4",
            "CREATE DATABASE `dc_tgt` DEFAULT CHARACTER SET utf8mb4",
            &format!("CREATE TABLE `dc_src`.`t` {DDL}"),
            &format!("CREATE TABLE `dc_tgt`.`t` {DDL}"),
            &format!("CREATE TABLE `dc_src`.`nokey` (`a` int, `b` varchar(10)) ENGINE=InnoDB"),
            &format!("CREATE TABLE `dc_tgt`.`nokey` (`a` int, `b` varchar(10)) ENGINE=InnoDB"),
            // 源：1 同 / 2 改 / 4 新增；目标：1 同 / 2 旧 / 3 多余
            "INSERT INTO `dc_src`.`t` (`id`,`name`,`price`,`score`,`note`,`created_at`) VALUES \
             (1,'同','10.10',1.5,'中文备注','2026-01-01 08:00:00'),\
             (2,'改后','20.00',2.5,NULL,'2026-01-02 09:30:15'),\
             (4,'新增','99.90',NULL,'blob 测试','2026-01-04 00:00:00')",
            "INSERT INTO `dc_tgt`.`t` (`id`,`name`,`price`,`score`,`note`,`created_at`) VALUES \
             (1,'同','10.1',1.5,'中文备注','2026-01-01 08:00:00'),\
             (2,'改前','19.99',2.5,'旧备注','2026-01-02 09:30:15'),\
             (3,'多余','5.00',0.5,NULL,'2026-01-03 12:00:00')",
            "INSERT INTO `dc_src`.`nokey` VALUES (1,'x')",
            "INSERT INTO `dc_tgt`.`nokey` VALUES (1,'x')",
        ];
        for sql in setup {
            a.execute(sql).await.expect("建样本失败");
        }

        let snap_s = a.snapshot_tables("dc_src", Some(&["t".into(), "nokey".into()])).await.unwrap();
        let snap_t = a.snapshot_tables("dc_tgt", Some(&["t".into(), "nokey".into()])).await.unwrap();
        let opts = super::DataCompareOptions { chunk_size: 2, max_detail_rows: 100 };

        // t：1 insert + 1 update + 1 delete（id=1 的 price 10.10 vs 10.1 归一化后不报差异）
        let r = super::compare_table(
            &a, &a, "dc_src", "dc_tgt", "t",
            snap_s.tables.iter().find(|t| t.name == "t"),
            snap_t.tables.iter().find(|t| t.name == "t"),
            &opts, &mut |_| {},
        ).await.expect("对比失败");
        assert_eq!(r.status, super::TableStatus::Different);
        assert_eq!(r.counts, super::RowCounts { insert: 1, update: 1, delete: 1, equal: 0 },
            "归一化后应只有 3 行真实差异: {:?}", r.counts);
        let upd = r.rows_data.iter().find(|x| x.action == super::RowAction::Update).unwrap();
        assert!(upd.changed.contains(&1), "name 列应变更");   // name
        assert!(upd.changed.contains(&2), "price 列应变更");  // price 20.00 vs 19.99
        assert!(upd.changed.contains(&4), "note 列应变更");   // note NULL vs '旧备注'
        assert!(!upd.changed.contains(&5), "created_at 相同不应误报"); // datetime 相同

        // nokey：跳过并标注
        let rk = super::compare_table(
            &a, &a, "dc_src", "dc_tgt", "nokey",
            snap_s.tables.iter().find(|t| t.name == "nokey"),
            snap_t.tables.iter().find(|t| t.name == "nokey"),
            &opts, &mut |_| {},
        ).await.unwrap();
        assert_eq!(rk.status, super::TableStatus::Skipped);
        assert!(rk.skip_reason.is_some());

        // 全量同步（含 delete）→ 复比应为 Equal
        let key_idx = r.key_idx();
        let sqls = super::sqlgen::build_statements("dc_tgt", &r, &key_idx, &[
            super::RowAction::Insert, super::RowAction::Update, super::RowAction::Delete,
        ]);
        a.execute_batch_tx(&sqls).await.expect("同步执行失败");

        let snap_t2 = a.snapshot_tables("dc_tgt", Some(&["t".into()])).await.unwrap();
        let r2 = super::compare_table(
            &a, &a, "dc_src", "dc_tgt", "t",
            snap_s.tables.iter().find(|t| t.name == "t"),
            snap_t2.tables.iter().find(|t| t.name == "t"),
            &opts, &mut |_| {},
        ).await.unwrap();
        assert_eq!(r2.status, super::TableStatus::Equal, "同步后仍有差异: {:?}", r2.counts);

        a.execute("DROP DATABASE `dc_src`").await.unwrap();
        a.execute("DROP DATABASE `dc_tgt`").await.unwrap();
        a.shutdown().await;
    }

    /// 跨版本（8.4 vs 5.6）同数据对比应为零差异（datetime/decimal 归一化）
    #[tokio::test]
    async fn e2e_data_compare_cross_version_normalized() {
        if !enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let a = connect(3306, "dbflow-a-2026").await;
        let l56 = connect(3307, "123123").await;
        let setup56 = [
            "DROP DATABASE IF EXISTS `dc_xv`",
            "CREATE DATABASE `dc_xv` DEFAULT CHARACTER SET utf8mb4",
            &format!("CREATE TABLE `dc_xv`.`t` {DDL}"),
            "INSERT INTO `dc_xv`.`t` (`id`,`name`,`price`,`score`,`created_at`) VALUES \
             (1,'甲','10.10',1.5,'2026-01-01 08:00:00'),(2,'乙','0.00',NULL,'2026-06-30 23:59:59')",
        ];
        for sql in setup56 {
            l56.execute(sql).await.expect("5.6 建样本失败");
        }
        let setup8 = [
            "DROP DATABASE IF EXISTS `dc_xv8`",
            "CREATE DATABASE `dc_xv8` DEFAULT CHARACTER SET utf8mb4",
            &format!("CREATE TABLE `dc_xv8`.`t` {DDL}"),
            "INSERT INTO `dc_xv8`.`t` (`id`,`name`,`price`,`score`,`created_at`) VALUES \
             (1,'甲','10.1',1.5,'2026-01-01 08:00:00'),(2,'乙','0',NULL,'2026-06-30 23:59:59')",
        ];
        for sql in setup8 {
            a.execute(sql).await.expect("8.x 建样本失败");
        }

        let snap8 = a.snapshot_tables("dc_xv8", Some(&["t".into()])).await.unwrap();
        let snap56 = l56.snapshot_tables("dc_xv", Some(&["t".into()])).await.unwrap();
        let opts = super::DataCompareOptions::default();
        let r = super::compare_table(
            &a, &l56, "dc_xv8", "dc_xv", "t",
            snap8.tables.first(), snap56.tables.first(),
            &opts, &mut |_| {},
        ).await.unwrap();
        assert_eq!(r.status, super::TableStatus::Equal,
            "跨版本同数据出现假差异: {:?} rows={:?}", r.counts, r.rows_data);

        l56.execute("DROP DATABASE `dc_xv`").await.unwrap();
        a.execute("DROP DATABASE `dc_xv8`").await.unwrap();
        a.shutdown().await;
        l56.shutdown().await;
    }
}
