import { describe, expect, it } from 'vitest'

import { dagreLayout } from './layout'

describe('dagreLayout：层次自动布局', () => {
  const nodes = [
    { id: 'a', width: 240, height: 160 },
    { id: 'b', width: 240, height: 120 },
    { id: 'c', width: 240, height: 200 },
  ]
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
  ]

  it('所有节点都拿到有限坐标', () => {
    const pos = dagreLayout(nodes, edges)
    for (const n of nodes) {
      expect(Number.isFinite(pos[n.id].x)).toBe(true)
      expect(Number.isFinite(pos[n.id].y)).toBe(true)
    }
  })

  it('LR 方向：引用方在左、被引用方在右（与行级左右连接点同向）', () => {
    const pos = dagreLayout(nodes, edges)
    expect(pos['a'].x).toBeLessThan(pos['b'].x)
    expect(pos['a'].x).toBeLessThan(pos['c'].x)
  })

  it('无边的孤立节点也有坐标', () => {
    const pos = dagreLayout([...nodes, { id: 'lonely', width: 100, height: 80 }], edges)
    expect(Number.isFinite(pos['lonely'].x)).toBe(true)
  })
})

describe('无边图：孤立节点排成网格而非单行', () => {
  const iso = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, width: 260, height: 500 }))

  it('62 个无边节点形成多行网格，宽度远小于单行', () => {
    const pos = dagreLayout(iso(62), [])
    const ys = new Set(Object.values(pos).map((p) => p.y))
    // 单行会让所有 y 相同；网格应有多个行
    expect(ys.size).toBeGreaterThan(1)
    // 单行宽度约 62×320≈19840；网格（≈8 列）宽度应远小于此
    const maxX = Math.max(...Object.values(pos).map((p) => p.x))
    expect(maxX).toBeLessThan(3000)
  })

  it('所有孤立节点坐标有限且互不重叠起点', () => {
    const pos = dagreLayout(iso(10), [])
    const keys = Object.keys(pos)
    expect(keys).toHaveLength(10)
    const distinct = new Set(keys.map((k) => `${pos[k].x},${pos[k].y}`))
    expect(distinct.size).toBe(10)
  })

  it('混合图：孤立节点排在 dagre 层次区域下方，不打散层次布局', () => {
    const pos = dagreLayout(
      [
        { id: 'a', width: 240, height: 100 },
        { id: 'b', width: 240, height: 100 },
        { id: 'x', width: 260, height: 500 },
        { id: 'y', width: 260, height: 300 },
      ],
      [{ source: 'a', target: 'b' }],
    )
    // 层次关系保持（LR：a 在 b 左侧）
    expect(pos['a'].x).toBeLessThan(pos['b'].x)
    // 孤立节点整体在层次区域下方
    expect(pos['x'].y).toBeGreaterThan(pos['b'].y)
    expect(pos['y'].y).toBeGreaterThanOrEqual(pos['x'].y)
  })
})

describe('枢纽表居中与连线密度间距', () => {
  const w = { width: 240, height: 100 }

  it('度数最高的枢纽表放正中，直接关联表环绕四周', () => {
    // hub 连 5 张表（度 5），p/q 各连 1 张
    const nodes = [
      { id: 'hub', ...w },
      { id: 'p', ...w },
      { id: 'q', ...w },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, ...w })),
    ]
    const edges = [
      ...Array.from({ length: 5 }, (_, i) => ({ source: 'hub', target: `x${i}` })),
      { source: 'p', target: 'x0' },
      { source: 'q', target: 'x1' },
    ]
    const pos = dagreLayout(nodes, edges)
    const hc = { x: pos['hub'].x + w.width / 2, y: pos['hub'].y + w.height / 2 }
    const centers = nodes
      .filter((n) => n.id !== 'hub')
      .map((n) => ({ x: pos[n.id].x + w.width / 2, y: pos[n.id].y + w.height / 2 }))
    // hub 被围着：邻居中既有在它左侧的、也有在它右侧的
    expect(centers.some((c) => c.x < hc.x)).toBe(true)
    expect(centers.some((c) => c.x > hc.x)).toBe(true)
    // 每个邻居都贴着 hub（一两圈内），没有隔空长连
    for (const c of centers) {
      expect(Math.hypot(c.x - hc.x, c.y - hc.y)).toBeLessThan(1000)
    }
    // hub 不与任何邻居重叠
    for (const n of nodes.filter((n) => n.id !== 'hub')) {
      const overlap =
        pos['hub'].x < pos[n.id].x + w.width &&
        pos[n.id].x < pos['hub'].x + w.width &&
        pos['hub'].y < pos[n.id].y + w.height &&
        pos[n.id].y < pos['hub'].y + w.height
      expect(overlap).toBe(false)
    }
  })

  it('列间隙穿越的线多时，列间距自动加宽（车道线有地方散开）', () => {
    // 3×3 双部图（度 3，不触发枢纽围绕）：9 条线全挤一个列间隙
    const denseNodes = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `l${i}`, ...w })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, ...w })),
    ]
    const denseEdges = denseNodes.flatMap((l) =>
      l.id.startsWith('l') ? Array.from({ length: 3 }, (_, j) => ({ source: l.id, target: `r${j}` })) : [],
    )
    const dense = dagreLayout(denseNodes, denseEdges)
    // 单边对照
    const sparse = dagreLayout([{ id: 'a', ...w }, { id: 'b', ...w }], [
      { source: 'a', target: 'b' },
    ])
    const gapOf = (from: string, to: string, pos: Record<string, { x: number; y: number }>) =>
      pos[to].x - pos[from].x - w.width
    expect(gapOf('l0', 'r0', dense)).toBeGreaterThan(gapOf('a', 'b', sparse) + 40)
  })
})

describe('枢纽围绕：简单关系的表贴近枢纽四周', () => {
  const w = { width: 240, height: 100 }
  const leaves = Array.from({ length: 7 }, (_, i) => ({ id: `leaf${i}`, ...w }))

  it('度 1 的表环绕在枢纽四周，不再隔空长连', () => {
    const nodes = [{ id: 'hub', ...w }, ...leaves, { id: 'o0', ...w }, { id: 'o1', ...w }]
    const edges = [
      ...leaves.map((l) => ({ source: l.id, target: 'hub' })),
      { source: 'hub', target: 'o0' },
      { source: 'hub', target: 'o1' },
    ]
    const pos = dagreLayout(nodes, edges)
    const hc = { x: pos['hub'].x + w.width / 2, y: pos['hub'].y + w.height / 2 }
    const centers = [...leaves.map((l) => l.id), 'o0', 'o1'].map((id) => ({
      x: pos[id].x + w.width / 2,
      y: pos[id].y + w.height / 2,
    }))
    // 环绕：左右两侧、上下两侧都有邻居（不是排成一条线）
    expect(centers.some((c) => c.x < hc.x)).toBe(true)
    expect(centers.some((c) => c.x > hc.x)).toBe(true)
    expect(centers.some((c) => c.y < hc.y)).toBe(true)
    expect(centers.some((c) => c.y > hc.y)).toBe(true)
    // 全部简单关系表贴近枢纽（就在旁边一两圈内）
    for (const c of centers) {
      expect(Math.hypot(c.x - hc.x, c.y - hc.y)).toBeLessThan(700)
    }
  })

  it('间接关联表挂在直接关联表的左右（水平对齐、连线少拐弯、离枢纽更远）', () => {
    // hub 度 4；a 是直接邻居，b 只与 a 关联（挂在 a 的左右一侧）
    const nodes = [
      { id: 'hub', ...w },
      { id: 'a', ...w },
      { id: 'b', ...w },
      { id: 'c', ...w },
      { id: 'd', ...w },
      { id: 'e', ...w },
    ]
    const edges = [
      { source: 'hub', target: 'a' },
      { source: 'hub', target: 'c' },
      { source: 'hub', target: 'd' },
      { source: 'hub', target: 'e' },
      { source: 'a', target: 'b' },
    ]
    const pos = dagreLayout(nodes, edges)
    const hc = { x: pos['hub'].x + w.width / 2, y: pos['hub'].y + w.height / 2 }
    const dc = (id: string) =>
      Math.hypot(pos[id].x + w.width / 2 - hc.x, pos[id].y + w.height / 2 - hc.y)
    expect(dc('b')).toBeGreaterThan(dc('a'))
    // b 与 a 水平对齐（a→b 是水平直线，没有拐弯）
    expect(Math.abs(pos['b'].y - pos['a'].y)).toBeLessThan(0.5)
    // b 就在 a 旁边（不与 a、hub 重叠）
    const overlap = (p: string, q: string) =>
      pos[p].x < pos[q].x + w.width &&
      pos[q].x < pos[p].x + w.width &&
      pos[p].y < pos[q].y + w.height &&
      pos[q].y < pos[p].y + w.height
    expect(overlap('b', 'a')).toBe(false)
    expect(overlap('b', 'hub')).toBe(false)
  })

  it('混合图：围绕摆放后节点两两不重叠', () => {
    const nodes = [
      { id: 'hub', ...w },
      ...leaves,
      // 一段与枢纽无关的层次链，考验避让
      { id: 'm1', ...w },
      { id: 'm2', ...w },
      { id: 'm3', ...w },
    ]
    const edges = [
      ...leaves.map((l) => ({ source: l.id, target: 'hub' })),
      { source: 'm1', target: 'm2' },
      { source: 'm2', target: 'm3' },
      { source: 'm1', target: 'hub' },
    ]
    const pos = dagreLayout(nodes, edges)
    const rects = nodes.map((n) => ({ ...pos[n.id], w: n.width, h: n.height }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlapNow = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlapNow).toBe(false)
      }
    }
  })

  it('大图径向布局：两两不重叠且包围盒有限', () => {
    // hub 度 12，每个直接邻居再挂 1–2 个二级表，共 43 节点
    const ring1 = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, ...w }))
    const ring2 = ring1.flatMap((n, i) =>
      Array.from({ length: (i % 2) + 1 }, (_, j) => ({ id: `${n.id}_c${j}`, ...w })),
    )
    const nodes = [{ id: 'hub', ...w }, ...ring1, ...ring2]
    const edges = [
      ...ring1.map((n) => ({ source: 'hub', target: n.id })),
      ...ring2.map((c) => ({ source: c.id.split('_')[0], target: c.id })),
    ]
    const pos = dagreLayout(nodes, edges)
    const rects = nodes.map((n) => ({ ...pos[n.id], w: n.width, h: n.height }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlapNow = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlapNow).toBe(false)
      }
    }
    const maxX = Math.max(...rects.map((r) => r.x + r.w))
    const maxY = Math.max(...rects.map((r) => r.y + r.h))
    expect(maxX).toBeLessThan(5200)
    expect(maxY).toBeLessThan(5200)
  })
})

describe('独立连通分量：各占单独展示区', () => {
  const w = { width: 240, height: 100 }
  /** 分量内所有表的膨胀包围盒（外扩 80 容纳回环/避障绕行的出界量） */
  const bboxOf =
    (pos: Record<string, { x: number; y: number }>) =>
    (ids: string[]) => ({
      x1: Math.min(...ids.map((id) => pos[id].x)) - 80,
      y1: Math.min(...ids.map((id) => pos[id].y)) - 80,
      x2: Math.max(...ids.map((id) => pos[id].x + w.width)) + 80,
      y2: Math.max(...ids.map((id) => pos[id].y + w.height)) + 80,
    })
  const disjoint = (
    p: { x1: number; y1: number; x2: number; y2: number },
    q: { x1: number; y1: number; x2: number; y2: number },
  ) => p.x2 < q.x1 || q.x2 < p.x1 || p.y2 < q.y1 || q.y2 < p.y1

  it('枢纽图之外的独立分量分开布局，膨胀包围盒两两不相交', () => {
    const nodes = [
      { id: 'hub', ...w },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, ...w })),
      { id: 'a1', ...w },
      { id: 'a2', ...w },
      { id: 'b1', ...w },
      { id: 'b2', ...w },
    ]
    const edges = [
      ...Array.from({ length: 4 }, (_, i) => ({ source: `x${i}`, target: 'hub' })),
      { source: 'a1', target: 'a2' },
      { source: 'b1', target: 'b2' },
    ]
    const pos = dagreLayout(nodes, edges)
    const box = bboxOf(pos)
    const A = box(['hub', 'x0', 'x1', 'x2', 'x3'])
    const B = box(['a1', 'a2'])
    const C = box(['b1', 'b2'])
    expect(disjoint(A, B)).toBe(true)
    expect(disjoint(A, C)).toBe(true)
    expect(disjoint(B, C)).toBe(true)
  })

  it('独立分量排在主分量下方，小分量同行水平排开', () => {
    const nodes = [
      { id: 'hub', ...w },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, ...w })),
      { id: 'a1', ...w },
      { id: 'a2', ...w },
      { id: 'b1', ...w },
      { id: 'b2', ...w },
    ]
    const edges = [
      ...Array.from({ length: 4 }, (_, i) => ({ source: `x${i}`, target: 'hub' })),
      { source: 'a1', target: 'a2' },
      { source: 'b1', target: 'b2' },
    ]
    const pos = dagreLayout(nodes, edges)
    const mainMaxY = Math.max(...['hub', 'x0', 'x1', 'x2', 'x3'].map((id) => pos[id].y + w.height))
    const rowA = Math.min(pos['a1'].y, pos['a2'].y)
    const rowB = Math.min(pos['b1'].y, pos['b2'].y)
    expect(rowA).toBeGreaterThan(mainMaxY)
    expect(rowB).toBeGreaterThan(mainMaxY)
    // 两个小分量同一行、水平方向分开（各占一块）
    expect(Math.abs(rowA - rowB)).toBeLessThan(1)
    expect(Math.min(pos['b1'].x, pos['b2'].x) - Math.max(pos['a1'].x, pos['a2'].x)).toBeGreaterThan(
      100,
    )
  })

  it('无枢纽时多个独立分量也各占一块（不混进同一层次图）', () => {
    const nodes = ['c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ id, ...w }))
    const edges = [
      { source: 'c', target: 'd' },
      { source: 'e', target: 'f' },
      { source: 'g', target: 'h' },
    ]
    const pos = dagreLayout(nodes, edges)
    const box = bboxOf(pos)
    const A = box(['c', 'd'])
    const B = box(['e', 'f'])
    const C = box(['g', 'h'])
    expect(disjoint(A, B)).toBe(true)
    expect(disjoint(A, C)).toBe(true)
    expect(disjoint(B, C)).toBe(true)
  })
})
