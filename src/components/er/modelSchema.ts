import type {
  ErColumnSchema,
  ErFkSchema,
  ErModelTableInput,
  ErTableDef,
  ErTableSchema,
  ForeignKeyDef,
} from '../../api/types'
import type { ErGraph, ErTable } from './transform'

/** 图上建模的表状态：schema 存在即「模型为准」；deleted=true 为待删除 tombstone */
export interface ModelTableState {
  schema: ErTableSchema | null
  deleted: boolean
}

/** 模型 schema → 画布表结构（主键/单列唯一分类与快照转换同规则） */
export function schemaToErTable(schema: ErTableSchema): ErTable {
  const pkIndex = schema.indexes.find((i) => i.isPrimary)
  const pkCols = new Set(pkIndex?.columns ?? [])
  const singleUniqueCols = new Set(
    schema.indexes
      .filter((i) => i.unique && !i.isPrimary && i.columns.length === 1)
      .flatMap((i) => i.columns),
  )
  return {
    name: schema.name,
    comment: schema.comment,
    singlePrimaryKey: pkIndex && pkIndex.columns.length === 1 ? pkIndex.columns[0] : null,
    indexes: schema.indexes.map((i) => ({
      name: i.name,
      columns: i.columns,
      unique: i.unique,
      primary: i.isPrimary,
      indexType: i.indexType,
    })),
    columns: schema.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      key: pkCols.has(c.name) ? 'pk' : singleUniqueCols.has(c.name) ? 'unique' : 'none',
      default: c.default,
      comment: c.comment,
    })),
  }
}

/** 实时快照表 → 模型 schema（copy-on-edit 的拷贝源）。
 *  fks = 该表在库里的外键（调用方从 snapshot.foreignKeys 按 table 过滤）——
 *  必须带上：丢掉会被 diff 判成「模型删了这些 FK」→ 待 DROP 危险项 + 画布隐藏真实 FK 边 */
export function snapshotTableToSchema(t: ErTableDef, fks: ForeignKeyDef[]): ErTableSchema {
  return {
    name: t.name,
    engine: t.engine,
    collation: t.collation,
    comment: t.comment,
    columns: t.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      default: c.default,
      extra: c.extra,
      comment: c.comment,
      characterSet: c.characterSet,
      collation: c.collation,
    })),
    indexes: t.indexes.map((i) => ({
      name: i.name,
      columns: [...i.columns],
      subParts: [...i.subParts],
      directions: [...i.directions],
      unique: i.unique,
      isPrimary: i.isPrimary,
      indexType: i.indexType,
    })),
    foreignKeys: fks
      .filter((f) => f.table.toLowerCase() === t.name.toLowerCase())
      .map((f) => ({
      name: f.name,
      table: f.table,
      columns: [...f.columns],
      refTable: f.refTable,
      refColumns: [...f.refColumns],
      onDelete: f.onDelete,
      onUpdate: f.onUpdate,
    })),
  }
}

/** 两份模型 schema 语义等价：字段级深比较（表名忽略大小写），不依赖 key 顺序 */
export function schemasEqual(a: ErTableSchema, b: ErTableSchema): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false
  if (a.engine !== b.engine || a.collation !== b.collation || a.comment !== b.comment) return false
  if (a.columns.length !== b.columns.length) return false
  for (let i = 0; i < a.columns.length; i++) {
    const x = a.columns[i]
    const y = b.columns[i]
    if (
      x.name !== y.name || x.dataType !== y.dataType || x.nullable !== y.nullable ||
      x.default !== y.default || x.extra !== y.extra || x.comment !== y.comment ||
      x.characterSet !== y.characterSet || x.collation !== y.collation
    ) return false
  }
  if (a.indexes.length !== b.indexes.length) return false
  for (let i = 0; i < a.indexes.length; i++) {
    const x = a.indexes[i]
    const y = b.indexes[i]
    if (
      x.name !== y.name || x.unique !== y.unique || x.isPrimary !== y.isPrimary ||
      x.indexType !== y.indexType ||
      x.columns.length !== y.columns.length ||
      x.columns.some((c, k) => c !== y.columns[k]) ||
      JSON.stringify(x.subParts) !== JSON.stringify(y.subParts) ||
      JSON.stringify(x.directions) !== JSON.stringify(y.directions)
    ) return false
  }
  if (a.foreignKeys.length !== b.foreignKeys.length) return false
  for (let i = 0; i < a.foreignKeys.length; i++) {
    const x = a.foreignKeys[i]
    const y = b.foreignKeys[i]
    if (
      x.name !== y.name || x.table !== y.table || x.refTable !== y.refTable ||
      x.onDelete !== y.onDelete || x.onUpdate !== y.onUpdate ||
      x.columns.length !== y.columns.length ||
      x.columns.some((c, k) => c !== y.columns[k]) ||
      x.refColumns.some((c, k) => c !== y.refColumns[k])
    ) return false
  }
  return true
}

/** 新建表初始 schema：预填 id 主键（可改可删） */
export function newTableSchema(name: string): ErTableSchema {
  return {
    name,
    engine: 'InnoDB',
    collation: null,
    comment: null,
    columns: [
      { name: 'id', dataType: 'bigint unsigned', nullable: false, default: null, extra: 'auto_increment', comment: null, characterSet: null, collation: null },
    ],
    indexes: [
      { name: 'PRIMARY', columns: ['id'], subParts: [null], directions: [null], unique: true, isPrimary: true, indexType: 'BTREE' },
    ],
    foreignKeys: [],
  }
}

/** 下一个可用新表名 new_table_N（忽略大小写避开既有表名） */
export function nextNewTableName(existing: string[]): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()))
  let n = 1
  while (taken.has(`new_table_${n}`)) n++
  return `new_table_${n}`
}

/** 表 schema 保存校验：返回错误文案，null = 通过。existingOthers = 其余表名（小写），缺省不查重 */
export function validateTableSchema(schema: ErTableSchema, existingOthers: Set<string> = new Set()): string | null {
  const name = schema.name.trim()
  if (!name) return '表名不能为空'
  if (existingOthers.has(name.toLowerCase())) return `已存在同名表「${name}」`
  if (schema.columns.length === 0) return '至少需要一列'
  const colNames = new Set<string>()
  for (const c of schema.columns) {
    if (!c.name.trim()) return '列名不能为空'
    if (!c.dataType.trim()) return `列「${c.name}」缺少类型`
    if (c.extra.toLowerCase().includes('auto_increment') && !isIntegerType(c.dataType))
      return `列「${c.name}」只有整数类型才能自增`
    if (c.extra.toLowerCase().includes('on update current_timestamp') && !isTemporalType(c.dataType))
      return `列「${c.name}」只有 timestamp/datetime 类型才能勾选更新时间`
    if (colNames.has(c.name.trim().toLowerCase())) return `存在重复列名「${c.name}」`
    colNames.add(c.name.trim().toLowerCase())
  }
  const idxNames = new Set<string>()
  let primaryCount = 0
  for (const i of schema.indexes) {
    if (!i.name.trim()) return '索引名不能为空'
    if (i.columns.length === 0) return `索引「${i.name}」至少需要一列`
    if (idxNames.has(i.name.trim().toLowerCase())) return `存在重复索引名「${i.name}」`
    for (const col of i.columns) {
      if (!colNames.has(col.trim().toLowerCase())) return `索引「${i.name}」引用了不存在的列「${col}」`
    }
    if (i.isPrimary) primaryCount++
    idxNames.add(i.name.trim().toLowerCase())
  }
  if (primaryCount > 1) return '只能有一个主键索引'
  const fkNames = new Set<string>()
  for (const fk of schema.foreignKeys) {
    if (!fk.name.trim()) return '外键名不能为空'
    if (!fk.refTable.trim()) return `外键「${fk.name}」缺少引用表`
    if (fkNames.has(fk.name.trim().toLowerCase())) return `存在重复外键名「${fk.name}」`
    if (fk.columns.length === 0 || fk.columns.length !== fk.refColumns.length)
      return `外键「${fk.name}」的列数与引用列数不匹配`
    for (const col of fk.columns) {
      if (!colNames.has(col.trim().toLowerCase())) return `外键「${fk.name}」引用了不存在的列「${col}」`
    }
    fkNames.add(fk.name.trim().toLowerCase())
  }
  return null
}

/** 删除表校验：其他模型表的外键引用该表时阻止（返回文案，null=允许） */
export function validateDeleteTable(
  targetLower: string,
  modelTables: Record<string, ModelTableState>,
): string | null {
  for (const mt of Object.values(modelTables)) {
    if (!mt.schema) continue
    const hit = mt.schema.foreignKeys.find((fk) => fk.refTable.toLowerCase() === targetLower)
    if (hit) return `模型表「${mt.schema.name}」的外键「${hit.name}」引用了该表，请先删除此外键`
  }
  return null
}

/** store 状态 → er_diff payload（serverNames：小写 → 服务器原始大小写表名） */
export function buildErDiffPayload(
  modelTables: Record<string, ModelTableState>,
  serverNames: Record<string, string>,
): ErModelTableInput[] {
  return Object.entries(modelTables).map(([lower, mt]) => ({
    name: serverNames[lower] ?? lower,
    // tombstone 恒 null（删除优先，即使残留编辑内容也不随 payload 下发）
    schema: mt.deleted ? null : mt.schema,
  }))
}

/** 拖线建模型外键的输入（画布列行拖拽得到，弹框补齐其余字段） */
export interface ModelFkInput {
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
  name?: string
  onDelete?: string | null
  onUpdate?: string | null
}

/** 拖线输入 → ErFkSchema（表名/列名用图里的服务器原始大小写） */
export function makeModelFk(input: ModelFkInput): ErFkSchema {
  return {
    name: input.name?.trim() || `fk_${input.table.toLowerCase()}_${input.columns[0].toLowerCase()}`,
    table: input.table,
    columns: [...input.columns],
    refTable: input.refTable,
    refColumns: [...input.refColumns],
    onDelete: input.onDelete ?? null,
    onUpdate: input.onUpdate ?? null,
  }
}

// ───────────────── 设计器列草稿（默认值三态） ─────────────────

/** 设计器列草稿的数据形态（不含 UI 的 uid）。
 *  default 三态：null=无默认，''=DEFAULT ''，其余为字面值——
 *  库侧 normalize_default 刻意区分空串默认与无默认，设计器不得合并二者 */
export interface ColDraftData {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  autoInc: boolean
  /** ON UPDATE CURRENT_TIMESTAMP（时间列自动更新时间） */
  onUpdateTs: boolean
  comment: string
  /** 其余 extra 原样保留 */
  extraRest: string
  characterSet: string | null
  collation: string | null
}

const ON_UPDATE_TS = 'on update current_timestamp'

/** 草稿 → 列 schema。类型输入里硬写的 on update / default current_timestamp
 *  会被剥到正确字段——留在 dataType 里会生成非法列序 DDL（on update 出现在 NULL 前） */
export function colDraftToSchema(c: ColDraftData): ErColumnSchema {
  let dataType = c.dataType.trim()
  let extra = [c.extraRest.trim(), c.autoInc ? 'auto_increment' : '', c.onUpdateTs ? ON_UPDATE_TS : '']
    .filter(Boolean)
    .join(' ')
  let def = c.default === '' ? '' : c.default
  // 剥离硬写在类型里的常见关键字（大小写不敏感）
  const strip = /\s+on\s+update\s+current_timestamp/gi
  if (strip.test(dataType)) {
    dataType = dataType.replace(strip, '').trim()
    extra = [extra, ON_UPDATE_TS].filter(Boolean).join(' ')
  }
  const stripDef = /\s+default\s+current_timestamp/gi
  if (stripDef.test(dataType)) {
    dataType = dataType.replace(stripDef, '').trim()
    if (def == null) def = 'current_timestamp'
  }
  return {
    name: c.name.trim(),
    dataType,
    nullable: c.nullable,
    default: def,
    extra,
    comment: c.comment === '' ? null : c.comment,
    characterSet: c.characterSet,
    collation: c.collation,
  }
}

/** 列 schema → 草稿（extra 拆出 auto_increment/on update；default 三态保持） */
export function schemaToColDraft(c: ErColumnSchema): ColDraftData {
  const extra = (c.extra ?? '').replace(/on\s+update\s+current_timestamp/gi, ' ')
  return {
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    default: c.default,
    autoInc: (c.extra ?? '').toLowerCase().includes('auto_increment'),
    onUpdateTs: (c.extra ?? '').toLowerCase().includes('on update current_timestamp'),
    comment: c.comment ?? '',
    extraRest: extra.split(/\s+/).filter((t) => t.toLowerCase() !== 'auto_increment').join(' ').trim(),
    characterSet: c.characterSet,
    collation: c.collation,
  }
}

/** 索引名推荐：idx_/uk_ 前缀 + 列名串联（MySQL 标识符上限 64 截断）。
 *  空列集返回空串；表名不进名（列名通常已含语义，防超长） */
export function recommendIndexName(_table: string, columns: string[], unique: boolean): string {
  const cols = columns.filter(Boolean)
  if (cols.length === 0) return ''
  const name = `${unique ? 'uk' : 'idx'}_${cols.join('_')}`
  return name.length > 64 ? name.slice(0, 64) : name
}

/** 整数族类型（auto_increment 只允许整数列；含 unsigned/显示宽度形态） */
export function isIntegerType(dataType: string): boolean {
  const base = dataType.trim().toLowerCase().split('(')[0].split(/\s+/)[0]
  return ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'].includes(base)
}

/** 时间类型（ON UPDATE CURRENT_TIMESTAMP 只允许 timestamp/datetime 列） */
export function isTemporalType(dataType: string): boolean {
  const base = dataType.trim().toLowerCase().split('(')[0].split(/\s+/)[0]
  return base === 'timestamp' || base === 'datetime'
}

/** 列改名传播：列名（忽略大小写）变化同步到索引列与外键列引用，
 *  否则改主键列名后索引仍指旧名，保存校验直接报「不存在的列」 */
export interface ColumnRenameDraft {
  cols: { uid: string; name: string }[]
  idxs: { uid: string; name: string; columns: string[] }[]
  fks: { uid: string; name: string; columns: string[] }[]
}
export function applyColumnNameRename<T extends ColumnRenameDraft>(
  draft: T,
  oldName: string,
  newName: string,
): T {
  const oldL = oldName.trim().toLowerCase()
  if (!oldL) return draft // 空旧名不传播（否则会把所有空白列一起改名）；本行由调用方编辑
  const rep = (col: string) => (col.trim().toLowerCase() === oldL ? newName : col)
  return {
    ...draft,
    cols: draft.cols.map((c) => ({ ...c, name: rep(c.name) })),
    idxs: draft.idxs.map((i) => ({ ...i, columns: i.columns.map(rep) })),
    fks: draft.fks.map((f) => ({ ...f, columns: f.columns.map(rep) })),
  }
}

// ───────────────── FK 拖线方向规范化 ─────────────────

/** 拖线方向规范化：源端是本表主键且目标端不是 → 交换（主键端作为被引用方），
 *  与手动关联 makeManualEdge 同规则——反向拖线不得生成倒置外键落库 */
export function normalizeFkDirection<
  T extends { sourceTable: string; sourceColumn: string; targetTable: string; targetColumn: string },
>(graph: ErGraph, pending: T): T {
  const src = graph.tables[pending.sourceTable.toLowerCase()]
  const tgt = graph.tables[pending.targetTable.toLowerCase()]
  const srcIsPk =
    !!src && src.singlePrimaryKey?.toLowerCase() === pending.sourceColumn.toLowerCase()
  const tgtIsPk =
    !!tgt && tgt.singlePrimaryKey?.toLowerCase() === pending.targetColumn.toLowerCase()
  if (srcIsPk && !tgtIsPk) {
    return {
      ...pending,
      sourceTable: pending.targetTable,
      sourceColumn: pending.targetColumn,
      targetTable: pending.sourceTable,
      targetColumn: pending.sourceColumn,
    }
  }
  return pending
}
