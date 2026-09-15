import { create } from 'zustand'
import { api } from '../api/commands'
import { withSessionReconnect } from './session'
import type {
  AppErrorInfo,
  ApplyResultItem,
  CompareOptions,
  CompareTargetSpec,
  DatabaseBrief,
  DiffAction,
  DiffItem,
  DiffKind,
  TableBrief,
} from '../api/types'

/** Navicat 式结构同步：选择 → 对比结果 → 部署 三步弹窗的状态机 */
export type CompareStep = 'select' | 'diff' | 'deploy'

export interface CompareEndpoint {
  connectionId: string | null
  database: string | null
}

const EMPTY_ENDPOINT: CompareEndpoint = { connectionId: null, database: null }

/** 多目标模式下每个目标的端点 + UI 状态 */
export interface MultiTarget {
  key: string
  connectionId: string | null
  database: string | null
  dbs: DatabaseBrief[]
  loadingDbs: boolean
}

/** 每个目标独立的同步状态（结果/勾选/部署等） */
interface TargetSyncState {
  report: DiffItem[] | null
  reportId: number
  selectedIds: string[]
  /** 结果树当前展开的行 key（分组行/表行），切换目标时各自保留 */
  expandedKeys: string[]
  activeTable: string | null
  activeItemId: string | null
  applying: boolean
  applyResults: ApplyResultItem[] | null
  applyElapsedMs: number | null
  error: AppErrorInfo | null
}

export const emptyTargetState = (): TargetSyncState => ({
  report: null,
  reportId: 0,
  selectedIds: [],
  expandedKeys: [],
  activeTable: null,
  activeItemId: null,
  applying: false,
  applyResults: null,
  applyElapsedMs: null,
  error: null,
})

export type CompareMode = 'single' | 'multi'

export type GroupMode = 'action' | 'object'

/** 树表节点（结果页三列树的数据源） */
export interface DiffNode {
  key: string
  nodeType: 'group' | 'table' | 'item'
  /** item 节点对应的 DiffItem.id */
  itemId?: string
  action?: DiffAction
  kind?: DiffKind
  table?: string
  /** 分组行标题（要修改的对象 等） */
  groupTitle?: string
  /** 源对象列显示名（create 时目标为 null、drop 时源为 null） */
  sourceName?: string | null
  targetName?: string | null
  sourceDesc?: string | null
  targetDesc?: string | null
  dangerous?: boolean
  children?: DiffNode[]
}

const GROUP_TITLES: Record<DiffAction, string> = {
  modify: '要修改的对象',
  create: '要创建的对象',
  rename: '要重命名的对象',
  drop: '要删除的对象',
}
const ACTION_ORDER: DiffAction[] = ['modify', 'create', 'rename', 'drop']
const MAX_TARGETS = 8

/** 单表叶子行（建表/删表/重命名）或明细行 */
function leafFromItem(i: DiffItem): DiffNode {
  const isRename = i.action === 'rename'
  return {
    key: i.id,
    nodeType: 'item',
    itemId: i.id,
    table: i.table,
    action: i.action,
    kind: i.kind,
    sourceName: isRename ? i.table : i.action === 'drop' ? null : i.name,
    targetName: isRename ? i.name : i.action === 'create' ? null : i.name,
    sourceDesc: i.sourceDesc,
    targetDesc: i.targetDesc,
    dangerous: i.dangerous,
  }
}

/** 一张表的差异 → 表行。只有表级项（建/删/重命名表）时是叶子；否则父行挂列/索引明细。 */
function tableNode(table: string, items: DiffItem[]): DiffNode {
  if (
    items.length === 1 &&
    (items[0].id === `tbl:${table}` ||
      items[0].action === 'rename' ||
      items[0].kind === 'view')
  ) {
    return leafFromItem(items[0])
  }
  return {
    key: `tbn:modify:${table}`,
    nodeType: 'table',
    table,
    action: 'modify',
    kind: 'table',
    sourceName: table,
    targetName: table,
    dangerous: items.some((i) => i.dangerous),
    children: items.map(leafFromItem),
  }
}

function groupByTable(items: DiffItem[]): [string, DiffItem[]][] {
  const byTable = new Map<string, DiffItem[]>()
  for (const i of items) {
    const arr = byTable.get(i.table) ?? []
    arr.push(i)
    byTable.set(i.table, arr)
  }
  return [...byTable.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh'))
}

/** 差异清单 → 三列树的节点（纯函数，便于测试） */
export function buildDiffTree(items: DiffItem[], mode: GroupMode): DiffNode[] {
  if (mode === 'object') {
    return groupByTable(items).map(([table, its]) => tableNode(table, its))
  }
  const buckets: Record<DiffAction, [string, DiffItem[]][]> = {
    modify: [],
    create: [],
    rename: [],
    drop: [],
  }
  for (const entry of groupByTable(items)) {
    const [table, its] = entry
    const tbl = its.find((i) => i.id === `tbl:${table}`)
    if (tbl) {
      buckets[tbl.action].push(entry)
    } else if (its[0]?.kind === 'view') {
      // 视图没有表级项，直接按自身 action 入桶
      buckets[its[0].action].push(entry)
    } else {
      // 非表级差异（列/索引）默认归入 modify；rename 是特例：表级 rename 没有 tbl: 前缀
      const action = its[0]?.action === 'rename' ? 'rename' : 'modify'
      buckets[action].push(entry)
    }
  }
  const groups: DiffNode[] = []
  for (const action of ACTION_ORDER) {
    const list = buckets[action]
    if (list.length === 0) continue
    groups.push({
      key: `grp:${action}`,
      nodeType: 'group',
      action,
      groupTitle: GROUP_TITLES[action],
      children: list.map(([table, its]) => tableNode(table, its)),
    })
  }
  return groups
}

/** 树中收集全部叶子项 id（勾选状态折算用） */
export function collectItemIds(nodes: DiffNode[]): string[] {
  const out: string[] = []
  const walk = (ns: DiffNode[]) => {
    for (const n of ns) {
      if (n.itemId) out.push(n.itemId)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** 按 action 分组（部署页统计等仍在用） */
export function groupByAction(items: DiffItem[]): {
  modify: DiffItem[]
  create: DiffItem[]
  rename: DiffItem[]
  drop: DiffItem[]
} {
  const modify: DiffItem[] = []
  const create: DiffItem[] = []
  const rename: DiffItem[] = []
  const drop: DiffItem[] = []
  for (const i of items) {
    if (i.action === 'modify') modify.push(i)
    else if (i.action === 'create') create.push(i)
    else if (i.action === 'rename') rename.push(i)
    else drop.push(i)
  }
  return { modify, create, rename, drop }
}

/**
 * 勾选的差异项 → 实际要执行的部署语句。
 * 同一张表的列变更（后端按源列序连续产出，子句见 sqlClause）自动合并为一条
 * `ALTER TABLE ... c1, c2, ...`；索引/表/视图等独立语句原样保留。
 * 输入顺序即执行顺序（后端保证 AFTER 引用的前驱先就位），这里不重排。
 */
export function buildDeployStatements(items: DiffItem[]): string[] {
  const out: string[] = []
  let curTable: string | null = null
  let curPrefix = ''
  let curClauses: string[] = []

  const flush = () => {
    if (curTable === null) return
    if (curClauses.length === 1) {
      out.push(`${curPrefix} ${curClauses[0]}`)
    } else {
      out.push(`${curPrefix} ${curClauses.join(', ')}`)
    }
    curTable = null
    curPrefix = ''
    curClauses = []
  }

  for (const item of items) {
    const clause = item.kind === 'column' ? item.sqlClause : null
    if (item.sql && clause) {
      // 完整语句 = 前缀 + 子句；从完整语句剥离子句得到 "ALTER TABLE `db`.`t`" 前缀
      const prefix = item.sql.endsWith(clause)
        ? item.sql.slice(0, item.sql.length - clause.length).trimEnd()
        : null
      if (prefix && item.table === curTable) {
        curClauses.push(clause)
        continue
      }
      flush()
      curTable = item.table
      curPrefix = prefix ?? item.sql
      curClauses = [clause]
    } else {
      flush()
      if (item.sql) out.push(item.sql)
    }
  }
  flush()
  return out
}

/** 结果树默认展开的行 key：分组行默认展开，表行默认收起 */
function defaultExpandedKeys(items: DiffItem[] | null, mode: GroupMode): string[] {
  return buildDiffTree(items ?? [], mode)
    .filter((n) => n.nodeType === 'group')
    .map((n) => n.key)
}

/** 把当前扁平工作态保存到指定目标 */
function stashCurrent(s: CompareState, key: string | null): Record<string, TargetSyncState> {
  if (!key || s.mode !== 'multi') return s.targetStates
  return {
    ...s.targetStates,
    [key]: {
      report: s.report,
      reportId: s.reportId,
      selectedIds: s.selectedIds,
      expandedKeys: s.expandedKeys,
      activeTable: s.activeTable,
      activeItemId: s.activeItemId,
      applying: s.applying,
      applyResults: s.applyResults,
      applyElapsedMs: s.applyElapsedMs,
      error: null,
    },
  }
}

/** 从指定目标恢复扁平工作态 */
function loadCurrent(s: CompareState, key: string | null): Partial<CompareState> {
  if (!key || s.mode !== 'multi') {
    return {
      report: null,
      reportId: 0,
      selectedIds: [],
      expandedKeys: [],
      activeTable: null,
      activeItemId: null,
      applying: false,
      applyResults: null,
      applyElapsedMs: null,
    }
  }
  const st = s.targetStates[key] ?? emptyTargetState()
  return {
    report: st.report,
    reportId: st.reportId,
    selectedIds: st.selectedIds,
    expandedKeys: st.expandedKeys,
    activeTable: st.activeTable,
    activeItemId: st.activeItemId,
    applying: st.applying,
    applyResults: st.applyResults,
    applyElapsedMs: st.applyElapsedMs,
  }
}

/** 多目标下是否有任意目标正在部署 */
function anyApplying(targets: MultiTarget[], states: Record<string, TargetSyncState>): boolean {
  return targets.some((t) => states[t.key]?.applying)
}

interface CompareState {
  modalOpen: boolean
  step: CompareStep
  mode: CompareMode
  /** 端点选择（关闭弹窗时保留，下次打开沿用上次的选择） */
  source: CompareEndpoint
  /** 单目标模式的目标端点 */
  target: CompareEndpoint
  /** 多目标模式的目标列表 */
  targets: MultiTarget[]
  /** 当前多目标模式下激活的目标 key */
  activeTargetKey: string | null
  /** 多目标模式下每个目标的状态仓库 */
  targetStates: Record<string, TargetSyncState>
  sourceDbs: DatabaseBrief[]
  targetDbs: DatabaseBrief[]
  loadingSourceDbs: boolean
  loadingTargetDbs: boolean
  /** 同步范围：true = 全部表；false = 指定表 */
  scopeAll: boolean
  /** 指定同步的表名（scopeAll=false 时有效） */
  sourceTables: string[]
  /** 源库表列表（供选择） */
  sourceTableList: TableBrief[]
  loadingSourceTables: boolean
  /** 对比对象选项：表永远对比；索引默认；视图等默认不对比 */
  compareOptions: CompareOptions
  report: DiffItem[] | null
  /** 每次成功对比 +1：结果页 Table 的 key，强制重置展开/勾选视觉态 */
  reportId: number
  selectedIds: string[]
  /** 结果树当前展开的行 key（分组行/表行），单目标模式用 */
  expandedKeys: string[]
  /** 当前选中的表名 */
  activeTable: string | null
  /** 当前选中的差异项 id */
  activeItemId: string | null
  groupMode: GroupMode
  comparing: boolean
  /** 对比进度阶段（后端事件） */
  comparePhase: string | null
  applying: boolean
  applyResults: ApplyResultItem[] | null
  applyElapsedMs: number | null
  /**
   * 对比请求的代际号。关闭弹窗、改端点、取消、发起新对比都会使其 +1；
   * 迟到的对比响应发现序号过期就丢弃，避免把弹窗顶回结果页。
   */
  runSeq: number

  openModal: () => void
  /** 重拉两端/多目标已选连接的库列表（保留已选数据库） */
  refreshEndpointDbs: () => Promise<void>
  closeModal: () => void
  setSourceConn: (connectionId: string) => Promise<void>
  setSourceDb: (database: string) => void
  setTargetConn: (connectionId: string) => Promise<void>
  setTargetDb: (database: string) => void
  swap: () => void
  setMode: (mode: CompareMode) => void
  addTarget: () => void
  removeTarget: (key: string) => void
  setTargetConnMulti: (key: string, connectionId: string) => Promise<void>
  setTargetDbMulti: (key: string, database: string) => void
  setScopeAll: (all: boolean) => void
  setSourceTables: (tables: string[]) => void
  setCompareOption: (key: keyof CompareOptions, value: boolean) => void
  loadSourceTables: () => Promise<void>
  runCompare: () => Promise<void>
  runCompareMulti: () => Promise<void>
  cancelCompare: () => void
  setGroupMode: (mode: GroupMode) => void
  toggle: (id: string) => void
  setItemsChecked: (ids: string[], checked: boolean) => void
  setExpandedKeys: (keys: string[]) => void
  setActive: (table: string | null, itemId: string | null) => void
  setActiveTarget: (key: string) => void
  backToSelect: () => void
  gotoDeploy: () => void
  backToDiff: () => void
  deploy: () => Promise<void>
  syncConnected: (connectedIds: string[]) => void
}

export const useCompareStore = create<CompareState>((set, get) => ({
  modalOpen: false,
  step: 'select',
  mode: 'single',
  source: { ...EMPTY_ENDPOINT },
  target: { ...EMPTY_ENDPOINT },
  targets: [],
  activeTargetKey: null,
  targetStates: {},
  sourceDbs: [],
  targetDbs: [],
  loadingSourceDbs: false,
  loadingTargetDbs: false,
  // 结构对比默认全部表
  scopeAll: true,
  sourceTables: [],
  sourceTableList: [],
  loadingSourceTables: false,
  compareOptions: { compareIndexes: true, compareViews: false },
  report: null,
  reportId: 0,
  selectedIds: [],
  expandedKeys: [],
  activeTable: null,
  activeItemId: null,
  groupMode: 'action',
  comparing: false,
  comparePhase: null,
  applying: false,
  applyResults: null,
  applyElapsedMs: null,
  runSeq: 0,

  openModal: () => {
    set({ modalOpen: true })
    const { source } = get()
    if (source.connectionId && source.database) {
      void get().loadSourceTables()
    }
    void get().refreshEndpointDbs()
  },

  refreshEndpointDbs: async () => {
    const { source, target, mode, targets } = get()
    const pullSource = async () => {
      if (!source.connectionId) return
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

    if (mode === 'single') {
      const pullTarget = async () => {
        if (!target.connectionId) return
        set({ loadingTargetDbs: true })
        try {
          const dbs = await withSessionReconnect(target.connectionId, () =>
            api.listDatabases(target.connectionId!),
          )
          set({ targetDbs: dbs, loadingTargetDbs: false })
        } catch {
          set({ loadingTargetDbs: false })
        }
      }
      await Promise.allSettled([pullSource(), pullTarget()])
      return
    }

    // 多目标模式：逐个拉目标库列表
    await pullSource()
    await Promise.allSettled(
      targets.map(async (t) => {
        if (!t.connectionId) return
        set((s) => ({
          targets: s.targets.map((x) =>
            x.key === t.key ? { ...x, loadingDbs: true } : x,
          ),
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
            targets: s.targets.map((x) =>
              x.key === t.key ? { ...x, loadingDbs: false } : x,
            ),
          }))
        }
      }),
    )
  },

  closeModal: () => {
    // 任意目标正在执行禁止关窗
    const { mode, targets, targetStates, applying } = get()
    if (mode === 'multi' ? anyApplying(targets, targetStates) : applying) return
    set((s) => ({
      modalOpen: false,
      runSeq: s.runSeq + 1,
      step: 'select',
      report: null,
      selectedIds: [],
      expandedKeys: [],
      activeTable: null,
      activeItemId: null,
      applyResults: null,
      applyElapsedMs: null,
      comparing: false,
      comparePhase: null,
      targetStates: {},
      activeTargetKey: null,
    }))
  },

  setSourceConn: async (connectionId) => {
    set((s) => ({
      source: { connectionId, database: null },
      sourceDbs: [],
      sourceTableList: [],
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

  setTargetConn: async (connectionId) => {
    set((s) => ({
      target: { connectionId, database: null },
      targetDbs: [],
      loadingTargetDbs: true,
      runSeq: s.runSeq + 1,
    }))
    try {
      const dbs = await withSessionReconnect(connectionId, () => api.listDatabases(connectionId))
      set({ targetDbs: dbs, loadingTargetDbs: false })
    } catch (e) {
      set({ loadingTargetDbs: false })
      throw e
    }
  },

  setTargetDb: (database) =>
    set((s) => ({ target: { ...s.target, database }, runSeq: s.runSeq + 1 })),

  swap: () => {
    const { source, target, sourceDbs, targetDbs } = get()
    set((s) => ({
      source: { connectionId: target.connectionId, database: target.database },
      target: { connectionId: source.connectionId, database: source.database },
      sourceDbs: targetDbs,
      targetDbs: sourceDbs,
      report: null,
      step: 'select',
      applyResults: null,
      runSeq: s.runSeq + 1,
      targets: [],
      targetStates: {},
      activeTargetKey: null,
    }))
  },

  setMode: (mode) => {
    const { mode: oldMode, target, targets, activeTargetKey } = get()
    if (mode === oldMode) return

    if (mode === 'multi') {
      // 单目标 → 多目标：把现有目标端点作为第一个目标
      const firstKey = crypto.randomUUID()
      set((s) => ({
        mode,
        targets: [
          {
            key: firstKey,
            connectionId: target.connectionId,
            database: target.database,
            dbs: s.targetDbs,
            loadingDbs: false,
          },
        ],
        activeTargetKey: firstKey,
        targetStates: {
          [firstKey]: emptyTargetState(),
        },
        target: { ...EMPTY_ENDPOINT },
        targetDbs: [],
        report: null,
        reportId: 0,
        selectedIds: [],
        activeTable: null,
        activeItemId: null,
        applyResults: null,
        applyElapsedMs: null,
        runSeq: s.runSeq + 1,
      }))
      return
    }

    // 多目标 → 单目标：把当前激活目标的端点作为单目标
    const active = activeTargetKey
      ? targets.find((t) => t.key === activeTargetKey)
      : targets[0]
    set((s) => ({
      mode,
      target: active
        ? { connectionId: active.connectionId, database: active.database }
        : { ...EMPTY_ENDPOINT },
      targetDbs: active?.dbs ?? [],
      targets: [],
      activeTargetKey: null,
      targetStates: {},
      report: null,
      reportId: 0,
      selectedIds: [],
      activeTable: null,
      activeItemId: null,
      applyResults: null,
      applyElapsedMs: null,
      runSeq: s.runSeq + 1,
    }))
  },

  addTarget: () => {
    const { targets } = get()
    if (targets.length >= MAX_TARGETS) return
    const key = crypto.randomUUID()
    set((s) => ({
      targets: [
        ...s.targets,
        { key, connectionId: null, database: null, dbs: [], loadingDbs: false },
      ],
      targetStates: { ...s.targetStates, [key]: emptyTargetState() },
      activeTargetKey: s.activeTargetKey ?? key,
    }))
  },

  removeTarget: (key) => {
    const { targets, activeTargetKey, targetStates } = get()
    const nextTargets = targets.filter((t) => t.key !== key)
    const nextStates = { ...targetStates }
    delete nextStates[key]
    let nextActive = activeTargetKey
    if (activeTargetKey === key) {
      nextActive = nextTargets[0]?.key ?? null
    }
    const patch: Partial<CompareState> = {
      targets: nextTargets,
      targetStates: nextStates,
      activeTargetKey: nextActive,
    }
    if (nextActive !== activeTargetKey) {
      Object.assign(patch, loadCurrent({ ...get(), targets: nextTargets, targetStates: nextStates, activeTargetKey: nextActive } as CompareState, nextActive))
    }
    set(patch)
  },

  setTargetConnMulti: async (key, connectionId) => {
    set((s) => ({
      targets: s.targets.map((t) =>
        t.key === key
          ? { ...t, connectionId, database: null, dbs: [], loadingDbs: true }
          : t,
      ),
      runSeq: s.runSeq + 1,
    }))
    try {
      const dbs = await withSessionReconnect(connectionId, () => api.listDatabases(connectionId))
      set((s) => ({
        targets: s.targets.map((t) =>
          t.key === key ? { ...t, dbs, loadingDbs: false } : t,
        ),
      }))
    } catch {
      set((s) => ({
        targets: s.targets.map((t) =>
          t.key === key ? { ...t, loadingDbs: false } : t,
        ),
      }))
    }
  },

  setTargetDbMulti: (key, database) =>
    set((s) => ({
      targets: s.targets.map((t) =>
        t.key === key ? { ...t, database } : t,
      ),
      runSeq: s.runSeq + 1,
    })),

  setScopeAll: (all) => set({ scopeAll: all, sourceTables: all ? [] : get().sourceTables }),

  setSourceTables: (tables) => set({ sourceTables: tables }),

  setCompareOption: (key, value) =>
    set((s) => ({
      compareOptions: { ...s.compareOptions, [key]: value },
    })),

  loadSourceTables: async () => {
    const { source } = get()
    if (!source.connectionId || !source.database) return
    set({ loadingSourceTables: true })
    try {
      const tables = await withSessionReconnect(source.connectionId, () =>
        api.listTables(source.connectionId!, source.database!),
      )
      set({ sourceTableList: tables, loadingSourceTables: false })
    } catch {
      set({ sourceTableList: [], loadingSourceTables: false })
    }
  },

  runCompare: async () => {
    const { source, target, scopeAll, sourceTables, compareOptions } = get()
    if (!source.connectionId || !source.database || !target.connectionId || !target.database) return
    const seq = get().runSeq + 1
    set({
      runSeq: seq,
      comparing: true,
      comparePhase: 'connect',
      applyResults: null,
      activeItemId: null,
    })
    let unlisten: (() => void) | undefined
    try {
      unlisten = await api
        .onCompareProgress((phase) => {
          if (get().runSeq === seq) set({ comparePhase: phase })
        })
        .catch(() => undefined)
      const tables = scopeAll ? undefined : sourceTables
      const srcId = source.connectionId!
      const tgtId = target.connectionId!
      // 任一端会话失效（长时间未用/隧道被掐）时先自动重连该端再重试一次对比
      const items = await withSessionReconnect(srcId, () =>
        withSessionReconnect(tgtId, () =>
          api.compareSchema(
            srcId,
            source.database!,
            tgtId,
            target.database!,
            tables,
            compareOptions,
          ),
        ),
      )
      // 表选项（ENGINE/默认 collation/COMMENT）差异同样展示，不再过滤。
      // 保持后端顺序：表内即部署执行顺序（tblopt 也由后端排在最前，AFTER 前驱先就位），
      // 表间排序交给 buildDiffTree
      const visible = items
      if (get().runSeq !== seq) return
      set((s) => ({
        report: visible,
        reportId: s.reportId + 1,
        // 默认全不选，由用户自行勾选要同步的对象
        selectedIds: [],
        expandedKeys: defaultExpandedKeys(visible, s.groupMode),
        activeTable: null,
        activeItemId: null,
        step: 'diff',
      }))
    } finally {
      unlisten?.()
      if (get().runSeq === seq) set({ comparing: false, comparePhase: null })
    }
  },

  runCompareMulti: async () => {
    const { source, targets, scopeAll, sourceTables, activeTargetKey, compareOptions } = get()
    if (!source.connectionId || !source.database) return
    const readyTargets = targets.filter((t) => t.connectionId && t.database)
    if (readyTargets.length === 0) return
    const seq = get().runSeq + 1
    set({
      runSeq: seq,
      comparing: true,
      comparePhase: 'connect',
      applyResults: null,
      activeItemId: null,
      targetStates: {},
    })
    let unlisten: (() => void) | undefined
    try {
      unlisten = await api
        .onCompareMultiProgress((e) => {
          if (get().runSeq === seq) {
            set({ comparePhase: `target ${e.index + 1}/${e.total}: ${e.database} (${e.phase})` })
          }
        })
        .catch(() => undefined)
      const specs: CompareTargetSpec[] = readyTargets.map((t) => ({
        key: t.key,
        connectionId: t.connectionId!,
        database: t.database!,
      }))
      // 源端会话失效时先自动重连再重试一次；目标端失效体现在各自结果的 error 里
      const srcId = source.connectionId!
      const reports = await withSessionReconnect(srcId, () =>
        api.compareSchemaMulti(
          srcId,
          source.database!,
          scopeAll ? null : sourceTables,
          specs,
          compareOptions,
        ),
      )
      if (get().runSeq !== seq) return

      // 分发结果到各目标状态（按 key 匹配，避免同连接+同库的重复目标冲突）
      const nextStates: Record<string, TargetSyncState> = {}
      // reportId 每轮对比递增一次（各目标共用），供 DiffTree 重挂载、重置折叠状态
      const nextReportId = get().reportId + 1
      for (const r of reports) {
        const t = readyTargets.find((x) => x.key === r.key)
        if (!t) continue
        // 表选项差异同样展示；保持后端顺序（表内即部署执行顺序），表间排序交给 buildDiffTree
        const visible = r.items
        nextStates[t.key] = {
          report: visible,
          reportId: nextReportId,
          // 默认全不选，由用户自行勾选要同步的对象
          selectedIds: [],
          expandedKeys: defaultExpandedKeys(visible, get().groupMode),
          activeTable: null,
          activeItemId: null,
          applying: false,
          applyResults: null,
          applyElapsedMs: null,
          error: r.error,
        }
      }

      const firstKey = activeTargetKey && nextStates[activeTargetKey]
        ? activeTargetKey
        : readyTargets[0]?.key ?? null
      const st = firstKey ? nextStates[firstKey] ?? emptyTargetState() : emptyTargetState()
      set(() => ({
        targetStates: nextStates,
        activeTargetKey: firstKey,
        report: st.report,
        reportId: st.reportId,
        selectedIds: st.selectedIds,
        expandedKeys: st.expandedKeys,
        activeTable: st.activeTable,
        activeItemId: st.activeItemId,
        applying: st.applying,
        applyResults: st.applyResults,
        applyElapsedMs: st.applyElapsedMs,
        step: 'diff',
      }))
    } finally {
      unlisten?.()
      if (get().runSeq === seq) set({ comparing: false, comparePhase: null })
    }
  },

  cancelCompare: () =>
    set((s) => ({ runSeq: s.runSeq + 1, comparing: false, comparePhase: null })),

  setGroupMode: (mode) =>
    set((s) => {
      // 分组方式改变后行 key 体系随之改变：当前目标与各目标暂存都重置为新模式默认展开
      const targetStates = { ...s.targetStates }
      for (const k of Object.keys(targetStates)) {
        targetStates[k] = {
          ...targetStates[k],
          expandedKeys: defaultExpandedKeys(targetStates[k].report, mode),
        }
      }
      return {
        groupMode: mode,
        expandedKeys: defaultExpandedKeys(s.report, mode),
        targetStates,
      }
    }),

  toggle: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  setItemsChecked: (ids, checked) =>
    set((s) => {
      const drop = new Set(ids)
      return {
        selectedIds: checked
          ? [...new Set([...s.selectedIds, ...ids])]
          : s.selectedIds.filter((x) => !drop.has(x)),
      }
    }),

  setExpandedKeys: (keys) => set({ expandedKeys: keys }),

  setActive: (table, itemId) => set({ activeTable: table, activeItemId: itemId }),

  setActiveTarget: (key) => {
    const { activeTargetKey } = get()
    if (key === activeTargetKey) return
    set((s) => {
      const stashed = stashCurrent(s, activeTargetKey)
      const loaded = loadCurrent({ ...s, targetStates: stashed, activeTargetKey: key } as CompareState, key)
      return {
        ...loaded,
        targetStates: stashed,
        activeTargetKey: key,
        runSeq: s.runSeq + 1,
      }
    })
  },

  backToSelect: () => {
    const { mode, targets, targetStates, applying } = get()
    if (mode === 'multi' ? anyApplying(targets, targetStates) : applying) return
    set({ step: 'select' })
  },

  gotoDeploy: () => {
    const { comparing, selectedIds } = get()
    if (comparing || selectedIds.length === 0) return
    set({ step: 'deploy' })
  },

  backToDiff: () => {
    const { mode, targets, targetStates, applying } = get()
    if (mode === 'multi' ? anyApplying(targets, targetStates) : applying) return
    set({ step: 'diff', applyResults: null, applyElapsedMs: null })
  },

  deploy: async () => {
    const {
      mode,
      target,
      targets,
      activeTargetKey,
      report,
      selectedIds,
      applying,
    } = get()

    let targetConnId: string | null = null
    let targetKey: string | null = null
    if (mode === 'single') {
      targetConnId = target.connectionId
      targetKey = null
    } else {
      const t = activeTargetKey ? targets.find((x) => x.key === activeTargetKey) : null
      targetConnId = t?.connectionId ?? null
      targetKey = t?.key ?? null
    }
    if (applying || !targetConnId || !report) return

    // 同表勾选的列变更合并为一条 ALTER，与结果页"部署脚本"预览完全一致
    const sqls = buildDeployStatements(
      report.filter((i) => selectedIds.includes(i.id)),
    )
    if (sqls.length === 0) return

    const startedAt = Date.now()
    set({ applying: true, applyResults: null, applyElapsedMs: null })
    try {
      const results = await api.applySync(targetConnId, sqls)
      set({ applyResults: results, applyElapsedMs: Date.now() - startedAt })
    } finally {
      set({ applying: false })
      // 多目标模式下把当前扁平工作态的 applyResults/applying 回写到目标状态
      if (mode === 'multi' && targetKey) {
        set((s) => ({
          targetStates: stashCurrent(
            { ...s, applying: false } as CompareState,
            targetKey,
          ),
        }))
      }
    }
  },

  syncConnected: (connectedIds) => {
    const { mode, source, target, targets } = get()
    const alive = new Set(connectedIds)
    const patch: Partial<CompareState> = {}
    if (source.connectionId && !alive.has(source.connectionId)) {
      patch.source = { ...EMPTY_ENDPOINT }
      patch.sourceDbs = []
      patch.sourceTableList = []
      patch.sourceTables = []
    }
    if (mode === 'single') {
      if (target.connectionId && !alive.has(target.connectionId)) {
        patch.target = { ...EMPTY_ENDPOINT }
        patch.targetDbs = []
      }
    } else {
      patch.targets = targets
        .filter((t) => !t.connectionId || alive.has(t.connectionId))
        .map((t) => ({ ...t, database: alive.has(t.connectionId ?? '') ? t.database : null }))
      // 如果当前激活目标被移除，切到第一个
      const { activeTargetKey } = get()
      if (
        activeTargetKey &&
        !patch.targets!.some((t) => t.key === activeTargetKey)
      ) {
        patch.activeTargetKey = patch.targets![0]?.key ?? null
        Object.assign(patch, loadCurrent({ ...get(), ...patch } as CompareState, patch.activeTargetKey ?? null))
      }
    }
    if (Object.keys(patch).length > 0) set(patch)
  },
}))
