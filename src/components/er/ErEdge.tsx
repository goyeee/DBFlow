import { useEffect, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  type EdgeProps,
  type Position,
} from '@xyflow/react'

import { useErStore } from '../../stores/er'
import { useErTabKey } from './erTabContext'
import { erCanvasApi } from './erCanvasApi'
import { projectToBorder, selfLoopVia, type AnchorSide } from './edgeAnchors'
import {
  nearestSegment,
  orthogonalizeChain,
  simplifyCollinear,
  smoothPolylinePath,
  snapToGuides,
} from './edgePath'
import type { ErEdgeInfo } from './transform'

export interface ErEdgeData {
  info: ErEdgeInfo
  /** 用户拖出的途经点（画布坐标）；空/缺省走自动 smoothstep */
  via?: { x: number; y: number }[]
  /** 车道分离：自动走线中线的偏移（同列间隙的平行边互不重合） */
  lane?: number
  /** 自引用单侧回环的外扩距离（自动锚点且未手动调整时存在） */
  selfLoop?: number
  [key: string]: unknown
}

type Pt = { x: number; y: number }
type EndWhich = 'source' | 'target'

/**
 * 拖拽会话（单指一次只会有一个）：
 * - via：拖途经点/段中点；insert=true 表示段中点首次拖出（先插入再按移动处理）；
 *   grab 为按下时指针相对点位的偏移（拖动不跳点）；fromLine 标记由整线拖动转化而来
 * - end：拖端点（改锚点）
 * - line：按住线体，未过阈值前不干预（保住单击弹信息），过阈值后转 via 插入
 */
type DragSession =
  | { kind: 'via'; index: number; insert: boolean; grab?: Pt; fromLine?: boolean }
  | { kind: 'end'; which: EndWhich }
  | { kind: 'line'; startClient: Pt; startFlow: Pt }

/** 超过该位移（屏幕像素）才算拖动，否则按单击处理 */
const DRAG_THRESHOLD = 4

function addDraggingClass(from: EventTarget | null) {
  clearDraggingClass()
  if (from instanceof Element) from.closest('.er-canvas')?.classList.add('er-dragging')
}
function clearDraggingClass() {
  document
    .querySelectorAll('.er-canvas.er-dragging')
    .forEach((el) => el.classList.remove('er-dragging'))
}

/**
 * ER 关系边，画图软件式连线交互：
 * - 按住连线任意位置直接拖动：在最近段拉出一个调整点（平滑圆角折线；
 *   渲染前正交化，调整点拖到任意位置斜段也自动折成水平 + 垂直的直角）
 * - 悬停线段时该段中点出现小点，拖它在该段插入调整点；调整点可继续拖动、右键删除；
 *   松手时接近共线的途经点自动消除（线拉直后中间点消失，全部共线即恢复自动走线）
 * - 拖动调整点/端点时与链上其余点水平或垂直对齐出现虚线引导线并自动吸附（6 屏幕像素）
 * - 拖两端空心圈改连接位置（可锚到表的任意面任意位置，仍贴表边框），右键恢复自动
 * - 无调整点时走自动 smoothstep；松手才提交 store（随模型文档保存）
 */
export function ErEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const tabKey = useErTabKey()
  const { screenToFlowPosition, getInternalNode, getViewport } = useReactFlow()
  // 画布可见范围（引导线横贯视口；拖动中视口基本不动，渲染开销可忽略）
  const viewW = useStore((s) => s.width)
  const viewH = useStore((s) => s.height)
  const [vpX, vpY, vpZoom] = useStore((s) => s.transform)
  const via = (data as ErEdgeData | undefined)?.via
  const lane = (data as ErEdgeData | undefined)?.lane ?? 0
  const selfLoop = (data as ErEdgeData | undefined)?.selfLoop
  // 拖拽中的临时途经点/端点（本地态保证流畅，松手提交 store）
  const [draft, setDraft] = useState<Pt[] | null>(null)
  // 对齐引导线位置（拖动途经点且吸附中时存在；松手即清）
  const [guides, setGuides] = useState<{ x?: number; y?: number } | null>(null)
  const [draftEnd, setDraftEnd] = useState<{
    which: EndWhich
    side: AnchorSide
    pos: number
    x: number
    y: number
  } | null>(null)
  // 悬停的线段下标：段中点手柄只在该段悬停时出现（平时线上看不到点，视觉干净）
  const [hoverSeg, setHoverSeg] = useState<number | null>(null)
  // 从热区滑到手柄的瞬间热区会先收到 leave，延迟一小拍再清，避免手柄闪烁消失
  const hoverClearRef = useRef<number | null>(null)
  const keepHoverSeg = (seg: number | null) => {
    if (hoverClearRef.current !== null) window.clearTimeout(hoverClearRef.current)
    hoverClearRef.current = null
    setHoverSeg(seg)
  }
  const clearHoverSegSoon = () => {
    if (hoverClearRef.current !== null) window.clearTimeout(hoverClearRef.current)
    hoverClearRef.current = window.setTimeout(() => {
      hoverClearRef.current = null
      setHoverSeg(null)
    }, 140)
  }
  const points = draft ?? via ?? []
  const dragRef = useRef<DragSession | null>(null)
  // 卸载时清掉悬停延迟清除的定时器
  useEffect(
    () => () => {
      if (hoverClearRef.current !== null) window.clearTimeout(hoverClearRef.current)
    },
    [],
  )
  // 拖拽中的最新值放 ref：连续 pointermove 之间 React 可能还没重渲染，
  // 直接读闭包里的 state 会拿到旧值（实测会把插入的途经点冲掉）
  const draftRef = useRef<Pt[] | null>(null)
  const draftEndRef = useRef<typeof draftEnd>(null)
  // 整线拖动后抑制紧随的 click（否则会冒泡到 React Flow 弹出边信息框）
  const suppressClickRef = useRef(false)

  const src =
    draftEnd?.which === 'source' ? { x: draftEnd.x, y: draftEnd.y } : { x: sourceX, y: sourceY }
  const tgt =
    draftEnd?.which === 'target' ? { x: draftEnd.x, y: draftEnd.y } : { x: targetX, y: targetY }
  const srcPos = draftEnd?.which === 'source' ? (draftEnd.side as Position) : sourcePosition
  const tgtPos = draftEnd?.which === 'target' ? (draftEnd.side as Position) : targetPosition

  const chain: Pt[] = [src, ...points, tgt]
  // 手动途经点渲染前正交化：点可拖到任意位置，斜段自动折成 L 形（水平 + 垂直），
  // 连线全程只走水平/垂直。首段沿源锚点面、末段沿目标锚点面的轴出入（线不斜着
  // 出表）；原始点不动只插拐点，拖拽与存储仍用原始链（正交链随端点实时重算）
  const orth =
    points.length > 0
      ? orthogonalizeChain(
          chain,
          srcPos === 'left' || srcPos === 'right',
          tgtPos === 'left' || tgtPos === 'right',
        )
      : null

  let path: string
  let autoMid: Pt
  if (orth) {
    path = smoothPolylinePath(orth.pts, 12)
    autoMid = orth.pts[Math.floor(orth.pts.length / 2)]
  } else if (
    selfLoop !== undefined &&
    (srcPos === 'left' || srcPos === 'right') &&
    srcPos === tgtPos
  ) {
    // 自引用单侧回环：从出端沿侧面向外折、竖走、折回入端（不绕整张表）。
    // 途经点按实际端点坐标计算，回环与端点严格正交，不受节点尺寸估算误差影响
    const dir: 1 | -1 = srcPos === 'left' ? -1 : 1
    const loop = selfLoopVia(src, tgt, dir, selfLoop)
    path = smoothPolylinePath([src, ...loop, tgt], Math.min(12, selfLoop))
    autoMid = { x: loop[0].x, y: (src.y + tgt.y) / 2 }
  } else {
    let labelX: number, labelY: number
    // 车道分离：两端都在侧面时错开中线 x（垂直段分离），都在上/下面时错开中线 y；
    // 混合面（手动锚点拖出来的）不偏移
    const horiz = (p: Position) => p === 'left' || p === 'right'
    const center: { centerX?: number; centerY?: number } = {}
    if (lane !== 0) {
      if (horiz(srcPos) && horiz(tgtPos)) center.centerX = (src.x + tgt.x) / 2 + lane
      else if (!horiz(srcPos) && !horiz(tgtPos)) center.centerY = (src.y + tgt.y) / 2 + lane
    }
    ;[path, labelX, labelY] = getSmoothStepPath({
      sourceX: src.x,
      sourceY: src.y,
      targetX: tgt.x,
      targetY: tgt.y,
      sourcePosition: srcPos,
      targetPosition: tgtPos,
      borderRadius: 8,
      ...center,
    })
    autoMid = { x: labelX, y: labelY }
  }

  const flowOf = (e: React.PointerEvent) =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY })

  /** 正交化链上最近的子段 →（原始段下标 + 投影点）：悬停高亮与新点插入
   *  都贴实际渲染的线（渲染的是正交链，不是原始链） */
  const orthHit = (p: Pt): { index: number; point: Pt } => {
    if (!orth) return nearestSegment(p, chain)
    const hit = nearestSegment(p, orth.pts)
    let index = 0
    for (let i = 0; i < points.length + 1; i++) {
      if (hit.index >= orth.segStart[i] && hit.index < orth.segStart[i + 1]) {
        index = i
        break
      }
    }
    return { index, point: hit.point }
  }

  /** 统一 pointermove：按会话类型分发（会话转换/提交都放 updater 外，StrictMode 下 updater 须纯） */
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    if (d.kind === 'end') {
      const node = getInternalNode(d.which === 'source' ? source : target)
      if (!node) return
      const nx = node.internals.positionAbsolute.x
      const ny = node.internals.positionAbsolute.y
      const nw = node.measured.width ?? 0
      const nh = node.measured.height ?? 0
      const proj = projectToBorder(flowOf(e), { x: nx, y: ny, width: nw, height: nh })
      // 与链上其余点（另一端 + 途经点）对齐吸附：只动沿边方向（锚点仍贴表边框），
      // 接近时显示水平/垂直引导线，方便把端点拉到与线上某点齐平
      const refs = d.which === 'source' ? [tgt, ...points] : [src, ...points]
      const tol = 6 / getViewport().zoom
      const vertical = proj.side === 'left' || proj.side === 'right'
      let best: number | null = null
      let bestD = Infinity
      for (const r of refs) {
        const dd = vertical ? Math.abs(r.y - proj.y) : Math.abs(r.x - proj.x)
        if (dd < tol && dd < bestD) {
          bestD = dd
          best = vertical ? r.y : r.x
        }
      }
      let next = { which: d.which, ...proj }
      let guide: { x?: number; y?: number } | null = null
      if (best !== null) {
        if (vertical) {
          const pos = Math.min(0.97, Math.max(0.03, (best - ny) / (nh || 1)))
          next = { ...next, y: best, pos }
          guide = { y: best }
        } else {
          const pos = Math.min(0.97, Math.max(0.03, (best - nx) / (nw || 1)))
          next = { ...next, x: best, pos }
          guide = { x: best }
        }
      }
      setGuides(guide)
      draftEndRef.current = next
      setDraftEnd(next)
      return
    }
    if (d.kind === 'line') {
      // 未过阈值不动（单击仍弹信息框）；过阈值转途经点拖拽
      const moved = Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y)
      if (moved < DRAG_THRESHOLD) return
      addDraggingClass(e.currentTarget)
      // 首次拖出：在最近段插入「按下位置在线上的投影点」，之后按移动它处理
      const base = via ?? []
      const { index, point } = orthHit(d.startFlow)
      dragRef.current = {
        kind: 'via',
        index,
        insert: false,
        grab: { x: point.x - d.startFlow.x, y: point.y - d.startFlow.y },
        fromLine: true,
      }
      const arr = [...base.slice(0, index), point, ...base.slice(index)]
      draftRef.current = arr
      setDraft(arr)
      return
    }
    const flow = flowOf(e)
    if (d.insert) {
      // 段中点首次拖出：把新点插到该段对应位置
      d.insert = false
      const base = draftRef.current ?? via ?? []
      const arr = [...base.slice(0, d.index), flow, ...base.slice(d.index)]
      draftRef.current = arr
      setDraft(arr)
      return
    }
    const g = d.grab ?? { x: 0, y: 0 }
    const base = draftRef.current ?? via ?? []
    // 与链上相邻点（被拖点在链中的下标为 d.index+1）做水平/垂直对齐吸附，吸附中显示引导线
    const chainPts: Pt[] = [src, ...base, tgt]
    const refs = [chainPts[d.index], chainPts[d.index + 2]].filter(
      (r): r is Pt => r !== undefined,
    )
    const snapped = snapToGuides(
      { x: flow.x + g.x, y: flow.y + g.y },
      refs,
      6 / getViewport().zoom,
    )
    setGuides(
      snapped.guideX !== undefined || snapped.guideY !== undefined
        ? { x: snapped.guideX, y: snapped.guideY }
        : null,
    )
    const arr = base.map((w, i) => (i === d.index ? snapped.point : w))
    draftRef.current = arr
    setDraft(arr)
  }

  /** 统一 pointerup/cancel：提交 store */
  const onUp = () => {
    const d = dragRef.current
    dragRef.current = null
    clearDraggingClass()
    setGuides(null)
    if (!d) return
    if (d.kind === 'end') {
      const cur = draftEndRef.current
      draftEndRef.current = null
      setDraftEnd(null)
      if (cur) {
        useErStore
          .getState()
          .setEdgeAnchor(tabKey, id, cur.which, { side: cur.side, pos: cur.pos })
      }
      return
    }
    const cur = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (cur) {
      // 提交前把与前后点接近共线的途经点消掉：线拉直后中间点自动消失，
      // 全部共线时存空数组正好恢复自动走线
      useErStore.getState().setEdgeRoute(tabKey, id, simplifyCollinear(cur, [src, tgt]))
      // 只有线体上发起的拖动需要抑制 click；手柄的 pointerdown 已 preventDefault，click 本就不会发
      if (d.kind === 'via' && d.fromLine) suppressClickRef.current = true
    }
  }

  // ---- 各拖拽入口 ----

  /** 线体按下：不 preventDefault（保住 click 弹信息）；
   *  立即进入 dragging 态禁选文字（pointerdown 先于 mousedown 默认行为，选择不会开始），
   *  位移过阈值后才接管为拖线 */
  const lineDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    // 合成事件/旧内核下可能没有活动指针，capture 会抛 NotFoundError；降级为不捕获
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* 不捕获也能拖（指针离开元素会断），仅自动化模拟场景会走到 */
    }
    addDraggingClass(e.currentTarget)
    dragRef.current = {
      kind: 'line',
      startClient: { x: e.clientX, y: e.clientY },
      startFlow: flowOf(e),
    }
  }

  /** 途经点/段中点按下 */
  const viaDown = (e: React.PointerEvent, index: number, insert: boolean) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // 合成事件/旧内核下可能没有活动指针，capture 会抛 NotFoundError；降级为不捕获
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* 不捕获也能拖（指针离开元素会断），仅自动化模拟场景会走到 */
    }
    addDraggingClass(e.currentTarget)
    const flow = flowOf(e)
    const at = !insert && points[index] ? points[index] : flow
    dragRef.current = {
      kind: 'via',
      index,
      insert,
      grab: { x: at.x - flow.x, y: at.y - flow.y },
    }
  }

  /** 端点按下 */
  const endDown = (e: React.PointerEvent, which: EndWhich) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // 合成事件/旧内核下可能没有活动指针，capture 会抛 NotFoundError；降级为不捕获
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* 不捕获也能拖（指针离开元素会断），仅自动化模拟场景会走到 */
    }
    addDraggingClass(e.currentTarget)
    dragRef.current = { kind: 'end', which }
  }

  /** 途经点右键：删除该点（恢复自动走线可从连线右键菜单一键重置） */
  const viaContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    useErStore
      .getState()
      .setEdgeRoute(tabKey, id, (via ?? []).filter((_, i) => i !== index))
  }

  /** 端点右键：该端恢复自动锚点 */
  const endContextMenu = (e: React.MouseEvent, which: EndWhich) => {
    e.preventDefault()
    e.stopPropagation()
    useErStore.getState().setEdgeAnchor(tabKey, id, which, null)
  }

  // 段中点手柄：无途经点时只有自动路径中点一个；有途经点时每段一个。
  // 有途经点时渲染的是正交链，手柄按 segStart 映射放到该段中间子段的中点（贴线）
  const mids: { at: Pt; insertIndex: number }[] =
    points.length === 0
      ? [{ at: autoMid, insertIndex: 0 }]
      : chain.slice(0, -1).map((_, i) => {
          const from = orth!.segStart[i]
          const k = from + Math.floor((orth!.segStart[i + 1] - from) / 2)
          const a = orth!.pts[k]
          const b = orth!.pts[k + 1]
          return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, insertIndex: i }
        })

  return (
    <>
      <BaseEdge id={id} path={path} />
      {/* 对齐引导线：拖动吸附时横贯可视区，松手即消失 */}
      {guides && (
        <g className="er-guides" pointerEvents="none">
          {guides.x !== undefined && (
            <line
              className="er-guide"
              x1={guides.x}
              y1={-vpY / vpZoom}
              x2={guides.x}
              y2={(viewH - vpY) / vpZoom}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {guides.y !== undefined && (
            <line
              className="er-guide"
              x1={-vpX / vpZoom}
              y1={guides.y}
              x2={(viewW - vpX) / vpZoom}
              y2={guides.y}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      )}
      {/* 整线拖拽热区：透明宽线盖在 BaseEdge 之上，单击/右键事件照常冒泡给 React Flow。
          宽度随缩放换算成恒定屏幕像素（缩小后不至于难得悬停不上）。
          注意 styles.css 的边样式只命中 .react-flow__edge-path，不会覆盖这里的宽度 */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.min(48, Math.max(20, 20 / vpZoom))}
        pointerEvents="stroke"
        style={{ cursor: 'grab' }}
        onPointerDown={lineDown}
        onPointerMove={(e) => {
          if (!dragRef.current) keepHoverSeg(orthHit(flowOf(e)).index)
          onMove(e)
        }}
        onPointerLeave={() => {
          if (!dragRef.current) clearHoverSegSoon()
        }}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            e.stopPropagation()
            e.preventDefault()
          }
        }}
      />
      <EdgeLabelRenderer>
        {(
          [
            { which: 'source' as const, at: src },
            { which: 'target' as const, at: tgt },
          ] as const
        ).map((e) => (
          <div
            key={`e-${e.which}`}
            className="er-wp er-wp-end nodrag"
            data-edge-id={id}
            style={{ transform: `translate(-50%, -50%) translate(${e.at.x}px, ${e.at.y}px)` }}
            title="拖动调整连接位置（可移到表的任意边）；右键恢复自动位置"
            onPointerDown={(ev) => endDown(ev, e.which)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(ev) => endContextMenu(ev, e.which)}
          />
        ))}
        {mids
          .filter((m) => m.insertIndex === hoverSeg)
          .map((m, i) => (
            <div
              key={`m-${i}`}
              className="er-wp er-wp-mid nodrag"
              data-edge-id={id}
              style={{ transform: `translate(-50%, -50%) translate(${m.at.x}px, ${m.at.y}px)` }}
              title="拖动在此处添加调整点；右键打开连线菜单"
              onPointerEnter={() => keepHoverSeg(m.insertIndex)}
              onPointerLeave={clearHoverSegSoon}
              onPointerDown={(e) => viaDown(e, m.insertIndex, true)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onContextMenu={(e) => {
                // portal 层的 contextmenu 冒泡不到 SVG 边组，转发给画布按边右键处理
                e.preventDefault()
                e.stopPropagation()
                erCanvasApi.edgeContextMenu?.(id)
              }}
            />
          ))}
        {points.map((p, i) => (
          <div
            key={`w-${i}`}
            className="er-wp er-wp-dot nodrag"
            data-edge-id={id}
            style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }}
            title="拖动移动调整点；右键删除"
            onPointerDown={(e) => viaDown(e, i, false)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(e) => viaContextMenu(e, i)}
          />
        ))}
      </EdgeLabelRenderer>
    </>
  )
}
