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

export type DiffKind = 'table' | 'column' | 'index'
export type DiffAction = 'create' | 'drop' | 'modify'

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
