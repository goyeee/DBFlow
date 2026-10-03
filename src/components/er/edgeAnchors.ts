/**
 * 表级锚点分配：关系线不再精确到列行，而是粗略指向表的侧边。
 * 面的选择看两端节点的相对位置：水平并排右出左入、垂直堆叠（x 区间重叠）
 * 上表底出下表顶入、目标在源左侧（手动拖过的反向）左出右入——线不回头穿表。
 * 同一面有多条边时沿该面均匀排布（按对端在面延展轴上的位置排序，减少交叉），
 * 只有一条时落在正中间。用户可拖动连线端点覆盖自动锚点（任意面任意位置）。
 * 自引用边不参与（右出左入会绕整表一圈、两侧都挂线），由 assignSelfLoops
 * 在同一侧面折小回环。
 */

/** 节点边框的四个面 */
export type AnchorSide = 'left' | 'right' | 'top' | 'bottom'

/** 用户手拖出的锚点覆盖：面 + 沿面的比例位置（0–1），随模型文档保存 */
export interface AnchorOverride {
  side: AnchorSide
  pos: number
}

/** 一条边在某节点一端的锚点 */
export interface EdgeAnchor {
  edgeId: string
  /** 该边在本节点这一侧的角色 */
  type: 'source' | 'target'
  /** 锚点所在的面（自动锚点按两端几何选择） */
  side: AnchorSide
  /** 沿面的百分比位置（0–100）：左/右面为距顶部，上/下面为距左缘 */
  pct: number
}

interface EdgeEnd {
  edgeId: string
  /** 该边在本节点这一侧的角色（同一面的出/入边一起均布，出发点不重叠） */
  type: 'source' | 'target'
  /** 排序键：对端节点在面延展轴上的中心坐标 */
  key: number
}

type Pt = { x: number; y: number }
type ObRect = { x: number; y: number; width: number; height: number }

/** 水平连接（中段竖线 x=c）/ 垂直连接（中段横线 y=c）的 Z 形折线顶点 */
function zPoly(src: Pt, tgt: Pt, bothH: boolean, c: number): Pt[] {
  return bothH
    ? [src, { x: c, y: src.y }, { x: c, y: tgt.y }, tgt]
    : [src, { x: src.x, y: c }, { x: tgt.x, y: c }, tgt]
}

/** 折线各段（水平/垂直）与膨胀后的矩形群相交检测（边界相切不算） */
function polyHits(poly: Pt[], obstacles: ObRect[], margin: number): boolean {
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i]
    const b = poly[i + 1]
    for (const o of obstacles) {
      const ox1 = o.x - margin
      const ox2 = o.x + o.width + margin
      const oy1 = o.y - margin
      const oy2 = o.y + o.height + margin
      if (a.y === b.y) {
        // 水平段
        if (a.y > oy1 && a.y < oy2 && Math.max(a.x, b.x) > ox1 && Math.min(a.x, b.x) < ox2)
          return true
      } else {
        // 垂直段
        if (a.x > ox1 && a.x < ox2 && Math.max(a.y, b.y) > oy1 && Math.min(a.y, b.y) < oy2)
          return true
      }
    }
  }
  return false
}

/**
 * 自动均布锚点（不含手动覆盖）。
 * @param edges  边的 id 与两端节点 id
 * @param rectOf 取节点矩形（左上角 + 宽高）的函数；未知节点返回 null 时退回默认右出左入
 */
export function assignEdgeAnchors(
  edges: { id: string; source: string; target: string }[],
  rectOf: (nodeId: string) => { x: number; y: number; width: number; height: number } | null,
): Map<string, EdgeAnchor[]> {
  const centerOf = (id: string) => {
    const r = rectOf(id)
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : { x: 0, y: 0 }
  }
  // 每条边两端选面：默认 source 右出 / target 左入（自引用边不进这里，由 assignSelfLoops 接管）
  const sidesOf = (
    e: { id: string; source: string; target: string },
  ): { src: AnchorSide; tgt: AnchorSide } => {
    const s = rectOf(e.source)
    const t = rectOf(e.target)
    if (s && t) {
      const xOverlap = s.x < t.x + t.width && t.x < s.x + s.width
      if (xOverlap) return t.y >= s.y ? { src: 'bottom', tgt: 'top' } : { src: 'top', tgt: 'bottom' }
      if (t.x < s.x) return { src: 'left', tgt: 'right' }
    }
    return { src: 'right' as AnchorSide, tgt: 'left' as AnchorSide }
  }
  // 桶键 = side：同一节点同一面的出/入边一起均布（分开均布会让各桶都落 50%，
  // 一出边一入边共享同一个出发点）
  const buckets = new Map<string, Map<AnchorSide, EdgeEnd[]>>()
  const push = (node: string, type: 'source' | 'target', side: AnchorSide, end: EdgeEnd) => {
    let bySide = buckets.get(node)
    if (!bySide) {
      bySide = new Map()
      buckets.set(node, bySide)
    }
    bySide.set(side, [...(bySide.get(side) ?? []), { ...end, type }])
  }
  for (const e of edges) {
    if (e.source === e.target) continue
    const { src, tgt } = sidesOf(e)
    const sc = centerOf(e.source)
    const tc = centerOf(e.target)
    // 左/右面沿纵向延展 → 按对端 y 排序；顶/底面沿横向延展 → 按对端 x 排序
    const keyFor = (side: AnchorSide, other: { x: number; y: number }) =>
      side === 'left' || side === 'right' ? other.y : other.x
    push(e.source, 'source', src, { edgeId: e.id, type: 'source', key: keyFor(src, tc) })
    push(e.target, 'target', tgt, { edgeId: e.id, type: 'target', key: keyFor(tgt, sc) })
  }
  const out = new Map<string, EdgeAnchor[]>()
  for (const [node, bySide] of buckets) {
    const anchors: EdgeAnchor[] = []
    for (const [side, list] of bySide) {
      list.sort((a, z) => a.key - z.key)
      // 按对端位置排序，n 个锚点取 (i+1)/(n+1) 均布
      list.forEach((en, i) =>
        anchors.push({
          edgeId: en.edgeId,
          type: en.type,
          side,
          pct: ((i + 1) / (list.length + 1)) * 100,
        }),
      )
    }
    out.set(node, anchors)
  }
  return out
}

/** 自引用回环距表侧面的基础外扩距离；同节点多条自引用逐条再加步长堆叠 */
const SELF_LOOP_GAP = 26
const SELF_LOOP_STEP = 12

/**
 * 自引用边的自动锚点：两端（出/入）锚到同一侧面，位置对齐参与列的行——
 * 出端在外键列（如 parent_id）行高、入端在被引用列（如 category_id）行高，
 * ErEdge 据此在该侧折一个小回环（selfLoopVia），不再绕整张表一圈。
 * 侧面选该节点上其他边锚点较少的一侧（并列取右），避免与均布锚点挤在一起；
 * 列位置未知（表折叠/找不到列）时退回 66/34 落位。
 * @param selfEdges 自引用边（node + 参与列，列取列映射的第一列）
 * @param anchors  已算好的其他边锚点（assignEdgeAnchors 的产物），就地追加
 * @param colPctOf 列行位置（沿左/右面的百分比 0–100）；未知返回 null
 * @returns 每条自引用边的回环外扩距离（gap），随边 data 传给 ErEdge
 */
export function assignSelfLoops(
  selfEdges: { id: string; node: string; sourceColumn?: string; targetColumn?: string }[],
  anchors: Map<string, EdgeAnchor[]>,
  colPctOf: (nodeId: string, column?: string) => number | null,
): Record<string, number> {
  const gaps: Record<string, number> = {}
  const byNode = new Map<string, typeof selfEdges>()
  for (const e of selfEdges) {
    const g = byNode.get(e.node) ?? []
    g.push(e)
    byNode.set(e.node, g)
  }
  for (const [node, list] of byNode) {
    // 该节点左右面已有的锚点数（自引用自己不算），回环去少的那一侧
    let left = 0
    let right = 0
    for (const a of anchors.get(node) ?? []) {
      if (a.side === 'left') left++
      else if (a.side === 'right') right++
    }
    const side: AnchorSide = right <= left ? 'right' : 'left'
    list.forEach((e, i) => {
      const srcPct = colPctOf(node, e.sourceColumn) ?? 66
      const tgtPct = colPctOf(node, e.targetColumn) ?? 34
      const nodeAnchors = anchors.get(node) ?? []
      nodeAnchors.push(
        { edgeId: e.id, type: 'source', side, pct: srcPct },
        { edgeId: e.id, type: 'target', side, pct: tgtPct },
      )
      anchors.set(node, nodeAnchors)
      gaps[e.id] = SELF_LOOP_GAP + i * SELF_LOOP_STEP
    })
  }
  return gaps
}

/**
 * 自引用回环的途经点：从出端沿侧面向外折 gap、竖走一段、再折回入端，
 * 全程水平/垂直。dir 为外折方向（右侧面 +1、左侧面 -1），由 ErEdge 按
 * 实际端点坐标调用（保证回环与端点严格正交，不受节点尺寸估算误差影响）。
 */
export function selfLoopVia(
  src: { x: number; y: number },
  tgt: { x: number; y: number },
  dir: 1 | -1,
  gap: number,
): { x: number; y: number }[] {
  const bx = src.x + dir * gap
  return [
    { x: bx, y: src.y },
    { x: bx, y: tgt.y },
  ]
}

/**
 * 自动走线避障（无途经点的边）：把 smoothstep 折线的完整顶点（两端短段 + 中段）
 * 与膨胀后的节点矩形逐一求交，任何一段穿表都算撞。中线位置 c 是唯一自由度，
 * 候选取默认中点与各障碍侧缘 ± margin，选离默认最近的无交解；全部撞时维持
 * 车道不比现状差（此时可由 routeOrth 兜底改走侧边绕桥）。
 * @returns 中线的最终偏移（水平连接为 x 偏移、垂直连接为 y 偏移，已含传入的车道
 *          lane）。混合面（手动锚点拉出的斜连接）不做避障，原样返回 lane。
 */
export function avoidObstacleMid(
  src: Pt,
  tgt: Pt,
  srcSide: AnchorSide,
  tgtSide: AnchorSide,
  obstacles: ObRect[],
  opts?: { lane?: number; margin?: number },
): number {
  const lane = opts?.lane ?? 0
  const margin = opts?.margin ?? 14
  const horiz = (s: AnchorSide) => s === 'left' || s === 'right'
  const bothH = horiz(srcSide) && horiz(tgtSide)
  const bothV = !horiz(srcSide) && !horiz(tgtSide)
  if (!bothH && !bothV) return lane

  const base = bothH ? (src.x + tgt.x) / 2 : (src.y + tgt.y) / 2
  const want = base + lane
  const cands = new Set<number>([want])
  for (const o of obstacles) {
    if (bothH) {
      cands.add(o.x - margin)
      cands.add(o.x + o.width + margin)
    } else {
      cands.add(o.y - margin)
      cands.add(o.y + o.height + margin)
    }
  }
  // 离默认最近的候选优先（改动最小），全都不行就维持车道
  const best = [...cands]
    .filter((c) => !polyHits(zPoly(src, tgt, bothH, c), obstacles, margin))
    .sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0]
  return (best ?? want) - base
}

/**
 * 把手动锚点覆盖套到自动均布结果上：被覆盖的一端换成指定的面与位置，
 * 其余端保持自动。未知边 id / 未覆盖的端忽略。
 */
export function withAnchorOverrides(
  auto: Map<string, EdgeAnchor[]>,
  edges: { id: string; source: string; target: string }[],
  overrides: Record<string, { source?: AnchorOverride; target?: AnchorOverride }>,
): Map<string, EdgeAnchor[]> {
  if (Object.keys(overrides).length === 0) return auto
  const out = new Map<string, EdgeAnchor[]>()
  for (const [node, list] of auto) out.set(node, list.map((a) => ({ ...a })))
  for (const e of edges) {
    const o = overrides[e.id]
    if (!o) continue
    for (const type of ['source', 'target'] as const) {
      const ov = o[type]
      if (!ov) continue
      const node = type === 'source' ? e.source : e.target
      const anchor = out.get(node)?.find((a) => a.edgeId === e.id && a.type === type)
      if (anchor) {
        anchor.side = ov.side
        anchor.pct = ov.pos * 100
      }
    }
  }
  return out
}

/**
 * 指针位置投影到节点矩形边框：取「投影点」最近的面（对边所在线段取垂足/端点），
 * 落点钳在面内且离角 3% 以上（避免锚点正好压在转角）。
 * 返回面、沿面比例（0–1）与投影点画布坐标。
 */
export function projectToBorder(
  p: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): { side: AnchorSide; pos: number; x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const cx = clamp(p.x, rect.x, rect.x + rect.width)
  const cy = clamp(p.y, rect.y, rect.y + rect.height)
  const dist = (x: number, y: number) => Math.hypot(p.x - x, p.y - y)
  const candidates: { side: AnchorSide; d: number; pos: number }[] = [
    { side: 'left', d: dist(rect.x, cy), pos: (cy - rect.y) / rect.height },
    { side: 'right', d: dist(rect.x + rect.width, cy), pos: (cy - rect.y) / rect.height },
    { side: 'top', d: dist(cx, rect.y), pos: (cx - rect.x) / rect.width },
    { side: 'bottom', d: dist(cx, rect.y + rect.height), pos: (cx - rect.x) / rect.width },
  ]
  let best = candidates[0]
  for (const c of candidates) {
    if (c.d < best.d) best = c
  }
  const pos = clamp(Number.isFinite(best.pos) ? best.pos : 0.5, 0.03, 0.97)
  const x =
    best.side === 'left'
      ? rect.x
      : best.side === 'right'
        ? rect.x + rect.width
        : rect.x + pos * rect.width
  const y =
    best.side === 'top'
      ? rect.y
      : best.side === 'bottom'
        ? rect.y + rect.height
        : rect.y + pos * rect.height
  return { side: best.side, pos, x, y }
}

/**
 * 走廊车道分离：自动走线的中段落在同一走廊（坐标接近且跨度区间重叠）时，
 * 互不重合。与 assignEdgeLanes（按列带分组）互补——避障把不同列带的边挪到
 * 同一障碍边缘、垂直堆叠的边共享水平走廊等场景由这里兜底。
 * 区间图贪心着色：按跨度起点排序，与当前层都不重叠的边复用层，否则开新层；
 * 层内互不重叠可共用偏移，多层对称错开 gap。
 */
export function assignCorridorLanes(
  mids: { id: string; mid: number; lo: number; hi: number }[],
  opts?: { tol?: number; gap?: number },
): Record<string, number> {
  const tol = opts?.tol ?? 6
  const gap = opts?.gap ?? 6
  const out: Record<string, number> = {}
  for (const m of mids) out[m.id] = 0
  if (mids.length < 2) return out
  // 按中段坐标排序后聚类：相邻中段差 ≤ tol 视为同一走廊
  const sorted = [...mids].sort((a, b) => a.mid - b.mid)
  let cluster: typeof sorted = []
  const flush = () => {
    if (cluster.length < 2) {
      cluster = []
      return
    }
    // 区间图着色：按 lo 排序，各层维护已占用的 hi
    const byLo = [...cluster].sort((a, b) => a.lo - b.lo)
    const layerHi: number[] = []
    const layerOf = new Map<string, number>()
    for (const m of byLo) {
      let placed = false
      for (let i = 0; i < layerHi.length; i++) {
        if (m.lo > layerHi[i]) {
          layerHi[i] = m.hi
          layerOf.set(m.id, i)
          placed = true
          break
        }
      }
      if (!placed) {
        layerHi.push(m.hi)
        layerOf.set(m.id, layerHi.length - 1)
      }
    }
    if (layerHi.length < 2) {
      cluster = []
      return
    }
    // 多层才需要错开：层号对称映射到 ±gap（0 层不动）
    for (const [id, layer] of layerOf) {
      out[id] = (layer - (layerHi.length - 1) / 2) * gap
    }
    cluster = []
  }
  for (const m of sorted) {
    if (cluster.length > 0 && m.mid - cluster[cluster.length - 1].mid > tol) flush()
    cluster.push(m)
  }
  flush()
  return out
}

/**
 * 穿表的正交绕行桥：当前 Z 形走线（中段在含车道偏移的默认位置）被节点挡住时，
 * 改用途径点从障碍群的侧边整体绕过去——入口/出口缘按两端在障碍群哪一侧，
 * 绕行带（水平连接走上/下缘外、垂直连接走左/右缘外）优先取离两端中点更近的
 * 一侧，全程保持水平/垂直。两端同高/同列的共线情形是它的特例。
 * 桥本身仍撞其他表（侧面也放满了）时不硬绕，返回 null。
 */
export function orthBypassVia(
  src: Pt,
  tgt: Pt,
  srcSide: AnchorSide,
  tgtSide: AnchorSide,
  obstacles: ObRect[],
  opts?: { margin?: number; detour?: number; lane?: number },
): Pt[] | null {
  const margin = opts?.margin ?? 14
  const detour = opts?.detour ?? 10
  const horiz = (s: AnchorSide) => s === 'left' || s === 'right'
  const bothH = horiz(srcSide) && horiz(tgtSide)
  const bothV = !horiz(srcSide) && !horiz(tgtSide)
  if (!bothH && !bothV) return null

  // 挡住当前走线的障碍群（膨胀后与含车道偏移的 Z 形折线相交），取联合包围盒
  const base = bothH ? (src.x + tgt.x) / 2 : (src.y + tgt.y) / 2
  const cur = zPoly(src, tgt, bothH, base + (opts?.lane ?? 0))
  const blockers = obstacles.filter((o) => polyHits(cur, [o], margin))
  if (blockers.length === 0) return null
  const K = margin + detour
  const bx1 = Math.min(...blockers.map((o) => o.x - K))
  const bx2 = Math.max(...blockers.map((o) => o.x + o.width + K))
  const by1 = Math.min(...blockers.map((o) => o.y - K))
  const by2 = Math.max(...blockers.map((o) => o.y + o.height + K))
  const clear = (via: Pt[]) => !polyHits([src, ...via, tgt], obstacles, margin)

  if (bothH) {
    // 绕行带取离两端中点 y 更近的上/下缘外；入口/出口缘按两端在障碍群左/右侧
    const midY = (src.y + tgt.y) / 2
    const gcx = (bx1 + bx2) / 2
    const entryX = src.x <= gcx ? bx1 : bx2
    const exitX = tgt.x <= gcx ? bx1 : bx2
    for (const gy of [by1, by2].sort((a, b) => Math.abs(a - midY) - Math.abs(b - midY))) {
      const via = [
        { x: entryX, y: src.y },
        { x: entryX, y: gy },
        { x: exitX, y: gy },
        { x: exitX, y: tgt.y },
      ]
      if (clear(via)) return via
    }
    return null
  }
  // 垂直连接：绕行带取离两端中点 x 更近的左/右缘外；入口/出口带按上/下侧
  const midX = (src.x + tgt.x) / 2
  const gcy = (by1 + by2) / 2
  const entryY = src.y <= gcy ? by1 : by2
  const exitY = tgt.y <= gcy ? by1 : by2
  for (const gx of [bx1, bx2].sort((a, b) => Math.abs(a - midX) - Math.abs(b - midX))) {
    const via = [
      { x: src.x, y: entryY },
      { x: gx, y: entryY },
      { x: gx, y: exitY },
      { x: tgt.x, y: exitY },
    ]
    if (clear(via)) return via
  }
  return null
}

/**
 * 自动正交走线总入口：先走 avoidObstacleMid 的中段偏移；得到的路径仍穿表
 * （两端分列障碍上下/左右、区间都压在障碍带上，Z 形无论中段挪哪都无解）时，
 * 改用 orthBypassVia 的侧边绕桥整体绕过去，线不再从表背部穿越。
 * @returns via 非空时用桥（途经点链，lane 忽略）；否则用 lane 偏移走 Z 形
 */
export function routeOrth(
  src: Pt,
  tgt: Pt,
  srcSide: AnchorSide,
  tgtSide: AnchorSide,
  obstacles: ObRect[],
  opts?: { lane?: number; margin?: number; detour?: number },
): { lane: number; via: Pt[] | null } {
  const lane = avoidObstacleMid(src, tgt, srcSide, tgtSide, obstacles, opts)
  const via = orthBypassVia(src, tgt, srcSide, tgtSide, obstacles, { ...opts, lane })
  return via ? { lane, via } : { lane, via: null }
}

/**
 * 车道分离：穿过同一列间隙的多条自动走线，smoothstep 的中线默认都落在
 * 源/目标正中间，垂直段会重合分不清。按「源列带→目标列带」分组、组内按
 * 边 id 排序对称错开，返回每条边中线的偏移（flow 坐标，正往目标侧偏）。
 * 同列带内的边不参与（偏移 0）。边数多时收窄车道宽度，避免散出列间隙。
 */
export function assignEdgeLanes(
  edges: { id: string; source: string; target: string }[],
  nodeX: Record<string, number>,
  opts?: { bandTolerance?: number; laneWidth?: number },
): Record<string, number> {
  const bandTolerance = opts?.bandTolerance ?? 120
  const laneWidth = opts?.laneWidth ?? 12
  const out: Record<string, number> = {}
  // 节点 left x 聚类成列带：排序后相邻间隙超过 tolerance 就切一刀
  const xs = [...new Set(Object.values(nodeX))].sort((a, b) => a - b)
  const bandByX = new Map<number, number>()
  let band = 0
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && xs[i] - xs[i - 1] > bandTolerance) band++
    bandByX.set(xs[i], band)
  }
  const groups = new Map<string, string[]>()
  for (const e of edges) {
    out[e.id] = 0
    const bs = bandByX.get(nodeX[e.source])
    const bt = bandByX.get(nodeX[e.target])
    if (bs === undefined || bt === undefined || bs === bt) continue
    const key = `${bs}>${bt}`
    const g = groups.get(key) ?? []
    g.push(e.id)
    groups.set(key, g)
  }
  for (const g of groups.values()) {
    g.sort()
    const n = g.length
    const w = Math.min(laneWidth, 72 / Math.max(n - 1, 1))
    g.forEach((id, i) => {
      out[id] = (i - (n - 1) / 2) * w
    })
  }
  return out
}
