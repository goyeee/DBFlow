import { create } from 'zustand'

import { api } from '../api/commands'
import type { ErModelDoc } from '../api/types'
import { errText } from '../components/connection/ConnectionTree'
import {
  buildErGraph,
  buildModelDoc,
  docOverlay,
  inferredLayoutEdges,
  makeManualEdge,
  placeFreshTables,
  type ErEdgeInfo,
  type ErGraph,
  type ManualEdgeInput,
} from '../components/er/transform'
import { inferEdges } from '../components/er/infer'
import { dagreLayout, estimateNodeSize } from '../components/er/layout'
import type { AnchorOverride } from '../components/er/edgeAnchors'
import { withSessionReconnect } from './session'

/** ER 图标签页状态机：加载快照 → 叠加模型文档（布局/裁决）→ 画布交互 → 保存文档 */
type ErStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 单个 ER 标签（一个库）的状态。store 按 tabKey 分片，切标签互不覆盖 */
export interface ErTabState {
  status: ErStatus
  error: string | null
  connectionId: string
  connectionName: string
  database: string
  graph: ErGraph | null
  inferredEdges: ErEdgeInfo[]
  /** 用户手动添加的关联 */
  manualEdges: ErEdgeInfo[]
  /** 表名（小写）→ 左上角坐标 */
  positions: Record<string, { x: number; y: number }>
  collapsed: Record<string, boolean>
  /** 推断边裁决（confirmed 参与布局；ignored 隐藏） */
  inferredStatus: Record<string, 'confirmed' | 'ignored'>
  dirty: boolean
  /** 画布选中/高亮（单击） */
  selectedTable: string | null
  /** 详情抽屉（双击） */
  drawerTable: string | null
  search: string
  /** load 代次：慢响应 resolve 时比对，过期结果丢弃 */
  requestSeq: number
  /** 模型文档读取/解析失败提示（区别于"无文档"） */
  docIssue: string | null
  /** 上次视野：切走再切回时恢复（临时态，不入文档） */
  viewport?: { x: number; y: number; zoom: number }
  /** 是否显示推断虚线（按库记忆） */
  showInferred: boolean
  /** 手拖出的连线路径（edgeId → 途经点），随模型文档保存 */
  edgeRoutes: Record<string, { x: number; y: number }[]>
  /** 手拖出的端点锚点覆盖（edgeId → 各端面+位置），随模型文档保存 */
  edgeAnchors: Record<string, { source?: AnchorOverride; target?: AnchorOverride }>
  /** 重新布局前的上一份位置，供撤销（仅内存，不写入文档） */
  undoPositions?: Record<string, { x: number; y: number }>
  /** 重新布局前的连线路径快照，供撤销 */
  undoRoutes?: Record<string, { x: number; y: number }[]>
  /** 重新布局前的锚点覆盖快照，供撤销 */
  undoAnchors?: Record<string, { source?: AnchorOverride; target?: AnchorOverride }>
}

interface ErStore {
  /** tabKey（= ErTab.key）→ 该标签状态 */
  tabs: Record<string, ErTabState>

  load: (tabKey: string, connectionId: string, database: string, connectionName: string) => Promise<void>
  moveTable: (tabKey: string, table: string, x: number, y: number) => void
  setCollapsed: (tabKey: string, table: string, collapsed: boolean) => void
  adjudicateInferred: (
    tabKey: string,
    edgeId: string,
    status: 'confirmed' | 'ignored' | 'reset',
  ) => void
  /** 批量裁决所有未裁决的推断边 */
  adjudicateAll: (tabKey: string, status: 'confirmed' | 'ignored') => void
  relayout: (tabKey: string) => void
  /** 撤销最近一次重新布局，恢复其之前的位置 */
  undo: (tabKey: string) => void
  /** 手动新增关联（校验/规范化/去重由 makeManualEdge 处理） */
  addManualEdge: (tabKey: string, input: ManualEdgeInput) => { ok: boolean; error?: string }
  removeManualEdge: (tabKey: string, edgeId: string) => void
  /** 设置某条连线的手拖途经点；空数组表示恢复自动走线 */
  setEdgeRoute: (tabKey: string, edgeId: string, via: { x: number; y: number }[]) => void
  /** 设置某条连线某端的锚点覆盖；null 表示该端恢复自动锚点 */
  setEdgeAnchor: (
    tabKey: string,
    edgeId: string,
    which: 'source' | 'target',
    anchor: AnchorOverride | null,
  ) => void
  save: (tabKey: string) => Promise<void>
  /** 关闭模型文档读取失败提示条 */
  dismissDocIssue: (tabKey: string) => void
  setSelectedTable: (tabKey: string, table: string | null) => void
  setDrawerTable: (tabKey: string, table: string | null) => void
  setSearch: (tabKey: string, s: string) => void
  setViewport: (tabKey: string, vp: { x: number; y: number; zoom: number }) => void
  setShowInferred: (tabKey: string, v: boolean) => void
  /** 删除已关闭标签的分片 */
  purgeTabs: (keys: string[]) => void
  /** 当前所有有未保存修改的 tabKey */
  dirtyKeys: () => string[]
}

/** 参与自动布局的推断候选边上限（用户已确认的边不受此限） */
export const LAYOUT_LIMIT = 300

/** dagre 全量布局：fk 边 + 给定推断边都参与 */
function layoutGraph(
  graph: ErGraph,
  collapsed: Record<string, boolean>,
  extraEdges: ErEdgeInfo[] = [],
): Record<string, { x: number; y: number }> {
  const nodes = Object.values(graph.tables).map((t) => ({
    id: t.name.toLowerCase(),
    ...estimateNodeSize(t.columns.length, !!collapsed[t.name.toLowerCase()]),
  }))
  const edges = [...graph.fkEdges, ...extraEdges].map((e) => ({
    source: e.sourceTable.toLowerCase(),
    target: e.targetTable.toLowerCase(),
  }))
  return dagreLayout(nodes, edges)
}

export const useErStore = create<ErStore>((set, get) => {
  /** 只替换某个分片的字段（分片须存在） */
  const patchTab = (tabKey: string, partial: Partial<ErTabState>) =>
    set((s) => {
      const t = s.tabs[tabKey]
      if (!t) return s
      return { tabs: { ...s.tabs, [tabKey]: { ...t, ...partial } } }
    })

  /** await 后的提交：仅当分片仍存在且 requestSeq 未变才生效，原子防慢响应覆盖 */
  const commit = (tabKey: string, seq: number, partial: Partial<ErTabState>) =>
    set((s) => {
      const t = s.tabs[tabKey]
      if (!t || t.requestSeq !== seq) return s
      return { tabs: { ...s.tabs, [tabKey]: { ...t, ...partial } } }
    })

  return {
    tabs: {},

    load: async (tabKey, connectionId, database, connectionName) => {
      const prev = get().tabs[tabKey]
      const seq = (prev?.requestSeq ?? 0) + 1
      // 覆盖该分片为 loading；显式刷新时保留 search/viewport/showInferred
      set((s) => ({
        tabs: {
          ...s.tabs,
          [tabKey]: {
            status: 'loading',
            error: null,
            connectionId,
            connectionName,
            database,
            graph: null,
            inferredEdges: [],
            manualEdges: [],
            positions: {},
            collapsed: {},
            inferredStatus: {},
            dirty: false,
            selectedTable: null,
            drawerTable: null,
            search: prev?.search ?? '',
            requestSeq: seq,
            docIssue: null,
            viewport: prev?.viewport,
            showInferred: prev?.showInferred ?? true,
            edgeRoutes: {},
            edgeAnchors: {},
          },
        },
      }))
      try {
        const snapshot = await withSessionReconnect(connectionId, () =>
          api.getErSnapshot(connectionId, database),
        )
        // 模型文档：文件不存在后端返回 null；读取/解析失败要单独提示，不能静默当无文档
        let doc: ErModelDoc | null = null
        let docIssue: string | null = null
        try {
          doc = await api.loadErModel(connectionId, database)
        } catch (e) {
          docIssue = errText(e)
        }

        const graph = buildErGraph(snapshot)
        const inferredEdges = inferEdges(graph)
        const overlay = docOverlay(doc)
        const lower = Object.keys(graph.tables)

        // 恢复手动关联；结构变更后表/列已不存在的丢弃
        const manualEdges = overlay.manualEdges.filter((e) => {
          const src = graph.tables[e.sourceTable.toLowerCase()]
          const tgt = graph.tables[e.targetTable.toLowerCase()]
          if (!src || !tgt) return false
          return (
            src.columns.some((c) => c.name.toLowerCase() === e.sourceColumns[0].toLowerCase()) &&
            tgt.columns.some((c) => c.name.toLowerCase() === e.targetColumns[0].toLowerCase())
          )
        })

        // 布局：文档里没有任何位置 → 全量 dagre；否则恢复位置，快照新增的表堆左侧
        const docKnown = lower.filter((t) => overlay.positions[t])

        // 折叠态：只按模型文档里记录的（用户手动折叠过/展开过的）；默认全部展开
        const collapsed: Record<string, boolean> = {}
        for (const t of lower) {
          if (overlay.collapsed[t]) collapsed[t] = true
        }

        let positions: Record<string, { x: number; y: number }>
        if (docKnown.length === 0) {
          // 无保存布局：手动关联 + 未忽略的推断候选边（前 N）与真实 FK 一起参与布局
          const layoutCandidates = [
            ...manualEdges,
            ...inferredLayoutEdges(inferredEdges, overlay.inferredStatus, LAYOUT_LIMIT),
          ]
          positions = layoutGraph(graph, collapsed, layoutCandidates)
        } else {
          const fresh = lower.filter((t) => !overlay.positions[t])
          const bounds = {
            minX: Math.min(...docKnown.map((t) => overlay.positions[t].x)),
            minY: Math.min(...docKnown.map((t) => overlay.positions[t].y)),
          }
          positions = { ...placeFreshTables(fresh, bounds) }
          for (const t of docKnown) positions[t] = overlay.positions[t]
        }
        // 文档里已不存在的表条目丢弃（结构以实时快照为准）
        const cleanPositions: typeof positions = {}
        for (const t of lower) {
          cleanPositions[t] = positions[t]
        }
        const inferredIds = new Set(inferredEdges.map((e) => e.id))
        const inferredStatus = Object.fromEntries(
          Object.entries(overlay.inferredStatus).filter(([id]) => inferredIds.has(id)),
        )
        // 连线路径：只保留当前仍存在的连线（fk/推断/手动）上的路径
        const allEdgeIds = new Set([
          ...graph.fkEdges.map((e) => e.id),
          ...inferredEdges.map((e) => e.id),
          ...manualEdges.map((e) => e.id),
        ])
        const edgeRoutes = Object.fromEntries(
          Object.entries(overlay.edgeRoutes).filter(([id]) => allEdgeIds.has(id)),
        )
        // 端点锚点覆盖同样只保留仍存在的连线
        const edgeAnchors = Object.fromEntries(
          Object.entries(overlay.edgeAnchors).filter(([id]) => allEdgeIds.has(id)),
        )
        commit(tabKey, seq, {
          status: 'ready',
          graph,
          inferredEdges,
          manualEdges,
          positions: cleanPositions,
          collapsed,
          inferredStatus,
          edgeRoutes,
          edgeAnchors,
          docIssue,
          dirty: false,
        })
      } catch (e) {
        // 分片已关/被新请求取代则丢弃错误，不重建已关闭分片
        commit(tabKey, seq, { status: 'error', error: errText(e) })
      }
    },

    moveTable: (tabKey, table, x, y) =>
      patchTab(tabKey, {
        positions: { ...get().tabs[tabKey]?.positions, [table]: { x, y } },
        dirty: true,
      }),

    setCollapsed: (tabKey, table, collapsed) =>
      set((s) => {
        const t = s.tabs[tabKey]
        if (!t) return s
        const next = { ...t.collapsed }
        if (collapsed) next[table] = true
        else delete next[table]
        return { tabs: { ...s.tabs, [tabKey]: { ...t, collapsed: next, dirty: true } } }
      }),

    adjudicateInferred: (tabKey, edgeId, status) =>
      set((s) => {
        const t = s.tabs[tabKey]
        if (!t) return s
        const next = { ...t.inferredStatus }
        if (status === 'reset') delete next[edgeId]
        else next[edgeId] = status
        return { tabs: { ...s.tabs, [tabKey]: { ...t, inferredStatus: next, dirty: true } } }
      }),

    relayout: (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t?.graph) return
      // 手动关联 + 未忽略的推断候选边（confirmed 优先、前 N）与真实 FK 一起重排
      const layoutCandidates = [
        ...t.manualEdges,
        ...inferredLayoutEdges(t.inferredEdges, t.inferredStatus, LAYOUT_LIMIT),
      ]
      patchTab(tabKey, {
        positions: layoutGraph(t.graph, t.collapsed, layoutCandidates),
        // 位置大改后旧连线路径与锚点必然失真，一并清空；记住重排前的快照供撤销
        edgeRoutes: {},
        edgeAnchors: {},
        undoPositions: t.positions,
        undoRoutes: t.edgeRoutes,
        undoAnchors: t.edgeAnchors,
        dirty: true,
      })
    },

    undo: (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t?.undoPositions) return
      patchTab(tabKey, {
        positions: t.undoPositions,
        edgeRoutes: t.undoRoutes ?? {},
        edgeAnchors: t.undoAnchors ?? {},
        undoPositions: undefined,
        undoRoutes: undefined,
        undoAnchors: undefined,
        dirty: true,
      })
    },

    addManualEdge: (tabKey, input) => {
      const t = get().tabs[tabKey]
      if (!t?.graph) return { ok: false, error: 'ER 图尚未加载' }
      const existing = [...t.graph.fkEdges, ...t.inferredEdges, ...t.manualEdges]
      const r = makeManualEdge(t.graph, input, existing)
      if (!r.edge) return { ok: false, error: r.error }
      patchTab(tabKey, { manualEdges: [...t.manualEdges, r.edge], dirty: true })
      return { ok: true }
    },

    removeManualEdge: (tabKey, edgeId) => {
      const t = get().tabs[tabKey]
      if (!t) return
      const edgeRoutes = { ...t.edgeRoutes }
      delete edgeRoutes[edgeId]
      const edgeAnchors = { ...t.edgeAnchors }
      delete edgeAnchors[edgeId]
      patchTab(tabKey, {
        manualEdges: t.manualEdges.filter((e) => e.id !== edgeId),
        edgeRoutes,
        edgeAnchors,
        dirty: true,
      })
    },

    setEdgeRoute: (tabKey, edgeId, via) =>
      set((s) => {
        const t = s.tabs[tabKey]
        if (!t) return s
        const edgeRoutes = { ...t.edgeRoutes }
        if (via.length > 0) edgeRoutes[edgeId] = via
        else delete edgeRoutes[edgeId]
        return { tabs: { ...s.tabs, [tabKey]: { ...t, edgeRoutes, dirty: true } } }
      }),

    setEdgeAnchor: (tabKey, edgeId, which, anchor) =>
      set((s) => {
        const t = s.tabs[tabKey]
        if (!t) return s
        const edgeAnchors = { ...t.edgeAnchors }
        const entry = { ...edgeAnchors[edgeId] }
        if (anchor) entry[which] = anchor
        else delete entry[which]
        if (entry.source || entry.target) edgeAnchors[edgeId] = entry
        else delete edgeAnchors[edgeId]
        return { tabs: { ...s.tabs, [tabKey]: { ...t, edgeAnchors, dirty: true } } }
      }),

    save: async (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t || !t.graph || !t.connectionId || !t.database) return
      const seq = t.requestSeq
      const doc = buildModelDoc({
        // 当前仅 MySQL 实现；接入新数据库类型时随连接信息带上
        kind: 'mysql',
        database: t.database,
        connectionName: t.connectionName ?? '',
        positions: t.positions,
        collapsed: t.collapsed,
        fkEdges: t.graph.fkEdges,
        inferredEdges: t.inferredEdges,
        manualEdges: t.manualEdges,
        inferredStatus: t.inferredStatus,
        edgeRoutes: t.edgeRoutes,
        edgeAnchors: t.edgeAnchors,
        mfkEdges: t.graph.mfkEdges,
        modelTables: {},
      })
      await api.saveErModel(t.connectionId, t.database, doc)
      // 保存期间若发生了新的 load（seq 已变），不清新分片的 dirty
      commit(tabKey, seq, { dirty: false })
    },

    setSelectedTable: (tabKey, table) => patchTab(tabKey, { selectedTable: table }),
    setDrawerTable: (tabKey, table) => patchTab(tabKey, { drawerTable: table }),
    setSearch: (tabKey, search) => patchTab(tabKey, { search }),
    setViewport: (tabKey, viewport) => patchTab(tabKey, { viewport }),
    setShowInferred: (tabKey, v) => patchTab(tabKey, { showInferred: v }),
    dismissDocIssue: (tabKey) => patchTab(tabKey, { docIssue: null }),

    adjudicateAll: (tabKey, status) =>
      set((s) => {
        const t = s.tabs[tabKey]
        if (!t) return s
        const inferredStatus = { ...t.inferredStatus }
        for (const e of t.inferredEdges) {
          if (!inferredStatus[e.id]) inferredStatus[e.id] = status
        }
        return {
          tabs: { ...s.tabs, [tabKey]: { ...t, inferredStatus, dirty: true } },
        }
      }),

    purgeTabs: (keys) =>
      set((s) => {
        const tabs = { ...s.tabs }
        let changed = false
        for (const k of keys) {
          if (k in tabs) {
            delete tabs[k]
            changed = true
          }
        }
        return changed ? { tabs } : s
      }),

    dirtyKeys: () =>
      Object.entries(get().tabs)
        .filter(([, t]) => t.dirty)
        .map(([k]) => k),
  }
})
