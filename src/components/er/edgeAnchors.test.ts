import { describe, expect, it } from 'vitest'

import {
  assignCorridorLanes,
  assignEdgeAnchors,
  assignEdgeLanes,
  assignSelfLoops,
  avoidObstacleMid,
  orthBypassVia,
  projectToBorder,
  routeOrth,
  selfLoopVia,
  withAnchorOverrides,
  type EdgeAnchor,
} from './edgeAnchors'

type Rect = { x: number; y: number; width: number; height: number }
const rect = (x: number, y: number, width = 240, height = 100): Rect => ({ x, y, width, height })
const byRect = (rects: Record<string, Rect>) => (id: string): Rect | null => rects[id] ?? null

describe('assignEdgeAnchors：表级锚点均布', () => {
  it('单边入的表：锚点在正中间', () => {
    const m = assignEdgeAnchors(
      [{ id: 'e1', source: 'a', target: 'b' }],
      byRect({ a: rect(0, 0), b: rect(500, 50) }),
    )
    expect(m.get('b')).toEqual([{ edgeId: 'e1', type: 'target', side: 'left', pct: 50 }])
    expect(m.get('a')).toEqual([{ edgeId: 'e1', type: 'source', side: 'right', pct: 50 }])
  })

  it('同侧多条边：按对端纵向位置排序均布', () => {
    // t 被 a、b、c 三张表引用；a 最上，c 最下
    const rects = { a: rect(0, 0), b: rect(0, 200), c: rect(0, 400), t: rect(500, 150) }
    const m = assignEdgeAnchors(
      [
        { id: 'ec', source: 'c', target: 't' },
        { id: 'ea', source: 'a', target: 't' },
        { id: 'eb', source: 'b', target: 't' },
      ],
      byRect(rects),
    )
    const tAnchors = m.get('t')!
    expect(tAnchors.map((a) => a.edgeId)).toEqual(['ea', 'eb', 'ec'])
    expect(tAnchors.map((a) => a.pct)).toEqual([25, 50, 75])
  })

  it('自引用边不进通用选面（由 assignSelfLoops 单侧回环接管）', () => {
    const m = assignEdgeAnchors(
      [
        { id: 'self', source: 'a', target: 'a' },
        { id: 'ab', source: 'a', target: 'b' },
      ],
      byRect({ a: rect(0, 0), b: rect(500, 0) }),
    )
    const a = m.get('a')!
    expect(a.some((x) => x.edgeId === 'self')).toBe(false)
    expect(a.some((x) => x.edgeId === 'ab')).toBe(true)
  })

  it('出边与入边各自独立均布', () => {
    // m 有一条出边到 x、两条入边来自 a/b
    const rects = { a: rect(0, 0), b: rect(0, 200), m: rect(500, 100), x: rect(1000, 100) }
    const m = assignEdgeAnchors(
      [
        { id: 'out', source: 'm', target: 'x' },
        { id: 'in1', source: 'a', target: 'm' },
        { id: 'in2', source: 'b', target: 'm' },
      ],
      byRect(rects),
    )
    const anchors = m.get('m')!
    expect(anchors.find((a) => a.edgeId === 'out')?.pct).toBe(50)
    expect(anchors.find((a) => a.edgeId === 'in1')?.pct).toBeCloseTo(33.33, 1)
    expect(anchors.find((a) => a.edgeId === 'in2')?.pct).toBeCloseTo(66.67, 1)
  })

  it('垂直堆叠（x 区间重叠）：上表底出、下表顶入', () => {
    const rects = { a: rect(100, 0), b: rect(120, 260) }
    const m = assignEdgeAnchors([{ id: 'e1', source: 'a', target: 'b' }], byRect(rects))
    expect(m.get('a')).toEqual([{ edgeId: 'e1', type: 'source', side: 'bottom', pct: 50 }])
    expect(m.get('b')).toEqual([{ edgeId: 'e1', type: 'target', side: 'top', pct: 50 }])
  })

  it('上下颠倒：target 在上 → source 顶出、target 底入', () => {
    const rects = { a: rect(100, 300), b: rect(120, 0) }
    const m = assignEdgeAnchors([{ id: 'e1', source: 'a', target: 'b' }], byRect(rects))
    expect(m.get('a')![0].side).toBe('top')
    expect(m.get('b')![0].side).toBe('bottom')
  })

  it('反向水平（目标在源左侧）：源左出、目标右入', () => {
    const rects = { a: rect(600, 0), b: rect(0, 40) }
    const m = assignEdgeAnchors([{ id: 'e1', source: 'a', target: 'b' }], byRect(rects))
    expect(m.get('a')![0].side).toBe('left')
    expect(m.get('b')![0].side).toBe('right')
  })

  it('顶面多条入边按对端横向位置排序均布', () => {
    // a/b/c 在上、t 在下（x 区间与三者重叠）→ t 顶面锚点按对端 x 排序
    const rects = { a: rect(0, 0), b: rect(230, 0), c: rect(460, 0), t: rect(230, 300) }
    const m = assignEdgeAnchors(
      [
        { id: 'ec', source: 'c', target: 't' },
        { id: 'ea', source: 'a', target: 't' },
        { id: 'eb', source: 'b', target: 't' },
      ],
      byRect(rects),
    )
    const top = m.get('t')!.filter((x) => x.side === 'top')
    expect(top.map((x) => x.edgeId)).toEqual(['ea', 'eb', 'ec'])
    expect(top.map((x) => x.pct)).toEqual([25, 50, 75])
  })

  it('同一面的出边与入边一起均布（出发点不重叠）', () => {
    // t 的出边（→x，x 在左）与入边（y→t，y 在左）都落在 t 的左面：
    // 两条线的出发点必须分开，不能都挤在 50% 处
    const rects = { t: rect(500, 0), x: rect(0, 0), y: rect(0, 200) }
    const m = assignEdgeAnchors(
      [
        { id: 'out', source: 't', target: 'x' },
        { id: 'in', source: 'y', target: 't' },
      ],
      byRect(rects),
    )
    const left = m.get('t')!.filter((a) => a.side === 'left')
    expect(left.map((a) => a.type)).toEqual(['source', 'target'])
    expect(left[0].pct).toBeCloseTo(100 / 3, 1)
    expect(left[1].pct).toBeCloseTo(200 / 3, 1)
  })
})

describe('withAnchorOverrides：手动锚点覆盖自动均布', () => {
  const edges = [
    { id: 'e1', source: 'a', target: 't' },
    { id: 'e2', source: 'b', target: 't' },
  ]
  const auto = () => assignEdgeAnchors(edges, () => null)

  it('被覆盖的一端换成指定的面与位置，另一端不受影响', () => {
    const m = withAnchorOverrides(auto(), edges, {
      e1: { target: { side: 'top', pos: 0.3 } },
    })
    expect(m.get('t')).toContainEqual({ edgeId: 'e1', type: 'target', side: 'top', pct: 30 })
    // e2 仍自动均布（两条入边 → 2/3 处），e1 的 source 端也仍是自动
    const e2 = m.get('t')!.find((a) => a.edgeId === 'e2')!
    expect(e2.side).toBe('left')
    expect(e2.pct).toBeCloseTo(66.67, 1)
    expect(m.get('a')).toContainEqual({ edgeId: 'e1', type: 'source', side: 'right', pct: 50 })
  })

  it('source 端覆盖：换到左边任意高度', () => {
    const m = withAnchorOverrides(auto(), edges, {
      e1: { source: { side: 'left', pos: 0.8 } },
    })
    expect(m.get('a')).toContainEqual({ edgeId: 'e1', type: 'source', side: 'left', pct: 80 })
  })

  it('未知边 id 与缺覆盖的条目被忽略', () => {
    const m = withAnchorOverrides(auto(), edges, {
      ghost: { source: { side: 'top', pos: 0.1 } },
      e1: {},
    })
    expect(m.get('a')).toContainEqual({ edgeId: 'e1', type: 'source', side: 'right', pct: 50 })
  })

  it('自引用边的两端可分别覆盖', () => {
    const self = [{ id: 's', source: 'a', target: 'a' }]
    const anchors = new Map<string, EdgeAnchor[]>()
    assignSelfLoops([{ id: 's', node: 'a' }], anchors, () => null)
    const m = withAnchorOverrides(anchors, self, {
      s: { source: { side: 'top', pos: 0.25 }, target: { side: 'bottom', pos: 0.75 } },
    })
    expect(m.get('a')).toContainEqual({ edgeId: 's', type: 'source', side: 'top', pct: 25 })
    expect(m.get('a')).toContainEqual({ edgeId: 's', type: 'target', side: 'bottom', pct: 75 })
  })
})

describe('assignSelfLoops：自引用单侧回环锚点', () => {
  it('两端锚到同一侧面，位置对齐参与列的行', () => {
    const anchors = new Map<string, EdgeAnchor[]>()
    const gaps = assignSelfLoops(
      [{ id: 'e1', node: 't', sourceColumn: 'parent_id', targetColumn: 'category_id' }],
      anchors,
      (_n, col) => (col === 'parent_id' ? 70 : 25),
    )
    const list = anchors.get('t')!
    expect(list.find((a) => a.type === 'source')).toMatchObject({ side: 'right', pct: 70 })
    expect(list.find((a) => a.type === 'target')).toMatchObject({ side: 'right', pct: 25 })
    expect(gaps.e1).toBeGreaterThan(0)
  })

  it('侧面避开已有锚点多的那一侧', () => {
    const anchors = new Map<string, EdgeAnchor[]>([
      [
        't',
        [
          { edgeId: 'x', type: 'source', side: 'right', pct: 30 },
          { edgeId: 'y', type: 'target', side: 'right', pct: 60 },
        ],
      ],
    ])
    assignSelfLoops([{ id: 'e1', node: 't' }], anchors, () => null)
    const mine = (anchors.get('t') ?? []).filter((a) => a.edgeId === 'e1')
    expect(mine).toHaveLength(2)
    expect(mine.every((a) => a.side === 'left')).toBe(true)
  })

  it('列位置未知（折叠/找不到列）时退回落位 66/34', () => {
    const anchors = new Map<string, EdgeAnchor[]>()
    assignSelfLoops([{ id: 'e1', node: 't' }], anchors, () => null)
    const list = anchors.get('t')!
    expect(list.find((a) => a.type === 'source')?.pct).toBe(66)
    expect(list.find((a) => a.type === 'target')?.pct).toBe(34)
  })

  it('同节点多条自引用回环逐条外扩', () => {
    const anchors = new Map<string, EdgeAnchor[]>()
    const gaps = assignSelfLoops(
      [
        { id: 'a', node: 't', sourceColumn: 'p1', targetColumn: 'id' },
        { id: 'b', node: 't', sourceColumn: 'p2', targetColumn: 'id' },
      ],
      anchors,
      () => null,
    )
    expect(gaps.b).toBeGreaterThan(gaps.a)
    expect((anchors.get('t') ?? []).length).toBe(4)
  })
})

describe('selfLoopVia：回环途经点', () => {
  it('右侧面回环向外折', () => {
    expect(selfLoopVia({ x: 100, y: 10 }, { x: 100, y: 50 }, 1, 26)).toEqual([
      { x: 126, y: 10 },
      { x: 126, y: 50 },
    ])
  })

  it('左侧面回环向外折', () => {
    expect(selfLoopVia({ x: 100, y: 10 }, { x: 100, y: 50 }, -1, 26)).toEqual([
      { x: 74, y: 10 },
      { x: 74, y: 50 },
    ])
  })
})

describe('projectToBorder：指针投影到节点边框', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 }

  it('左侧取左边，pos 为纵向比例', () => {
    const r = projectToBorder({ x: 40, y: 150 }, rect)
    expect(r).toEqual({ side: 'left', pos: 0.5, x: 100, y: 150 })
  })

  it('上方取上边，pos 为横向比例', () => {
    const r = projectToBorder({ x: 200, y: 20 }, rect)
    expect(r.side).toBe('top')
    expect(r.pos).toBeCloseTo(0.5, 5)
    expect(r.y).toBe(100)
  })

  it('节点内部的点取最近的面', () => {
    const r = projectToBorder({ x: 200, y: 190 }, rect)
    expect(r.side).toBe('bottom')
    expect(r.y).toBe(200)
  })

  it('角落处钳制，不贴到顶点上', () => {
    const r = projectToBorder({ x: 20, y: 101 }, rect)
    expect(r.side).toBe('left')
    expect(r.pos).toBeGreaterThanOrEqual(0.03)
    expect(r.y).toBeGreaterThan(100)
  })
})

describe('avoidObstacleMid：自动走线中段避障', () => {
  it('水平连接的中间垂直段穿过节点时，挪到障碍近侧缘外', () => {
    // src 右缘 (300,50) → tgt 左缘 (700,200)，中线 x=500；障碍 [480,620]×[90,150]
    // 只挡中段竖线（两端 y 都在障碍带外），最近的无交解是障碍左缘 466
    const off = avoidObstacleMid({ x: 300, y: 50 }, { x: 700, y: 200 }, 'right', 'left', [
      { x: 480, y: 90, width: 140, height: 60 },
    ])
    expect(off).toBe(466 - 500)
  })

  it('无障碍时保留车道偏移', () => {
    const off = avoidObstacleMid({ x: 300, y: 50 }, { x: 700, y: 50 }, 'right', 'left', [], {
      lane: 6,
    })
    expect(off).toBe(6)
  })

  it('垂直连接的中间水平段同理挪到障碍上/下缘外', () => {
    // src 底缘 (100,100) → tgt 顶缘 (160,500)，中线 y=300；障碍 [40,90]×[280,340]
    const off = avoidObstacleMid({ x: 100, y: 100 }, { x: 160, y: 500 }, 'bottom', 'top', [
      { x: 40, y: 280, width: 50, height: 60 },
    ])
    expect(off).toBe(266 - 300)
  })

  it('障碍与中段纵向不重叠时不处理', () => {
    const off = avoidObstacleMid({ x: 300, y: 50 }, { x: 700, y: 50 }, 'right', 'left', [
      { x: 480, y: 200, width: 100, height: 80 }, // y 在锚点连线跨度之外
    ])
    expect(off).toBe(0)
  })

  it('混合面（手动锚点拉出的斜连接）不避障，原样返回车道', () => {
    const off = avoidObstacleMid(
      { x: 300, y: 50 },
      { x: 700, y: 300 },
      'right',
      'top',
      [{ x: 450, y: 100, width: 100, height: 100 }],
      { lane: 4 },
    )
    expect(off).toBe(4)
  })

  it('两端短段穿表也绕开：源水平段被挡时提前拐弯', () => {
    // src 右缘 (300,100) → tgt 左缘 (900,300)，默认中线 x=600；
    // 障碍 [350,450]×[80,180] 挡住源侧水平段（y=100），须在障碍左缘 336 前拐弯
    const off = avoidObstacleMid({ x: 300, y: 100 }, { x: 900, y: 300 }, 'right', 'left', [
      { x: 350, y: 80, width: 100, height: 100 },
    ])
    expect(off).toBe(336 - 600)
  })

  it('所有候选都穿时维持车道（不比现状差）', () => {
    // 障碍完全包裹两端锚点连线的一切绕法（现实中布局不会发生，只验证兜底）
    const off = avoidObstacleMid({ x: 300, y: 50 }, { x: 700, y: 50 }, 'right', 'left', [
      { x: 340, y: -200, width: 320, height: 500 },
    ])
    expect(off).toBe(0)
  })
})

describe('orthBypassVia：穿表的正交绕行桥', () => {
  it('水平共线且直线穿过节点：折到障碍上方过去再折回', () => {
    // src 右缘 (300,100) → tgt 左缘 (900,100)，障碍 [450,550]×[70,150] 挡在直线上
    const via = orthBypassVia({ x: 300, y: 100 }, { x: 900, y: 100 }, 'right', 'left', [
      { x: 450, y: 70, width: 100, height: 80 },
    ])
    expect(via).toEqual([
      { x: 450 - 14 - 10, y: 100 }, // 障碍前拐点
      { x: 450 - 14 - 10, y: 70 - 14 - 10 }, // 折到障碍上方
      { x: 550 + 14 + 10, y: 70 - 14 - 10 }, // 上方过去
      { x: 550 + 14 + 10, y: 100 }, // 折回原高度
    ])
  })

  it('垂直共线且直线穿过节点：折到障碍侧边过去', () => {
    // src 底缘 (200,100) → tgt 顶缘 (200,500)，障碍 [150,250]×[240,320]
    const via = orthBypassVia({ x: 200, y: 100 }, { x: 200, y: 500 }, 'bottom', 'top', [
      { x: 150, y: 240, width: 100, height: 80 },
    ])
    expect(via).toEqual([
      { x: 200, y: 240 - 14 - 10 },
      { x: 150 - 14 - 10, y: 240 - 14 - 10 },
      { x: 150 - 14 - 10, y: 320 + 14 + 10 },
      { x: 200, y: 320 + 14 + 10 },
    ])
  })

  it('共线但直线不穿任何节点：不绕行', () => {
    const via = orthBypassVia({ x: 300, y: 100 }, { x: 900, y: 100 }, 'right', 'left', [
      { x: 450, y: 300, width: 100, height: 80 },
    ])
    expect(via).toBeNull()
  })

  it('非共线（两端不同高）直连被挡：同样折桥，绕行带取离两端中点更近的一侧', () => {
    // src 右缘 (300,100) → tgt 左缘 (900,300)，障碍 [450,550]×[100,180]
    // 两端中点 y=200，障碍下缘外 (204) 比上缘外 (76) 更近 → 从下方绕
    const via = orthBypassVia({ x: 300, y: 100 }, { x: 900, y: 300 }, 'right', 'left', [
      { x: 450, y: 100, width: 100, height: 80 },
    ])
    expect(via).toEqual([
      { x: 450 - 24, y: 100 },
      { x: 450 - 24, y: 180 + 24 },
      { x: 550 + 24, y: 180 + 24 },
      { x: 550 + 24, y: 300 },
    ])
  })
})

describe('routeOrth：中段避障优先，Z 形无解时侧边绕桥', () => {
  it('中段偏移可解时不出桥（保持 Z 形 + lane）', () => {
    const r = routeOrth({ x: 300, y: 50 }, { x: 700, y: 200 }, 'right', 'left', [
      { x: 480, y: 90, width: 140, height: 60 },
    ])
    expect(r.via).toBeNull()
    expect(r.lane).toBe(466 - 500)
  })

  it('两端分列障碍上下（x 都压在障碍带上）：Z 形无解，从侧边整体绕过', () => {
    // src 底缘 (200,100) → tgt 顶缘 (260,500)，障碍 [100,360]×[200,280]：
    // 中段横线无论放哪，两端竖段之一必穿障碍 → 左侧绕桥
    const r = routeOrth({ x: 200, y: 100 }, { x: 260, y: 500 }, 'bottom', 'top', [
      { x: 100, y: 200, width: 260, height: 80 },
    ])
    expect(r.via).toEqual([
      { x: 200, y: 200 - 24 },
      { x: 100 - 24, y: 200 - 24 },
      { x: 100 - 24, y: 280 + 24 },
      { x: 260, y: 280 + 24 },
    ])
  })
})

describe('assignCorridorLanes：同一走廊的中段互不重合', () => {
  it('中段同位且跨度重叠的两条边对称错开', () => {
    const lanes = assignCorridorLanes([
      { id: 'a', mid: 500, lo: 100, hi: 200 },
      { id: 'b', mid: 500, lo: 150, hi: 260 },
    ])
    expect(lanes.a).toBe(-lanes.b)
    expect(Math.abs(lanes.a)).toBeGreaterThan(0)
  })

  it('中段同位但跨度不重叠的边不错开（物理上不重合）', () => {
    const lanes = assignCorridorLanes([
      { id: 'a', mid: 500, lo: 100, hi: 200 },
      { id: 'b', mid: 500, lo: 400, hi: 600 },
    ])
    expect(lanes.a).toBe(0)
    expect(lanes.b).toBe(0)
  })

  it('三条全重叠的边：-gap / 0 / +gap', () => {
    const lanes = assignCorridorLanes([
      { id: 'a', mid: 500, lo: 100, hi: 200 },
      { id: 'b', mid: 500, lo: 120, hi: 220 },
      { id: 'c', mid: 500, lo: 140, hi: 240 },
    ])
    expect(lanes.b).toBe(0)
    expect(lanes.a).toBe(-lanes.c)
    expect(Math.abs(lanes.a)).toBeCloseTo(6, 5)
  })

  it('中段相距超过容差的边不在同一走廊', () => {
    const lanes = assignCorridorLanes([
      { id: 'a', mid: 500, lo: 100, hi: 200 },
      { id: 'b', mid: 620, lo: 150, hi: 260 },
    ])
    expect(lanes.a).toBe(0)
    expect(lanes.b).toBe(0)
  })

  it('链式重叠：a-b 重叠、b-c 重叠、a-c 不重叠 → 两层错开', () => {
    const lanes = assignCorridorLanes([
      { id: 'a', mid: 500, lo: 100, hi: 200 },
      { id: 'b', mid: 500, lo: 150, hi: 260 },
      { id: 'c', mid: 500, lo: 240, hi: 340 },
    ])
    // a 与 c 不重叠可以同层；b 与两者都重叠须单独一层
    expect(lanes.a).toBe(lanes.c)
    expect(lanes.b).not.toBe(lanes.a)
  })
})

describe('assignEdgeLanes：同一列间隙的边分配错开的车道', () => {
  // 列：x≈0 的 a/b/c，x≈500 的 t；t2 在 x≈1000
  const xs: Record<string, number> = { a: 0, b: 10, c: -5, t: 500, t2: 1000 }

  it('同一间隙 3 条边：按边 id 排序对称错开', () => {
    const lanes = assignEdgeLanes(
      [
        { id: 'ec', source: 'c', target: 't' },
        { id: 'ea', source: 'a', target: 't' },
        { id: 'eb', source: 'b', target: 't' },
      ],
      xs,
    )
    expect(lanes.ea).toBeLessThan(0)
    expect(lanes.eb).toBe(0)
    expect(lanes.ec).toBeGreaterThan(0)
    expect(lanes.ec).toBe(-lanes.ea)
  })

  it('不同间隙各自独立分配', () => {
    const lanes = assignEdgeLanes(
      [
        { id: 'e2', source: 'b', target: 't' },
        { id: 'e1', source: 'a', target: 't' },
        { id: 'e4', source: 't', target: 't2' },
        { id: 'e3', source: 't', target: 't2' },
      ],
      xs,
    )
    // 间隙 (0,1) 两条、间隙 (1,2) 两条，各自对称
    expect(lanes.e1).toBe(-lanes.e2)
    expect(lanes.e3).toBe(-lanes.e4)
  })

  it('同列内的边不分配车道（偏移 0）', () => {
    const lanes = assignEdgeLanes(
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'c' },
      ],
      xs,
    )
    expect(lanes.e1).toBe(0)
    expect(lanes.e2).toBe(0)
  })

  it('结果与输入顺序无关（确定性）', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 't' },
      { id: 'e2', source: 'b', target: 't' },
      { id: 'e3', source: 'c', target: 't' },
    ]
    const l1 = assignEdgeLanes(edges, xs)
    const l2 = assignEdgeLanes([...edges].reverse(), xs)
    expect(l1).toEqual(l2)
  })

  it('单条边的间隙：偏移 0', () => {
    const lanes = assignEdgeLanes([{ id: 'e1', source: 'a', target: 't' }], xs)
    expect(lanes.e1).toBe(0)
  })

  it('边数很多时收窄车道宽度，避免散出列间隙', () => {
    const edges = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      source: i % 2 ? 'a' : 'b',
      target: 't',
    }))
    const lanes = assignEdgeLanes(edges, xs)
    const spread = Math.max(...Object.values(lanes)) - Math.min(...Object.values(lanes))
    expect(spread).toBeLessThanOrEqual(80)
  })
})
