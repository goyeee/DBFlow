// 与 src-tauri 的 serde 结构一一对应（camelCase）
export type DatabaseKind = 'mysql'
export type SslMode = 'disabled' | 'preferred' | 'required'

export interface ConnectionOptions {
  sslMode: SslMode
  connectTimeoutSecs: number
  charset: string | null
  comment: string | null
}

export type SshAuth =
  | { type: 'password' }
  | { type: 'privateKey'; keyPath: string }

export interface SshTunnelConfig {
  host: string
  port: number
  user: string
  auth: SshAuth
  targetHostOverride: string | null
}

export interface ConnectionProfile {
  id: string
  name: string
  groupId: string | null
  color: string | null
  db: DatabaseKind
  host: string
  port: number
  user: string
  defaultDatabase: string | null
  hasPassword: boolean
  sshHasPassword: boolean
  /** 记住密码：密码同时落一份到本地 secrets.json（仅混淆），更新/重启后免输入 */
  rememberPassword: boolean
  options: ConnectionOptions
  ssh: SshTunnelConfig | null
  createdAt: number
  updatedAt: number
}

/** 新建/编辑表单提交体 */
export interface ConnectionProfileInput {
  id: string | null
  name: string
  groupId: string | null
  color: string | null
  db: DatabaseKind
  host: string
  port: number
  user: string
  defaultDatabase: string | null
  rememberPassword: boolean
  options: ConnectionOptions
  ssh: SshTunnelConfig | null
}

export interface ConnectionGroup {
  id: string
  name: string
  sortOrder: number
  color: string | null
}

export interface ConfigSnapshot {
  groups: ConnectionGroup[]
  connections: ConnectionProfile[]
}

export interface DatabaseBrief {
  name: string
}

export interface TableBrief {
  name: string
  engine: string | null
  rowsEstimate: number | null
  comment: string | null
}

export interface ColumnBrief {
  name: string
  dataType: string
  nullable: boolean
  key: string
  default: string | null
  extra: string
  comment: string | null
}

export interface AppErrorInfo {
  code: string
  message: string
  detail?: string
}

export interface TestResult {
  ok: boolean
  serverVersion: string | null
  latencyMs: number
  error: AppErrorInfo | null
}

export interface ConnectResult {
  serverVersion: string
  latencyMs: number
}

export interface NavicatCandidate {
  sourceName: string
  kind: string
  host: string
  port: number
  user: string
  password: string | null
  passwordStatus: 'plain' | 'master' | 'unknown' | 'empty'
  database: string | null
  ssh: SshTunnelConfig | null
  sshPassword: string | null
  origin: string
}

export interface NavicatImportSelection {
  sourceName: string
  origin: string
  host: string
  port: number
  user: string
  groupId: string | null
  path: string | null
}

export interface NavicatImportResult {
  imported: number
  failed: { name: string; reason: string }[]
}

// ───────────────── 结构对比与同步 ─────────────────

export type DiffKind = 'table' | 'column' | 'index' | 'view'
export type DiffAction = 'create' | 'drop' | 'modify' | 'rename'

export interface CompareOptions {
  /** 表永远对比；索引默认对比 */
  compareIndexes: boolean
  /** 视图等非常用对象默认不对比 */
  compareViews: boolean
}

export interface DiffItem {
  /** tbl:{表} / tblopt:{表} / col:{表}:{列} / idx:{表}:{索引} */
  id: string
  kind: DiffKind
  action: DiffAction
  table: string
  name: string
  sourceDesc: string | null
  targetDesc: string | null
  sql: string | null
  /** 破坏性操作（DROP 类）→ 默认不勾选 */
  dangerous: boolean
  /** 源端该表完整建表 DDL（表在源端不存在为 null） */
  sourceDdl: string | null
  /** 目标端该表完整建表 DDL（表在目标端不存在为 null） */
  targetDdl: string | null
}

export interface ApplyResultItem {
  sql: string
  ok: boolean
  error: string | null
}

/** 多目标对比：单个目标规格 */
export interface CompareTargetSpec {
  key: string
  connectionId: string
  database: string
}

/** 多目标对比：单个目标结果 */
export interface TargetReport {
  key: string
  connectionId: string
  database: string
  items: DiffItem[]
  error: AppErrorInfo | null
}

// ───────────────── 数据对比与同步 ─────────────────

export type RowAction = 'insert' | 'update' | 'delete' | 'equal'
export type TableDataStatus =
  | 'equal'
  | 'different'
  | 'skipped'
  | 'missingOnTarget'
  | 'missingOnSource'

export interface DataCompareOptions {
  chunkSize: number
  maxDetailRows: number
}

export interface RowCounts {
  insert: number
  update: number
  delete: number
  /** 两端一致的行数 */
  equal: number
}

export interface CellDiff {
  column: string
  source: string
  target: string
  changed: boolean
}

export interface RowDiff {
  key: string[]
  action: RowAction
  /** update：逐列前后值；insert/delete 为空（看 sourceRow/targetRow） */
  cells: CellDiff[]
  sourceRow: string[] | null
  targetRow: string[] | null
}

/** 行级对照筛选：所有行 / 不同 / 单一动作 */
export type RowPreviewFilter = 'all' | 'different' | RowAction

/** 行级预览的一行（格式化展示值） */
export interface RowPreview {
  action: RowAction
  key: string[]
  source: string[] | null
  target: string[] | null
  /** 与 source 等长的逐列变更标记 */
  changed: boolean[]
}

/** 行级预览：按键归并的两端全行（含一致行） */
export interface TableRowsPreview {
  table: string
  columns: string[]
  keyColumns: string[]
  truncated: boolean
  rows: RowPreview[]
}

export interface TableDataDiff {
  table: string
  status: TableDataStatus
  skipReason?: string
  keyColumns: string[]
  /** 参与对比的列名（与明细行值一一对应） */
  columns: string[]
  counts: RowCounts
  /** 明细因上限被截断（counts 仍是精确值） */
  truncated: boolean
  /** compare 响应中为 []；明细经 getTableDiffDetail 按需拉取 */
  rows: RowDiff[]
}

/** 数据对比：单个目标结果 */
export interface DataTargetReport {
  reportId: string
  key: string
  connectionId: string
  database: string
  tables: TableDataDiff[]
  error: AppErrorInfo | null
}

/** 表的可对比性（选择表步骤置灰无主键表用） */
export interface TableKeyInfo {
  name: string
  keyColumns: string[] | null
  skipReason?: string
}

/** 同步勾选粒度：表 × 类别 */
export interface SyncSelection {
  table: string
  action: RowAction
  /** 行级取消勾选的主键（格式化串），空/缺省 = 全部参与 */
  excludeKeys?: string[][]
}

export interface DataSyncStatement {
  table: string
  action: RowAction
  sql: string
}

export interface TableApplyResult {
  table: string
  ok: boolean
  appliedCount: number
  error: string | null
}
