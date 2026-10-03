# ER 图（数据结构可视化）MVP 设计

日期：2026-09-29
状态：已确认（MVP 范围），实现后按反馈迭代

> **修订（2026-09-30）**：命名推断规则已简化为「同名列 = 他表主键（表名+ID，忽略大小写）」，删除复数/缩写等猜测；新增手动关联（拖拽连线/对话框添加，实线紫、可删除，随模型文档保存）。本文档其余部分为 MVP 设计原稿，最新行为以 README 为准。

## 背景与目标

为 DBFlow 增加类 PowerDesigner / drawdb / ChartDB 的数据结构管理能力。整体愿景分三个阶段：

1. **MVP（本期）**：逆向可视化——连接已有数据库，自动生成只读 ER 图，浏览/布局/搜索/导出
2. **二期 A**：图上编辑建模，diff 后应用回库（复用现有 diff/DDL 引擎）
3. **二期 B**：多人协作——主版本模型文档共享，成员导入后与自己的库对比

### 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| MVP 核心场景 | 逆向可视化（只读 ER 图） |
| 目标规模 | 大库 50–300 表，需自动布局/搜索/小地图 |
| 关系来源 | 真实外键 + 命名约定推断（推断边可裁决） |
| 入口形态 | WorkTab 新增 `type: 'er'` 标签页，连接树库节点右键打开 |
| 画布选型 | `@xyflow/react` v12 + `@dagrejs/dagre` 自动布局 |
| MVP 加分项 | 布局本地保存、导出 PNG、导出 DDL、搜索定位 |
| 协作预留 | ER 模型为独立版本化文档（`.er.json`），不提前实现协作功能 |

## 总体架构

### 模块划分（跟随现有项目模式）

```
src/components/er/
  ErTab.tsx        # ER 标签页容器（WorkTab 新增 type: 'er'）
  ErCanvas.tsx     # React Flow 画布
  TableNode.tsx    # 表节点组件
  ErToolbar.tsx    # 搜索、导出、重新布局、推断关系开关
  ErDrawer.tsx     # 表详情侧边抽屉
  infer.ts         # 命名推断纯函数
  layout.ts        # dagre 自动布局封装
  transform.ts     # 快照 → 节点/边 转换纯函数
src/stores/er.ts   # zustand store：快照加载、模型文档、脏标记
```

### 数据流

1. 打开标签 → 调 `get_er_snapshot(connection_id, database)`：后端组合 `snapshot_tables`（表/列/主键/索引，已有能力）+ 外键查询（新增），一次往返拿全
2. `transform.ts` 把快照转为节点 + 真实 FK 边
3. `infer.ts` 生成命名推断边，虚线样式，不参与布局计算
4. dagre 按真实 FK 关系层次布局（TB）→ 渲染
5. 用户拖拽/裁决/折叠后 → 保存模型文档

## 模型文档格式（协作铺垫核心）

```ts
interface ErModelDoc {
  formatVersion: 1
  kind: 'mysql'                  // 随 DatabaseKind 扩展
  database: string
  origin: { connectionName: string; capturedAt: string }  // 不含敏感信息
  tables: { id: string; name: string; x: number; y: number; collapsed: boolean }[]
  edges: {
    id: string
    kind: 'fk' | 'inferred'
    status?: 'confirmed' | 'ignored'   // 推断边用户裁决
    source: { table: string; column: string }
    target: { table: string; column: string }
  }[]
}
```

**关键决策：文档不冗余存储列结构。** 列定义属于数据库，每次打开实时取；文档只存布局与关系拓扑。文档极小、纯文本可 git diff/合并（适配二期协作）、永不过期。二期建模时给表加可选 `schema` 字段表达与库的差异，`formatVersion` 支持演进。

## 后端改动（src-tauri）

1. `datasource/mysql.rs` 新增 `list_foreign_keys(db)`：查 `KEY_COLUMN_USAGE` join `REFERENTIAL_CONSTRAINTS`，返回 `ForeignKeyDef { name, columns[], ref_table, ref_columns[], on_delete, on_update }`；`LiveConnection` trait 加对应方法
2. 新命令：
   - `get_er_snapshot`：表快照 + 外键组合返回（过滤视图）
   - `load_er_model` / `save_er_model` / `delete_er_model`：模型文档 CRUD，存 `配置目录/er-models/${connectionId}__${database}.er.json`，原子写（复用 config 模式）
   - `export_er_model`：dialog 选路径导出 `.er.json`
   - `export_tables_ddl`：按表名集合过滤快照 + `create_table_sql` 拼 DDL 返回文本
3. FK 的 DDL 生成（ADD/DROP FOREIGN KEY）二期补，MVP 不需要

## 前端交互

- **表节点**：头部（表名 + 注释 tooltip）+ 列行（主键/唯一索引图标、列名、类型与 NULL 灰字）；可折叠为纯头部
- **边**：FK 实线 smoothstep；推断边灰虚线；hover 高亮两端 + tooltip（FK 名/列映射）
- **表详情 Drawer**：单击表滑出，antd Table 展示完整列/索引/外键
- **布局**：首次 dagre；有文档恢复位置；新增表摆左侧堆叠区；「重新布局」全量重排；拖拽产生脏标记，关标签提示保存
- **搜索**：本地匹配表名/列名/注释 → 结果下拉 → 定位 fitView + 高亮
- **导出图片**：`html-to-image` + React Flow 导出方式生成 PNG，tauri dialog 保存
- **导出 DDL**：选中表 → Modal 预览 → 复制或存 .sql

## 命名推断规则（infer.ts 纯函数）

- 模式：`user_id` / `userId` → 复数化目标表（`users`）的单列主键；内置英文单复数规则（+s、y→ies、常见不规则词）
- 约束：目标表存在且有单列主键；排除被真实 FK 覆盖的列；排除自引用误报
- 裁决：点击推断边 → 确认（转实线、参与布局）/ 忽略（隐藏并记入文档）
- 性能：300 表 × 15 列建索引后毫秒级

## 测试策略

- **前端 vitest**（`vi.mock('../api/commands')` 模式）：
  - `infer.test.ts`：复数/不规则词/排除 FK/自连接/复合主键分支
  - `transform.test.ts`：快照→节点/边转换
  - `er.test.ts`：store 加载、文档保存恢复、脏标记、新增表合并
- **Rust**：`list_foreign_keys` 按 `mysql.rs` 内联单测 + docker e2e 模式；模型文档读写按 `config/store.rs` 模式
- **性能验收**：docker fixture 造 200+ 表库实测拖拽/缩放

## 依赖增量

`@xyflow/react`（~50KB gzip）+ `@dagrejs/dagre`（~30KB）+ `html-to-image`（~10KB），画布基础能力的最轻组合。

## 二期路线（仅架构预留）

1. 图上编辑建模 → 文档 `schema` 字段 → `diff_snapshots` 模型↔库对比 → 复用 `apply_sync` 部署；补 FK DDL 生成
2. 多人协作：主版本 `.er.json` 放 git/共享盘 → 导入 → 与本库对比（对比来源从连接扩展为文档）
