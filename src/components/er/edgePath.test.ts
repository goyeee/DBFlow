import { describe, expect, it } from 'vitest'

import {
  nearestSegment,
  orthogonalizeChain,
  simplifyCollinear,
  smoothPolylinePath,
  snapToGuides,
} from './edgePath'

describe('smoothPolylinePath：带圆角的折线', () => {
  it('两点：直线', () => {
    expect(smoothPolylinePath([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe('M 0 0 L 100 0')
  })

  it('三点直角：拐角处二次贝塞尔圆角', () => {
    const d = smoothPolylinePath(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
      10,
    )
    expect(d).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 100')
  })

  it('共线的中间点不产生圆角', () => {
    const d = smoothPolylinePath(
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }],
      10,
    )
    expect(d).toBe('M 0 0 L 50 0 L 100 0')
  })

  it('段长不足时圆角半径自动收缩，不越界', () => {
    const d = smoothPolylinePath(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }],
      12,
    )
    // 前段只有 10px，半径收缩为 5
    expect(d).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 100')
  })

  it('多点折线每个拐角都有圆角', () => {
    const d = smoothPolylinePath(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }],
      10,
    )
    expect(d).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 90 Q 100 100 110 100 L 200 100')
  })
})

describe('nearestSegment：最近线段与投影点', () => {
  const chain = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]

  it('垂足在段内：返回该段与垂足', () => {
    expect(nearestSegment({ x: 50, y: 10 }, chain)).toEqual({
      index: 0,
      point: { x: 50, y: 0 },
    })
  })

  it('垂足在段外：钳到端点', () => {
    const r = nearestSegment({ x: 110, y: 50 }, chain)
    expect(r).toEqual({ index: 1, point: { x: 100, y: 50 } })
    const r2 = nearestSegment({ x: -20, y: 5 }, chain)
    expect(r2).toEqual({ index: 0, point: { x: 0, y: 0 } })
  })

  it('多段比较取距离最小者', () => {
    // 离段 1（竖线 x=100）更近
    const r = nearestSegment({ x: 95, y: 60 }, chain)
    expect(r.index).toBe(1)
    expect(r.point).toEqual({ x: 100, y: 60 })
  })
})

describe('snapToGuides：水平/垂直对齐吸附', () => {
  it('x 接近参考点：吸附 x 并给出垂直引导线', () => {
    const r = snapToGuides({ x: 103, y: 200 }, [{ x: 100, y: 300 }], 6)
    expect(r.point).toEqual({ x: 100, y: 200 })
    expect(r.guideX).toBe(100)
    expect(r.guideY).toBeUndefined()
  })

  it('y 接近参考点：吸附 y 并给出水平引导线', () => {
    const r = snapToGuides({ x: 50, y: 295 }, [{ x: 100, y: 300 }], 6)
    expect(r.point).toEqual({ x: 50, y: 300 })
    expect(r.guideY).toBe(300)
    expect(r.guideX).toBeUndefined()
  })

  it('两轴可分别吸附到不同参考点', () => {
    const r = snapToGuides(
      { x: 97, y: 203 },
      [{ x: 100, y: 0 }, { x: 0, y: 200 }],
      6,
    )
    expect(r.point).toEqual({ x: 100, y: 200 })
    expect(r.guideX).toBe(100)
    expect(r.guideY).toBe(200)
  })

  it('超出阈值不吸附、无引导', () => {
    const r = snapToGuides({ x: 110, y: 290 }, [{ x: 100, y: 300 }], 6)
    expect(r.point).toEqual({ x: 110, y: 290 })
    expect(r.guideX).toBeUndefined()
    expect(r.guideY).toBeUndefined()
  })

  it('距离恰为阈值不吸附（取严格小于）', () => {
    const r = snapToGuides({ x: 106, y: 200 }, [{ x: 100, y: 0 }], 6)
    expect(r.point.x).toBe(106)
    expect(r.guideX).toBeUndefined()
  })

  it('多参考点同一轴取最近者', () => {
    const r = snapToGuides(
      { x: 103, y: 0 },
      [{ x: 100, y: 0 }, { x: 112, y: 0 }],
      6,
    )
    expect(r.guideX).toBe(100)
    expect(r.point.x).toBe(100)
  })

  it('无参考点原样返回', () => {
    const r = snapToGuides({ x: 1, y: 2 }, [], 6)
    expect(r).toEqual({ point: { x: 1, y: 2 } })
  })
})

describe('simplifyCollinear：拉直后自动消掉共线途经点', () => {
  const ends = [{ x: 0, y: 0 }, { x: 100, y: 0 }] as [{ x: number; y: number }, { x: number; y: number }]

  it('途经点与两端共线：移除（返回空恢复自动走线）', () => {
    expect(simplifyCollinear([{ x: 50, y: 0 }], ends)).toEqual([])
  })

  it('接近共线（偏差在阈值内）：同样移除', () => {
    expect(simplifyCollinear([{ x: 50, y: 0.4 }], ends)).toEqual([])
  })

  it('偏差超过阈值：保留', () => {
    expect(simplifyCollinear([{ x: 50, y: 3 }], ends)).toEqual([{ x: 50, y: 3 }])
  })

  it('真拐点保留、同侧共线点移除', () => {
    // 链 (100,0)→(120,0)→(120,60)→(120,120)：后两点共竖线，(120,60) 可删，
    // (120,0) 是水平转竖直的真拐点必须保留
    expect(
      simplifyCollinear([{ x: 120, y: 0 }, { x: 120, y: 60 }], [
        { x: 100, y: 0 },
        { x: 120, y: 120 },
      ]),
    ).toEqual([{ x: 120, y: 0 }])
  })

  it('级联共线全部清除', () => {
    expect(
      simplifyCollinear([{ x: 20, y: 0 }, { x: 50, y: 0.2 }, { x: 80, y: 0 }], ends),
    ).toEqual([])
  })

  it('空途经点原样返回', () => {
    expect(simplifyCollinear([], ends)).toEqual([])
  })
})

describe('orthogonalizeChain：途经点链正交化（只走水平/垂直）', () => {
  it('斜段拆成 L 形：水平出 + 垂直入 → 先横后竖', () => {
    const r = orthogonalizeChain([{ x: 0, y: 0 }, { x: 100, y: 60 }], true, false)
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
    ])
    // 原始点在正交化链中的下标（段中点手柄定位用）
    expect(r.segStart).toEqual([0, 2])
  })

  it('垂直出 + 水平入 → 先竖后横', () => {
    const r = orthogonalizeChain([{ x: 0, y: 0 }, { x: 100, y: 60 }], false, true)
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 60 },
      { x: 100, y: 60 },
    ])
  })

  it('已是水平/垂直的链原样保留（自动绕桥/共线点不受影响）', () => {
    const chain = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 80 },
      { x: 120, y: 80 },
    ]
    const r = orthogonalizeChain(chain, true, true)
    expect(r.pts).toEqual(chain)
  })

  it('水平进出且不共线：中点双拐（横-竖-横）', () => {
    const r = orthogonalizeChain([{ x: 0, y: 0 }, { x: 100, y: 60 }], true, true)
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 60 },
      { x: 100, y: 60 },
    ])
    expect(r.segStart).toEqual([0, 3])
  })

  it('垂直进出且不共线：中点双拐（竖-横-竖）', () => {
    const r = orthogonalizeChain([{ x: 0, y: 0 }, { x: 100, y: 60 }], false, false)
    expect(r.pts).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 60 },
    ])
  })

  it('多途经点混合斜置：全程无斜段且首尾轴向正确', () => {
    const r = orthogonalizeChain(
      [
        { x: 0, y: 0 },
        { x: 80, y: 40 },
        { x: 160, y: 10 },
        { x: 240, y: 70 },
      ],
      true,
      false,
    )
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i]
      const b = r.pts[i + 1]
      expect(a.x === b.x || a.y === b.y).toBe(true)
    }
    expect(r.pts[0]).toEqual({ x: 0, y: 0 })
    expect(r.pts[r.pts.length - 1]).toEqual({ x: 240, y: 70 })
    // 首段沿出线轴水平离开、末段沿入线轴垂直进入
    expect(r.pts[0].y).toBe(r.pts[1].y)
    expect(r.pts[r.pts.length - 2].x).toBe(r.pts[r.pts.length - 1].x)
    // 每个原始点都精确落在正交化链上（且顺序保持）
    expect(r.pts[r.segStart[1]]).toEqual({ x: 80, y: 40 })
    expect(r.pts[r.segStart[3]]).toEqual({ x: 240, y: 70 })
  })
})
