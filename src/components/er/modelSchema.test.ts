import { describe, expect, it } from 'vitest'

import type { ErTableDef, ErTableSchema } from '../../api/types'
import {
  buildErDiffPayload,
  newTableSchema,
  nextNewTableName,
  schemaToErTable,
  schemasEqual,
  snapshotTableToSchema,
  validateDeleteTable,
  validateTableSchema,
} from './modelSchema'

function col(name: string, extra?: Partial<ErTableSchema['columns'][number]>) {
  return { name, dataType: 'int', nullable: true, default: null, extra: '', comment: null, characterSet: null, collation: null, ...extra }
}
function schema(name: string, over?: Partial<ErTableSchema>): ErTableSchema {
  return {
    name,
    engine: 'InnoDB',
    collation: null,
    comment: null,
    columns: [col('id', { nullable: false }), col('name', { dataType: 'varchar(20)' })],
    indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
    foreignKeys: [],
    ...over,
  }
}

describe('schemaToErTable', () => {
  it('主键/单列唯一分类与快照转换同规则', () => {
    const s = schema('t', {
      indexes: [
        { name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
        { name: 'uk_name', columns: ['name'], subParts: [null], directions: [null], unique: true, isPrimary: false, indexType: 'BTREE' },
      ],
    })
    const t = schemaToErTable(s)
    expect(t.name).toBe('t')
    expect(t.columns[0].key).toBe('pk')
    expect(t.columns[1].key).toBe('unique')
    expect(t.singlePrimaryKey).toBe('id')
  })
})

describe('snapshotTableToSchema / newTableSchema / nextNewTableName', () => {
  it('快照表全量拷贝为模型 schema（含该表的库外键——丢了会被 diff 判成待 DROP）', () => {
    const t: ErTableDef = {
      name: 'orders',
      engine: 'InnoDB',
      collation: 'utf8mb4_general_ci',
      comment: '订单',
      columns: [{ name: 'id', dataType: 'bigint unsigned', nullable: false, default: null, extra: 'auto_increment', comment: '主键', ordinal: 1, characterSet: null, collation: null }],
      indexes: [{ name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }],
    }
    const fk = { name: 'fk_u', table: 'orders', columns: ['id'], refTable: 'users', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: null }
    const s = snapshotTableToSchema(t, [fk, { ...fk, name: 'other', table: 'other_tbl' }])
    expect(s.name).toBe('orders')
    expect(s.columns[0].extra).toBe('auto_increment')
    expect(s.collation).toBe('utf8mb4_general_ci')
    // 只收本表的外键，原样拷贝
    expect(s.foreignKeys).toEqual([fk])
  })

  it('schemasEqual：字段级深比较（含 cs/collation/FK），key 顺序无关', () => {
    const a = schema('t')
    const b = JSON.parse(JSON.stringify(a)) as typeof a
    // 打乱对象 key 顺序不影响
    const shuffled = {
      indexes: b.indexes,
      foreignKeys: b.foreignKeys,
      comment: b.comment,
      collation: b.collation,
      engine: b.engine,
      name: b.name,
      columns: b.columns.map((c: typeof b.columns[number]) =>
        JSON.parse(
          JSON.stringify({
            default: c.default, comment: c.comment, characterSet: c.characterSet,
            collation: c.collation, nullable: c.nullable, extra: c.extra,
            dataType: c.dataType, name: c.name,
          }),
        ),
      ),
    } as typeof a
    expect(schemasEqual(a, shuffled)).toBe(true)
    // 任一字段不同即不等
    expect(schemasEqual(a, { ...b, collation: 'utf8mb4_bin' })).toBe(false)
    expect(schemasEqual(a, { ...b, columns: [...b.columns, { name: 'x', dataType: 'int', nullable: true, default: null, extra: '', comment: null, characterSet: null, collation: null }] })).toBe(false)
    expect(schemasEqual(a, { ...b, foreignKeys: [{ name: 'f', table: 't', columns: ['id'], refTable: 'u', refColumns: ['id'], onDelete: null, onUpdate: null }] })).toBe(false)
    // 列级 characterSet 不同也不等（假角标防线）
    expect(schemasEqual(a, { ...b, columns: [b.columns[0], { ...b.columns[1], characterSet: 'utf8mb4' }] })).toBe(false)
    // 表名忽略大小写（服务器大小写差异不算改动）
    expect(schemasEqual(a, { ...b, name: 'T' })).toBe(true)
  })

  it('新表预填 id 主键', () => {
    const s = newTableSchema('t_new')
    expect(s.columns).toHaveLength(1)
    expect(s.columns[0]).toMatchObject({ name: 'id', dataType: 'bigint unsigned', extra: 'auto_increment' })
    expect(s.indexes[0].isPrimary).toBe(true)
  })
  it('默认名递增且避开既有表（忽略大小写）', () => {
    expect(nextNewTableName([])).toBe('new_table_1')
    expect(nextNewTableName(['new_table_1', 'New_Table_2'])).toBe('new_table_3')
  })
})

describe('validateTableSchema', () => {
  const others = new Set(['users'])
  it('正常 schema 通过', () => {
    expect(validateTableSchema(schema('orders'), others)).toBeNull()
  })
  it('重名（忽略大小写）/空名/0列/重复列名/空类型拒绝', () => {
    expect(validateTableSchema(schema('Users'), others)).toContain('同名')
    expect(validateTableSchema(schema(' '), others)).toContain('表名')
    expect(validateTableSchema(schema('t', { columns: [] }))).toContain('至少需要一列')
    expect(validateTableSchema(schema('t', { columns: [col('id'), col('ID')] }))).toContain('重复列名')
    expect(validateTableSchema(schema('t', { columns: [col('id', { dataType: ' ' })] }))).toContain('类型')
  })
  it('索引引用不存在的列 / 双主键 / 重复索引名拒绝', () => {
    expect(
      validateTableSchema(schema('t', { indexes: [{ name: 'idx_x', columns: ['nope'], subParts: [null], directions: [null], unique: false, isPrimary: false, indexType: 'BTREE' }] })),
    ).toContain('不存在的列')
    const p2 = { name: 'P2', columns: ['name'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' }
    expect(validateTableSchema(schema('t', { indexes: [...schema('t').indexes, p2] }))).toContain('一个主键')
    expect(validateTableSchema(schema('t', { indexes: [...schema('t').indexes, { ...p2, name: 'PRIMARY', isPrimary: false, unique: false }] }))).toContain('重复索引名')
  })
  it('FK 列数不匹配 / 引用本表不存在列 / 重复外键名拒绝', () => {
    const fk = (name: string, cols: string[], rc: string[]) => ({ name, table: 't', columns: cols, refTable: 'u', refColumns: rc, onDelete: null, onUpdate: null })
    expect(validateTableSchema(schema('t', { foreignKeys: [fk('f1', ['id'], ['a', 'b'])] }))).toContain('不匹配')
    expect(validateTableSchema(schema('t', { foreignKeys: [fk('f1', ['ghost'], ['a'])] }))).toContain('不存在的列')
    expect(validateTableSchema(schema('t', { foreignKeys: [fk('f1', ['id'], ['a']), fk('F1', ['id'], ['a'])] }))).toContain('重复外键名')
  })
})

describe('validateDeleteTable', () => {
  it('被其他模型表外键引用时阻止', () => {
    const fk = { name: 'f1', table: 'child', columns: ['pid'], refTable: 'parent', refColumns: ['id'], onDelete: null, onUpdate: null }
    const modelTables = { child: { schema: schema('child', { foreignKeys: [fk] }), deleted: false } }
    expect(validateDeleteTable('parent', modelTables)).toContain('先删除')
    expect(validateDeleteTable('other', modelTables)).toBeNull()
  })
})

describe('buildErDiffPayload', () => {
  it('只含有建模痕迹的表；tombstone 的 schema 为 null；表名用服务器原始大小写', () => {
    const modelTables = {
      orders: { schema: schema('orders'), deleted: false },
      legacy: { schema: null, deleted: true },
    }
    const payload = buildErDiffPayload(modelTables, { orders: 'Orders', legacy: 'legacy' })
    expect(payload).toEqual([
      { name: 'Orders', schema: modelTables.orders.schema },
      { name: 'legacy', schema: null },
    ])
  })
  it('tombstone 保留 schema 时 payload 仍传 null（删除优先）', () => {
    const modelTables = { edited_then_del: { schema: schema('x'), deleted: true } }
    const payload = buildErDiffPayload(modelTables, {})
    expect(payload).toEqual([{ name: 'edited_then_del', schema: null }])
  })
})

// ───────────────── 评审修复：设计器列草稿三态默认值 / FK 拖线方向 ─────────────────

import { colDraftToSchema, normalizeFkDirection, schemaToColDraft } from './modelSchema'
import type { ErGraph } from './transform'

  describe("设计器列草稿：默认值三态（无默认 ≠ DEFAULT '')", () => {
  const base = { name: 'name', dataType: 'varchar(20)', nullable: false, default: null, extra: '', autoInc: false, comment: '', extraRest: '', characterSet: null, collation: null }
  it("DEFAULT '' 经草稿往返无损（不再被静默剥离成无默认）", () => {
    const draft = schemaToColDraft({ ...base, default: '' })
    expect(draft.default).toBe('')
    expect(colDraftToSchema(draft).default).toBe('')
  })
  it('无默认（null）经草稿往返保持 null', () => {
    const draft = schemaToColDraft({ ...base, default: null })
    expect(draft.default).toBeNull()
    expect(colDraftToSchema(draft).default).toBeNull()
  })
})

describe('normalizeFkDirection：主键端作为被引用方（与手动关联同规则）', () => {
  const graph: ErGraph = {
    tables: {
      users: { name: 'users', comment: null, columns: [], indexes: [], singlePrimaryKey: 'id' },
      orders: { name: 'orders', comment: null, columns: [], indexes: [], singlePrimaryKey: null },
    },
    fkEdges: [],
    mfkEdges: [],
  }
  it('从父表主键拖向子表列 → 方向交换（子表作为 FK 所在表）', () => {
    const r = normalizeFkDirection(graph, {
      sourceTable: 'users', sourceColumn: 'id',
      targetTable: 'orders', targetColumn: 'user_id',
    })
    expect(r).toEqual({
      sourceTable: 'orders', sourceColumn: 'user_id',
      targetTable: 'users', targetColumn: 'id',
    })
  })
  it('正常方向（子表 → 父表主键）不动；两端都非主键也不动', () => {
    const normal = { sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', targetColumn: 'id' }
    expect(normalizeFkDirection(graph, normal)).toEqual(normal)
    const none = { sourceTable: 'orders', sourceColumn: 'a', targetTable: 'users', targetColumn: 'b' }
    expect(normalizeFkDirection(graph, none)).toEqual(none)
  })
})
