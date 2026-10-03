import { describe, expect, it } from 'vitest'

import type { ErModelDoc, ErSnapshot } from '../../api/types'
import {
  buildErGraph,
  buildModelDoc,
  docOverlay,
  inferredLayoutEdges,
  makeManualEdge,
  placeFreshTables,
  type ErEdgeInfo,
} from './transform'

function snap(): ErSnapshot {
  return {
    tables: [
      {
        name: 'users',
        engine: 'InnoDB',
        collation: 'utf8mb4_0900_ai_ci',
        comment: '用户',
        columns: [
          { name: 'id', dataType: 'bigint unsigned', nullable: false, default: null, extra: 'auto_increment', comment: null, ordinal: 1, characterSet: null, collation: null },
          { name: 'email', dataType: 'varchar(255)', nullable: false, default: null, extra: '', comment: null, ordinal: 2, characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
          { name: 'name', dataType: 'varchar(64)', nullable: true, default: null, extra: '', comment: null, ordinal: 3, characterSet: null, collation: null },
        ],
        indexes: [
          { name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
          { name: 'uk_email', columns: ['email'], subParts: [null], directions: [null], unique: true, isPrimary: false, indexType: 'BTREE' },
        ],
      },
      {
        name: 'user_roles',
        engine: 'InnoDB',
        collation: null,
        comment: null,
        columns: [
          { name: 'user_id', dataType: 'bigint unsigned', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null },
          { name: 'role_id', dataType: 'bigint unsigned', nullable: false, default: null, extra: '', comment: null, ordinal: 2, characterSet: null, collation: null },
        ],
        indexes: [
          { name: 'PRIMARY', columns: ['user_id', 'role_id'], subParts: [null, null], directions: [null, null], unique: true, isPrimary: true, indexType: 'BTREE' },
        ],
      },
    ],
    foreignKeys: [
      {
        name: 'fk_user_role_user',
        table: 'user_roles',
        columns: ['user_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      },
    ],
    serverVersion: '8.4.11',
  }
}

describe('buildErGraph：快照 → 表/边', () => {
  it('列按键类型分类（主键/唯一/普通），单列主键可取到', () => {
    const g = buildErGraph(snap())
    const users = g.tables['users']
    expect(users.columns.map((c) => c.key)).toEqual(['pk', 'unique', 'none'])
    expect(users.singlePrimaryKey).toBe('id')
  })

  it('复合主键表 singlePrimaryKey 为 null', () => {
    const g = buildErGraph(snap())
    expect(g.tables['user_roles'].singlePrimaryKey).toBeNull()
  })

  it('外键边携带列映射与规则，id 形如 fk:表:约束名', () => {
    const g = buildErGraph(snap())
    expect(g.fkEdges).toHaveLength(1)
    const e = g.fkEdges[0]
    expect(e.id).toBe('fk:user_roles:fk_user_role_user')
    expect(e.kind).toBe('fk')
    expect(e.sourceTable).toBe('user_roles')
    expect(e.sourceColumns).toEqual(['user_id'])
    expect(e.targetTable).toBe('users')
    expect(e.targetColumns).toEqual(['id'])
    expect(e.onDelete).toBe('CASCADE')
    expect(e.onUpdate).toBe('RESTRICT')
  })

  it('仅大小写不同的同名表（Users/users）抛错，不静默覆盖丢表', () => {
    const col = { name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null }
    const pk = { name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }
    const s: ErSnapshot = {
      tables: [
        { name: 'Users', engine: null, collation: null, comment: null, columns: [col], indexes: [pk] },
        { name: 'users', engine: null, collation: null, comment: null, columns: [col], indexes: [pk] },
      ],
      foreignKeys: [],
      serverVersion: null,
    }
    expect(() => buildErGraph(s)).toThrow(/大小写/)
  })
})

describe('docOverlay：模型文档 → 布局/裁决叠加', () => {
  it('无文档时返回空叠加', () => {
    const o = docOverlay(null)
    expect(o.positions).toEqual({})
    expect(o.collapsed).toEqual({})
    expect(o.inferredStatus).toEqual({})
  })

  it('提取位置/折叠/推断边裁决；文档里已被删除的表条目被容忍', () => {
    const doc: ErModelDoc = {
      formatVersion: 1,
      kind: 'mysql',
      database: 'db',
      origin: { connectionName: '本地', capturedAt: '2026-01-01T00:00:00Z' },
      tables: [
        { id: 'users', name: 'users', x: 10, y: 20, collapsed: true },
        { id: 'dropped', name: 'dropped', x: 1, y: 2, collapsed: false },
      ],
      edges: [
        {
          id: 'inf:orders.user_id->users.id',
          kind: 'inferred',
          status: 'confirmed',
          source: { table: 'orders', column: 'user_id' },
          target: { table: 'users', column: 'id' },
        },
        {
          id: 'man:orders.parent_id->orders.id',
          kind: 'manual',
          via: [{ x: 500, y: 300 }],
          source: { table: 'orders', column: 'parent_id' },
          target: { table: 'orders', column: 'id' },
        },
      ],
    }
    const o = docOverlay(doc)
    expect(o.positions['users']).toEqual({ x: 10, y: 20 })
    expect(o.positions['dropped']).toEqual({ x: 1, y: 2 })
    expect(o.collapsed['users']).toBe(true)
    expect(o.inferredStatus['inf:orders.user_id->users.id']).toBe('confirmed')
    // manual 边被恢复
    expect(o.manualEdges).toHaveLength(1)
    expect(o.manualEdges[0]).toMatchObject({
      id: 'man:orders.parent_id->orders.id',
      kind: 'manual',
      sourceTable: 'orders',
      sourceColumns: ['parent_id'],
      targetTable: 'orders',
      targetColumns: ['id'],
    })
    // via 途经点被恢复到 edgeRoutes
    expect(o.edgeRoutes['man:orders.parent_id->orders.id']).toEqual([{ x: 500, y: 300 }])
    expect(o.edgeRoutes['inf:orders.user_id->users.id']).toBeUndefined()
  })
})

describe('makeManualEdge：手动关联构造', () => {
  // 两表：Account(AccountID pk)、Order(OrderID pk, 含 AccountID)
  const g = buildErGraph({
    ...snap(),
    tables: [
      {
        name: 'Account',
        engine: null,
        collation: null,
        comment: null,
        columns: [
          { name: 'AccountID', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null },
        ],
        indexes: [
          { name: 'PRIMARY', columns: ['AccountID'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
        ],
      },
      {
        name: 'Order',
        engine: null,
        collation: null,
        comment: null,
        columns: [
          { name: 'OrderID', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null },
          { name: 'AccountID', dataType: 'bigint', nullable: true, default: null, extra: '', comment: null, ordinal: 2, characterSet: null, collation: null },
        ],
        indexes: [
          { name: 'PRIMARY', columns: ['OrderID'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
        ],
      },
    ],
    foreignKeys: [],
  })

  it('创建 Order.AccountID → Account.AccountID', () => {
    const r = makeManualEdge(
      g,
      { sourceTable: 'Order', sourceColumn: 'AccountID', targetTable: 'Account', targetColumn: 'AccountID' },
      [],
    )
    expect(r.error).toBeUndefined()
    expect(r.edge).toMatchObject({
      id: 'man:Order.AccountID->Account.AccountID',
      kind: 'manual',
      sourceTable: 'Order',
      targetTable: 'Account',
    })
  })

  it('方向规范化：从主键端拖出时自动交换，主键端作为 target', () => {
    // source 给 Account.AccountID（主键），target 给 Order.AccountID（非主键）→ 交换
    const r = makeManualEdge(
      g,
      { sourceTable: 'Account', sourceColumn: 'AccountID', targetTable: 'Order', targetColumn: 'AccountID' },
      [],
    )
    expect(r.edge).toMatchObject({
      sourceTable: 'Order',
      sourceColumns: ['AccountID'],
      targetTable: 'Account',
      targetColumns: ['AccountID'],
    })
  })

  it('允许同表自引用（Order.某列 → Order.OrderID）', () => {
    // Order 加一列 ParentID
    const g2: typeof g = {
      ...g,
      tables: {
        ...g.tables,
        order: {
          ...g.tables.order,
          columns: [
            ...g.tables.order.columns,
            { name: 'ParentID', dataType: 'bigint', nullable: true, key: 'none', default: null, comment: null },
          ],
        },
      },
    }
    const r = makeManualEdge(
      g2,
      { sourceTable: 'Order', sourceColumn: 'ParentID', targetTable: 'Order', targetColumn: 'OrderID' },
      [],
    )
    expect(r.edge?.id).toBe('man:Order.ParentID->Order.OrderID')
  })

  it('同一列连到自身（拖拽误触）返回错误', () => {
    expect(
      makeManualEdge(
        g,
        { sourceTable: 'Order', sourceColumn: 'AccountID', targetTable: 'Order', targetColumn: 'AccountID' },
        [],
      ).error,
    ).toContain('自身')
  })

  it('表或列不存在时返回错误', () => {
    expect(
      makeManualEdge(g, { sourceTable: 'Ghost', sourceColumn: 'x', targetTable: 'Account', targetColumn: 'AccountID' }, []).error,
    ).toContain('不存在')
    expect(
      makeManualEdge(g, { sourceTable: 'Order', sourceColumn: 'ghost', targetTable: 'Account', targetColumn: 'AccountID' }, []).error,
    ).toContain('没有列')
  })

  it('与现有边重复时返回错误', () => {
    const existing: ErEdgeInfo[] = [
      {
        id: 'inf:Order.AccountID->Account.AccountID',
        kind: 'inferred',
        sourceTable: 'Order',
        sourceColumns: ['AccountID'],
        targetTable: 'Account',
        targetColumns: ['AccountID'],
      },
    ]
    expect(
      makeManualEdge(
        g,
        { sourceTable: 'Order', sourceColumn: 'AccountID', targetTable: 'Account', targetColumn: 'AccountID' },
        existing,
      ).error,
    ).toBe('该关联已存在')
  })
})

describe('buildModelDoc：当前状态 → 文档', () => {
  const fkEdge: ErEdgeInfo = {
    id: 'fk:user_roles:fk_user_role_user',
    kind: 'fk',
    sourceTable: 'user_roles',
    sourceColumns: ['user_id'],
    targetTable: 'users',
    targetColumns: ['id'],
    onDelete: 'CASCADE',
    onUpdate: null,
  }
  const inferredEdge: ErEdgeInfo = {
    id: 'inf:orders.user_id->users.id',
    kind: 'inferred',
    sourceTable: 'orders',
    sourceColumns: ['user_id'],
    targetTable: 'users',
    targetColumns: ['id'],
  }

  it('fk 边全量入档；推断边带裁决状态（未裁决不写 status）', () => {
    // 一条手动关联（Order.ParentID → Order.OrderID，自引用）
    const manualEdge: ErEdgeInfo = {
      id: 'man:Order.ParentID->Order.OrderID',
      kind: 'manual',
      sourceTable: 'Order',
      sourceColumns: ['ParentID'],
      targetTable: 'Order',
      targetColumns: ['OrderID'],
    }
    const doc = buildModelDoc({
      kind: 'mysql',
      database: 'db',
      connectionName: '本地',
      positions: { users: { x: 5, y: 6 }, user_roles: { x: 7, y: 8 }, orders: { x: 1, y: 2 } },
      collapsed: { users: true },
      fkEdges: [fkEdge],
      inferredEdges: [inferredEdge],
      manualEdges: [manualEdge],
      inferredStatus: { 'inf:orders.user_id->users.id': 'ignored' },
      edgeRoutes: {
        'man:Order.ParentID->Order.OrderID': [{ x: 300, y: 300 }],
        'fk:user_roles:fk_user_role_user': [{ x: 10, y: 10 }],
      },
      edgeAnchors: {},
    })
    expect(doc.formatVersion).toBe(1)
    expect(doc.database).toBe('db')
    expect(doc.origin.connectionName).toBe('本地')
    expect(doc.origin.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(doc.tables).toHaveLength(3)
    expect(doc.tables.find((t) => t.name === 'users')).toMatchObject({ x: 5, y: 6, collapsed: true })
    expect(doc.edges).toHaveLength(3)
    const fk = doc.edges.find((e) => e.id === fkEdge.id)
    expect(fk).toMatchObject({
      kind: 'fk',
      source: { table: 'user_roles', column: 'user_id' },
      target: { table: 'users', column: 'id' },
    })
    expect(fk?.status).toBeUndefined()
    expect(doc.edges.find((e) => e.id === inferredEdge.id)?.status).toBe('ignored')
    // manual 边入档，无 status
    const man = doc.edges.find((e) => e.id === 'man:Order.ParentID->Order.OrderID')
    expect(man).toMatchObject({
      kind: 'manual',
      source: { table: 'Order', column: 'ParentID' },
      target: { table: 'Order', column: 'OrderID' },
    })
    expect(man?.status).toBeUndefined()
    // edgeRoutes 写入各边的 via（fk 与 manual 都有）；未途经的边不带 via
    expect(man?.via).toEqual([{ x: 300, y: 300 }])
    expect(doc.edges.find((e) => e.id === fkEdge.id)?.via).toEqual([{ x: 10, y: 10 }])
    expect(doc.edges.find((e) => e.id === inferredEdge.id)?.via).toBeUndefined()
  })

  it('edgeAnchors 写入各边的 sourceAnchor/targetAnchor；未覆盖的边不带锚点字段', () => {
    const doc = buildModelDoc({
      kind: 'mysql',
      database: 'db',
      connectionName: '本地',
      positions: { users: { x: 5, y: 6 } },
      collapsed: {},
      fkEdges: [fkEdge],
      inferredEdges: [inferredEdge],
      manualEdges: [],
      inferredStatus: {},
      edgeRoutes: {},
      edgeAnchors: {
        [fkEdge.id]: { source: { side: 'top', pos: 0.25 }, target: { side: 'left', pos: 0.6 } },
      },
    })
    const fk = doc.edges.find((e) => e.id === fkEdge.id)
    expect(fk?.sourceAnchor).toEqual({ side: 'top', pos: 0.25 })
    expect(fk?.targetAnchor).toEqual({ side: 'left', pos: 0.6 })
    const inf = doc.edges.find((e) => e.id === inferredEdge.id)
    expect(inf?.sourceAnchor).toBeUndefined()
    expect(inf?.targetAnchor).toBeUndefined()
  })
})

describe('锚点覆盖：文档 → 叠加层恢复', () => {
  it('恢复 sourceAnchor/targetAnchor；形状非法的条目丢弃、pos 越界钳制到 0-1', () => {
    const doc: ErModelDoc = {
      formatVersion: 1,
      kind: 'mysql',
      database: 'db',
      origin: { connectionName: '本地', capturedAt: '2026-01-01T00:00:00Z' },
      tables: [],
      edges: [
        {
          id: 'e1',
          kind: 'fk',
          source: { table: 'a', column: 'x' },
          target: { table: 'b', column: 'id' },
          sourceAnchor: { side: 'top', pos: 0.3 },
          targetAnchor: { side: 'left', pos: 1.7 },
        },
        {
          id: 'e2',
          kind: 'fk',
          source: { table: 'c', column: 'x' },
          target: { table: 'd', column: 'id' },
          // side 不在枚举内：整条覆盖丢弃
          sourceAnchor: { side: 'center', pos: 0.5 } as unknown as ErModelDoc['edges'][number]['sourceAnchor'],
        },
      ],
    }
    const o = docOverlay(doc)
    expect(o.edgeAnchors['e1']).toEqual({
      source: { side: 'top', pos: 0.3 },
      target: { side: 'left', pos: 1 },
    })
    expect(o.edgeAnchors['e2']).toBeUndefined()
  })
})

describe('inferredLayoutEdges：参与布局的推断边', () => {
  const mk = (id: string): ErEdgeInfo => ({
    id,
    kind: 'inferred',
    sourceTable: 's',
    sourceColumns: ['c'],
    targetTable: 't',
    targetColumns: ['id'],
  })
  const edges = [mk('a'), mk('b'), mk('c'), mk('d')]

  it('ignored 排除；confirmed 优先于未裁决', () => {
    const status: Record<string, 'confirmed' | 'ignored'> = {
      a: 'confirmed',
      d: 'ignored',
    }
    const result = inferredLayoutEdges(edges, status, 10)
    // confirmed a 优先，ignored d 排除，pending b、c 随后
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('limit 截断未裁决候选，confirmed 全部保留', () => {
    const status: Record<string, 'confirmed' | 'ignored'> = {
      a: 'confirmed',
      b: 'confirmed',
    }
    const result = inferredLayoutEdges(edges, status, 3)
    // a、b 已确认不受限；剩余 1 个配额给 pending c
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('placeFreshTables：库里新增表的堆叠摆放', () => {
  it('新表摆在画布左侧，纵向堆叠', () => {
    const pos = placeFreshTables(['new_a', 'new_b', 'new_c'], { minX: 100, minY: 50 })
    expect(Object.keys(pos)).toHaveLength(3)
    expect(pos['new_a']).toEqual({ x: 100 - 460, y: 50 })
    expect(pos['new_b'].y).toBeGreaterThan(pos['new_a'].y)
    expect(pos['new_c'].x).toBe(pos['new_a'].x)
  })

  it('空列表返回空', () => {
    expect(placeFreshTables([], { minX: 0, minY: 0 })).toEqual({})
  })
})

// ───────────────── 图上建模：buildErGraph 融合模型表（二期 A） ─────────────────

import type { ErTableSchema } from '../../api/types'
import type { ModelTableState } from './modelSchema'

describe('buildErGraph 模型表融合', () => {
  const modelSnap: ErSnapshot = {
    tables: [
      {
        name: 'orders', engine: null, collation: null, comment: null,
        columns: [
          { name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null },
          { name: 'uid', dataType: 'bigint', nullable: true, default: null, extra: '', comment: null, ordinal: 2, characterSet: null, collation: null },
        ],
        indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
      },
      {
        name: 'users', engine: null, collation: null, comment: null,
        columns: [{ name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, ordinal: 1, characterSet: null, collation: null }],
        indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
      },
    ],
    foreignKeys: [
      { name: 'fk_ou', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: null, onUpdate: null },
    ],
    serverVersion: '8.0.36',
  }

  const ordersSchema = (fks: ErTableSchema['foreignKeys'], comment: string | null = null): ErTableSchema => ({
    name: 'orders', engine: null, collation: null, comment,
    columns: [
      { name: 'id', dataType: 'bigint', nullable: false, default: null, extra: '', comment: null, characterSet: null, collation: null },
      { name: 'uid', dataType: 'bigint', nullable: true, default: null, extra: '', comment: null, characterSet: null, collation: null },
    ],
    indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
    foreignKeys: fks,
  })

  it('无 modelTables 时行为不变（纯浏览态）', () => {
    const g = buildErGraph(modelSnap)
    expect(Object.keys(g.tables)).toHaveLength(2)
    expect(g.fkEdges).toHaveLength(1)
    expect(g.mfkEdges).toEqual([])
    expect(g.tables.orders.modelStatus).toBeUndefined()
  })

  it('编辑表以文档 schema 渲染并标 edited；tombstone 标 deleted', () => {
    const modelTables: Record<string, ModelTableState> = {
      orders: { schema: ordersSchema([], '改过'), deleted: false },
      users: { schema: null, deleted: true },
    }
    const g = buildErGraph(modelSnap, modelTables)
    expect(g.tables.orders.modelStatus).toBe('edited')
    expect(g.tables.orders.comment).toBe('改过')
    expect(g.tables.users.modelStatus).toBe('deleted')
    expect(g.tables.users.columns).toHaveLength(1) // 结构仍来自快照
  })

  it('模型表删掉的库 FK 不再出边；保留的 FK 仍是 fk 边；新增模型 FK 出 mfk 边', () => {
    // orders 被 copy-on-edit 且 schema.foreignKeys 为空 → 库里的 fk_ou 应消失（待应用 DROP）
    const dropped = buildErGraph(modelSnap, { orders: { schema: ordersSchema([]), deleted: false } })
    expect(dropped.fkEdges).toHaveLength(0)
    expect(dropped.mfkEdges).toHaveLength(0)

    // schema 保留同名 FK → 仍是 fk 边（真实存在于库）
    const kept = buildErGraph(modelSnap, {
      orders: { schema: ordersSchema([{ name: 'fk_ou', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: null, onUpdate: null }]), deleted: false },
    })
    expect(kept.fkEdges).toHaveLength(1)
    expect(kept.mfkEdges).toHaveLength(0)

    // 模型新 FK（库没有）→ mfk 边，id 为 mfk:{表}:{约束名}
    const added = buildErGraph(modelSnap, {
      orders: { schema: ordersSchema([{ name: 'fk_new', table: 'orders', columns: ['uid'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: null }]), deleted: false },
    })
    expect(added.mfkEdges).toHaveLength(1)
    expect(added.mfkEdges[0]).toMatchObject({ id: 'mfk:orders:fk_new', kind: 'mfk', onDelete: 'CASCADE' })
  })

  it('新建表（库没有）来自 schema 并标 new', () => {
    const g = buildErGraph(modelSnap, {
      brand_new: { schema: {
        name: 'brand_new', engine: 'InnoDB', collation: null, comment: null,
        columns: [{ name: 'id', dataType: 'int', nullable: false, default: null, extra: '', comment: null, characterSet: null, collation: null }],
        indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
        foreignKeys: [],
      }, deleted: false },
    })
    expect(g.tables.brand_new.modelStatus).toBe('new')
    expect(g.tables.brand_new.singlePrimaryKey).toBe('id')
  })

  it('tombstone 且库里已不存在的条目被丢弃', () => {
    const g = buildErGraph(modelSnap, { ghost: { schema: null, deleted: true } })
    expect(g.tables.ghost).toBeUndefined()
  })
})
