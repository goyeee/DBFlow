import { describe, expect, it } from 'vitest'

import type { ErEdgeInfo, ErTable } from './transform'
import { inferEdges } from './infer'

/** 构造表：pk 为单列主键名（无主键传 null），其余为普通列 */
function table(name: string, pk: string | null, columns: string[]): ErTable {
  return {
    name,
    comment: null,
    singlePrimaryKey: pk,
    indexes: pk
      ? [
          {
            name: 'PRIMARY',
            columns: [pk],
            unique: true,
            primary: true,
            indexType: 'BTREE',
          },
        ]
      : [],
    columns: columns.map((c) => ({
      name: c,
      dataType: 'bigint unsigned',
      nullable: c !== pk,
      key: c === pk ? ('pk' as const) : ('none' as const),
      default: null,
      comment: null,
    })),
  }
}

function graph(tables: ErTable[], fkEdges: ErEdgeInfo[] = []) {
  const map: Record<string, ErTable> = {}
  for (const t of tables) map[t.name.toLowerCase()] = t
  return { tables: map, fkEdges }
}

describe('命名推断：同名字段 = 目标表主键', () => {
  it('Account 主键 AccountID，Order 含 AccountID 列 → 关联 Account', () => {
    const g = graph([
      table('Account', 'AccountID', ['AccountID', 'Name']),
      table('Order', 'OrderID', ['OrderID', 'AccountID', 'Amount']),
    ])
    const edges = inferEdges(g)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      kind: 'inferred',
      sourceTable: 'Order',
      sourceColumns: ['AccountID'],
      targetTable: 'Account',
      targetColumns: ['AccountID'],
    })
    expect(edges[0].id).toBe('inf:Order.AccountID->Account.AccountID')
  })

  it('匹配忽略大小写（accountid / ACCOUNTID 也算）', () => {
    const g = graph([
      table('Account', 'accountid', ['accountid']),
      table('Order', 'OrderID', ['OrderID', 'ACCOUNTID']),
    ])
    expect(inferEdges(g)).toHaveLength(1)
  })

  it('一个表含多个 XxxID 列 → 分别关联多张表', () => {
    const g = graph([
      table('Agent', 'AgentID', ['AgentID']),
      table('AccountStatus', 'AccountStatusID', ['AccountStatusID']),
      table('Account', 'AccountID', [
        'AccountID',
        'AgentID',
        'AccountStatusID',
      ]),
    ])
    const edges = inferEdges(g)
    expect(edges).toHaveLength(2)
    expect(edges.map((e) => e.targetTable).sort()).toEqual([
      'AccountStatus',
      'Agent',
    ])
  })
})

describe('命名推断：排除规则', () => {
  it('主键名不是「表名+ID」（如通用 id）的表不参与推断', () => {
    // users 主键为 id：即使 orders 有 user_id 也不匹配（id 不是 usersID）
    const g = graph([
      table('users', 'id', ['id', 'name']),
      table('orders', 'id', ['id', 'user_id']),
    ])
    expect(inferEdges(g)).toHaveLength(0)
  })

  it('自表的同名字段就是自己的主键，不产生自引用', () => {
    const g = graph([table('Category', 'CategoryID', ['CategoryID', 'Name'])])
    expect(inferEdges(g)).toHaveLength(0)
  })

  it('已被真实外键覆盖的列不再推断', () => {
    const g = graph(
      [
        table('Order', 'OrderID', ['OrderID', 'AccountID']),
        table('Account', 'AccountID', ['AccountID']),
      ],
      [
        {
          id: 'fk:Order:fk_account',
          kind: 'fk',
          sourceTable: 'Order',
          sourceColumns: ['AccountID'],
          targetTable: 'Account',
          targetColumns: ['AccountID'],
        },
      ],
    )
    expect(inferEdges(g)).toHaveLength(0)
  })

  it('目标表无单列主键（复合主键）不推断', () => {
    const g = graph([
      table('Order', 'OrderID', ['OrderID', 'AccountID']),
      {
        name: 'Account',
        comment: null,
        singlePrimaryKey: null,
        indexes: [
          {
            name: 'PRIMARY',
            columns: ['a', 'b'],
            unique: true,
            primary: true,
            indexType: 'BTREE',
          },
        ],
        columns: [
          { name: 'a', dataType: 'bigint', nullable: false, key: 'pk', default: null, comment: null },
          { name: 'b', dataType: 'bigint', nullable: false, key: 'pk', default: null, comment: null },
        ],
      },
    ])
    expect(inferEdges(g)).toHaveLength(0)
  })
})
