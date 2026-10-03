import { describe, expect, it } from 'vitest'

import { collectNodeMarks, type MarkKind } from './highlight'

const edges = [
  {
    id: 'e1',
    source: 'orders',
    target: 'customer',
    sourceColumns: ['CustomerID'],
    targetColumns: ['CustomerID'],
  },
  {
    id: 'e2',
    source: 'orders',
    target: 'shipment',
    sourceColumns: ['order_id', 'order_no'],
    targetColumns: ['id'],
  },
]

describe('collectNodeMarks：关系高亮的节点/列标记（声明式，虚拟化重挂载不丢）', () => {
  it('点亮边 → 两端节点与参与列（列名转小写）各得该类标记', () => {
    const m = collectNodeMarks(edges, { e1: ['sel'] })
    expect(m.get('orders')).toEqual({
      node: ['sel'],
      cols: { customerid: ['sel'] },
    })
    expect(m.get('customer')).toEqual({
      node: ['sel'],
      cols: { customerid: ['sel'] },
    })
    // 未点亮的边两端（shipment）不出现在结果里
    expect(m.has('shipment')).toBe(false)
  })

  it('同一节点多条边多类高亮合并且去重（保首次出现序）', () => {
    const m = collectNodeMarks(edges, { e1: ['related'], e2: ['related', 'sel'] })
    expect(m.get('orders')).toEqual({
      node: ['related', 'sel'],
      cols: { customerid: ['related'], order_id: ['related', 'sel'], order_no: ['related', 'sel'] },
    })
  })

  it('复合外键的全部参与列都标记', () => {
    const m = collectNodeMarks(edges, { e2: ['tsel'] })
    expect(m.get('shipment')).toEqual({ node: ['tsel'], cols: { id: ['tsel'] } })
    expect(Object.keys(m.get('orders')!.cols).sort()).toEqual(['order_id', 'order_no'])
  })

  it('自引用边：两端同节点只标一次，出/入列都进同一节点', () => {
    const m = collectNodeMarks(
      [
        {
          id: 'self',
          source: 'category',
          target: 'category',
          sourceColumns: ['parent_id'],
          targetColumns: ['category_id'],
        },
      ],
      { self: ['fpick'] },
    )
    expect(m.get('category')).toEqual({
      node: ['fpick'],
      cols: { parent_id: ['fpick'], category_id: ['fpick'] },
    })
    expect(m.size).toBe(1)
  })

  it('kinds 为空或不存在的边不产生标记', () => {
    const m = collectNodeMarks(edges, { e1: [], ghost: ['sel' as MarkKind] })
    expect(m.size).toBe(0)
  })
})
