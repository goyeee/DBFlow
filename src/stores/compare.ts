import { create } from 'zustand'
import { api } from '../api/commands'
import type { ApplyResultItem, DatabaseBrief, DiffAction, DiffItem, DiffKind } from '../api/types'

/** Navicat 式结构同步：选择 → 对比结果 → 部署 三步弹窗的状态机 */
export type CompareStep = 'select' | 'diff' | 'deploy'

export interface CompareEndpoint {
  connectionId: string | null
  database: string | null
}

const EMPTY_ENDPOINT: CompareEndpoint = { connectionId: null, database: null }

/** 结果页分组方式（Navicat 左上角下拉） */
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
  drop: '要删除的对象',
}
const ACTION_ORDER: DiffAction[] = ['modify', 'create', 'drop']

/** 单表叶子行（建表/删表）或明细行 */
function leafFromItem(i: DiffItem): DiffNode {
  return {
    key: i.id,
    nodeType: 'item',
    itemId: i.id,
    table: i.table,
    action: i.action,
    kind: i.kind,
    sourceName: i.action === 'drop' ? null : i.name,
    targetName: i.action === 'create' ? null : i.name,
    sourceDesc: i.sourceDesc,
    targetDesc: i.targetDesc,
    dangerous: i.dangerous,
  }
}

/** 一张表的差异 → 表行。只有表级项（建/删表）时是叶子；否则父行挂列/索引明细。
 *  表行的 action 固定 modify（能走到这里说明表两端都存在、只是结构有差异）。 */
function tableNode(table: string, items: DiffItem[]): DiffNode {
  if (items.length === 1 && items[0].id === `tbl:${table}`) {
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
  // 按表级操作归类（Navicat 的粒度是「表」，不是「列/索引」）：
  // 建表 → 要创建；删表 → 要删除；其余（表两端都在、仅列/索引有差异）→ 要修改。
  // 否则同一张表会因列有增有删而同时出现在多个分组里。
  const buckets: Record<DiffAction, [string, DiffItem[]][]> = {
    modify: [],
    create: [],
    drop: [],
  }
  for (const entry of groupByTable(items)) {
    const [table, its] = entry
    const tbl = its.find((i) => i.id === `tbl:${table}`)
    if (tbl) {
      buckets[tbl.action].push(entry)
    } else {
      buckets.modify.push(entry)
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
  drop: DiffItem[]
} {
  const modify: DiffItem[] = []
  const create: DiffItem[] = []
  const drop: DiffItem[] = []
  for (const i of items) {
    if (i.action === 'modify') modify.push(i)
    else if (i.action === 'create') create.push(i)
    else drop.push(i)
  }
  return { modify, create, drop }
}

/** 默认勾选：非破坏性项；DROP 类留给用户手动勾 */
function defaultSelected(items: DiffItem[]): string[] {
  return items.filter((i) => !i.dangerous).map((i) => i.id)
}

interface CompareState {
  modalOpen: boolean
  step: CompareStep
  /** 端点选择（关闭弹窗时保留，下次打开沿用上次的选择） */
  source: CompareEndpoint
  target: CompareEndpoint
  sourceDbs: DatabaseBrief[]
  targetDbs: DatabaseBrief[]
  loadingSourceDbs: boolean
  loadingTargetDbs: boolean
  report: DiffItem[] | null
  /** 每次成功对比 +1：结果页 Table 的 key，强制重置展开/勾选视觉态 */
  reportId: number
  selectedIds: string[]
  /** 当前选中的表名（选中表行时设置，用于部署脚本按表展示） */
  activeTable: string | null
  /** 当前选中的差异项 id（选中明细行时设置） */
  activeItemId: string | null
  groupMode: GroupMode
  comparing: boolean
  /** 对比进度阶段（后端事件）：connect/fetch_source/fetch_target/diff */
  comparePhase: string | null
  applying: boolean
  applyResults: ApplyResultItem[] | null
  /** 一次执行的起止（耗时统计） */
  applyElapsedMs: number | null
  /**
   * 对比请求的代际号。关闭弹窗、改端点、取消、发起新对比都会使其 +1；
   * 迟到的对比响应发现序号过期就丢弃，避免把弹窗顶回结果页。
   */
  runSeq: number

  openModal: () => void
  /** 重拉两端已选连接的库列表（保留已选数据库） */
  refreshEndpointDbs: () => Promise<void>
  closeModal: () => void
  setSourceConn: (connectionId: string) => Promise<void>
  setSourceDb: (database: string) => void
  setTargetConn: (connectionId: string) => Promise<void>
  setTargetDb: (database: string) => void
  swap: () => void
  runCompare: () => Promise<void>
  cancelCompare: () => void
  setGroupMode: (mode: GroupMode) => void
  toggle: (id: string) => void
  /** 勾选/取消一组差异项（树表勾选级联用） */
  setItemsChecked: (ids: string[], checked: boolean) => void
  /** 选中某行：表行只设 table，明细行设 table + itemId，清除传 (null, null) */
  setActive: (table: string | null, itemId: string | null) => void
  backToSelect: () => void
  gotoDeploy: () => void
  backToDiff: () => void
  deploy: () => Promise<void>
  /** 左树断开连接后调用：清掉引用已断开连接的端点选择 */
  syncConnected: (connectedIds: string[]) => void
}

export const useCompareStore = create<CompareState>((set, get) => ({
  modalOpen: false,
  step: 'select',
  source: { ...EMPTY_ENDPOINT },
  target: { ...EMPTY_ENDPOINT },
  sourceDbs: [],
  targetDbs: [],
  loadingSourceDbs: false,
  loadingTargetDbs: false,
  report: null,
  reportId: 0,
  selectedIds: [],
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
    // 打开时重拉两端已选连接的库列表（外面可能新建了库），保留已选数据库
    void get().refreshEndpointDbs()
  },

  refreshEndpointDbs: async () => {
    const { source, target } = get()
    const pull = async (ep: CompareEndpoint, isSource: boolean) => {
      if (!ep.connectionId) return
      set(isSource ? { loadingSourceDbs: true } : { loadingTargetDbs: true })
      try {
        const dbs = await api.listDatabases(ep.connectionId)
        set(isSource ? { sourceDbs: dbs, loadingSourceDbs: false } : { targetDbs: dbs, loadingTargetDbs: false })
      } catch {
        set(isSource ? { loadingSourceDbs: false } : { loadingTargetDbs: false })
      }
    }
    await Promise.allSettled([pull(source, true), pull(target, false)])
  },

  closeModal: () => {
    // 部署执行进行中禁止关窗（Modal 的 X 与底部按钮都走这里，统一把守）
    if (get().applying) return
    // runSeq +1：进行中的对比响应落地时会发现已过期，不再写回状态
    set((s) => ({
      modalOpen: false,
      runSeq: s.runSeq + 1,
      step: 'select',
      report: null,
      selectedIds: [],
      activeTable: null,
      activeItemId: null,
      applyResults: null,
      applyElapsedMs: null,
      comparing: false,
      comparePhase: null,
    }))
  },

  setSourceConn: async (connectionId) => {
    set((s) => ({
      source: { connectionId, database: null },
      sourceDbs: [],
      loadingSourceDbs: true,
      runSeq: s.runSeq + 1,
    }))
    try {
      const dbs = await api.listDatabases(connectionId)
      set({ sourceDbs: dbs, loadingSourceDbs: false })
    } catch (e) {
      set({ loadingSourceDbs: false })
      throw e
    }
  },
  setSourceDb: (database) =>
    set((s) => ({ source: { ...s.source, database }, runSeq: s.runSeq + 1 })),

  setTargetConn: async (connectionId) => {
    set((s) => ({
      target: { connectionId, database: null },
      targetDbs: [],
      loadingTargetDbs: true,
      runSeq: s.runSeq + 1,
    }))
    try {
      const dbs = await api.listDatabases(connectionId)
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
    }))
  },

  runCompare: async () => {
    const { source, target } = get()
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
      // 监听后端阶段事件驱动进度层（事件可能因环境缺失失败，不阻塞主流程）
      unlisten = await api
        .onCompareProgress((phase) => {
          if (get().runSeq === seq) set({ comparePhase: phase })
        })
        .catch(() => undefined)
      const items = await api.compareSchema(
        source.connectionId,
        source.database,
        target.connectionId,
        target.database,
      )
      // 表选项（ENGINE/COMMENT 差异，id 前缀 tblopt:）默认不展示、不参与同步
      const visible = items.filter((i) => !i.id.startsWith('tblopt:'))
      // 表级项在前、同表按 id 排序
      visible.sort((a, b) =>
        a.table === b.table ? a.id.localeCompare(b.id) : a.table.localeCompare(b.table, 'zh'),
      )
      // 等待期间弹窗被关闭 / 端点被改 / 被取消 / 发起了新对比 → 序号已过期，丢弃结果
      if (get().runSeq !== seq) return
      set((s) => ({
        report: visible,
        reportId: s.reportId + 1,
        selectedIds: defaultSelected(visible),
        activeTable: null,
        activeItemId: null,
        step: 'diff',
      }))
    } finally {
      unlisten?.()
      if (get().runSeq === seq) set({ comparing: false, comparePhase: null })
    }
  },

  /** 进度层上的取消：放弃等待本次结果（后端查询只读，让其自然跑完即可） */
  cancelCompare: () =>
    set((s) => ({ runSeq: s.runSeq + 1, comparing: false, comparePhase: null })),

  setGroupMode: (mode) => set({ groupMode: mode }),

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

  setActive: (table, itemId) => set({ activeTable: table, activeItemId: itemId }),

  backToSelect: () => {
    if (get().applying) return
    // 保留端点选择与 report，仅回到选择页；再点「对比」会用当前端点重跑
    set({ step: 'select' })
  },

  gotoDeploy: () => {
    if (get().comparing || get().selectedIds.length === 0) return
    set({ step: 'deploy' })
  },
  backToDiff: () => {
    if (get().applying) return
    set({ step: 'diff', applyResults: null, applyElapsedMs: null })
  },

  deploy: async () => {
    const { target, report, selectedIds, applying } = get()
    if (applying || !target.connectionId || !report) return
    const sqls = report
      .filter((i) => selectedIds.includes(i.id))
      .map((i) => i.sql)
      .filter((s): s is string => !!s)
    if (sqls.length === 0) return
    const startedAt = Date.now()
    set({ applying: true, applyResults: null, applyElapsedMs: null })
    try {
      const results = await api.applySync(target.connectionId, sqls)
      set({ applyResults: results, applyElapsedMs: Date.now() - startedAt })
    } finally {
      set({ applying: false })
    }
  },

  syncConnected: (connectedIds) => {
    const { source, target } = get()
    const alive = new Set(connectedIds)
    const patch: Partial<CompareState> = {}
    if (source.connectionId && !alive.has(source.connectionId)) {
      patch.source = { ...EMPTY_ENDPOINT }
      patch.sourceDbs = []
    }
    if (target.connectionId && !alive.has(target.connectionId)) {
      patch.target = { ...EMPTY_ENDPOINT }
      patch.targetDbs = []
    }
    if (Object.keys(patch).length > 0) set(patch)
  },
}))
