import { create } from 'zustand'
import { api } from '../api/commands'
import { withSessionReconnect } from './session'
import type {
  AppErrorInfo,
  CompareTargetSpec,
  DataCompareOptions,
  DataSyncStatement,
  DatabaseBrief,
  RowAction,
  RowPreviewFilter,
  SyncSelection,
  TableApplyResult,
  TableBrief,
  TableDataDiff,
  TableKeyInfo,
  TableRowsPreview,
} from '../api/types'

/** 数据同步弹窗：选择 → 对比结果 → 部署 三步状态机。
 *  选择页支持单目标（默认）/ 多目标两种模式；内部状态统一用 targets 列表，
 *  单目标 = 只有一行的 targets，结果/部署页因此无需感知模式。 */
export type DataCompareStep = 'select' | 'diff' | 'deploy'

/** 目标模式：单目标（一对一）/ 多目标（一源对多目标） */
export type DataCompareMode = 'single' | 'multi'

export interface DataEndpoint {
  connectionId: string | null
  database: string | null
}

const EMPTY_ENDPOINT: DataEndpoint = { connectionId: null, database: null }

export interface DataTarget {
  key: string
  connectionId: string | null
  database: string | null
  dbs: DatabaseBrief[]
  loadingDbs: boolean
}

const emptyDataTarget = (): DataTarget => ({
  key: crypto.randomUUID(),
  connectionId: null,
  database: null,
  dbs: [],
  loadingDbs: false,
})

/** 选择键：`${table}:${action}` */
export const selKey = (table: string, action: RowAction) => `${table}:${action}`

/** 每个目标独立的同步状态 */
export interface DataTargetState {
  /** 后端报告句柄（行级预览与 SQL 预览用）；空串 = 对比失败 */
  reportId: string
  tables: TableDataDiff[]
  /** 勾选的 `table:action` 列表；delete 默认不勾 */
  selected: string[]
  /** 行级取消勾选的行：`table:action` → 行主键串（`` 连接）；缺省 = 该类别全部参与 */
  uncheckedRows: Record<string, string[]>
  activeTable: string | null
  /** 已拉取的行级预览缓存（table → 两端对齐全行，含 equal） */
  details: Record<string, TableRowsPreview>
  detailLoading: boolean
  /** 行级对照筛选；部署往返后保留 */
  rowFilter: RowPreviewFilter
  preview: DataSyncStatement[] | null
  applying: boolean
  applyResults: TableApplyResult[] | null
  applyElapsedMs: number | null
  error: AppErrorInfo | null
}

export const emptyDataTargetState = (): DataTargetState => ({
  reportId: '',
  tables: [],
  selected: [],
  uncheckedRows: {},
  activeTable: null,
  details: {},
  detailLoading: false,
  rowFilter: 'different',
  preview: null,
  applying: false,
  applyResults: null,
  applyElapsedMs: null,
  error: null,
})

const MAX_TARGETS = 8

/** 勾选列表 → 后端 SyncSelection */
export function toSelections(selected: string[]): SyncSelection[] {
  return selected.map((s) => {
    const i = s.lastIndexOf(':')
    return { table: s.slice(0, i), action: s.slice(i + 1) as RowAction }
  })
}

/** 目标是否正在执行（关窗/翻页保护用） */
function anyApplying(states: Record<string, DataTargetState>): boolean {
  return Object.values(states).some((s) => s.applying)
}

interface DataCompareState {
  modalOpen: boolean
  step: DataCompareStep
  /** 目标模式：单目标（默认）/ 多目标；只影响选择页 UI，内部统一存 targets */
  mode: DataCompareMode
  source: DataEndpoint
  targets: DataTarget[]
  activeTargetKey: string | null
  targetStates: Record<string, DataTargetState>
  sourceDbs: DatabaseBrief[]
  loadingSourceDbs: boolean
  /** 同步范围：true = 全部可对比表；false = 指定表 */
  scopeAll: boolean
  sourceTables: string[]
  sourceTableList: TableBrief[]
  tableKeys: TableKeyInfo[]
  loadingSourceTables: boolean
  options: DataCompareOptions
  comparing: boolean
  comparePhase: string | null
  runSeq: number

  openModal: () => void
  closeModal: () => void
  setMode: (mode: DataCompareMode) => void
  refreshEndpointDbs: () => Promise<void>
  setSourceConn: (connectionId: string) => Promise<void>
  setSourceDb: (database: string) => void
  addTarget: () => void
  removeTarget: (key: string) => void
  setTargetConnMulti: (key: string, connectionId: string) => Promise<void>
  setTargetDbMulti: (key: string, database: string) => void
  setScopeAll: (all: boolean) => void
  setSourceTables: (tables: string[]) => void
  setOption: <K extends keyof DataCompareOptions>(key: K, value: DataCompareOptions[K]) => void
  loadSourceTables: () => Promise<void>
  /** 实际参与对比的表（scopeAll 时展开为全部可对比表） */
  effectiveTables: () => string[]
  runCompare: () => Promise<void>
  cancelCompare: () => void
  setActiveTarget: (key: string) => void
  setActiveTable: (table: string | null) => Promise<void>
  toggleSelection: (table: string, action: RowAction) => void
  setTableChecked: (table: string, actions: RowAction[], checked: boolean) => void
  /** 行级勾选：checked=false 记入 uncheckedRows，true 则移除；
   *  勾选"整体未勾选"类别中的一行时，需传该类别全部行 key（siblingKeys），
   *  其余行进入排除清单，保证只选中这一行 */
  setRowChecked: (
    table: string,
    action: RowAction,
    rowKey: string,
    checked: boolean,
    siblingKeys?: string[],
  ) => void
  /** 行级批量勾选（勾选条表头全选用）：一次 set 完成大量行的勾/取消 */
  setRowsChecked: (
    table: string,
    entries: Array<{ action: RowAction; rowKey: string }>,
    checked: boolean,
  ) => void
  setRowFilter: (filter: RowPreviewFilter) => void
  setAllChecked: (checked: boolean) => void
  backToSelect: () => void
  gotoDeploy: () => Promise<void>
  backToDiff: () => void
  deploy: () => Promise<void>
  syncConnected: (connectedIds: string[]) => void
}

/** 更新当前激活目标的状态 */
function patchActive(
  s: Pick<DataCompareState, 'activeTargetKey' | 'targetStates'>,
  patch: Partial<DataTargetState>,
): Partial<DataCompareState> {
  if (!s.activeTargetKey) return {}
  const cur = s.targetStates[s.activeTargetKey] ?? emptyDataTargetState()
  return { targetStates: { ...s.targetStates, [s.activeTargetKey]: { ...cur, ...patch } } }
}

export const useDataCompareStore = create<DataCompareState>((set, get) => ({
  modalOpen: false,
  step: 'select',
  mode: 'single',
  source: { ...EMPTY_ENDPOINT },
  targets: [],
  activeTargetKey: null,
  targetStates: {},
  sourceDbs: [],
  loadingSourceDbs: false,
  // 默认按指定表对比，避免误操作全部表的数据
  scopeAll: false,
  sourceTables: [],
  sourceTableList: [],
  tableKeys: [],
  loadingSourceTables: false,
  options: { chunkSize: 5000, maxDetailRows: 1000 },
  comparing: false,
  comparePhase: null,
  runSeq: 0,

  openModal: () => {
    set({ modalOpen: true })
    // 保证至少有一个目标行（单/多目标选择页都需要绑定）
    if (get().targets.length === 0) get().addTarget()
    const { source } = get()
    if (source.connectionId && source.database) {
      void get().loadSourceTables()
    }
    void get().refreshEndpointDbs()
  },

  setMode: (mode) => {
    const cur = get()
    if (cur.mode === mode) return
    if (mode === 'single') {
      // 多目标 → 单目标：保留当前激活目标的端点，其余丢弃
      const active =
        (cur.activeTargetKey && cur.targets.find((t) => t.key === cur.activeTargetKey)) ||
        cur.targets[0]
      set({
        mode,
        targets: active ? [active] : [],
        activeTargetKey: active?.key ?? null,
        targetStates: active ? { [active.key]: emptyDataTargetState() } : {},
      })
      return
    }
    // 单目标 → 多目标：现有目标作为第一行，保证至少一行可编辑
    const targets = cur.targets.length > 0 ? cur.targets : [emptyDataTarget()]
    set({
      mode,
      targets,
      activeTargetKey: targets[0].key,
      targetStates: {},
    })
  },

  closeModal: () => {
    if (anyApplying(get().targetStates)) return
    set((s) => ({
      modalOpen: false,
      runSeq: s.runSeq + 1,
      step: 'select',
      comparing: false,
      comparePhase: null,
      targetStates: {},
    }))
  },

  refreshEndpointDbs: async () => {
    const { source, targets } = get()
    if (source.connectionId) {
      set({ loadingSourceDbs: true })
      try {
        const dbs = await withSessionReconnect(source.connectionId, () =>
          api.listDatabases(source.connectionId!),
        )
        set({ sourceDbs: dbs, loadingSourceDbs: false })
      } catch {
        set({ loadingSourceDbs: false })
      }
    }
    await Promise.allSettled(
      targets.map(async (t) => {
        if (!t.connectionId) return
        set((s) => ({
          targets: s.targets.map((x) => (x.key === t.key ? { ...x, loadingDbs: true } : x)),
        }))
        try {
          const dbs = await withSessionReconnect(t.connectionId, () =>
            api.listDatabases(t.connectionId!),
          )
          set((s) => ({
            targets: s.targets.map((x) =>
              x.key === t.key ? { ...x, dbs, loadingDbs: false } : x,
            ),
          }))
        } catch {
          set((s) => ({
            targets: s.targets.map((x) => (x.key === t.key ? { ...x, loadingDbs: false } : x)),
          }))
        }
      }),
    )
  },

  setSourceConn: async (connectionId) => {
    set((s) => ({
      source: { connectionId, database: null },
      sourceDbs: [],
      sourceTableList: [],
      tableKeys: [],
      sourceTables: [],
      loadingSourceDbs: true,
      runSeq: s.runSeq + 1,
    }))
    try {
      const dbs = await withSessionReconnect(connectionId, () => api.listDatabases(connectionId))
      set({ sourceDbs: dbs, loadingSourceDbs: false })
    } catch (e) {
      set({ loadingSourceDbs: false })
      throw e
    }
  },

  setSourceDb: (database) => {
    set((s) => ({
      source: { ...s.source, database },
      sourceTables: [],
      runSeq: s.runSeq + 1,
    }))
    void get().loadSourceTables()
  },

  addTarget: () => {
    const { targets } = get()
    if (targets.length >= MAX_TARGETS) return
    const row = emptyDataTarget()
    set((s) => ({
      targets: [...s.targets, row],
      targetStates: { ...s.targetStates, [row.key]: emptyDataTargetState() },
      activeTargetKey: s.activeTargetKey ?? row.key,
    }))
  },

  removeTarget: (key) => {
    const { targets, activeTargetKey, targetStates } = get()
    const nextTargets = targets.filter((t) => t.key !== key)
    const nextStates = { ...targetStates }
    delete nextStates[key]
    set({
      targets: nextTargets,
      targetStates: nextStates,
      activeTargetKey:
        activeTargetKey === key ? nextTargets[0]?.key ?? null : activeTargetKey,
    })
  },

  setTargetConnMulti: async (key, connectionId) => {
    set((s) => ({
      targets: s.targets.map((t) =>
        t.key === key ? { ...t, connectionId, database: null, dbs: [], loadingDbs: true } : t,
      ),
      runSeq: s.runSeq + 1,
    }))
    try {
      const dbs = await withSessionReconnect(connectionId, () => api.listDatabases(connectionId))
      set((s) => ({
        targets: s.targets.map((t) => (t.key === key ? { ...t, dbs, loadingDbs: false } : t)),
      }))
    } catch {
      set((s) => ({
        targets: s.targets.map((t) => (t.key === key ? { ...t, loadingDbs: false } : t)),
      }))
    }
  },

  setTargetDbMulti: (key, database) =>
    set((s) => ({
      targets: s.targets.map((t) => (t.key === key ? { ...t, database } : t)),
      runSeq: s.runSeq + 1,
    })),

  setScopeAll: (all) => set({ scopeAll: all, sourceTables: all ? [] : get().sourceTables }),

  setSourceTables: (tables) => set({ sourceTables: tables }),

  setOption: (key, value) => set((s) => ({ options: { ...s.options, [key]: value } })),

  loadSourceTables: async () => {
    const { source } = get()
    if (!source.connectionId || !source.database) return
    set({ loadingSourceTables: true })
    try {
      const [tables, keys] = await withSessionReconnect(source.connectionId, () =>
        Promise.all([
          api.listTables(source.connectionId!, source.database!),
          api.listTableKeys(source.connectionId!, source.database!),
        ]),
      )
      set({ sourceTableList: tables, tableKeys: keys, loadingSourceTables: false })
    } catch {
      set({ sourceTableList: [], tableKeys: [], loadingSourceTables: false })
    }
  },

  effectiveTables: () => {
    const { scopeAll, sourceTables, tableKeys } = get()
    if (!scopeAll) return sourceTables
    // 全部表 = 全部有可对比键的表
    return tableKeys.filter((k) => k.keyColumns).map((k) => k.name)
  },

  runCompare: async () => {
    const { source, targets, options } = get()
    if (!source.connectionId || !source.database) return
    const readyTargets = targets.filter((t) => t.connectionId && t.database)
    if (readyTargets.length === 0) return
    const tables = get().effectiveTables()
    if (tables.length === 0) return
    const seq = get().runSeq + 1
    set({ runSeq: seq, comparing: true, comparePhase: 'connect', targetStates: {} })
    let unlisten: (() => void) | undefined
    try {
      unlisten = await api
        .onDataCompareProgress((e) => {
          if (get().runSeq !== seq) return
          const label = e.table ? `${e.database} · ${e.table}（已比对 ${e.rowsCompared.toLocaleString()} 行）` : e.database
          set({ comparePhase: `target ${e.index + 1}/${e.total}: ${label}` })
        })
        .catch(() => undefined)
      const specs: CompareTargetSpec[] = readyTargets.map((t) => ({
        key: t.key,
        connectionId: t.connectionId!,
        database: t.database!,
      }))
      const srcId = source.connectionId!
      const reports = await withSessionReconnect(srcId, () =>
        api.compareDataMulti(
          srcId,
          source.database!,
          tables,
          specs,
          options,
        ),
      )
      if (get().runSeq !== seq) return

      const nextStates: Record<string, DataTargetState> = {}
      for (const r of reports) {
        const t = readyTargets.find((x) => x.key === r.key)
        if (!t) continue
        nextStates[t.key] = {
          ...emptyDataTargetState(),
          reportId: r.reportId,
          tables: r.tables,
          // 默认全不选，由用户自行勾选要同步的数据
          selected: [],
          error: r.error,
        }
      }
      const firstKey =
        get().activeTargetKey && nextStates[get().activeTargetKey!]
          ? get().activeTargetKey
          : readyTargets[0]?.key ?? null
      set({ targetStates: nextStates, activeTargetKey: firstKey, step: 'diff' })
    } finally {
      unlisten?.()
      if (get().runSeq === seq) set({ comparing: false, comparePhase: null })
    }
  },

  cancelCompare: () =>
    set((s) => ({ runSeq: s.runSeq + 1, comparing: false, comparePhase: null })),

  setActiveTarget: (key) => {
    if (key !== get().activeTargetKey) set({ activeTargetKey: key })
  },

  setActiveTable: async (table) => {
    const { activeTargetKey, targetStates } = get()
    if (!activeTargetKey) return
    const st = targetStates[activeTargetKey] ?? emptyDataTargetState()
    set((s) => patchActive(s, { activeTable: table }))
    if (!table || st.details[table] || !st.reportId) return
    set((s) => patchActive(s, { detailLoading: true }))
    try {
      // 行级预览含一致行；上限给足，截断时界面有提示
      const preview = await api.getTableRowsPreview(st.reportId, table, 20000)
      set((s) => {
        const cur = s.targetStates[s.activeTargetKey ?? '']
        if (!cur) return {}
        return patchActive(s, {
          details: { ...cur.details, [table]: preview },
          detailLoading: false,
        })
      })
    } catch {
      set((s) => patchActive(s, { detailLoading: false }))
    }
  },

  toggleSelection: (table, action) =>
    set((s) => {
      const cur = s.targetStates[s.activeTargetKey ?? '']
      if (!cur) return {}
      const id = selKey(table, action)
      return patchActive(s, {
        selected: cur.selected.includes(id)
          ? cur.selected.filter((x) => x !== id)
          : [...cur.selected, id],
      })
    }),

  setTableChecked: (table, actions, checked) =>
    set((s) => {
      const cur = s.targetStates[s.activeTargetKey ?? '']
      if (!cur) return {}
      const ids = actions.map((a) => selKey(table, a))
      const uncheckedRows = { ...cur.uncheckedRows }
      if (checked) {
        // 整类勾上 = 清空该类别的行级排除
        for (const id of ids) delete uncheckedRows[id]
      }
      return patchActive(s, {
        selected: checked
          ? [...new Set([...cur.selected, ...ids])]
          : cur.selected.filter((x) => !ids.includes(x)),
        uncheckedRows,
      })
    }),

  setRowsChecked: (table, entries, checked) =>
    set((s) => {
      const cur = s.targetStates[s.activeTargetKey ?? '']
      if (!cur) return {}
      const byId = new Map<string, Set<string>>()
      for (const { action, rowKey } of entries) {
        const id = selKey(table, action)
        if (!byId.has(id)) byId.set(id, new Set(cur.uncheckedRows[id] ?? []))
        if (checked) byId.get(id)!.delete(rowKey)
        else byId.get(id)!.add(rowKey)
      }
      const uncheckedRows = { ...cur.uncheckedRows }
      for (const [id, excluded] of byId) uncheckedRows[id] = [...excluded]
      // 批量勾上时确保类别本身处于勾选态（否则排除清单无意义）
      let selected = cur.selected
      if (checked) {
        const missing = [...byId.keys()].filter((id) => !cur.selected.includes(id))
        if (missing.length > 0) selected = [...cur.selected, ...missing]
      }
      return patchActive(s, { selected, uncheckedRows })
    }),

  setRowFilter: (filter) => set((s) => patchActive(s, { rowFilter: filter })),

  setRowChecked: (table, action, rowKey, checked, siblingKeys = []) =>
    set((s) => {
      const cur = s.targetStates[s.activeTargetKey ?? '']
      if (!cur) return {}
      const id = selKey(table, action)
      const excluded = new Set(cur.uncheckedRows[id] ?? [])
      if (checked) {
        // 类别整体未勾选时勾选其中一行 = 只选这一行：类别进入勾选态，
        // 其余同类行全部计入排除清单（否则会连带选中所有同色行）
        if (!cur.selected.includes(id)) {
          for (const k of siblingKeys) {
            if (k !== rowKey) excluded.add(k)
          }
          return patchActive(s, {
            selected: [...cur.selected, id],
            uncheckedRows: { ...cur.uncheckedRows, [id]: [...excluded] },
          })
        }
        excluded.delete(rowKey)
        return patchActive(s, {
          selected: cur.selected,
          uncheckedRows: { ...cur.uncheckedRows, [id]: [...excluded] },
        })
      }
      // 行级取消勾选时确保类别本身处于勾选态，excludeKeys 才有意义
      if (!cur.selected.includes(id)) return {}
      excluded.add(rowKey)
      return patchActive(s, {
        selected: cur.selected,
        uncheckedRows: { ...cur.uncheckedRows, [id]: [...excluded] },
      })
    }),

  setAllChecked: (checked) =>
    set((s) => {
      const cur = s.targetStates[s.activeTargetKey ?? '']
      if (!cur) return {}
      if (!checked) return patchActive(s, { selected: [] })
      const all: string[] = []
      for (const t of cur.tables) {
        if (t.status !== 'different') continue
        if (t.counts.insert > 0) all.push(selKey(t.table, 'insert'))
        if (t.counts.update > 0) all.push(selKey(t.table, 'update'))
        if (t.counts.delete > 0) all.push(selKey(t.table, 'delete'))
      }
      return patchActive(s, { selected: all })
    }),

  backToSelect: () => {
    if (anyApplying(get().targetStates)) return
    set({ step: 'select' })
  },

  gotoDeploy: async () => {
    const { activeTargetKey, targetStates, comparing } = get()
    const st = activeTargetKey ? targetStates[activeTargetKey] : null
    if (comparing || !st || st.selected.length === 0 || !st.reportId) return
    const selections: SyncSelection[] = toSelections(st.selected).map((sel) => {
      const excluded = st.uncheckedRows[selKey(sel.table, sel.action)]
      return excluded?.length ? { ...sel, excludeKeys: excluded.map((k) => k.split('\u0001')) } : sel
    })
    const preview = await api.previewDataSync(st.reportId, selections)
    set((s) => ({ ...patchActive(s, { preview }), step: 'deploy' }))
  },

  backToDiff: () => {
    if (anyApplying(get().targetStates)) return
    set((s) => ({ ...patchActive(s, { applyResults: null, applyElapsedMs: null }), step: 'diff' }))
  },

  deploy: async () => {
    const { activeTargetKey, targets, targetStates } = get()
    const st = activeTargetKey ? targetStates[activeTargetKey] : null
    const target = targets.find((t) => t.key === activeTargetKey)
    if (!st || st.applying || !target?.connectionId || !st.preview?.length) return
    const startedAt = Date.now()
    set((s) => patchActive(s, { applying: true, applyResults: null, applyElapsedMs: null }))
    try {
      const results = await api.applyDataSync(target.connectionId, st.preview)
      set((s) =>
        patchActive(s, {
          applyResults: results,
          applyElapsedMs: Date.now() - startedAt,
          applying: false,
        }),
      )
    } finally {
      set((s) => patchActive(s, { applying: false }))
    }
  },

  syncConnected: (connectedIds) => {
    const { source, targets, activeTargetKey } = get()
    const alive = new Set(connectedIds)
    const patch: Partial<DataCompareState> = {}
    if (source.connectionId && !alive.has(source.connectionId)) {
      patch.source = { ...EMPTY_ENDPOINT }
      patch.sourceDbs = []
      patch.sourceTableList = []
      patch.tableKeys = []
      patch.sourceTables = []
    }
    const nextTargets = targets
      .filter((t) => !t.connectionId || alive.has(t.connectionId))
      .map((t) => ({ ...t, database: alive.has(t.connectionId ?? '') ? t.database : null }))
    if (nextTargets.length !== targets.length || nextTargets.some((t, i) => t.database !== targets[i].database)) {
      patch.targets = nextTargets
      if (activeTargetKey && !nextTargets.some((t) => t.key === activeTargetKey)) {
        patch.activeTargetKey = nextTargets[0]?.key ?? null
      }
    }
    if (Object.keys(patch).length > 0) set(patch)
  },
}))
