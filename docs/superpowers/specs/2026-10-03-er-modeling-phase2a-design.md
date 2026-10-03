# ER 图二期 A：图上编辑建模 设计

日期：2026-10-03
状态：已确认（六节分节评审通过），待写实施计划

## 背景与目标

ER 图 MVP（0.3.0，逆向只读可视化）之上的正向建模闭环：在 ER 图上新建表、修改列/索引/关系，模型与真实库 diff 后生成 DDL（含外键 ADD/DROP）应用回库——类 PowerDesigner 的正向建模。

前置材料：`2026-09-29-er-diagram-mvp-design.md`（MVP 设计与「二期路线」预留）、README「ER 图」章节（MVP 全部交互行为）。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 编辑入口 | 显式编辑模式开关（关闭时与 MVP 行为完全一致） |
| diff 范围 | 仅模型涉及的表（新建/编辑/标记删除的表）；库里其他表永不出现在差异里 |
| 关系概念 | 手动关联（紫实线、纯标注、永不生成 DDL）与模型外键（青绿实线、表 schema 一部分、回库生成 FK DDL）区分两概念 |
| 应用目标 | 仅应用回模型来源的连接+库 |
| 表编辑 UI | 独立表设计器 Modal（列/索引/外键/表选项 Tab + 实时 DDL 预览） |
| schema 存储 | 文档按表全量存（字段与后端 `TableDef` 对齐）；存在即「模型为准」 |
| diff 复用 | 前端构造模型 payload → 后端薄命令 `er_diff` → `compare/er_model.rs` 纯函数组装 → 复用 `diff_snapshots` + 新增 FK 对比；执行复用 `apply_sync` |
| 表改名 | 不支持（已同步表名只读；未应用新表可改）——规避改名被误判 DROP+CREATE 的丢数据路径 |
| 文档版本 | formatVersion 1 → 2，惰性迁移（v1 读作无 schema 的 v2，下次保存升级） |

## 总体架构与数据流

```
编辑态（工具栏开关进入）
  新建表 ──► modelTables[key] = { schema }                    ┐
  编辑表 ──► copy-on-edit：库结构拷入 schema，此后文档为准       │ 脏标记，随 .er.json v2 保存
  删除表 ──► tombstone（deleted: true，画布灰显，可恢复）        │
  建模型 FK ─► 存入子表 schema.foreignKeys（非 manual edge）    ┘

应用变更（编辑态工具栏按钮）
  前端: modelTables payload ─► 后端 er_diff(connection_id, database, payload)
  后端: snapshot_tables(仅涉及表) + list_foreign_keys
        ─► compare/er_model.rs 纯函数：
            构造模型快照 → diff_snapshots()（列/索引/表选项零改动复用）
            + diff_foreign_keys()（ADD/DROP/重建 FK）
            + DDL 排序（DROP FK → DROP TABLE → 建表/改表 → ADD FK）
        ─► Vec<DiffItem>（结构与现有 compare 完全一致）
  前端: ErApplyModal（差异勾选 → 部署 → 完成刷新）
        ─► apply_sync 逐条执行 ─► 刷新快照 + 复跑 er_diff
        ─► 零差异表清 schema、tombstone 移除、角标更新
```

## 模型文档格式 v2

```ts
interface ErModelDoc {
  formatVersion: 2            // 1 → 2，新增字段全部可选，向下兼容
  kind: 'mysql'
  database: string
  origin: { connectionName: string; capturedAt: string }
  tables: ErDocTable[]
  edges: ErDocEdge[]
}

interface ErDocTable {
  id: string; name: string; x: number; y: number; collapsed: boolean  // 既有字段不变
  status?: 'deleted'         // 仅 tombstone；new/edited 不落文档
  schema?: ErTableSchema     // 仅新建/编辑过的表有；存在即「模型为准」
}

interface ErTableSchema {
  name: string
  engine: string | null
  collation: string | null
  comment: string | null
  columns: { name; dataType; nullable; default; extra; comment; characterSet; collation }[]
  indexes: { name; columns; subParts; directions; unique; isPrimary; indexType }[]
  foreignKeys: ErFkSchema[]
}

interface ErFkSchema {
  name: string; columns: string[]; refTable: string; refColumns: string[]
  onDelete: string | null; onUpdate: string | null
}
```

语义要点：

- **new/edited 不单独存**：由「有无 schema × 是否在实时快照中」在加载时推导（有 schema 且库有 → 已编辑；库无 → 新建）。diff 的 CREATE/ALTER 同样由此判定。新建表与库中已有表同名（忽略大小写）在前端校验拦截
- **模型外键真源在 `schema.foreignKeys`**；`edges[]` 新增 `kind: 'mfk'` 只承载显示层信息（via/锚点覆盖）。模型 FK 边 id：`mfk:{表}:{约束名}`（真实 FK 为 `fk:{表}:{约束名}`）；应用成功刷新时把 `mfk:` 边的 via/锚点迁移到对应 `fk:` 边（同名同表时），用户手调的走线不丢
- **tombstone 保留坐标**供画布灰显（删除线样式），应用前可右键恢复；应用成功后条目移除
- **v1 → v2 惰性迁移**：打开 v1 当 v2 读（无 schema/status 即普通同步表），下次保存写 `formatVersion: 2`；版本缺失或 > 2 走现有 `docIssue` 提示。不做破坏性改写
- **应用成功自清理**：apply 完成 → 刷新快照 → 复跑 er_diff，零剩余差异的表自动清 schema 回「实时为准」；仍有差异（未勾危险项/执行失败）则 schema 保留、角标仍在

## 后端改动

### 新命令 `er_diff`（`commands/er.rs`，薄 IO 层）

```rust
#[tauri::command]
pub async fn er_diff(
    registry, connection_id: Uuid, database: String,
    model: Vec<ErModelTableInput>,   // { name, schema? }；schema=None 即 tombstone
) -> AppResult<Vec<DiffItem>>
```

流程：`snapshot_tables(db, 仅涉及表)` + `list_foreign_keys(db)` → 调 `compare::er_model::diff_model_vs_db` → 返回。**应用侧零新命令**（复用 `apply_sync`）。

### 新纯函数模块 `compare/er_model.rs`

（`compare/mod.rs` 已约 1900 行不再塞；与 `diff_snapshots` 同级可单测）

1. **模型快照构造**：payload 带 schema 的表 → `TableDef`；tombstone 不进 source。给 `TableDef`/`ColumnDef`/`IndexDef`/`ForeignKeyDef` 补 `Deserialize`（`ordinal` 加 `#[serde(default)]`），文档 schema 与 TableDef **按类型对齐**而非手工镜像。payload 表结构 = TableDef 字段 + `foreignKeys`。`server_version` 取实时快照的（归一化目标就是应用目标库）
2. **表名对齐**：payload 表名若与库中表忽略大小写同名，对齐为库原始大小写后再 diff（避免 diff 引擎精确匹配把大小写差异误判为 DROP+CREATE；新表不在库中，用用户输入原样）
3. **结构 diff 复用**：`diff_snapshots(model, db, { compare_indexes: true, compare_views: false })`——新表 CREATE、tombstone DROP、编辑表列/索引差异全部自然产出。**保留 `tblopt:` 表选项差异项**（与结构同步工具的过滤策略不同：设计器支持编辑注释/引擎/排序规则）
4. **FK 对比规则**（`diff_foreign_keys` + tombstone 附加规则）：
   - FK 所在表 ∈ 模型 schema 表集：按（表, 约束名）匹配——模型有库无 → ADD（复用 `foreign_key_ddl`）；库有模型无 → DROP（`drop_foreign_key_ddl`，dangerous）；都有但列/引用/规则不同 → 一条 ALTER 内 DROP+ADD（照 `rebuild_index_sql` 模式）
   - 库中引用任一 tombstone 表的外键（无论所在表是否模型涉及）→ 一律 DROP FK（dangerous）——删除表的直接必然后果，否则 DROP TABLE 必然失败
   - 其余（非模型表且不引用 tombstone 的外键）不动
5. **DDL 排序**（er_model.rs 统一排序，前端按序执行）：
   ```
   ① DROP FOREIGN KEY（含 tombstone 引用 FK；环上 FK 在此解除）
   ② DROP TABLE（被引用表排后；①已断环，无需合并语句）
   ③ CREATE TABLE / ALTER（沿用 diff 引擎表内顺序；组内按表名、id 稳定排序）
   ④ ADD / 重建 FOREIGN KEY（表与列已就位）
   ```
   前端 `buildDeployStatements` 需保持返回顺序（同表列子句合并逻辑不变；若现实现有重排序则调整）
6. **payload 校验**（`AppError::Validation`）：表名非空且集合内唯一（忽略大小写）、schema 表至少一列、列名/索引名/FK 约束名表内唯一（忽略大小写）、FK 的 columns 与 refColumns 长度相等且 ≥1。引用表/列存在性由前端设计器保证 + 数据库报错兜底

### DiffItem 扩展

`DiffKind` 加 `ForeignKey` 变体（`#[serde(rename = "foreignKey")]`，其余字段命名已是 camelCase）；FK 项 id `fk:{表}:{约束名}`，带 `source_ddl`/`target_ddl`（各自形态的 FK DDL）供 DDL 对比视图。

### sqlgen 新增

- `drop_foreign_key_ddl(db, table, fk_name)` → `ALTER TABLE `db`.`t` DROP FOREIGN KEY `name``
- FK 重建（DROP+ADD 同语句）复用既有拼接规则

### 辅助命令 `preview_table_ddl`

`(schema: ErModelTableInput) → String`：复用 `create_table_sql`，表设计器底部实时 DDL 预览用。

### 不改的东西

`diff_snapshots` 本体、`apply_sync`、`SchemaSnapshot`（不加 foreign_keys 字段——普通结构同步行为不变，FK 比较只挂在 er_model 路径）。

## 前端交互

### 编辑模式开关（工具栏）

- 打开：工具栏出现「新建表」「应用变更（N）」；双击表 → 直接打开表设计器（浏览态双击仍开只读抽屉，抽屉内加「编辑结构」按钮亦可唤起设计器）；画布右键菜单扩展
- 关闭只是隐藏编辑入口，建模修改保留（角标仍在）；脏标记与布局共用一套 dirty/save/closeGuard，`.er.json` 一次落盘

### 新建表

- 工具栏按钮 → 视口中心创建空表节点（虚线边框 +「新」角标）→ 立即弹出表设计器，预填一行 `id BIGINT UNSIGNED AUTO_INCREMENT` 主键（可改可删）
- 默认名 `new_table_N`（递增）；**未应用前可改名**，已同步表在设计器中表名只读；校验：不与库表/其他模型表同名（忽略大小写）、至少一列（前端保存校验 + er_diff 后端兜底）

### 表设计器 Modal（新建/编辑共用，~960 宽）

- **列** Tab：行内编辑——列名/类型（输入 + 常用类型建议）/NULL/默认值/自增/注释；上下箭头调列序（列序驱动 AFTER 子句）
- **索引** Tab：含 PRIMARY 行（可编辑列集合）；名/列/唯一/类型
- **外键** Tab：名/本表列（多选）/引用表（全图可选，含模型表）/引用列（多选）/ON DELETE/ON UPDATE 下拉
- **表选项** Tab：注释/引擎/排序规则
- 底部**实时 DDL 预览**（`preview_table_ddl`）
- 打开已同步表 = copy-on-edit 拷实时结构入文档 schema；保存时若与库结构完全一致则不落 schema（不留假「已编辑」角标）

### 模型外键（画布）

- 编辑态从列行拖线到目标列（复用现有拖线交互）→ 弹框确认：约束名（默认 `fk_{表}_{列}`）、ON DELETE/ON UPDATE → 写入**子表** schema.foreignKeys（子表随之 copy-on-edit）。浏览态拖线仍是 manual edge
- 视觉：实线青绿 + 端点菱形标记 + tooltip「模型外键（未应用）」；与真实 FK（实线蓝）、manual（实线紫）、推断（虚线）四类可辨；参与 dagre 布局与真实 FK 同权
- 右键模型 FK 边 → 删除（库里已有同名 FK 的，下次 diff 即 DROP FK 项）

### 删除表

- 编辑态右键表 → 确认弹窗 → 同步表转 tombstone（灰显 + 名称删除线 +「删」角标，可右键恢复）；新建表直接移除
- **校验**：有模型外键引用该表时阻止删除，提示先删引用关系（库中外键引用由后端排序自动处理）

### 应用变更（ErApplyModal，独立弹窗）

- 三步：差异确认（按表分组勾选树 + DDL 对比/部署脚本页签，dangerous 默认不勾、红色标注）→ 部署执行（逐条结果内联标注）→ 完成态
- 组件策略：优先复用 `DiffTree`/`SqlView`（必要时把 props 从 compare store 解耦成受控组件）；ER 差异量小（用户驱动），兜底做按表分组的精简勾选列表
- 完成后自动：刷新快照 + 复跑 er_diff → 零差异表清 schema、tombstone 移除、角标更新；弹窗保留「重新比较」
- 弹窗打开期间画布锁定；applying 中禁用一切编辑动作

### store 与图构建（`stores/er.ts` / `transform.ts`）

- `ErTabState` 增 `editMode: boolean`、`modelTables: Record<lowerName, { schema: ErTableSchema | null; deleted: boolean }>`
- 动作集：`createTable / saveTableSchema / deleteTable / restoreTable / addModelFk / removeModelFk`（+ 编辑开关）
- `buildErGraph(snapshot, modelTables)`：有 schema 的表以文档结构渲染（列/索引来自 schema）；新表只来自 schema；tombstone 表以库结构渲染 + 标记；模型 FK → mfk 边；推断/manual 逻辑不变（对新表同样生效）

## 冲突与安全策略

- **库漂移**：diff 永远在点击「应用变更」时拉库实时快照，模型 schema 是目标形态，无过期基准。别人加的列/索引在模型里没有 → 如实显示为 DROP 类危险项（默认不勾）；不勾即不应用，冲突透明，无静默丢数据路径
- **危险项**：DROP TABLE/COLUMN/INDEX/FOREIGN KEY 全部 dangerous：红色 + 默认不勾（沿用 compare 口径）；删除表二次确认 + tombstone 可恢复
- **不可回滚**：MySQL DDL 隐式提交，`apply_sync` 逐条执行、单条失败继续、结果逐条如实回报；部署页顶部警示文案沿用，不假装能回滚
- **执行失败**：失败语句 + 服务端错误内联标注，可「重新比较」后修复重试；只有零剩余差异才清 schema，状态与库实际一致。ADD FK 被库拒绝（数据不一致/类型不兼容）→ 错误如实展示；前端只做存在性校验，类型兼容性交给数据库裁决
- **已知局限**：同库多 ER 标签同时建模仍为 last-write-wins（MVP 既有语义，二期 B 协作时统一解决）；连接断开走既有 `withSessionReconnect`

## 测试策略

**Rust（`cargo test`，TDD 先行）**

- `compare/er_model.rs` 单测：快照构造与表名对齐、tombstone 排除/DROP、tblopt 保留、`diff_foreign_keys`（ADD/DROP dangerous/同名重建/只比模型表）、tombstone 引用 FK 一律 DROP、DDL 四组排序与断环、payload 校验（空名/重名/0 列/FK 列数）、schema JSON → TableDef 反序列化
- `sqlgen`：`drop_foreign_key_ddl`、FK 重建语句文本
- e2e（`DBFLOW_E2E=1`，照 `compare/mod.rs` e2e 模式）：mysql5.6 完整闭环（新表+编辑表+tombstone+模型 FK → er_diff → execute → 复跑零差异）；demo_fk 环形引用删除实测；mysql-a（8.4）兼容性复跑
- 复用路径不重复测：diff_snapshots/apply_sync 既有测试即回归保障

**前端（`pnpm test`，vitest + `vi.mock('../api/commands')` 既有模式）**

- `transform.test.ts`：buildErGraph(快照+modelTables)（schema 表用文档结构、新表入图、tombstone 标记、mfk 边）、buildModelDoc 落 schema/status 与 formatVersion 2、v1 文档照常叠加（惰性迁移）
- 校验纯函数：重名（忽略大小写）/0 列/FK 引用完整性/删被引用表阻止
- `er.test.ts`：createTable（默认名递增）、saveTableSchema（copy-on-edit、与库一致不落 schema）、deleteTable/restore、addModelFk/removeModelFk、v2 文档恢复（new/edited 角标推导）、apply 后刷新（零差异清 schema、tombstone 移除、mfk→fk 走线迁移——mock er_diff/apply_sync）
- DiffTree 若解耦为受控组件则补受控行为测试

**验收（真库手工）**：demo_fk 21 表跑通「新建表 → 模型 FK → 编辑既有表 → 应用 → 库结构核对 → 角标消失」全闭环；README ER 章节同步更新。

提交门槛：`pnpm test` + `cargo test` 全绿。

## 范围外与已知局限

- 表改名（已同步表）、多目标应用、协作导入对比（二期 B）、视图/触发器/存储过程建模、非 MySQL 方言
- 说明：非模型表上「引用被删表」的外键会被 tombstone 规则自动 DROP（这是删除操作的必然后果，属本期范围）；该表本身的其他结构永不被改动
