/** 连线路径工具：带圆角的折线路径、最近线段投影。均为纯函数，便于单测 */

type Pt = { x: number; y: number }

const fmt = (n: number) => {
  // 避免浮点尾数进入 path（如 89.999999），同时保留一位以内精度
  const r = Math.round(n * 100) / 100
  return Object.is(r, -0) ? 0 : r
}

/**
 * 带圆角的折线 SVG path：每段直线，中间拐角用二次贝塞尔过渡。
 * 拐角半径不超过相邻两段长度的一半（短段自动收缩）；共线的中间点直接通过。
 */
export function smoothPolylinePath(points: Pt[], radius = 12): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${fmt(points[0].x)} ${fmt(points[0].y)}`
  if (points.length === 2) {
    return `M ${fmt(points[0].x)} ${fmt(points[0].y)} L ${fmt(points[1].x)} ${fmt(points[1].y)}`
  }
  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const next = points[i + 1]
    const v1x = cur.x - prev.x
    const v1y = cur.y - prev.y
    const v2x = next.x - cur.x
    const v2y = next.y - cur.y
    const len1 = Math.hypot(v1x, v1y)
    const len2 = Math.hypot(v2x, v2y)
    if (len1 < 1e-6 || len2 < 1e-6) continue
    const cross = v1x * v2y - v1y * v2x
    const r = Math.min(radius, len1 / 2, len2 / 2)
    if (Math.abs(cross) < 1e-6 || r < 0.5) {
      // 共线（含回头）或拐角过小：直接连到拐点
      d += ` L ${fmt(cur.x)} ${fmt(cur.y)}`
      continue
    }
    // 拐角两侧各退 r 作为圆角起止点，贝塞尔控制点即拐点
    const p1x = cur.x - (v1x / len1) * r
    const p1y = cur.y - (v1y / len1) * r
    const p2x = cur.x + (v2x / len2) * r
    const p2y = cur.y + (v2y / len2) * r
    d += ` L ${fmt(p1x)} ${fmt(p1y)} Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(p2x)} ${fmt(p2y)}`
  }
  const last = points[points.length - 1]
  return `${d} L ${fmt(last.x)} ${fmt(last.y)}`
}

/** 点到线段的最短距离点（投影钳在段内） */
function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const len2 = abx * abx + aby * aby
  if (len2 < 1e-12) return { x: a.x, y: a.y }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2
  t = Math.min(1, Math.max(0, t))
  return { x: a.x + abx * t, y: a.y + aby * t }
}

/**
 * 折线链中距 p 最近的线段：返回段下标（第 i 段 = chain[i]→chain[i+1]）与投影点。
 * 用于「按住连线任意位置拖出调整点」时决定新点插入位置。
 */
export function nearestSegment(p: Pt, chain: Pt[]): { index: number; point: Pt } {
  let best = { index: 0, point: chain[0], d: Number.POSITIVE_INFINITY }
  for (let i = 0; i < chain.length - 1; i++) {
    const q = closestOnSegment(p, chain[i], chain[i + 1])
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d < best.d) best = { index: i, point: q, d }
  }
  return { index: best.index, point: { x: best.point.x, y: best.point.y } }
}

/**
 * 拉直后自动消点：途经点与前后点（含两端端点）接近共线（点到其连线距离 ≤ tol）
 * 时移除该点，迭代到不动点（级联共线也清干净）。全部共线返回 []——正好恢复自动走线。
 * 返回简化后的途经点（不含端点）。
 */
export function simplifyCollinear(
  pts: Pt[],
  ends: [Pt, Pt],
  tol = 0.75,
): Pt[] {
  if (pts.length === 0) return pts
  const chain = [ends[0], ...pts, ends[1]]
  let changed = true
  while (changed) {
    changed = false
    for (let i = 1; i < chain.length - 1; i++) {
      const q = closestOnSegment(chain[i], chain[i - 1], chain[i + 1])
      if (Math.hypot(chain[i].x - q.x, chain[i].y - q.y) <= tol) {
        chain.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return chain.slice(1, -1)
}

export interface SnapResult {
  /** 吸附后的点（未发生吸附时与入参相同） */
  point: Pt
  /** 垂直引导线所在 x（x 轴发生吸附时存在） */
  guideX?: number
  /** 水平引导线所在 y（y 轴发生吸附时存在） */
  guideY?: number
}

/**
 * 智能对齐吸附：p 与任一参考点在某一轴上的距离严格小于 threshold 时，
 * 该轴吸附到最近的参考点，并报告对应引导线位置。两个轴独立判断。
 */
export function snapToGuides(p: Pt, refs: Pt[], threshold: number): SnapResult {
  let bestX: { x: number; d: number } | null = null
  let bestY: { y: number; d: number } | null = null
  for (const r of refs) {
    const dx = Math.abs(p.x - r.x)
    if (dx < threshold && (!bestX || dx < bestX.d)) bestX = { x: r.x, d: dx }
    const dy = Math.abs(p.y - r.y)
    if (dy < threshold && (!bestY || dy < bestY.d)) bestY = { y: r.y, d: dy }
  }
  return {
    point: { x: bestX ? bestX.x : p.x, y: bestY ? bestY.y : p.y },
    guideX: bestX?.x,
    guideY: bestY?.y,
  }
}

/**
 * 途经点链正交化：手动拖出的途经点可落在任意位置，相邻点直连会产生斜段——
 * 渲染前把每段拆成 L 形（水平 + 垂直），连线全程只走水平/垂直。
 * 首段沿 srcHoriz 指定的轴离开起点、末段沿 tgtHoriz 指定的轴进入终点
 * （与锚点所在面一致，线不斜着出表）；中间段轴交替（真拐弯），进出同轴时
 * 中点双拐。已是水平/垂直的段原样通过，原始点本身不动、只插拐点。
 * @param chain 端点 + 途经点（原始数据链，随模型文档保存）
 * @param srcHoriz 起点是否从水平方向（左/右面）出
 * @param tgtHoriz 终点是否从水平方向（左/右面）入
 * @returns pts 正交化后的折线；segStart 原始点 i 在 pts 中的下标
 *          （段中点手柄据此定位到正交化后的真实线段上）
 */
export function orthogonalizeChain(
  chain: Pt[],
  srcHoriz: boolean,
  tgtHoriz: boolean,
): { pts: Pt[]; segStart: number[] } {
  const pts: Pt[] = chain.length > 0 ? [chain[0]] : []
  const segStart: number[] = new Array(chain.length)
  if (chain.length > 0) segStart[0] = 0
  // entryH：上一段结束时的轴向（true = 水平），决定当前段先走哪个轴
  let entryH = srcHoriz
  for (let i = 1; i < chain.length; i++) {
    const a = pts[pts.length - 1]
    const b = chain[i]
    // 中间段轴交替（真拐弯）；末段按目标锚点面收尾
    const exitH = i === chain.length - 1 ? tgtHoriz : !entryH
    if (a.y === b.y || a.x === b.x) {
      // 已水平/已垂直：直通，轴向按实际更新
      entryH = a.y === b.y
    } else if (entryH && exitH) {
      // 水平进水平出：中点双拐（横-竖-横）
      const mx = (a.x + b.x) / 2
      pts.push({ x: mx, y: a.y }, { x: mx, y: b.y })
    } else if (!entryH && !exitH) {
      // 垂直进垂直出：中点双拐（竖-横-竖）
      const my = (a.y + b.y) / 2
      pts.push({ x: a.x, y: my }, { x: b.x, y: my })
    } else if (entryH) {
      // 先横后竖
      pts.push({ x: b.x, y: a.y })
      entryH = false
    } else {
      // 先竖后横
      pts.push({ x: a.x, y: b.y })
      entryH = true
    }
    // 原始点 b 落在正交化链中的下标（拐点之后）
    segStart[i] = pts.length
    pts.push(b)
  }
  return { pts, segStart }
}
