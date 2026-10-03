import dagre from '@dagrejs/dagre'

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutEdge {
  source: string
  target: string
}

/** 估算表节点尺寸（dagre 布局用）：固定宽，高按列数/折叠态估算 */
export function estimateNodeSize(columns: number, collapsed: boolean): { width: number; height: number } {
  const width = 260
  const header = 36
  if (collapsed) return { width, height: header }
  return { width, height: header + columns * 22 + 6 }
}

/** 度数达到该值的表视为枢纽，启用径向布局（居中 + 环绕） */
const RADIAL_HUB_MIN = 4

/**
 * 径向布局：枢纽表放正中，直接关联表绕它环形分布（四周），
 * 间接关联表挂在各自关联表的外侧（远离枢纽方向、沿切向找空位）。
 * 覆盖枢纽所在的整个连通分量；全部矩形经碰撞检测，两两不重叠。
 * 返回内容最大 y（供孤立节点/其余分量接续排布）。
 */
function radialLayout(
  hub: LayoutNode,
  nodes: LayoutNode[],
  adj: Map<string, string[]>,
  out: Record<string, { x: number; y: number }>,
): number {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  // BFS 分层：dist 0 = 枢纽，dist 1 = 直接关联，再往外逐层；parent 记录挂在哪张表下
  const dist = new Map<string, number>([[hub.id, 0]])
  const parent = new Map<string, string>()
  const queue = [hub.id]
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]
    for (const nb of adj.get(cur) ?? []) {
      if (!nodeById.has(nb) || dist.has(nb)) continue
      dist.set(nb, (dist.get(cur) ?? 0) + 1)
      parent.set(nb, cur)
      queue.push(nb)
    }
  }
  // 已放置矩形（左上角 + 宽高），碰撞检测与最终输出的依据
  const placedRects = new Map<string, { x: number; y: number; w: number; h: number }>()
  const MARGIN = 24 // 避让判定外扩的余量
  const STEP = 40
  const clashes = (r: { x: number; y: number; w: number; h: number }) => {
    for (const pr of placedRects.values()) {
      if (
        r.x < pr.x + pr.w + MARGIN &&
        pr.x < r.x + r.w + MARGIN &&
        r.y < pr.y + pr.h + MARGIN &&
        pr.y < r.y + r.h + MARGIN
      )
        return true
    }
    return false
  }
  const apply = (id: string, x: number, y: number) => {
    const n = nodeById.get(id)!
    placedRects.set(id, { x, y, w: n.width, h: n.height })
  }
  /** 沿一条轨道（固定 x 或 y 的左上角坐标，另一轴从扫描中心向两侧）找第一个空位 */
  const slotOnTrack = (
    n: LayoutNode,
    fixed: { x?: number; y?: number },
    centerOther: number,
  ): { x: number; y: number } | null => {
    for (let k = 0; k < 40; k++) {
      for (const s of k === 0 ? [0] : [1, -1]) {
        const off = centerOther + s * k * STEP
        const x = fixed.x !== undefined ? fixed.x : off - n.width / 2
        const y = fixed.y !== undefined ? fixed.y : off - n.height / 2
        if (!clashes({ x, y, w: n.width, h: n.height })) return { x, y }
      }
    }
    return null
  }

  // 枢纽放原点邻域（左上角 (0,0)），四周展开；坐标可为负，React Flow 支持
  apply(hub.id, 0, 0)
  const hubC = { x: hub.width / 2, y: hub.height / 2 }

  // 第一圈：直接关联表绕枢纽环形均匀分布。半径保证环上相邻表放得下，
  // 摆放时沿切向扫描避让（表高不一可能挤到）
  const ring1 = (adj.get(hub.id) ?? []).filter((id) => nodeById.has(id) && id !== hub.id)
  const R1 = Math.max(380, Math.ceil((ring1.length * 310) / (2 * Math.PI)))
  ring1.forEach((id, i) => {
    const nd = nodeById.get(id)!
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / ring1.length
    const cx = hubC.x + Math.cos(ang) * R1
    const cy = hubC.y + Math.sin(ang) * R1
    // 固定径向主轴、沿切向扫描空位
    const vertical = Math.abs(Math.cos(ang)) >= Math.abs(Math.sin(ang))
    const slot = vertical
      ? slotOnTrack(nd, { x: cx - nd.width / 2 }, cy)
      : slotOnTrack(nd, { y: cy - nd.height / 2 }, cx)
    const p = slot ?? { x: cx - nd.width / 2, y: cy - nd.height / 2 }
    apply(id, p.x, p.y)
  })

  // 第二圈起：间接关联表挂在各自 parent 的左右/上下（绝对四方向、水平优先）——
  // 与 parent 水平/垂直对齐时连线是直线、拐弯最少；优先远离枢纽的一侧，
  // 同方向的多个下挂表沿垂直方向排开；放不下退到更远一圈再扫
  const R_STEP = 350
  const deeper = nodes
    .filter((n) => (dist.get(n.id) ?? 9) >= 2)
    .sort(
      (a, b) =>
        (dist.get(a.id) ?? 9) - (dist.get(b.id) ?? 9) ||
        (adj.get(b.id)?.length ?? 0) - (adj.get(a.id)?.length ?? 0),
    )
  for (const nd of deeper) {
    const pid = parent.get(nd.id)
    const pr = pid ? placedRects.get(pid) : undefined
    if (!pr) continue
    const pcx = pr.x + pr.w / 2
    const pcy = pr.y + pr.h / 2
    const dirs: { x: number; y: number }[] = [
      { x: pcx >= hubC.x ? 1 : -1, y: 0 },
      { x: pcx >= hubC.x ? -1 : 1, y: 0 },
      { x: 0, y: pcy >= hubC.y ? 1 : -1 },
      { x: 0, y: pcy >= hubC.y ? -1 : 1 },
    ]
    let placed = false
    for (const step of [R_STEP, R_STEP * 1.8]) {
      for (const d of dirs) {
        const bx = pcx + d.x * step
        const by = pcy + d.y * step
        const slot =
          d.x !== 0
            ? slotOnTrack(nd, { x: bx - nd.width / 2 }, by)
            : slotOnTrack(nd, { y: by - nd.height / 2 }, bx)
        if (slot) {
          apply(nd.id, slot.x, slot.y)
          placed = true
          break
        }
      }
      if (placed) break
    }
    if (!placed) {
      // 全方向都放不下（极端拥挤）：贴第一方向的远圈基础位兜底
      apply(nd.id, pcx + dirs[0].x * R_STEP - nd.width / 2, pcy - nd.height / 2)
    }
  }

  let maxY = 0
  for (const [id, r] of placedRects) {
    out[id] = { x: r.x, y: r.y }
    maxY = Math.max(maxY, r.y + r.h)
  }
  return maxY
}

/** 连通分量划分：有边相连的表归为一组。
 *  按分量内最高度数、边数、节点数降序——最高度数的枢纽所在分量排最前（主分量） */
function splitComponents(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): { nodes: LayoutNode[]; edges: LayoutEdge[] }[] {
  const degree: Record<string, number> = {}
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    degree[e.source] = (degree[e.source] ?? 0) + 1
    degree[e.target] = (degree[e.target] ?? 0) + 1
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const comps: { nodes: LayoutNode[]; edges: LayoutEdge[]; maxDeg: number }[] = []
  for (const n of nodes) {
    if (seen.has(n.id)) continue
    const group: LayoutNode[] = []
    const queue = [n.id]
    seen.add(n.id)
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]
      const cn = nodeById.get(cur)
      if (cn) group.push(cn)
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb) || !nodeById.has(nb)) continue
        seen.add(nb)
        queue.push(nb)
      }
    }
    const ids = new Set(group.map((g) => g.id))
    comps.push({
      nodes: group,
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      maxDeg: Math.max(0, ...group.map((g) => degree[g.id] ?? 0)),
    })
  }
  return comps.sort(
    (a, b) =>
      b.maxDeg - a.maxDeg || b.edges.length - a.edges.length || b.nodes.length - a.nodes.length,
  )
}

/** dagre 层次布局（LR：引用方在左、被引用方在右）+ 径向枢纽 + 密度间距 + 分量展示区 + 孤立节点网格。
 *  - 度数最高且 ≥4 的枢纽表：径向布局——放正中、直接关联表绕四周、
 *    间接关联表挂各自关联表的外侧左右展开
 *  - 没有这样的枢纽时：dagre 层次布局，列间隙穿越的连线多时自动加宽列间距，
 *    平行车道线有地方散开、不挤成一团；列内按度数居中
 *  - 互不相连的独立分量各占单独展示区：主分量在上，其余分量各自单独布局后
 *    装箱到主区域下方（行内水平排开、超宽换行），块间距远大于连线的出界量，
 *    任何分量的连线都不会穿过别的分量的表
 *  - 无边的孤立节点 dagre 会全部排进同一层，几十张表会拉成一条几万像素宽的长队，
 *    既放不进视野也没法导航——孤立节点改排成 √n 列的网格，放在层次区域下方 */
export function dagreLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Record<string, { x: number; y: number }> {
  const touched = new Set(edges.flatMap((e) => [e.source, e.target]))
  const connected = nodes.filter((n) => touched.has(n.id))
  const isolated = nodes.filter((n) => !touched.has(n.id))

  const out: Record<string, { x: number; y: number }> = {}
  let contentMaxY = 0
  const comps = splitComponents(connected, edges)
  if (comps.length > 1) {
    // 多个独立分量：主分量单独布局在上；其余分量装箱到下方的独立展示区
    const sizeOf = new Map(nodes.map((n) => [n.id, n]))
    /** 布局结果归一到 (0,0) 并计算包围盒（装箱需要） */
    const packOf = (positions: Record<string, { x: number; y: number }>) => {
      const vals = Object.values(positions)
      const minX = Math.min(...vals.map((p) => p.x))
      const minY = Math.min(...vals.map((p) => p.y))
      const norm: typeof positions = {}
      let w = 0
      let h = 0
      for (const [id, p] of Object.entries(positions)) {
        norm[id] = { x: p.x - minX, y: p.y - minY }
        const nd = sizeOf.get(id)!
        w = Math.max(w, norm[id].x + nd.width)
        h = Math.max(h, norm[id].y + nd.height)
      }
      return { norm, w, h }
    }
    const main = packOf(dagreLayout(comps[0].nodes, comps[0].edges))
    Object.assign(out, main.norm)
    contentMaxY = main.h
    // 行内水平排开、累计宽度超过主分量宽度（或 1560）换行；块间距保证连线互不靠近
    const GAP_X = 220
    const GAP_Y = 240
    const ROW_LIMIT = Math.max(1560, main.w)
    let x = 0
    let y = contentMaxY + 260
    let rowH = 0
    for (const comp of comps.slice(1)) {
      const blk = packOf(dagreLayout(comp.nodes, comp.edges))
      if (x > 0 && x + blk.w > ROW_LIMIT) {
        x = 0
        y += rowH + GAP_Y
        rowH = 0
      }
      for (const [id, p] of Object.entries(blk.norm)) out[id] = { x: x + p.x, y: y + p.y }
      x += blk.w + GAP_X
      rowH = Math.max(rowH, blk.h)
    }
    contentMaxY = Math.max(contentMaxY, y + rowH)
  } else if (comps.length === 1) {
    const degree: Record<string, number> = {}
    const adj = new Map<string, string[]>()
    for (const e of edges) {
      degree[e.source] = (degree[e.source] ?? 0) + 1
      degree[e.target] = (degree[e.target] ?? 0) + 1
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target])
      adj.set(e.target, [...(adj.get(e.target) ?? []), e.source])
    }

    const mainHub = [...connected].sort((a, b) => (degree[b.id] ?? 0) - (degree[a.id] ?? 0))[0]
    if (mainHub && (degree[mainHub.id] ?? 0) >= RADIAL_HUB_MIN) {
      contentMaxY = radialLayout(mainHub, connected, adj, out)
    } else {
      const g = new dagre.graphlib.Graph()
      const NODESEP = 40
      g.setGraph({ rankdir: 'LR', nodesep: NODESEP, ranksep: 120, marginx: 40, marginy: 40 })
      g.setDefaultEdgeLabel(() => ({}))
      for (const n of connected) g.setNode(n.id, { width: n.width, height: n.height })
      for (const e of edges) g.setEdge(e.source, e.target)
      dagre.layout(g)

      // 第一次布局已定列结构（rank 不随间距变化）：按 x 聚列，统计每个列间隙
      // 被多少条连线穿越，最密的间隙决定加宽幅度（车道线约 12px 一条）
      const colOf = new Map<string, number>()
      const colXs = [...new Set(connected.map((n) => Math.round(g.node(n.id).x)))].sort(
        (a, b) => a - b,
      )
      for (const n of connected) {
        let best = 0
        for (let i = 1; i < colXs.length; i++) {
          if (Math.abs(colXs[i] - g.node(n.id).x) < Math.abs(colXs[best] - g.node(n.id).x)) best = i
        }
        colOf.set(n.id, best)
      }
      const crossing = new Map<number, number>()
      for (const e of edges) {
        const a = colOf.get(e.source) ?? 0
        const b = colOf.get(e.target) ?? 0
        for (let c = Math.min(a, b); c < Math.max(a, b); c++) {
          crossing.set(c, (crossing.get(c) ?? 0) + 1)
        }
      }
      const maxCrossing = Math.max(0, ...crossing.values())
      if (maxCrossing > 3) {
        const extra = Math.min((maxCrossing - 3) * 14, 160)
        g.setGraph({
          rankdir: 'LR',
          nodesep: NODESEP + Math.round(extra / 2),
          ranksep: 120 + extra,
          marginx: 40,
          marginy: 40,
        })
        dagre.layout(g)
      }

      // 每列内重排：度数降序，从列的垂直中部向上下交替展开（枢纽居中被围着）。
      // 第二次布局只是拉开间距，节点归属哪一列（rank）不变，colOf 仍有效
      const byCol = new Map<number, LayoutNode[]>()
      for (const n of connected) {
        const key = colOf.get(n.id) ?? 0
        byCol.set(key, [...(byCol.get(key) ?? []), n])
      }
      for (const list of byCol.values()) {
        if (list.length < 3) continue
        const ordered = [...list].sort((a, b) => (degree[b.id] ?? 0) - (degree[a.id] ?? 0))
        // 放置槽位序：正中 → 上 → 下 → 再上 → 再下……
        const n = ordered.length
        const mid = Math.floor((n - 1) / 2)
        const slots: number[] = [mid]
        for (let k = 1; slots.length < n; k++) {
          if (mid - k >= 0) slots.push(mid - k)
          if (mid + k < n) slots.push(mid + k)
        }
        const placed: LayoutNode[] = new Array(n)
        ordered.forEach((node, i) => {
          placed[slots[i]] = node
        })
        // 槽位序重排后紧凑堆叠（列内集合不变，总高不变，只调垂直顺序）
        const top = Math.min(...list.map((nd) => g.node(nd.id).y - nd.height / 2))
        let y = top
        for (const node of placed) {
          g.node(node.id).y = y + node.height / 2
          y += node.height + NODESEP
        }
      }

      for (const n of connected) {
        const node = g.node(n.id)
        // dagre 给的是中心点，React Flow 要左上角
        out[n.id] = { x: node.x - n.width / 2, y: node.y - n.height / 2 }
        contentMaxY = Math.max(contentMaxY, out[n.id].y + n.height)
      }
    }
  }

  if (isolated.length > 0) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(isolated.length)))
    const gapX = 60
    const gapY = 60
    const margin = 40
    let y = connected.length > 0 ? contentMaxY + 120 : margin
    let rowHeight = 0
    isolated.forEach((n, i) => {
      const col = i % cols
      out[n.id] = { x: margin + col * (n.width + gapX), y }
      rowHeight = Math.max(rowHeight, n.height)
      if (col === cols - 1 || i === isolated.length - 1) {
        y += rowHeight + gapY
        rowHeight = 0
      }
    })
  }
  return out
}
