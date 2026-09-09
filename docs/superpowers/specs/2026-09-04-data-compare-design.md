# 数据对比与同步（一源对多目标）设计

日期：2026-09-04
状态：已确认（方案 A + 五段设计均经用户确认）

## 1. 背景与范围

DBFlow 已实现**结构对比**（一源对多目标并行、差异清单、SQL 生成、勾选执行）。
本设计新增**数据对比**（行级），同样为一源对多目标，形成「对比 → 行级明细 → 同步执行」闭环，对标 Navicat 数据同步。

已确认的关键决策：

| 决策点 | 结论 |
|---|---|
| 功能范围 | 对比 + 行级明细 + 同步执行 |
| 结果粒度 | 表级计数 + 行级明细（Update 行展示字段级前后值） |
| 无主键表 | 跳过并标注原因；优先取主键，否则第一个全 NOT NULL 唯一索引作为对比键 |
| 核心算法 | 方案 A：主键分块流式对比，块哈希跳过一致块，块内 merge-join 精确对比 |
| 数据库 | 仅 MySQL（5.6 / 8.x 兼容） |

## 2. 后端对比引擎（`src-tauri/src/datacmp/` 新模块）

### 2.1 数据模型

```rust
enum TableStatus { Equal, Different, Skipped, MissingOnTarget, MissingOnSource }

struct TableDataDiff {
    table: String,
    status: TableStatus,
    skip_reason: Option<String>,      // "无主键" / "主键含 text 列" 等
    key_columns: Vec<String>,         // 实际使用的对比键
    counts: RowCounts,                // { insert, update, delete }，精确计数，不受明细上限影响
    rows: Vec<RowDiff>,               // 差异明细，每类别封顶（默认 1000 条）
    truncated: bool,
}

enum RowAction { Insert, Update, Delete }  // Delete → dangerous

struct RowDiff {
    key: Vec<String>,                 // 键值（格式化后，展示用）
    action: RowAction,
    cells: Vec<CellDiff>,             // Update 时逐列 { column, source, target, changed }
    source_row: Option<Vec<String>>,  // Insert 时整行（格式化后）
    target_row: Option<Vec<String>>,  // Delete 时整行
    sql: Option<String>,              // 预生成同步 SQL（见 §5）
}
```

### 2.2 行值归一化（`Value` 枚举）

`Null / Int(i64) / UInt(u64) / Float(f64) / Decimal(String 规范化去尾零) / Text(String) / Bytes(Vec<u8>) / DateTime(String "YYYY-MM-DD HH:MM:SS.ffffff", UTC)`

- 连接会话 `SET time_zone = '+00:00'` 消除时区差
- float/double 精确位比较（同数据复制场景成立）
- BLOB/TEXT：参与哈希；明细展示用 `[BLOB 1.2KB]` 占位
- 归一化逻辑为纯函数，可单测

### 2.3 分块对比算法

1. 确定对比键：主键；无主键则取第一个全 NOT NULL 唯一索引；都没有 → `Skipped`
2. 键列含 text/blob/float 等不可可靠排序比较的类型 → `Skipped` 并注明
3. 两端同步按块拉取：`WHERE (pk) > (last_key) ORDER BY pk LIMIT 5000`（多列键用行构造器 `(a,b) > (?,?)`）
4. 每块对齐范围后先算**块哈希**（归一化值序列化后 SHA-1，复用项目已有 sha1 依赖）——一致则只累计行数，不产生明细
5. 不一致的块内做 merge-join 逐行对比：
   - 键仅在源 → Insert
   - 键仅在目标 → Delete（dangerous，同步默认不勾选）
   - 键相同、行哈希不同 → Update（记录字段级前后值）
6. 两端耗尽即结束

**内存特征**：任意时刻仅 2 个块（源+目标各 5000 行）+ 封顶差异明细，与表大小无关。

### 2.4 边界情况

- 目标缺表 → `MissingOnTarget`（提示先做结构同步）；源缺表 → `MissingOnSource`
- 空表对空表 → `Equal`，不产生明细

## 3. 命令层与 API（`src-tauri/src/commands/datacmp.rs`）

结构与现有 `commands/compare.rs` 对称，复用 `CompareTargetSpec` / `ApplyResult` / Registry / JoinSet 并行框架：

```rust
compare_data_multi(
    source_connection_id, source_database,
    tables: Vec<String>,
    targets: Vec<CompareTargetSpec>,
    options: DataCompareOptions,        // { chunk_size: 默认5000, max_detail_rows: 默认1000 }
) -> Vec<DataTargetReport>

struct DataTargetReport {
    report_id: String,                  // 明细拉取句柄（见 get_table_diff_detail）
    key, connection_id, database,
    tables: Vec<TableDataDiff>,         // 仅摘要与计数；明细按需拉取
    error: Option<TargetError>,         // 单目标失败不影响其他目标（同结构对比语义）
}

get_table_diff_detail(                  // 行级明细按需拉取（避免一次性传大量明细到前端）
    report_id: String,                  // compare_data_multi 返回的 DataTargetReport.reportId
    table: String
) -> TableDataDiff                      // 含 rows
// 后端在 App 状态里缓存最近一次对比的完整报告（reportId -> DataTargetReport），
// 新一次 compare_data_multi 会替换同 target key 的旧缓存；前端切换表时按表拉取明细。

apply_data_sync(
    target_connection_id,
    statements: Vec<DataSyncStatement>, // { table, action, sql }
) -> Vec<TableApplyResult>              // { table, ok, applied_count, error }
```

**进度事件** `data-compare-progress`：`{ targetIndex, table, phase: fetch|diff, rowsCompared }`。
源端失败整体报错；目标端失败写入该目标 error。

## 4. 前端交互

### 4.1 入口与向导

- 连接树在「结构同步」旁新增「数据同步」入口，打开全屏 `DataSyncModal`
- 四步向导（与 `SyncSchemaModal` 一致）：
  1. **选源与目标**：源连接+库；多目标勾选（复用现有多目标选择器）。选项：分块大小（5000）、明细上限（1000）
  2. **选表**：源库表列表（带行数估计、全选/搜索）；无可用对比键的表置灰提示
  3. **对比**：进度弹层，多目标并行，逐表进度条（`data-compare-progress` 驱动）
  4. **结果页**（三栏）：
     - 左：目标 Tab 横排，差异数徽标；失败目标标红可查看错误
     - 中：表清单（状态图标 + insert/update/delete 计数，默认只显示有差异表，可切换全部）
     - 右：行级明细（Insert 绿 / Delete 红 / Update 黄；Update 行展开字段级前后值并高亮变更字段；封顶时提示「仅显示前 1000 条，计数为精确值」）

### 4.2 同步操作

- 勾选粒度：**表 × 类别**（如 orders 表的 231 条 insert）
- Delete 类默认不勾选 + 红色警示
- 「预览 SQL」查看全部将执行语句（DELETE 总数置顶显示）→「开始同步」→ 每表成功/失败结果 → 一键「重新对比」验证

### 4.3 状态管理

新增 `src/stores/dataCompare.ts`（zustand，结构镜像 `compare.ts`）。
明细数据只存当前选中目标+表，切换时经 `get_table_diff_detail` 按需拉取。

## 5. 同步执行

### 5.1 SQL 生成（对比时逐行预生成，内嵌 `RowDiff.sql`）

- Insert → 多行合并多值 `INSERT INTO \`db\`.\`t\` (...) VALUES (...), (...)`，每 100 行一条
- Update → `UPDATE ... SET 仅变更列 WHERE 键列`（WHERE 用目标端原始键值，防键被改时找不到行）
- Delete → `DELETE FROM ... WHERE 键列`（dangerous）
- 值转义：字符串/时间 → 单引号 + 反斜杠转义；BLOB → `0x` 十六进制；NULL 原样
- SQL 为完整文本内联值（与结构同步「勾选后原样提交」模式一致）；值全部来自数据库本身且经严格转义

### 5.2 执行

- 按表分组，**每表一个事务**（InnoDB DML 可回滚）：全成功 COMMIT，任一失败 ROLLBACK 该表并记录错误，表间互不影响
- 执行会话内 `SET FOREIGN_KEY_CHECKS=0`（会话级，结束后自动恢复）

### 5.3 安全闸门

- Delete 类默认不勾选 + 红色警示 + 预览置顶 DELETE 总数
- 单表 delete 超过 1000 行时二次确认

## 6. 测试策略

- **纯函数单测**（`datacmp/`，不走数据库）：归一化规则（decimal 尾零、datetime 格式）、merge-join 各分支、多列键、块边界、SQL 生成与转义
- **e2e**（复用 `DBFLOW_E2E=1` + docker/testenv 的 mysql-a/b/5.6）：同构表造差异数据 → 断言计数与明细 → 全量同步 → 复比零差异；跨 8.4/5.6 组验证归一化无假差异；无主键表跳过组
- **前端 store 测试**：`dataCompare.test.ts`（vitest，镜像 `compare.test.ts`）

## 7. 文件影响清单

新增：
- `src-tauri/src/datacmp/mod.rs`（引擎：模型、归一化、分块对比、SQL 生成）
- `src-tauri/src/commands/datacmp.rs`（三个命令 + 进度事件）
- `src/stores/dataCompare.ts` + `dataCompare.test.ts`
- `src/components/datacmp/DataSyncModal.tsx`（向导 + 结果三栏）
- `src/components/datacmp/RowDiffView.tsx`（行级明细）
- `src/api/types.ts` / `src/api/commands.ts` 增补对应类型与封装

修改：
- `src-tauri/src/lib.rs`（注册模块与命令）
- `src-tauri/src/datasource/mod.rs`（`LiveConnection` 增加分块拉取行数据的方法）
- `src-tauri/src/datasource/mysql.rs`（实现该方法 + 会话时区设置）
- 连接树组件（新增「数据同步」入口）
