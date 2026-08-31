import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  ApplyResultItem,
  ColumnBrief,
  CompareOptions,
  CompareTargetSpec,
  ConfigSnapshot,
  DiffItem,
  ConnectionGroup,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectResult,
  DatabaseBrief,
  NavicatCandidate,
  NavicatImportResult,
  NavicatImportSelection,
  TableBrief,
  TargetReport,
  TestResult,
} from './types'

/** Tauri command 封装：参数/返回值与 src-tauri/src/commands 对应 */

export type SaveConnectionArgs = {
  input: ConnectionProfileInput
  dbPassword?: string
  sshPassword?: string
  sshKeyPassphrase?: string
}

export const api = {
  // 连接
  listConnections: () => invoke<ConfigSnapshot>('list_connections'),
  saveConnection: (args: SaveConnectionArgs) =>
    invoke<ConnectionProfile>('save_connection', args),
  deleteConnection: (id: string) => invoke<void>('delete_connection', { id }),
  duplicateConnection: (id: string) =>
    invoke<ConnectionProfile>('duplicate_connection', { id }),
  testConnection: (args: SaveConnectionArgs & { trustHostKey?: string }) =>
    invoke<TestResult>('test_connection', args),
  connect: (id: string, trustHostKey?: string) =>
    invoke<ConnectResult>('connect', { id, trustHostKey }),
  disconnect: (id: string) => invoke<void>('disconnect', { id }),

  // 分组
  createGroup: (name: string) => invoke<ConnectionGroup>('create_group', { name }),
  renameGroup: (id: string, name: string) =>
    invoke<ConnectionGroup>('rename_group', { id, name }),
  deleteGroup: (id: string) => invoke<void>('delete_group', { id }),

  // 库表浏览
  listDatabases: (connectionId: string) =>
    invoke<DatabaseBrief[]>('list_databases', { connectionId }),
  listTables: (connectionId: string, database: string) =>
    invoke<TableBrief[]>('list_tables', { connectionId, database }),
  describeTable: (connectionId: string, database: string, table: string) =>
    invoke<ColumnBrief[]>('describe_table', { connectionId, database, table }),

  // Navicat 导入
  navicatScan: () => invoke<NavicatCandidate[]>('navicat_scan'),
  navicatImportNcx: (path: string) =>
    invoke<NavicatCandidate[]>('navicat_import_ncx', { path }),
  navicatImport: (selections: NavicatImportSelection[]) =>
    invoke<NavicatImportResult>('navicat_import', { selections }),

  // 结构对比与同步
  compareSchema: (
    sourceConnectionId: string,
    sourceDatabase: string,
    targetConnectionId: string,
    targetDatabase: string,
    tables?: string[],
    options?: CompareOptions,
  ) =>
    invoke<DiffItem[]>('compare_schema', {
      sourceConnectionId,
      sourceDatabase,
      targetConnectionId,
      targetDatabase,
      tables: tables ?? null,
      options: options ?? null,
    }),
  compareSchemaMulti: (
    sourceConnectionId: string,
    sourceDatabase: string,
    tables: string[] | null,
    targets: CompareTargetSpec[],
    options?: CompareOptions,
  ) =>
    invoke<TargetReport[]>('compare_schema_multi', {
      sourceConnectionId,
      sourceDatabase,
      tables,
      targets,
      options: options ?? null,
    }),
  applySync: (targetConnectionId: string, sqls: string[]) =>
    invoke<ApplyResultItem[]>('apply_sync', { targetConnectionId, sqls }),

  /** 对比进度事件（fetch_source/fetch_target/diff），返回取消监听函数 */
  onCompareProgress: (cb: (phase: string) => void) =>
    listen<string>('compare-progress', (e) => cb(e.payload)),
  /** 多目标对比进度事件 */
  onCompareMultiProgress: (
    cb: (e: { index: number; total: number; phase: string; database: string }) => void,
  ) => listen<{ index: number; total: number; phase: string; database: string }>(
    'compare-multi-progress',
    (e) => cb(e.payload),
  ),

  openConfigDir: () => invoke<void>('open_config_dir'),
}
