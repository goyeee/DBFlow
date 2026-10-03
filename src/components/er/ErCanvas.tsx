import { useEffect, useMemo, useRef, useState } from 'react'
import { message } from 'antd'
import { toPng } from 'html-to-image'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'

import { useErStore } from '../../stores/er'
import { useUiStore } from '../../stores/ui'
import { TableNode } from './TableNode'
import { ErEdge } from './ErEdge'
import {
  assignCorridorLanes,
  assignEdgeAnchors,
  assignEdgeLanes,
  assignSelfLoops,
  routeOrth,
  withAnchorOverrides,
  type EdgeAnchor,
} from './edgeAnchors'
import { estimateNodeSize } from './layout'
import { collectNodeMarks, type MarkKind, type NodeMark } from './highlight'
import { erCanvasApi } from './erCanvasApi'
import { askChoice } from './closeGuard'
import { useErTab, useErTabKey } from './erTabContext'
import { ErFkModal } from './ErFkModal'
import type { ErEdgeInfo } from './transform'

const nodeTypes = { erTable: TableNode }
const edgeTypes = { erEdge: ErEdge }

/** 快照图 → React Flow 节点（派生，本地 state 仅承接拖拽/选中的即时变化）。
 *  prevSelected 让派生重建时保留节点的选中态（否则任何派生变化都会清空框选/多选） */
function buildNodes(
  graph: ReturnType<typeof useErStore.getState>['tabs'][string]['graph'],
  positions: Record<string, { x: number; y: number }>,
  collapsed: Record<string, boolean>,
  search: string,
  selectedTable: string | null,
  anchors: Map<string, EdgeAnchor[]>,
  prevSelected: Map<string, boolean>,
  marks: Map<string, NodeMark>,
  handlers: {
    onHeaderClick: (nodeId: string) => void
    onColumnPick: (tableId: string, column: string) => void
  },
): Node[] {
  if (!graph) return []
  const q = search.trim().toLowerCase()
  return Object.values(graph.tables).map((t) => {
    const id = t.name.toLowerCase()
    const match =
      !!q &&
      (t.name.toLowerCase().includes(q) ||
        (t.comment?.toLowerCase().includes(q) ?? false) ||
        t.columns.some(
          (c) => c.name.toLowerCase().includes(q) || (c.comment?.toLowerCase().includes(q) ?? false),
        ))
    // 命中的具体列（列名匹配），供节点内列行高亮
    const matchedColumns = q
      ? t.columns
          .filter((c) => c.name.toLowerCase().includes(q))
          .map((c) => c.name.toLowerCase())
      : []
    const mark = marks.get(id)
    const modelCls =
      t.modelStatus === 'new'
        ? 'er-node-new'
        : t.modelStatus === 'deleted'
          ? 'er-node-deleted'
          : undefined
    return {
      id,
      type: 'erTable' as const,
      // 关系高亮的节点级 class 挂在 RF wrapper 上（CSS：.er-node-{kind} .er-table-node）。
      // 声明式输出——画布开着虚拟化，视口外/滚动重挂载的节点不会丢高亮
      className:
        [mark?.node.length ? mark.node.map((k) => `er-node-${k}`).join(' ') : undefined, modelCls]
          .filter(Boolean)
          .join(' ') || undefined,
      position: positions[id] ?? { x: 0, y: 0 },
      // 关掉 RF 的「单击单选替换」（节点级覆盖，Shift 框选不受影响）：
      // 表头单击走自己的追加式选中（联动高亮/方向键微移）
      selectable: false,
      selected: prevSelected.get(id) ?? false,
      data: {
        table: t,
        collapsed: !!collapsed[id],
        modelStatus: t.modelStatus,
        highlight: match || id === selectedTable,
        matchedColumns: matchedColumns.length > 0 ? matchedColumns : undefined,
        anchors: anchors.get(id) ?? [],
        markCols: mark?.cols,
        onHeaderClick: handlers.onHeaderClick,
        onColumnPick: handlers.onColumnPick,
      },
    }
  })
}

/** 边：真实 FK 实线蓝；模型外键实线青绿（未应用）；手动关联实线紫；推断边虚线（确认后仍虚线、忽略后隐藏）。
 *  via 为手拖途经点（自定义边组件据此切换折线走线） */
function buildEdges(
  fkEdges: ErEdgeInfo[],
  mfkEdges: ErEdgeInfo[],
  inferredEdges: ErEdgeInfo[],
  manualEdges: ErEdgeInfo[],
  inferredStatus: Record<string, 'confirmed' | 'ignored'>,
  showInferred: boolean,
  edgeRoutes: Record<string, { x: number; y: number }[]>,
): Edge[] {
  const toEdge = (e: ErEdgeInfo, className: string): Edge => ({
    id: e.id,
    source: e.sourceTable.toLowerCase(),
    target: e.targetTable.toLowerCase(),
    // 锚定到表侧边的均布锚点（锚点 Handle 以边 id 命名），不再精确到列行
    sourceHandle: e.id,
    targetHandle: e.id,
    type: 'erEdge',
    className,
    data: { info: e, via: edgeRoutes[e.id] },
  })
  const fk = fkEdges.map((e) => toEdge(e, 'er-edge-fk'))
  const mfk = mfkEdges.map((e) => toEdge(e, 'er-edge-mfk'))
  const manual = manualEdges.map((e) => toEdge(e, 'er-edge-manual'))
  const inferred = inferredEdges
    .filter((e) => showInferred && inferredStatus[e.id] !== 'ignored')
    .map((e) =>
      toEdge(e, inferredStatus[e.id] === 'confirmed' ? 'er-edge-inferred-ok' : 'er-edge-inferred'),
    )
  return [...fk, ...mfk, ...manual, ...inferred]
}

/** 边提示框的文本行：FK 名 / 手动标记 / 列映射 / ON 规则 */
function edgeTipLines(info: ErEdgeInfo): string[] {
  const lines: string[] = []
  if (info.fkName) lines.push(info.fkName)
  if (info.kind === 'manual') lines.push('手动关联')
  if (info.kind === 'mfk') lines.push('模型外键（未应用）')
  info.sourceColumns.forEach((c, i) => {
    lines.push(`${info.sourceTable}.${c} → ${info.targetTable}.${info.targetColumns[i]}`)
  })
  if (info.onDelete) lines.push(`ON DELETE ${info.onDelete}`)
  if (info.onUpdate) lines.push(`ON UPDATE ${info.onUpdate}`)
  return lines
}

export function ErCanvas() {
  const tabKey = useErTabKey()
  const graph = useErTab((t) => t.graph)
  const positions = useErTab((t) => t.positions)
  const collapsed = useErTab((t) => t.collapsed)
  const inferredEdges = useErTab((t) => t.inferredEdges)
  const manualEdges = useErTab((t) => t.manualEdges)
  const inferredStatus = useErTab((t) => t.inferredStatus)
  const showInferred = useErTab((t) => t.showInferred)
  const edgeRoutes = useErTab((t) => t.edgeRoutes)
  const edgeAnchors = useErTab((t) => t.edgeAnchors)
  const search = useErTab((t) => t.search)
  const miniMap = useUiStore((s) => s.erMiniMap)
  const selectedTable = useErTab((t) => t.selectedTable)

  const { fitView, getViewport, setViewport, zoomIn, zoomOut } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  // edges 是 useMemo 派生物，镜像一份供 erCanvasApi.edgeContextMenu 按 id 找回边
  const edgesRef = useRef<Edge[]>([])
  const nodesInitialized = useNodesInitialized()
  const rfWidth = useStore((s) => s.width)
  const rfHeight = useStore((s) => s.height)
  const wrapRef = useRef<HTMLDivElement>(null)

  const [edgeTip, setEdgeTip] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  // 左键单击选中的连线（高亮）；信息/裁决等操作在右键弹框
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  // 编辑态拖线建模型外键的待确认输入（ErFkModal 打开中）
  const [fkPending, setFkPending] = useState<{
    sourceTable: string
    sourceColumn: string
    targetTable: string
    targetColumn: string
  } | null>(null)
  // 悬停中的连线（hover 高亮）：与选中各自独立，一起进声明式 marks
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null)
  // 选中表集合（追加单击/框选）：联动点亮它参与的关系线与两端表/列
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(() => new Set())
  // 字段点亮的关联边集合（点列行触发）：点亮线 + 两端表/列（对方字段一眼可见）
  const [pickedEdgeIds, setPickedEdgeIds] = useState<Set<string>>(() => new Set())
  // tabKey 镜像：data 里的点击回调闭包可能跨渲染留存，读 ref 保证写到当前标签
  const tabKeyRef = useRef(tabKey)
  tabKeyRef.current = tabKey

  /** 表头单击：单选切换——只选中这一个表（其余全部取消），再点一次取消。
   *  只有表头才算选中表，点字段不算（字段单击是点亮该列参与的关系）。
   *  关联表的联动只是列高亮，不进入选择，点击下一个表头不会被它们干扰 */
  const handleHeaderClick = (nodeId: string) => {
    const nowOn = !nodesRef.current.find((n) => n.id === nodeId)?.selected
    setNodes((nds) => nds.map((n) => ({ ...n, selected: nowOn && n.id === nodeId })))
    useErStore.getState().setSelectedTable(tabKeyRef.current, nowOn ? nodeId : null)
    setPickedEdgeIds(new Set())
  }

  /** 列行单击：不选中表。该列参与关系时点亮这些关系线与两端表/列（再点一次取消） */
  const handleColumnPick = (tableId: string, column: string) => {
    const col = column.toLowerCase()
    const hits = new Set(
      edgesRef.current
        .filter((e) => {
          const info = (e.data as { info?: ErEdgeInfo } | undefined)?.info
          if (!info) return false
          return (
            (info.sourceTable.toLowerCase() === tableId &&
              info.sourceColumns.some((c) => c.toLowerCase() === col)) ||
            (info.targetTable.toLowerCase() === tableId &&
              info.targetColumns.some((c) => c.toLowerCase() === col))
          )
        })
        .map((e) => e.id),
    )
    setPickedEdgeIds((prev) => {
      if (prev.size === hits.size && [...hits].every((x) => prev.has(x))) return new Set()
      return hits
    })
  }
  // 是否只渲染视口内节点（虚拟化）。导出 PNG 时临时关闭
  const [virtualize, setVirtualize] = useState(true)
  // 拖动表时的对齐引导线位置（flow 坐标）；仅拖拽中存在
  const [nodeGuides, setNodeGuides] = useState<{ x?: number; y?: number } | null>(null)
  // 画布变换（引导线 DOM 层把 flow 坐标换算成容器像素）
  const [vpX, vpY, vpZoom] = useStore((s) => s.transform)

  // 边与锚点一体派生：先建边 → 自动锚点（按两端几何选面：并排右出左入、垂直堆叠
  // 底出顶入、反向左出右入，同面多条按对端位置均布）套手动覆盖 → 车道分离 +
  // 中段避障 → 最终边。避障要读每条边两端的锚点面与位置，所以与锚点放同一个 memo
  const { edges, anchors, marks } = useMemo(() => {
    if (!graph)
      return {
        edges: [] as Edge[],
        anchors: new Map<string, EdgeAnchor[]>(),
        marks: new Map<string, NodeMark>(),
      }
    const built = buildEdges(
      graph.fkEdges,
      graph.mfkEdges,
      inferredEdges ?? [],
      manualEdges ?? [],
      inferredStatus ?? {},
      showInferred ?? true,
      edgeRoutes ?? {},
    )
    const ends = built.map((e) => ({ id: e.id, source: e.source, target: e.target }))
    // 节点矩形：布局位置 + 按列数/折叠态估算的尺寸（与 dagre 布局同源）
    const rectOf = (id: string) => {
      const p = positions?.[id]
      const t = graph.tables[id]
      if (!p || !t) return null
      const { width, height } = estimateNodeSize(t.columns.length, !!collapsed?.[id])
      return { x: p.x, y: p.y, width, height }
    }
    // 自引用边（source === target）单独分配单侧回环锚点，不进通用选面
    const selfEnds = built
      .filter((e) => e.source === e.target)
      .map((e) => ({
        id: e.id,
        node: e.source,
        sourceColumn: (e.data as { info?: ErEdgeInfo } | undefined)?.info?.sourceColumns[0],
        targetColumn: (e.data as { info?: ErEdgeInfo } | undefined)?.info?.targetColumns[0],
      }))
    // 列行位置（沿左/右面百分比）：表头 36 + 行高 22，与 estimateNodeSize 同源；
    // 表折叠/找不到列返回 null（assignSelfLoops 退回落位）
    const colPctOf = (nodeId: string, column?: string): number | null => {
      if (!column) return null
      const t = graph.tables[nodeId]
      const r = rectOf(nodeId)
      if (!t || !r || collapsed?.[nodeId]) return null
      const idx = t.columns.findIndex((c) => c.name.toLowerCase() === column.toLowerCase())
      if (idx < 0) return null
      return ((36 + idx * 22 + 11) / r.height) * 100
    }
    const crossAnchors = assignEdgeAnchors(
      ends.filter((e) => e.source !== e.target),
      rectOf,
    )
    // 自引用锚点就地追加进 crossAnchors，并返回每条边的回环外扩距离
    const selfGaps = assignSelfLoops(selfEnds, crossAnchors, colPctOf)
    const autoAnchors = withAnchorOverrides(crossAnchors, ends, edgeAnchors ?? {})
    // 锚点（面 + 沿面比例）→ 锚点在画布上的坐标，避障用它估计中段位置
    const anchorPt = (nodeId: string, edgeId: string, type: 'source' | 'target') => {
      const a = autoAnchors.get(nodeId)?.find((x) => x.edgeId === edgeId && x.type === type)
      const r = rectOf(nodeId)
      if (!a || !r) return null
      if (a.side === 'left') return { x: r.x, y: r.y + (a.pct / 100) * r.height, side: a.side }
      if (a.side === 'right')
        return { x: r.x + r.width, y: r.y + (a.pct / 100) * r.height, side: a.side }
      if (a.side === 'top') return { x: r.x + (a.pct / 100) * r.width, y: r.y, side: a.side }
      return { x: r.x + (a.pct / 100) * r.width, y: r.y + r.height, side: a.side }
    }
    const allRects = Object.keys(graph.tables)
      .map((id) => ({ id, r: rectOf(id) }))
      .filter(
        (x): x is { id: string; r: { x: number; y: number; width: number; height: number } } =>
          !!x.r,
      )
    // 车道分离（列带）：同一列间隙的平行边中线错开，垂直段不再重合
    const nodeX = Object.fromEntries(Object.entries(positions ?? {}).map(([id, p]) => [id, p.x]))
    const lanes = assignEdgeLanes(ends, nodeX)
    // 走廊车道：避障后的中段若与其他边重合（中段坐标接近且跨度重叠）再错开，
    // 兜住「多条线被同一个障碍挤到同一侧边缘」等列带分组覆盖不到的重合
    const laneById: Record<string, number> = {}
    // 共线穿表的边：中线自由度救不了（水平段必然横穿），注入正交绕行桥途经点
    const bypassVia: Record<string, { x: number; y: number }[]> = {}
    const corridorMids: { id: string; mid: number; lo: number; hi: number }[] = []
    for (const e of built) {
      if (e.source === e.target) {
        // 自引用单侧回环不走车道/避障（ErEdge 按实际端点折回环）
        laneById[e.id] = 0
        continue
      }
      let lane = lanes[e.id] ?? 0
      // 手拖过的边走自定义折线；自动走线整条避开无关节点，不从表背部穿越
      if (!(edgeRoutes ?? {})[e.id]?.length) {
        const sp = anchorPt(e.source, e.id, 'source')
        const tp = anchorPt(e.target, e.id, 'target')
        if (sp && tp) {
          const obstacles = allRects
            .filter((x) => x.id !== e.source && x.id !== e.target)
            .map((x) => x.r)
          // 中段偏移优先；Z 形无解（两端压在障碍带上）时侧边绕桥，线不穿表背
          const r = routeOrth(sp, tp, sp.side, tp.side, obstacles, { lane })
          if (r.via) {
            bypassVia[e.id] = r.via
          } else {
            lane = r.lane
            const horizS = sp.side === 'left' || sp.side === 'right'
            const horizT = tp.side === 'left' || tp.side === 'right'
            // 水平边的中段是竖线（记录 x + y 跨度）；垂直边是横线（记录 y + x 跨度）
            if (horizS && horizT) {
              corridorMids.push({
                id: e.id,
                mid: (sp.x + tp.x) / 2 + lane,
                lo: Math.min(sp.y, tp.y),
                hi: Math.max(sp.y, tp.y),
              })
            } else if (!horizS && !horizT) {
              corridorMids.push({
                id: e.id,
                mid: (sp.y + tp.y) / 2 + lane,
                lo: Math.min(sp.x, tp.x),
                hi: Math.max(sp.x, tp.x),
              })
            }
          }
        }
      }
      laneById[e.id] = lane
    }
    const corridor = assignCorridorLanes(corridorMids)
    const finalEdges = built.map((e) => ({
      ...e,
      className:
        e.id === selectedEdgeId ||
        pickedEdgeIds.has(e.id) ||
        selectedTableIds.has(e.source) ||
        selectedTableIds.has(e.target)
          ? `${e.className} er-edge-selected`
          : e.className,
      data: {
        ...e.data,
        via: (edgeRoutes ?? {})[e.id]?.length ? e.data?.via : bypassVia[e.id],
        lane: (laneById[e.id] ?? 0) + (corridor[e.id] ?? 0),
        // 自引用回环只在全自动（无手拖途经点/锚点覆盖）时启用；
        // 手动调整过则退回通用折线，恢复自动后回环回来
        selfLoop:
          e.source === e.target &&
          !(edgeRoutes ?? {})[e.id]?.length &&
          !(edgeAnchors ?? {})[e.id]?.source &&
          !(edgeAnchors ?? {})[e.id]?.target
            ? selfGaps[e.id]
            : undefined,
      },
    }))
    // 关系高亮（声明式）：悬停边/选中边/选中表联动/点字段点亮 → 两端节点与参与列
    // 的标记集合，随节点 className / data 渲染——虚拟化下视口外、滚动重挂载的
    // 节点高亮都不丢（之前直接 toggle DOM class，重挂载即被 React 重建冲掉）
    const kindsByEdge: Record<string, MarkKind[]> = {}
    const addKind = (edgeId: string, kind: MarkKind) => {
      kindsByEdge[edgeId] = [...(kindsByEdge[edgeId] ?? []), kind]
    }
    if (hoverEdgeId) addKind(hoverEdgeId, 'related')
    if (selectedEdgeId) addKind(selectedEdgeId, 'sel')
    for (const id of pickedEdgeIds) addKind(id, 'fpick')
    for (const e of built) {
      if (selectedTableIds.has(e.source) || selectedTableIds.has(e.target)) addKind(e.id, 'tsel')
    }
    const marks = collectNodeMarks(
      built.map((e) => {
        const info = (e.data as { info?: ErEdgeInfo } | undefined)?.info
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceColumns: info?.sourceColumns ?? [],
          targetColumns: info?.targetColumns ?? [],
        }
      }),
      kindsByEdge,
    )
    return { edges: finalEdges, anchors: autoAnchors, marks }
  }, [
    graph,
    inferredEdges,
    manualEdges,
    inferredStatus,
    showInferred,
    edgeRoutes,
    positions,
    collapsed,
    edgeAnchors,
    selectedEdgeId,
    hoverEdgeId,
    selectedTableIds,
    pickedEdgeIds,
  ])
  edgesRef.current = edges

  useEffect(() => {
    setNodes(
      buildNodes(
        graph ?? null,
        positions ?? {},
        collapsed ?? {},
        search ?? '',
        selectedTable ?? null,
        anchors,
        new Map(nodesRef.current.map((n) => [n.id, !!n.selected])),
        marks,
        { onHeaderClick: handleHeaderClick, onColumnPick: handleColumnPick },
      ),
    )
  }, [graph, positions, collapsed, search, selectedTable, anchors, marks, setNodes])

  // 初始视野：有上次视野则 defaultViewport 恢复、不 fit；否则等节点与容器就绪后 fitView
  const savedViewport = useErTab((t) => t.viewport)
  const pendingFit = useRef(!savedViewport)
  useEffect(() => {
    if (pendingFit.current && nodesInitialized && nodes.length > 0 && rfWidth > 0 && rfHeight > 0) {
      pendingFit.current = false
      fitView({ padding: 0.15, duration: 250, minZoom: 0.4, maxZoom: 1 })
    }
  }, [nodesInitialized, nodes.length, rfWidth, rfHeight, fitView])

  // 画布卸载（切走标签/刷新）前保存视野，重挂时 defaultViewport 恢复
  useEffect(
    () => () => {
      useErStore.getState().setViewport(tabKey, getViewport())
    },
    [tabKey, getViewport],
  )

  // Cmd/Ctrl + 滚轮以鼠标位置缩放（capture 拦截，阻止 React Flow 的平移处理）。
  // 普通滚轮/双指滑动走平移，缩放交给捏合
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const vp = getViewport()
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const nz = vp.zoom * factor
      // 以鼠标位置为锚点：缩放后鼠标下的画布坐标保持不动
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const cx = (px - vp.x) / vp.zoom
      const cy = (py - vp.y) / vp.zoom
      setViewport({ x: px - cx * nz, y: py - cy * nz, zoom: nz })
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [getViewport, setViewport])

  // 快捷键：Cmd/Ctrl+F 聚焦搜索、+0 适应窗口、+±缩放；Esc 清选/关抽屉；方向键微移选中表
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.er-toolbar input')?.focus()
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        erCanvasApi.fitAll?.()
        return
      }
      if (mod && (e.key === '=' || e.key === '+' || e.key === '-')) {
        e.preventDefault()
        if (e.key === '-') zoomOut()
        else zoomIn()
        return
      }
      // 输入框聚焦时，其余按键交给输入框自身处理
      if (typing) return
      if (e.key === 'Escape') {
        setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
        setSelectedEdgeId(null)
        setPickedEdgeIds(new Set())
        useErStore.getState().setSelectedTable(tabKey, null)
        useErStore.getState().setDrawerTable(tabKey, null)
        return
      }
      const dirs: Record<string, [number, number]> = {
        ArrowUp: [0, -20],
        ArrowDown: [0, 20],
        ArrowLeft: [-20, 0],
        ArrowRight: [20, 0],
      }
      const d = dirs[e.key]
      if (!d) return
      const selectedNodes = nodesRef.current.filter((n) => n.selected)
      if (selectedNodes.length === 0) return
      e.preventDefault()
      setNodes((nds) =>
        nds.map((n) =>
          n.selected
            ? { ...n, position: { x: n.position.x + d[0], y: n.position.y + d[1] } }
            : n,
        ),
      )
      for (const n of selectedNodes) {
        useErStore
          .getState()
          .moveTable(tabKey, n.id, n.position.x + d[0], n.position.y + d[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabKey, setNodes, zoomIn, zoomOut])

  // 挂载画布能力（供工具栏调用）
  useEffect(() => {
    erCanvasApi.focusTable = (name) => {
      fitView({ nodes: [{ id: name.toLowerCase() }], duration: 300, maxZoom: 1.1, padding: 0.6 })
    }
    erCanvasApi.fitAll = () => fitView({ padding: 0.15, duration: 250, minZoom: 0.4, maxZoom: 1 })
    erCanvasApi.getSelectedTables = () => nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    // 段中点手柄（portal 层）右键转发：事件冒泡到不了 SVG 边组
    erCanvasApi.edgeContextMenu = (edgeId) => {
      const edge = edgesRef.current.find((e) => e.id === edgeId)
      if (edge) void showEdgeMenu(edge)
    }
    erCanvasApi.exportPng = async () => {
      // 虚拟化时视口外节点不在 DOM：临时关闭，等全量挂载后截图，完成后恢复
      setVirtualize(false)
      // 截图不含连线拖拽手柄
      wrapRef.current?.classList.add('er-exporting')
      try {
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        )
        const { getNodesBounds, getViewportForBounds } = await import('@xyflow/react')
        const bounds = getNodesBounds(nodesRef.current)
        const width = Math.ceil(bounds.width) + 160
        const height = Math.ceil(bounds.height) + 160
        const viewport = getViewportForBounds(bounds, width, height, 0.2, 2, 0.1)
        const el = document.querySelector<HTMLElement>('.er-canvas .react-flow__viewport')
        if (!el) throw new Error('画布尚未渲染')
        return await toPng(el, {
          backgroundColor: '#ffffff',
          width,
          height,
          style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          },
        })
      } finally {
        wrapRef.current?.classList.remove('er-exporting')
        setVirtualize(true)
      }
    }
    return () => {
      delete erCanvasApi.focusTable
      delete erCanvasApi.fitAll
      delete erCanvasApi.getSelectedTables
      delete erCanvasApi.exportPng
      delete erCanvasApi.edgeContextMenu
    }
  }, [fitView, setVirtualize])

  /** 点空白：清除画布选中（RF 内部）与 selectedTable/连线/字段点亮 */
  const onPaneClick = () => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
    setSelectedEdgeId(null)
    setPickedEdgeIds(new Set())
    useErStore.getState().setSelectedTable(tabKey, null)
  }

  /** 双击节点：编辑态开表设计器（tombstone 不可编辑）；浏览态开详情抽屉 */
  const onNodeDoubleClick = (_: unknown, node: Node) => {
    const t = useErStore.getState().tabs[tabKey]
    if (t?.editMode) {
      if (t.modelTables[node.id]?.deleted) return
      useErStore.getState().setDesignerTable(tabKey, node.id)
    } else {
      useErStore.getState().setDrawerTable(tabKey, node.id)
    }
  }

  /** 拖动表时的智能对齐引导（画图软件式 smart guides）：被拖表的左/中/右缘
   *  与其他表的边/中线对齐（上/中/下缘同理），接近时显示虚线并实时吸附。
   *  React Flow 每次移动会先按内部累计的未吸附位置覆写，这里随后再纠正——
   *  同一事件内两次 setState 合并成一次渲染，视觉始终是吸附位，松手按最终位提交 */
  const onNodeDrag = (_: unknown, drag: Node) => {
    const w = drag.measured?.width ?? 0
    const h = drag.measured?.height ?? 0
    if (!w || !h) return
    const tol = 6 / getViewport().zoom
    const refX: number[] = []
    const refY: number[] = []
    for (const o of nodesRef.current) {
      if (o.id === drag.id) continue
      const ow = o.measured?.width
      const oh = o.measured?.height
      if (!ow || !oh) continue
      refX.push(o.position.x, o.position.x + ow / 2, o.position.x + ow)
      refY.push(o.position.y, o.position.y + oh / 2, o.position.y + oh)
    }
    // 被拖表的三缘（起点/中点/终点）与参考值比对，取容差内最近的对齐
    const align = (refs: number[], edges: [number, number][]) => {
      let best: { pos: number; guide: number; d: number } | null = null
      for (const ref of refs) {
        for (const [v, off] of edges) {
          const d = Math.abs(v - ref)
          if (d <= tol && (!best || d < best.d)) best = { pos: ref - off, guide: ref, d }
        }
      }
      return best
    }
    // 关联线对齐：被拖表某条边的锚点接近与对端锚点同高（水平边）/同列（垂直边）
    // 时吸附表位置把线拉直——拖表时线跟着动，对齐了拐弯最少
    const lineAlign = (axis: 'x' | 'y') => {
      let best: { pos: number; guide: number; d: number } | null = null
      for (const e of edgesRef.current) {
        if (e.source !== drag.id && e.target !== drag.id) continue
        const myType: 'source' | 'target' = e.source === drag.id ? 'source' : 'target'
        const otherId = myType === 'source' ? e.target : e.source
        if (otherId === drag.id) continue // 自引用边的「对端」是自己，没有对齐可言
        const myA = anchors.get(drag.id)?.find((a) => a.edgeId === e.id && a.type === myType)
        const otherNode = nodesRef.current.find((n) => n.id === otherId)
        const otherA = anchors
          .get(otherId)
          ?.find(
            (a) =>
              a.edgeId === e.id && a.type === (myType === 'source' ? ('target' as const) : ('source' as const)),
          )
        const ow = otherNode?.measured?.width ?? 0
        const oh = otherNode?.measured?.height ?? 0
        if (!myA || !otherNode || !otherA || !ow || !oh) continue
        const horizSide = myA.side === 'left' || myA.side === 'right'
        const otherHoriz = otherA.side === 'left' || otherA.side === 'right'
        if (horizSide !== otherHoriz) continue // 混合面的线没有水平/垂直可言
        if (axis === 'y') {
          if (!horizSide) continue
          const otherY = otherNode.position.y + (otherA.pct / 100) * oh
          const myPct = myA.pct / 100
          const d = Math.abs(drag.position.y + myPct * h - otherY)
          if (d <= tol && (!best || d < best.d))
            best = { pos: otherY - myPct * h, guide: otherY, d }
        } else {
          if (horizSide) continue
          const otherX = otherNode.position.x + (otherA.pct / 100) * ow
          const myPct = myA.pct / 100
          const d = Math.abs(drag.position.x + myPct * w - otherX)
          if (d <= tol && (!best || d < best.d))
            best = { pos: otherX - myPct * w, guide: otherX, d }
        }
      }
      return best
    }
    const bestOf = (
      a: { pos: number; guide: number; d: number } | null,
      b: { pos: number; guide: number; d: number } | null,
    ) => (!a ? b : !b ? a : a.d <= b.d ? a : b)
    const ax = bestOf(
      align(refX, [
        [drag.position.x, 0],
        [drag.position.x + w / 2, w / 2],
        [drag.position.x + w, w],
      ]),
      lineAlign('x'),
    )
    const ay = bestOf(
      align(refY, [
        [drag.position.y, 0],
        [drag.position.y + h / 2, h / 2],
        [drag.position.y + h, h],
      ]),
      lineAlign('y'),
    )
    setNodeGuides(ax || ay ? { x: ax?.guide, y: ay?.guide } : null)
    if (ax || ay) {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === drag.id
            ? {
                ...n,
                position: { x: ax ? ax.pos : n.position.x, y: ay ? ay.pos : n.position.y },
              }
            : n,
        ),
      )
    }
  }

  const onNodeDragStop = (_: unknown, node: Node) => {
    setNodeGuides(null)
    useErStore.getState().moveTable(tabKey, node.id, node.position.x, node.position.y)
  }

  /** 拖拽两列拉线：编辑态建「模型外键」（弹框确认约束名/ON 规则，回库生成 DDL）；
   *  浏览态确认后添加手动关联（方向自动规范化为主键端被引用；仅入本地模型文档） */
  const onConnect = async (conn: Connection) => {
    if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return
    const tab = useErStore.getState().tabs[tabKey]
    const g = tab?.graph
    if (!g) return
    if (tab?.editMode) {
      // 编辑态：拖拽源 = 子表列，目标 = 被引用表列
      setFkPending({
        sourceTable: g.tables[conn.source]?.name ?? conn.source,
        sourceColumn: conn.sourceHandle,
        targetTable: g.tables[conn.target]?.name ?? conn.target,
        targetColumn: conn.targetHandle,
      })
      return
    }
    // 节点 id 是小写表名，展示用真实表名
    const srcName = g.tables[conn.source]?.name ?? conn.source
    const tgtName = g.tables[conn.target]?.name ?? conn.target
    const answer = await askChoice<'ok'>({
      title: '添加手动关联',
      content: (
        <div className="er-edge-info">
          <div>{`${srcName}.${conn.sourceHandle} → ${tgtName}.${conn.targetHandle}`}</div>
          <div className="er-edge-info-hint">
            若一端是表主键，方向会自动调整为主键端作为被引用方；仅记录在本地模型文档，不修改数据库。
          </div>
        </div>
      ),
      choices: [
        { value: 'ok', label: '添加', primary: true },
        { value: null, label: '取消' },
      ],
    })
    if (answer !== 'ok') return
    const r = useErStore.getState().addManualEdge(tabKey, {
      sourceTable: conn.source,
      sourceColumn: conn.sourceHandle,
      targetTable: conn.target,
      targetColumn: conn.targetHandle,
    })
    if (!r.ok) message.warning(r.error ?? '无法添加关联')
  }

  /** 画布右键不弹菜单；节点右键在编辑态弹「编辑结构/删除表/恢复」操作框 */
  const suppressContextMenu = (e: React.MouseEvent | MouseEvent) => e.preventDefault()

  const onNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    const t = useErStore.getState().tabs[tabKey]
    if (!t?.editMode || !t.graph) return
    const lower = node.id
    const tombstone = !!t.modelTables[lower]?.deleted
    void (async () => {
      const answer = await askChoice<'design' | 'del' | 'restore'>({
        title: `表 · ${t.graph!.tables[lower]?.name ?? lower}`,
        content: tombstone
          ? '该表已标记删除（未应用）。'
          : '编辑结构或标记删除（应用变更时才修改数据库）。',
        choices: [
          ...(tombstone
            ? [{ value: 'restore' as const, label: '恢复表', primary: true }]
            : [
                { value: 'design' as const, label: '编辑结构', primary: true },
                { value: 'del' as const, label: '删除表', danger: true },
              ]),
          { value: null, label: '关闭' },
        ],
      })
      const store = useErStore.getState()
      if (answer === 'design') store.setDesignerTable(tabKey, lower)
      else if (answer === 'restore') store.restoreTable(tabKey, lower)
      else if (answer === 'del') {
        const r = store.deleteTable(tabKey, lower)
        if (!r.ok) message.warning(r.error ?? '无法删除')
      }
    })()
  }

  // 关系高亮（悬停边/选中边/选中表联动/点字段点亮）全部走上面的声明式 marks：
  // 节点 class 进 node.className、列 class 进 data.markCols，由 TableNode 渲染

  // 选中的边已不在画布上（删除关联/隐藏推断）时清掉选中态
  useEffect(() => {
    if (selectedEdgeId && !edges.some((e) => e.id === selectedEdgeId)) {
      setSelectedEdgeId(null)
    }
  }, [edges, selectedEdgeId])

  /** 节点选中集合变化（追加单击/框选/Esc）：驱动选中表的联动高亮与边样式 */
  const onSelectionChange = ({ nodes: sel }: { nodes: Node[]; edges: Edge[] }) => {
    setSelectedTableIds((prev) => {
      const next = new Set(sel.map((n) => n.id))
      if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev
      return next
    })
  }
  const onEdgeMouseEnter = (e: React.MouseEvent, edge: Edge) => {
    const info = (edge.data as { info?: ErEdgeInfo } | undefined)?.info
    if (!info) return
    setHoverEdgeId(edge.id)
    setEdgeTip({ x: e.clientX, y: e.clientY, lines: edgeTipLines(info) })
  }
  const onEdgeMouseMove = (e: React.MouseEvent) =>
    setEdgeTip((p) => (p ? { ...p, x: e.clientX, y: e.clientY } : p))
  const onEdgeMouseLeave = () => {
    setHoverEdgeId(null)
    setEdgeTip(null)
  }

  /** 左键单击边：仅高亮选中；点空白/其他边/Esc 取消（信息弹框在右键） */
  const onEdgeClick = (_: unknown, edge: Edge) => setSelectedEdgeId(edge.id)

  /**
   * 边的信息/操作框——FK 只读信息；手动关联可删除；推断边可确认/忽略
   * （中性关闭不判决）；已裁决的可取消。有手拖路径或锚点覆盖时附带
   * 「恢复自动走线与锚点」。弹框同时高亮该边，指明操作对象。
   * 入口：RF 边组右键（onEdgeContextMenu）+ portal 层段中点手柄右键（erCanvasApi 转发）
   */
  const showEdgeMenu = async (edge: Edge) => {
    const info = (edge.data as { info?: ErEdgeInfo } | undefined)?.info
    if (!info) return
    setSelectedEdgeId(edge.id)
    const store = useErStore.getState()
    const tab = store.tabs[tabKey]
    const canReset = !!tab?.edgeRoutes[edge.id]?.length || !!tab?.edgeAnchors[edge.id]
    const resetRouteChoice = { value: 'resetRoute' as const, label: '恢复自动走线与锚点' }
    const closeChoice = { value: null, label: '关闭' }
    const resetRoute = () => {
      store.setEdgeRoute(tabKey, edge.id, [])
      store.setEdgeAnchor(tabKey, edge.id, 'source', null)
      store.setEdgeAnchor(tabKey, edge.id, 'target', null)
    }
    const columnsList = edgeTipLines(info)
    const infoContent = (hint?: string) => (
      <div className="er-edge-info">
        {columnsList.map((l) => (
          <div key={l}>{l}</div>
        ))}
        {hint && <div className="er-edge-info-hint">{hint}</div>}
      </div>
    )

    if (info.kind === 'fk') {
      const ans = await askChoice<'resetRoute'>({
        title: `外键 · ${info.fkName ?? ''}`,
        content: infoContent(),
        choices: [...(canReset ? [resetRouteChoice] : []), closeChoice],
      })
      if (ans === 'resetRoute') resetRoute()
      return
    }

    if (info.kind === 'mfk') {
      const answer = await askChoice<'remove' | 'resetRoute'>({
        title: `模型外键 · ${info.fkName ?? ''}`,
        content: infoContent('建模添加的外键，尚未应用到数据库；应用变更时生成 ADD FOREIGN KEY。'),
        choices: [
          { value: 'remove', label: '删除模型外键', danger: true },
          ...(canReset ? [resetRouteChoice] : []),
          closeChoice,
        ],
      })
      if (answer === 'remove')
        store.removeModelFk(tabKey, info.sourceTable.toLowerCase(), info.fkName ?? '')
      else if (answer === 'resetRoute') resetRoute()
      return
    }

    if (info.kind === 'manual') {
      const answer = await askChoice<'remove' | 'resetRoute'>({
        title: '手动关联',
        content: infoContent('手动添加的关联，仅记录在本地模型文档。'),
        choices: [
          { value: 'remove', label: '删除关联', danger: true },
          ...(canReset ? [resetRouteChoice] : []),
          closeChoice,
        ],
      })
      if (answer === 'remove') store.removeManualEdge(tabKey, edge.id)
      else if (answer === 'resetRoute') resetRoute()
      return
    }

    const adjudicated = tab?.inferredStatus[edge.id]
    if (!adjudicated) {
      const answer = await askChoice<'confirmed' | 'ignored' | 'resetRoute'>({
        title: '命名推断的关系',
        content: infoContent('确认该关系存在，或忽略；关闭不做任何裁决。'),
        choices: [
          { value: 'confirmed', label: '确认关系', primary: true },
          { value: 'ignored', label: '忽略', danger: true },
          ...(canReset ? [resetRouteChoice] : []),
          closeChoice,
        ],
      })
      if (answer === 'resetRoute') resetRoute()
      else if (answer) store.adjudicateInferred(tabKey, edge.id, answer)
    } else {
      const answer = await askChoice<'reset' | 'resetRoute'>({
        title: '命名推断的关系',
        content: `当前：${adjudicated === 'confirmed' ? '已确认' : '已忽略'}`,
        choices: [
          { value: 'reset', label: '取消裁决', primary: true },
          ...(canReset ? [resetRouteChoice] : []),
          closeChoice,
        ],
      })
      if (answer === 'reset') store.adjudicateInferred(tabKey, edge.id, 'reset')
      else if (answer === 'resetRoute') resetRoute()
    }
  }

  /** 边右键：弹信息/操作框（仅阻止 webview 默认菜单） */
  const onEdgeContextMenu = (e: React.MouseEvent, edge: Edge) => {
    e.preventDefault()
    void showEdgeMenu(edge)
  }

  return (
    <div className="er-canvas" ref={wrapRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={suppressContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeClick={onEdgeClick}
        onEdgeContextMenu={onEdgeContextMenu}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseMove={onEdgeMouseMove}
        onEdgeMouseLeave={onEdgeMouseLeave}
        minZoom={0.05}
        maxZoom={2.5}
        defaultViewport={savedViewport}
        // 滚轮/双指滑动平移，捏合缩放；Cmd+滚轮由上方监听处理
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        onlyRenderVisibleElements={virtualize}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <Controls showInteractive={false} />
        {miniMap && (
          <div className="er-minimap-wrap">
            <MiniMap pannable zoomable />
            <button
              className="er-minimap-close"
              title="关闭小地图"
              onClick={() => useUiStore.getState().setErMiniMap(false)}
            >
              ×
            </button>
          </div>
        )}
        {!miniMap && (
          <button
            className="er-minimap-open"
            title="显示小地图"
            onClick={() => useUiStore.getState().setErMiniMap(true)}
          >
            小地图
          </button>
        )}
      </ReactFlow>
      {/* 拖表对齐引导线：flow 坐标换算成容器像素的橙色虚线，仅拖拽中显示 */}
      {nodeGuides && (nodeGuides.x !== undefined || nodeGuides.y !== undefined) && (
        <div className="er-node-guides" aria-hidden="true">
          {nodeGuides.x !== undefined && (
            <div className="er-ng er-ng-v" style={{ left: nodeGuides.x * vpZoom + vpX }} />
          )}
          {nodeGuides.y !== undefined && (
            <div className="er-ng er-ng-h" style={{ top: nodeGuides.y * vpZoom + vpY }} />
          )}
        </div>
      )}
      <ErFkModal open={!!fkPending} pending={fkPending} onClose={() => setFkPending(null)} />
      {edgeTip && (
        <div className="er-edge-tip" style={{ left: edgeTip.x + 12, top: edgeTip.y + 12 }}>
          {edgeTip.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}
