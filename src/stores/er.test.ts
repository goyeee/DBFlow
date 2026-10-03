import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ErModelDoc, ErSnapshot } from '../api/types'

vi.mock('../api/commands', () => ({ api: {} }))

import { api } from '../api/commands'
import { useErStore } from './er'

const KEY_A = 'c1/db1/__er__'
const KEY_B = 'c1/db2/__er__'

type ColType = ErSnapshot['tables'][number]['columns'][number]

function col(name: string, extra?: Partial<ColType>): ColType {
  return {
    name,
    dataType: 'bigint unsigned',
    nullable: true,
    default: null,
    extra: '',
    comment: null,
    ordinal: 1,
    characterSet: null,
    collation: null,
    ...extra,
  }
}

/** 构造表：主键名 = 表名 + ID（项目命名约定） */
function makeTable(
  name: string,
  pkName: string,
  other: { name: string; extra?: Partial<ColType> }[],
): ErSnapshot['tables'][number] {
  return {
    name,
    engine: null,
    collation: null,
    comment: null,
    columns: [col(pkName, { nullable: false }), ...other.map((c) => col(c.name, c.extra))],
    indexes: [
      {
        name: 'PRIMARY',
        columns: [pkName],
        subParts: [null],
        directions: [null],
        unique: true,
        isPrimary: true,
        indexType: 'BTREE',
      },
    ],
  }
}

/** orders=true 时加一张 orders 表（含 usersID 引用列） */
function snapWith(orders: boolean): ErSnapshot {
  const tables = [
    makeTable('users', 'usersID', [{ name: 'name', extra: { dataType: 'varchar(64)' } }]),
    makeTable('user_roles', 'user_rolesID', [{ name: 'usersID' }]),
  ]
  if (orders) {
    tables.push(
      makeTable('orders', 'ordersID', [
        { name: 'usersID' },
        { name: 'amount', extra: { dataType: 'decimal(12,2)' } },
      ]),
    )
  }
  return {
    tables,
    foreignKeys: [
      {
        name: 'fk_ur_user',
        table: 'user_roles',
        columns: ['usersID'],
        refTable: 'users',
        refColumns: ['usersID'],
        onDelete: null,
        onUpdate: null,
      },
    ],
    serverVersion: '8.4.11',
  }
}

const savedDoc: ErModelDoc = {
  formatVersion: 1,
  kind: 'mysql',
  database: 'db1',
  origin: { connectionName: '本地', capturedAt: '2026-01-01T00:00:00Z' },
  tables: [
    { id: 'users', name: 'users', x: 100, y: 200, collapsed: false },
    { id: 'user_roles', name: 'user_roles', x: 400, y: 200, collapsed: true },
  ],
  edges: [],
}

function mockApi(snapshot: ErSnapshot, doc: ErModelDoc | null) {
  ;(api as Record<string, unknown>).getErSnapshot = vi.fn().mockResolvedValue(snapshot)
  ;(api as Record<string, unknown>).loadErModel = vi.fn().mockResolvedValue(doc)
  ;(api as Record<string, unknown>).saveErModel = vi.fn().mockResolvedValue(undefined)
}

const initialState = useErStore.getState()

beforeEach(() => {
  useErStore.setState(initialState, true)
})

const INF_ID = 'inf:orders.usersID->users.usersID'

describe('ER store：加载', () => {
  it('无文档时全量 dagre 布局，推断边产出，非脏', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.status).toBe('ready')
    expect(t.error).toBeNull()
    expect(t.database).toBe('db1')
    for (const name of ['users', 'user_roles', 'orders']) {
      expect(Number.isFinite(t.positions[name].x)).toBe(true)
    }
    // user_roles.usersID 被真实 FK 覆盖；orders.usersID 推断
    expect(t.inferredEdges.map((e) => e.id)).toEqual([INF_ID])
    expect(t.dirty).toBe(false)
  })

  it('有文档时恢复保存的位置；快照新增的表堆叠在左侧', async () => {
    mockApi(snapWith(true), savedDoc)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.positions['users']).toEqual({ x: 100, y: 200 })
    expect(t.positions['user_roles']).toEqual({ x: 400, y: 200 })
    expect(t.collapsed['user_roles']).toBe(true)
    // orders 不在文档里 → 摆在已知布局左侧
    expect(t.positions['orders'].x).toBeLessThan(100)
  })

  it('加载失败进入 error 态', async () => {
    ;(api as Record<string, unknown>).getErSnapshot = vi
      .fn()
      .mockRejectedValue({ code: 'x', message: '连接丢失' })
    ;(api as Record<string, unknown>).loadErModel = vi.fn().mockResolvedValue(null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.status).toBe('error')
    expect(t.error).toContain('连接丢失')
  })
})

describe('ER store：多标签分片隔离', () => {
  it('加载 B 不覆盖 A：两个分片各自独立保留', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    useErStore.getState().moveTable(KEY_A, 'users', 71, 72)
    // 打开第二个库（getErSnapshot 同一 mock 返回相同快照即可）
    await useErStore.getState().load(KEY_B, 'c1', 'db2', '本地')
    const store = useErStore.getState()
    // A 的编辑与状态仍在，未被 B 的加载 reset
    expect(store.tabs[KEY_A].status).toBe('ready')
    expect(store.tabs[KEY_A].positions['users']).toEqual({ x: 71, y: 72 })
    expect(store.tabs[KEY_A].dirty).toBe(true)
    expect(store.tabs[KEY_B].status).toBe('ready')
    expect(store.tabs[KEY_B].database).toBe('db2')
  })

  it('慢响应（旧代次）resolve 后不覆盖新代次结果', async () => {
    const smallSnap: ErSnapshot = {
      tables: [makeTable('users', 'usersID', [])],
      foreignKeys: [],
      serverVersion: null,
    }
    let resolveFirst!: (s: ErSnapshot) => void
    ;(api as Record<string, unknown>).getErSnapshot = vi
      .fn()
      // 第一次 load（seq1）：挂起的 promise
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      // 第二次 load（seq2）：立即返回 3 表快照
      .mockImplementationOnce(() => Promise.resolve(snapWith(true)))
    ;(api as Record<string, unknown>).loadErModel = vi.fn().mockResolvedValue(null)

    const store = useErStore.getState()
    const p1 = store.load(KEY_A, 'c1', 'db1', '本地') // seq1，未完成
    const p2 = store.load(KEY_A, 'c1', 'db1', '本地') // seq2
    await p2
    expect(useErStore.getState().tabs[KEY_A].requestSeq).toBe(2)

    // seq1 迟来的结果只有 1 张表；若被错误采用会把图覆盖成 1 表
    resolveFirst(smallSnap)
    await p1
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.requestSeq).toBe(2)
    expect(Object.keys(t.graph!.tables)).toHaveLength(3)
  })

  it('purgeTabs 只删传入的分片；dirtyKeys 返回所有脏标签', async () => {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    await useErStore.getState().load(KEY_B, 'c1', 'db2', '本地')
    useErStore.getState().moveTable(KEY_A, 'users', 1, 2)
    expect(useErStore.getState().dirtyKeys().sort()).toEqual([KEY_A])
    useErStore.getState().purgeTabs([KEY_B])
    const tabs = useErStore.getState().tabs
    expect(tabs[KEY_B]).toBeUndefined()
    expect(tabs[KEY_A]).toBeDefined()
  })
})

describe('ER store：编辑与保存', () => {
  async function ready() {
    mockApi(snapWith(true), null)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
  }

  it('移动/折叠/裁决推断边都会置脏', async () => {
    await ready()
    useErStore.getState().moveTable(KEY_A, 'users', 11, 22)
    expect(useErStore.getState().tabs[KEY_A].dirty).toBe(true)
    expect(useErStore.getState().tabs[KEY_A].positions['users']).toEqual({ x: 11, y: 22 })
    useErStore.getState().setCollapsed(KEY_A, 'users', true)
    expect(useErStore.getState().tabs[KEY_A].collapsed['users']).toBe(true)
    useErStore.getState().adjudicateInferred(KEY_A, INF_ID, 'confirmed')
    expect(useErStore.getState().tabs[KEY_A].inferredStatus[INF_ID]).toBe('confirmed')
    // reset 清除裁决
    useErStore.getState().adjudicateInferred(KEY_A, INF_ID, 'reset')
    expect(useErStore.getState().tabs[KEY_A].inferredStatus[INF_ID]).toBeUndefined()
  })

  it('relayout 用 dagre 重排所有表并置脏', async () => {
    await ready()
    useErStore.getState().moveTable(KEY_A, 'users', 9999, 9999)
    useErStore.getState().relayout(KEY_A)
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.dirty).toBe(true)
    expect(t.positions['users'].x).toBeLessThan(9999)
  })

  it('setEdgeRoute 记录连线路径并置脏；空数组清除', async () => {
    await ready()
    const via = [{ x: 300, y: 120 }]
    useErStore.getState().setEdgeRoute(KEY_A, INF_ID, via)
    let t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeRoutes[INF_ID]).toEqual(via)
    expect(t.dirty).toBe(true)
    useErStore.getState().setEdgeRoute(KEY_A, INF_ID, [])
    t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeRoutes[INF_ID]).toBeUndefined()
  })

  it('加载时恢复文档里的连线路径；指向已不存在连线的路径被丢弃', async () => {
    const doc: ErModelDoc = {
      ...savedDoc,
      edges: [
        {
          id: INF_ID,
          kind: 'inferred',
          via: [{ x: 260, y: 80 }],
          source: { table: 'orders', column: 'usersID' },
          target: { table: 'users', column: 'usersID' },
        },
        {
          id: 'man:ghost.a->ghost.b',
          kind: 'manual',
          via: [{ x: 1, y: 1 }],
          source: { table: 'ghost', column: 'a' },
          target: { table: 'ghost', column: 'b' },
        },
      ],
    }
    mockApi(snapWith(true), doc)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeRoutes[INF_ID]).toEqual([{ x: 260, y: 80 }])
    // 表/列不存在的手动边连同其路径一起被丢弃
    expect(t.edgeRoutes['man:ghost.a->ghost.b']).toBeUndefined()
    expect(t.manualEdges.find((e) => e.id === 'man:ghost.a->ghost.b')).toBeUndefined()
  })

  it('save 把连线路径写进文档 via 字段', async () => {
    await ready()
    useErStore.getState().setEdgeRoute(KEY_A, INF_ID, [{ x: 9, y: 9 }])
    await useErStore.getState().save(KEY_A)
    const doc = (api.saveErModel as ReturnType<typeof vi.fn>).mock.calls[0][2] as ErModelDoc
    expect(doc.edges.find((e) => e.id === INF_ID)?.via).toEqual([{ x: 9, y: 9 }])
  })

  it('relayout 清空连线路径；undo 同时恢复位置与路径', async () => {
    await ready()
    const via = [{ x: 300, y: 120 }]
    useErStore.getState().setEdgeRoute(KEY_A, INF_ID, via)
    useErStore.getState().relayout(KEY_A)
    let t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeRoutes).toEqual({})
    useErStore.getState().undo(KEY_A)
    t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeRoutes[INF_ID]).toEqual(via)
  })

  it('setEdgeAnchor 设置/清除锚点覆盖并置脏；两端都清除时删除记录', async () => {
    await ready()
    useErStore.getState().setEdgeAnchor(KEY_A, INF_ID, 'source', { side: 'top', pos: 0.3 })
    let t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[INF_ID]).toEqual({ source: { side: 'top', pos: 0.3 } })
    expect(t.dirty).toBe(true)
    useErStore.getState().setEdgeAnchor(KEY_A, INF_ID, 'target', { side: 'left', pos: 0.6 })
    t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[INF_ID]?.target).toEqual({ side: 'left', pos: 0.6 })
    // 清掉一端，另一端保留
    useErStore.getState().setEdgeAnchor(KEY_A, INF_ID, 'source', null)
    t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[INF_ID]).toEqual({ target: { side: 'left', pos: 0.6 } })
    // 两端都清除 → 整条记录删除
    useErStore.getState().setEdgeAnchor(KEY_A, INF_ID, 'target', null)
    t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[INF_ID]).toBeUndefined()
  })

  it('加载时恢复文档里的锚点覆盖；指向已不存在连线的覆盖被丢弃', async () => {
    const doc: ErModelDoc = {
      ...savedDoc,
      edges: [
        {
          id: INF_ID,
          kind: 'inferred',
          source: { table: 'orders', column: 'usersID' },
          target: { table: 'users', column: 'usersID' },
          sourceAnchor: { side: 'top', pos: 0.4 },
        },
        {
          id: 'man:ghost.a->ghost.b',
          kind: 'manual',
          source: { table: 'ghost', column: 'a' },
          target: { table: 'ghost', column: 'b' },
          targetAnchor: { side: 'bottom', pos: 0.2 },
        },
      ],
    }
    mockApi(snapWith(true), doc)
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[INF_ID]).toEqual({ source: { side: 'top', pos: 0.4 } })
    expect(t.edgeAnchors['man:ghost.a->ghost.b']).toBeUndefined()
  })

  it('save 把锚点覆盖写进文档；relayout 清空锚点覆盖，undo 恢复', async () => {
    await ready()
    useErStore.getState().setEdgeAnchor(KEY_A, INF_ID, 'target', { side: 'bottom', pos: 0.7 })
    await useErStore.getState().save(KEY_A)
    const doc = (api.saveErModel as ReturnType<typeof vi.fn>).mock.calls[0][2] as ErModelDoc
    expect(doc.edges.find((e) => e.id === INF_ID)?.targetAnchor).toEqual({
      side: 'bottom',
      pos: 0.7,
    })
    useErStore.getState().relayout(KEY_A)
    let t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors).toEqual({})
    useErStore.getState().undo(KEY_A)
    t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[INF_ID]).toEqual({ target: { side: 'bottom', pos: 0.7 } })
  })

  it('removeManualEdge 连带删除其锚点覆盖', async () => {
    await ready()
    const r = useErStore.getState().addManualEdge(KEY_A, {
      sourceTable: 'orders',
      sourceColumn: 'amount',
      targetTable: 'users',
      targetColumn: 'usersID',
    })
    expect(r.ok).toBe(true)
    const manId = 'man:orders.amount->users.usersID'
    useErStore.getState().setEdgeAnchor(KEY_A, manId, 'source', { side: 'top', pos: 0.1 })
    useErStore.getState().removeManualEdge(KEY_A, manId)
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.edgeAnchors[manId]).toBeUndefined()
  })

  it('addManualEdge/removeManualEdge：新增、去重、删除手动关联', async () => {
    await ready()
    // 手动在 orders.amount 与 users.usersID 之间建一条关联（任意两列即可）
    const r = useErStore.getState().addManualEdge(KEY_A, {
      sourceTable: 'orders',
      sourceColumn: 'amount',
      targetTable: 'users',
      targetColumn: 'usersID',
    })
    expect(r.ok).toBe(true)
    let t = useErStore.getState().tabs[KEY_A]
    const manId = 'man:orders.amount->users.usersID'
    expect(t.manualEdges).toHaveLength(1)
    expect(t.manualEdges[0].id).toBe(manId)
    expect(t.dirty).toBe(true)

    // 重复添加同一关联 → 拒绝
    expect(
      useErStore.getState().addManualEdge(KEY_A, {
        sourceTable: 'orders',
        sourceColumn: 'amount',
        targetTable: 'users',
        targetColumn: 'usersID',
      }),
    ).toMatchObject({ ok: false, error: '该关联已存在' })

    // 删除
    useErStore.getState().removeManualEdge(KEY_A, manId)
    t = useErStore.getState().tabs[KEY_A]
    expect(t.manualEdges).toHaveLength(0)
  })

  it('save 生成含布局与裁决的文档并清脏', async () => {
    await ready()
    useErStore.getState().moveTable(KEY_A, 'users', 5, 6)
    useErStore.getState().adjudicateInferred(KEY_A, INF_ID, 'ignored')
    await useErStore.getState().save(KEY_A)
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.dirty).toBe(false)
    expect(api.saveErModel).toHaveBeenCalledTimes(1)
    const doc = (api.saveErModel as ReturnType<typeof vi.fn>).mock.calls[0][2] as ErModelDoc
    expect(doc.formatVersion).toBe(2)
    expect(doc.origin.connectionName).toBe('本地')
    expect(doc.tables.find((x) => x.name === 'users')).toMatchObject({ x: 5, y: 6 })
    expect(doc.edges.find((e) => e.id === INF_ID)?.status).toBe('ignored')
  })

  it('save 失败时保留 dirty', async () => {
    await ready()
    useErStore.getState().moveTable(KEY_A, 'users', 5, 6)
    ;(api as Record<string, unknown>).saveErModel = vi
      .fn()
      .mockRejectedValue(new Error('磁盘只读'))
    await expect(useErStore.getState().save(KEY_A)).rejects.toThrow(/磁盘/)
    expect(useErStore.getState().tabs[KEY_A].dirty).toBe(true)
  })

  it('adjudicateAll 批量确认所有未裁决推断边', async () => {
    await ready()
    const before = useErStore.getState().tabs[KEY_A]
    const pending = before.inferredEdges.filter((e) => !before.inferredStatus[e.id])
    expect(pending.length).toBeGreaterThan(0)
    useErStore.getState().adjudicateAll(KEY_A, 'confirmed')
    const after = useErStore.getState().tabs[KEY_A]
    for (const e of after.inferredEdges) {
      expect(after.inferredStatus[e.id]).toBe('confirmed')
    }
    expect(after.dirty).toBe(true)
  })

  it('模型文档读取失败时记录 docIssue，但仍正常出图', async () => {
    ;(api as Record<string, unknown>).getErSnapshot = vi
      .fn()
      .mockResolvedValue(snapWith(true))
    ;(api as Record<string, unknown>).loadErModel = vi
      .fn()
      .mockRejectedValue(new Error('JSON 解析失败'))
    await useErStore.getState().load(KEY_A, 'c1', 'db1', '本地')
    const t = useErStore.getState().tabs[KEY_A]
    expect(t.status).toBe('ready')
    expect(t.docIssue).toContain('JSON')
    useErStore.getState().dismissDocIssue(KEY_A)
    expect(useErStore.getState().tabs[KEY_A].docIssue).toBeNull()
  })
})
