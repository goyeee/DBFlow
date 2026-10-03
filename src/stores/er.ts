import { create } from 'zustand'

import { api } from '../api/commands'
import type { DiffItem, ErModelDoc, ErSnapshot, ErTableSchema } from '../api/types'
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
import {
  buildErDiffPayload,
  makeModelFk,
  newTableSchema,
  nextNewTableName,
  schemasEqual,
  snapshotTableToSchema,
  validateDeleteTable,
  validateTableSchema,
  type ModelFkInput,
  type ModelTableState,
} from '../components/er/modelSchema'
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
  /** 逆向快照原样保留（copy-on-edit 的拷贝源 + 应用后刷新） */
  snapshot: ErSnapshot | null
  /** 编辑模式（显式开关；关闭只是隐藏编辑入口） */
  editMode: boolean
  /** 图上建模状态：小写表名 → schema/tombstone */
  modelTables: Record<string, ModelTableState>
  /** 表设计器正在编辑的表（小写；null=关） */
  designerTable: string | null
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
  setEditMode: (tabKey: string, v: boolean) => void
  setDesignerTable: (tabKey: string, table: string | null) => void
  /** 新建空表（预填 id 主键）并打开设计器；返回小写表键 */
  createTable: (tabKey: string) => string | null
  /** 保存设计器草稿（未应用新表可改名 → rekey）；与库一致时不落 schema */
  saveTableSchema: (
    tabKey: string,
    lower: string,
    schema: ErTableSchema,
  ) => { ok: boolean; error?: string }
  /** 删除表：同步表转 tombstone（保留编辑），新建表直接移除；被模型外键引用时阻止 */
  deleteTable: (tabKey: string, lower: string) => { ok: boolean; error?: string }
  /** 恢复 tombstone：有编辑 → 恢复编辑态；无编辑 → 回到无痕 */
  restoreTable: (tabKey: string, lower: string) => void
  /** 画布拖线建模型外键（子表 copy-on-edit） */
  addModelFk: (tabKey: string, input: ModelFkInput) => { ok: boolean; error?: string }
  removeModelFk: (tabKey: string, tableLower: string, fkName: string) => void
  /** 应用变更第一步：模型 vs 库实时结构 diff */
  runErDiff: (tabKey: string) => Promise<DiffItem[]>
  /** 应用后刷新：拉新快照重建图 → 复跑 diff → 零差异表清条目（角标消失），
   *  mfk 走线按需迁移到 fk 边 id → 自动保存文档。返回剩余差异（弹窗「重新比较」用） */
  refreshAfterApply: (tabKey: string) => Promise<DiffItem[]>
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
  const edges = [...graph.fkEdges, ...graph.mfkEdges, ...extraEdges].map((e) => ({
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

  /** 以当前 modelTables 重建派生图（编辑动作后调用） */
  const rebuildGraph = (tabKey: string) => {
    const t = get().tabs[tabKey]
    if (!t?.snapshot) return
    patchTab(tabKey, { graph: buildErGraph(t.snapshot, t.modelTables) })
  }

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
            snapshot: null,
            editMode: prev?.editMode ?? false,
            modelTables: {},
            designerTable: null,
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

        // 版本号校验：只认 1/2；其他版本不按无文档静默处理，要显式提示
        let overlayInput = doc
        if (doc && doc.formatVersion !== 1 && doc.formatVersion !== 2) {
          docIssue = `文档版本 ${doc.formatVersion} 不受支持`
          overlayInput = null
        }
        const overlay = docOverlay(overlayInput)
        // 有 schema 的表以文档结构渲染（模型为准）；tombstone 标记
        const modelTables = overlay.modelTables
        const graph = buildErGraph(snapshot, modelTables)
        const inferredEdges = inferEdges(graph)
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
          ...graph.mfkEdges.map((e) => e.id),
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
          snapshot,
          graph,
          inferredEdges,
          manualEdges,
          modelTables,
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

    setEditMode: (tabKey, v) => patchTab(tabKey, { editMode: v }),
    setDesignerTable: (tabKey, table) => patchTab(tabKey, { designerTable: table }),

    createTable: (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return null
      const name = nextNewTableName([...Object.keys(t.graph.tables), ...Object.keys(t.modelTables)])
      const lower = name.toLowerCase()
      // 位置：现有布局左侧堆叠区起点（与 placeFreshTables 同风格）
      const xs = Object.values(t.positions).map((p) => p.x)
      const ys = Object.values(t.positions).map((p) => p.y)
      const pos = {
        x: (xs.length ? Math.min(...xs) : 0) - 460,
        y: ys.length ? Math.min(...ys) : 0,
      }
      patchTab(tabKey, {
        modelTables: { ...t.modelTables, [lower]: { schema: newTableSchema(name), deleted: false } },
        positions: { ...t.positions, [lower]: pos },
        designerTable: lower,
        dirty: true,
      })
      rebuildGraph(tabKey)
      return lower
    },

    saveTableSchema: (tabKey, lower, schema) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return { ok: false, error: 'ER 图尚未加载' }
      // 改名只允许未应用的新表（已同步表名在设计器中只读）
      const inDb = t.snapshot.tables.some((s) => s.name.toLowerCase() === lower)
      const newLower = schema.name.trim().toLowerCase()
      if (newLower !== lower && inDb) return { ok: false, error: '已存在于库中的表不能改名' }
      const others = new Set(
        [...Object.keys(t.graph.tables), ...Object.keys(t.modelTables)].filter((n) => n !== lower),
      )
      const err = validateTableSchema(schema, others)
      if (err) return { ok: false, error: err }
      let modelTables = { ...t.modelTables }
      let positions = t.positions
      let collapsed = t.collapsed
      if (newLower !== lower) {
        delete modelTables[lower]
        positions = { ...t.positions }
        collapsed = { ...t.collapsed }
        positions[newLower] = { ...(positions[lower] ?? { x: 0, y: 0 }) }
        delete positions[lower]
        if (collapsed[lower]) {
          collapsed[newLower] = true
          delete collapsed[lower]
        }
      }
      // 与库结构完全一致的同步表 → 不落 schema（不留假「已编辑」角标）。
      // 比较必须含该表的库外键（copy-on-edit 同源），用 schemasEqual 而非 JSON
      const src = t.snapshot.tables.find((s) => s.name.toLowerCase() === newLower)
      const srcFks = src
        ? t.snapshot.foreignKeys.filter((f) => f.table.toLowerCase() === newLower)
        : []
      const sameAsDb = !!src && schemasEqual(schema, snapshotTableToSchema(src, srcFks))
      const wasDeleted = !!modelTables[newLower]?.deleted
      if (sameAsDb && !wasDeleted) {
        delete modelTables[newLower]
      } else {
        // 防御：tombstone 表理论上进不了设计器；万一保存，保持 deleted 标记
        modelTables[newLower] = { schema, deleted: wasDeleted }
      }
      patchTab(tabKey, { modelTables, positions, collapsed, designerTable: newLower, dirty: true })
      rebuildGraph(tabKey)
      return { ok: true }
    },

    deleteTable: (tabKey, lower) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return { ok: false, error: 'ER 图尚未加载' }
      const blocked = validateDeleteTable(lower, t.modelTables)
      if (blocked) return { ok: false, error: blocked }
      const inDb = t.snapshot.tables.some((s) => s.name.toLowerCase() === lower)
      const modelTables = { ...t.modelTables }
      if (inDb) {
        // tombstone：保留原 schema（先编辑后删的表，恢复时找回编辑内容）
        modelTables[lower] = { schema: t.modelTables[lower]?.schema ?? null, deleted: true }
      } else {
        delete modelTables[lower] // 新建表直接移除
      }
      patchTab(tabKey, { modelTables, dirty: true })
      rebuildGraph(tabKey)
      return { ok: true }
    },

    restoreTable: (tabKey, lower) => {
      const t = get().tabs[tabKey]
      if (!t) return
      const mt = t.modelTables[lower]
      const modelTables = { ...t.modelTables }
      if (mt?.schema) {
        // 有编辑内容：撤销删除、恢复为已编辑态
        modelTables[lower] = { schema: mt.schema, deleted: false }
      } else {
        // 未编辑过：恢复 = 回到「无建模痕迹」
        delete modelTables[lower]
      }
      patchTab(tabKey, { modelTables, dirty: true })
      rebuildGraph(tabKey)
    },

    addModelFk: (tabKey, input) => {
      const t = get().tabs[tabKey]
      if (!t?.graph || !t.snapshot) return { ok: false, error: 'ER 图尚未加载' }
      const childLower = input.table.toLowerCase()
      const existing = t.modelTables[childLower]
      // copy-on-edit：子表未有 schema 时从快照全量拷贝（含该表的库外键）
      const base =
        existing?.schema ??
        (() => {
          const src = t.snapshot!.tables.find((s) => s.name.toLowerCase() === childLower)
          if (!src) return null
          const srcFks = t
            .snapshot!.foreignKeys.filter((f) => f.table.toLowerCase() === childLower)
          return snapshotTableToSchema(src, srcFks)
        })()
      if (!base) return { ok: false, error: '找不到子表结构' }
      const fk = makeModelFk(input)
      if (base.foreignKeys.some((f) => f.name.toLowerCase() === fk.name.toLowerCase()))
        return { ok: false, error: `外键名「${fk.name}」已存在` }
      // 引用列/本表列存在性由 validateTableSchema 统一把关：先组装再校验
      const schema = { ...base, foreignKeys: [...base.foreignKeys, fk] }
      const others = new Set(
        [...Object.keys(t.graph.tables), ...Object.keys(t.modelTables)].filter(
          (n) => n !== childLower,
        ),
      )
      const err = validateTableSchema(schema, others)
      if (err) return { ok: false, error: err }
      patchTab(tabKey, {
        modelTables: { ...t.modelTables, [childLower]: { schema, deleted: false } },
        dirty: true,
      })
      rebuildGraph(tabKey)
      return { ok: true }
    },

    removeModelFk: (tabKey, tableLower, fkName) => {
      const t = get().tabs[tabKey]
      if (!t?.snapshot) return
      const mt = t.modelTables[tableLower]
      if (!mt?.schema) return
      const fks = mt.schema.foreignKeys.filter(
        (f) => f.name.toLowerCase() !== fkName.toLowerCase(),
      )
      const schema = { ...mt.schema, foreignKeys: fks }
      const modelTables = { ...t.modelTables }
      // 删完与库一致 → 条目整体清除
      const src = t.snapshot.tables.find((s) => s.name.toLowerCase() === tableLower)
      const srcFks = src
        ? t.snapshot.foreignKeys.filter((f) => f.table.toLowerCase() === tableLower)
        : []
      const sameAsDb = !!src && schemasEqual(schema, snapshotTableToSchema(src, srcFks))
      if (sameAsDb) delete modelTables[tableLower]
      else modelTables[tableLower] = { schema, deleted: false }
      patchTab(tabKey, { modelTables, dirty: true })
      rebuildGraph(tabKey)
    },

    runErDiff: async (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t?.graph) throw new Error('ER 图尚未加载')
      const serverNames = Object.fromEntries(
        Object.entries(t.graph.tables).map(([k, v]) => [k, v.name]),
      )
      const payload = buildErDiffPayload(t.modelTables, serverNames)
      if (payload.length === 0) return []
      return withSessionReconnect(t.connectionId, () =>
        api.erDiff(t.connectionId, t.database, payload),
      )
    },

    refreshAfterApply: async (tabKey) => {
      const t = get().tabs[tabKey]
      if (!t) return []
      const seq = t.requestSeq
      const snapshot = await withSessionReconnect(t.connectionId, () =>
        api.getErSnapshot(t.connectionId, t.database),
      )
      // 图以「新快照 + 现有 modelTables」重建（布局/折叠/走线等全部保留）
      const graph = buildErGraph(snapshot, t.modelTables)
      const inferredEdges = inferEdges(graph)
      commit(tabKey, seq, { snapshot, graph, inferredEdges })

      // 复跑 diff 决定清理范围
      const cur = get().tabs[tabKey]
      if (!cur) return []
      const serverNames = Object.fromEntries(
        Object.entries(cur.graph?.tables ?? {}).map(([k, v]) => [k, v.name]),
      )
      const payload = buildErDiffPayload(cur.modelTables, serverNames)
      let remain: DiffItem[] = []
      if (payload.length > 0) {
        remain = await withSessionReconnect(cur.connectionId, () =>
          api.erDiff(cur.connectionId, cur.database, payload),
        )
      }
      // 有差异项的表保留条目；零差异/tombstone 已消失的清除
      // （新建表可能已存在库里而 remain 为空 → 同样清除，角标消失）
      const tablesWithDiff = new Set(remain.map((i) => i.table.toLowerCase()))
      const modelTables: typeof cur.modelTables = {}
      for (const [lower, mt] of Object.entries(cur.modelTables)) {
        if (tablesWithDiff.has(lower)) modelTables[lower] = mt
      }
      // mfk → fk 走线/锚点迁移：仅迁移「复跑差异里已无对应 FK 项」的边
      // （该 FK 已应用/收敛，真实 FK 边即将出现）；未应用的 FK 边保留 mfk 键，
      // 否则用户没勾选的模型外键走线会丢
      const pendingFkIds = new Set(
        remain.filter((i) => i.kind === 'foreignKey').map((i) => i.id.toLowerCase()),
      )
      const edgeRoutes = { ...cur.edgeRoutes }
      const edgeAnchors = { ...cur.edgeAnchors }
      for (const key of Object.keys(edgeRoutes)) {
        const m = key.match(/^mfk:(.+):(.+)$/)
        if (!m) continue
        const fkKey = `fk:${m[1]}:${m[2]}`
        if (pendingFkIds.has(fkKey.toLowerCase())) continue
        if (!(fkKey in edgeRoutes)) edgeRoutes[fkKey] = edgeRoutes[key]
        delete edgeRoutes[key]
      }
      for (const key of Object.keys(edgeAnchors)) {
        const m = key.match(/^mfk:(.+):(.+)$/)
        if (!m) continue
        const fkKey = `fk:${m[1]}:${m[2]}`
        if (pendingFkIds.has(fkKey.toLowerCase())) continue
        if (!(fkKey in edgeAnchors)) edgeAnchors[fkKey] = edgeAnchors[key]
        delete edgeAnchors[key]
      }
      const graph2 = buildErGraph(snapshot, modelTables)
      commit(tabKey, seq, {
        modelTables,
        graph: graph2,
        inferredEdges: inferEdges(graph2),
        edgeRoutes,
        edgeAnchors,
        dirty: true,
      })
      await get().save(tabKey) // 应用成功后的文档变化直接落盘，不留给用户手动保存
      return remain
    },

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
        modelTables: t.modelTables,
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
