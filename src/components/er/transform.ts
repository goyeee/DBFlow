import type { DatabaseKind, ErModelDoc, ErSnapshot } from '../../api/types'
import type { AnchorOverride } from './edgeAnchors'

/** 画布上的表：结构来自实时快照（文档只存布局，不冗余列定义） */
/** 画布上的索引摘要（详情抽屉展示用） */
export interface ErIndexDisplay {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  indexType: string | null
}

export interface ErTable {
  name: string
  comment: string | null
  columns: ErColumnDisplay[]
  indexes: ErIndexDisplay[]
  /** 单列主键名（命名推断的目标列）；复合主键/无主键为 null */
  singlePrimaryKey: string | null
}

export interface ErColumnDisplay {
  name: string
  dataType: string
  nullable: boolean
  key: 'pk' | 'unique' | 'none'
  /** 列默认值（归一化后） */
  default: string | null
  comment: string | null
}

/** 关系边：fk = 真实外键；inferred = 命名推断；manual = 用户手动添加 */
export interface ErEdgeInfo {
  /** fk:{表}:{约束名} / inf|man:{源表}.{源列}->{目标表}.{目标列} */
  id: string
  kind: 'fk' | 'inferred' | 'manual'
  sourceTable: string
  sourceColumns: string[]
  targetTable: string
  targetColumns: string[]
  fkName?: string
  onDelete?: string | null
  onUpdate?: string | null
}

export interface ErGraph {
  /** key 为表名小写（MySQL 表名大小写敏感性随平台，统一小写比较） */
  tables: Record<string, ErTable>
  fkEdges: ErEdgeInfo[]
}

/** 快照 → 画布图数据。列按键类型分类，外键转为边 */
export function buildErGraph(snapshot: ErSnapshot): ErGraph {
  const tables: Record<string, ErTable> = {}
  for (const t of snapshot.tables) {
    const key = t.name.toLowerCase()
    // MySQL 在大小写敏感实例上允许仅大小写不同的表并存；本图统一小写键，
    // 冲突会静默覆盖丢表，提前报错让用户知晓（不做易错的自动消歧）
    if (tables[key]) {
      throw new Error(
        `存在仅大小写不同的同名表「${tables[key].name}」与「${t.name}」，无法在同一 ER 图区分，请重命名后再打开`,
      )
    }
    const pkIndex = t.indexes.find((i) => i.isPrimary)
    const pkCols = new Set(pkIndex?.columns ?? [])
    // 仅单列唯一索引（非主键）的列标 UK；复合唯一的各列不逐列标，在索引列表体现，
    // 否则读者会误以为复合唯一键中每列都单列唯一
    const singleUniqueCols = new Set(
      t.indexes
        .filter((i) => i.unique && !i.isPrimary && i.columns.length === 1)
        .flatMap((i) => i.columns),
    )
    tables[key] = {
      name: t.name,
      comment: t.comment,
      singlePrimaryKey: pkIndex && pkIndex.columns.length === 1 ? pkIndex.columns[0] : null,
      indexes: t.indexes.map((i) => ({
        name: i.name,
        columns: i.columns,
        unique: i.unique,
        primary: i.isPrimary,
        indexType: i.indexType,
      })),
      columns: t.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        nullable: c.nullable,
        key: pkCols.has(c.name) ? 'pk' : singleUniqueCols.has(c.name) ? 'unique' : 'none',
        default: c.default,
        comment: c.comment,
      })),
    }
  }
  const fkEdges: ErEdgeInfo[] = snapshot.foreignKeys.map((fk) => ({
    id: `fk:${fk.table}:${fk.name}`,
    kind: 'fk',
    fkName: fk.name,
    sourceTable: fk.table,
    sourceColumns: fk.columns,
    targetTable: fk.refTable,
    targetColumns: fk.refColumns,
    onDelete: fk.onDelete,
    onUpdate: fk.onUpdate,
  }))
  return { tables, fkEdges }
}

/** 文档叠加到实时图上的信息：布局、推断边裁决、手动关联、连线路径、端点锚点 */
export interface ErDocOverlay {
  positions: Record<string, { x: number; y: number }>
  collapsed: Record<string, boolean>
  inferredStatus: Record<string, 'confirmed' | 'ignored'>
  manualEdges: ErEdgeInfo[]
  /** edgeId → 手拖途经点 */
  edgeRoutes: Record<string, { x: number; y: number }[]>
  /** edgeId → 手拖端点锚点覆盖（source/target 各自独立） */
  edgeAnchors: Record<string, { source?: AnchorOverride; target?: AnchorOverride }>
}

/** 文档里的锚点字段 → 覆盖值；形状非法返回 undefined，pos 钳制到 0–1 */
function toAnchorOverride(v: unknown): AnchorOverride | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as { side?: unknown; pos?: unknown }
  if (o.side !== 'left' && o.side !== 'right' && o.side !== 'top' && o.side !== 'bottom') {
    return undefined
  }
  if (typeof o.pos !== 'number' || !Number.isFinite(o.pos)) return undefined
  return { side: o.side, pos: Math.min(1, Math.max(0, o.pos)) }
}

export function docOverlay(doc: ErModelDoc | null): ErDocOverlay {
  const empty = {
    positions: {},
    collapsed: {},
    inferredStatus: {},
    manualEdges: [],
    edgeRoutes: {},
    edgeAnchors: {},
  }
  if (!doc) return empty
  const positions: Record<string, { x: number; y: number }> = {}
  const collapsed: Record<string, boolean> = {}
  for (const t of doc.tables) {
    positions[t.name.toLowerCase()] = { x: t.x, y: t.y }
    if (t.collapsed) collapsed[t.name.toLowerCase()] = true
  }
  const inferredStatus: Record<string, 'confirmed' | 'ignored'> = {}
  const manualEdges: ErEdgeInfo[] = []
  const edgeRoutes: Record<string, { x: number; y: number }[]> = {}
  const edgeAnchors: ErDocOverlay['edgeAnchors'] = {}
  for (const e of doc.edges) {
    if (e.kind === 'inferred' && (e.status === 'confirmed' || e.status === 'ignored')) {
      inferredStatus[e.id] = e.status
    } else if (e.kind === 'manual') {
      manualEdges.push({
        id: e.id,
        kind: 'manual',
        sourceTable: e.source.table,
        sourceColumns: [e.source.column],
        targetTable: e.target.table,
        targetColumns: [e.target.column],
      })
    }
    if (e.via && e.via.length > 0) edgeRoutes[e.id] = e.via
    const source = toAnchorOverride(e.sourceAnchor)
    const target = toAnchorOverride(e.targetAnchor)
    if (source || target) edgeAnchors[e.id] = { ...(source ? { source } : {}), ...(target ? { target } : {}) }
  }
  return { positions, collapsed, inferredStatus, manualEdges, edgeRoutes, edgeAnchors }
}

export interface ModelDocInput {
  kind: DatabaseKind
  database: string
  connectionName: string
  positions: Record<string, { x: number; y: number }>
  collapsed: Record<string, boolean>
  fkEdges: ErEdgeInfo[]
  inferredEdges: ErEdgeInfo[]
  manualEdges: ErEdgeInfo[]
  inferredStatus: Record<string, 'confirmed' | 'ignored'>
  /** edgeId → 手拖途经点（写入各边的 via） */
  edgeRoutes: Record<string, { x: number; y: number }[]>
  /** edgeId → 手拖端点锚点（写入各边的 sourceAnchor/targetAnchor） */
  edgeAnchors: Record<string, { source?: AnchorOverride; target?: AnchorOverride }>
}

/** 当前状态 → 模型文档（每次保存全量重建，文档即协作分享的载体） */
export function buildModelDoc(input: ModelDocInput): ErModelDoc {
  const tables = Object.entries(input.positions).map(([lower, p]) => ({
    id: lower,
    name: lower,
    x: Math.round(p.x),
    y: Math.round(p.y),
    collapsed: !!input.collapsed[lower],
  }))
  const anchorFields = (id: string) => {
    const a = input.edgeAnchors[id]
    return {
      ...(a?.source ? { sourceAnchor: a.source } : {}),
      ...(a?.target ? { targetAnchor: a.target } : {}),
    }
  }
  const toDocEdge = (
    e: ErEdgeInfo,
    kind: 'fk' | 'manual',
  ): {
    id: string
    kind: 'fk' | 'manual'
    via?: { x: number; y: number }[]
    sourceAnchor?: AnchorOverride
    targetAnchor?: AnchorOverride
    source: { table: string; column: string }
    target: { table: string; column: string }
  } => ({
    id: e.id,
    kind,
    ...(input.edgeRoutes[e.id]?.length ? { via: input.edgeRoutes[e.id] } : {}),
    ...anchorFields(e.id),
    source: { table: e.sourceTable, column: e.sourceColumns[0]},
    target: { table: e.targetTable, column: e.targetColumns[0] },
  })
  const fkEdges = input.fkEdges.map((e) => toDocEdge(e, 'fk'))
  const manualEdges = input.manualEdges.map((e) => toDocEdge(e, 'manual'))
  const inferred = input.inferredEdges.map((e) => {
    const status = input.inferredStatus[e.id]
    return {
      id: e.id,
      kind: 'inferred' as const,
      ...(status ? { status } : {}),
      ...(input.edgeRoutes[e.id]?.length ? { via: input.edgeRoutes[e.id] } : {}),
      ...anchorFields(e.id),
      source: { table: e.sourceTable, column: e.sourceColumns[0] },
      target: { table: e.targetTable, column: e.targetColumns[0] },
    }
  })
  return {
    formatVersion: 1,
    kind: input.kind,
    database: input.database,
    origin: { connectionName: input.connectionName, capturedAt: new Date().toISOString() },
    tables,
    edges: [...fkEdges, ...manualEdges, ...inferred],
  }
}

/** 手动关联输入（表名/列名按用户拖拽或对话框所选，大小写不敏感解析） */
export interface ManualEdgeInput {
  sourceTable: string
  sourceColumn: string
  targetTable: string
  targetColumn: string
}

/** 构造一条手动关联：校验表/列存在，方向规范化（主键端作为被引用目标），
 *  与现有边去重。返回 edge 或明确错误文案 */
export function makeManualEdge(
  graph: ErGraph,
  input: ManualEdgeInput,
  existing: ErEdgeInfo[],
): { edge?: ErEdgeInfo; error?: string } {
  const resolveSide = (tableName: string, colName: string) => {
    const t = graph.tables[tableName.toLowerCase()]
    if (!t) return { error: `表「${tableName}」不存在` }
    const col = t.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase())
    if (!col) return { error: `表「${t.name}」没有列「${colName}」` }
    return { table: t, column: col.name }
  }

  const a = resolveSide(input.sourceTable, input.sourceColumn)
  const b = resolveSide(input.targetTable, input.targetColumn)
  if ('error' in a) return { error: a.error }
  if ('error' in b) return { error: b.error }

  // 方向规范化：若 A 端是其主键、B 端不是主键，交换——让主键端作为 target（被引用）
  let src = a
  let tgt = b
  const srcIsPk = src.table.singlePrimaryKey?.toLowerCase() === src.column.toLowerCase()
  const tgtIsPk = tgt.table.singlePrimaryKey?.toLowerCase() === tgt.column.toLowerCase()
  if (srcIsPk && !tgtIsPk) {
    src = b
    tgt = a
  }

  // 同一列连到自身没有意义（多为拖拽误触）；同表两列的自引用是允许的
  if (
    src.table.name.toLowerCase() === tgt.table.name.toLowerCase() &&
    src.column.toLowerCase() === tgt.column.toLowerCase()
  ) {
    return { error: '不能把列关联到其自身' }
  }

  // 去重：同一 源表.列 → 目标表.列 的任意现有边（fk/inferred/manual）
  const same = existing.some(
    (e) =>
      e.sourceTable.toLowerCase() === src.table.name.toLowerCase() &&
      e.sourceColumns[0].toLowerCase() === src.column.toLowerCase() &&
      e.targetTable.toLowerCase() === tgt.table.name.toLowerCase() &&
      e.targetColumns[0].toLowerCase() === tgt.column.toLowerCase(),
  )
  if (same) return { error: '该关联已存在' }

  return {
    edge: {
      id: `man:${src.table.name}.${src.column}->${tgt.table.name}.${tgt.column}`,
      kind: 'manual',
      sourceTable: src.table.name,
      sourceColumns: [src.column],
      targetTable: tgt.table.name,
      targetColumns: [tgt.column],
    },
  }
}

/** 新增表（文档里没有位置的）摆到画布左侧纵向堆叠，不打乱已整理的布局 */
export function placeFreshTables(
  fresh: string[],
  bounds: { minX: number; minY: number },
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  fresh.forEach((name, i) => {
    out[name.toLowerCase()] = { x: bounds.minX - 460, y: bounds.minY + i * 280 }
  })
  return out
}

/** 参与布局的推断边：ignored 排除；confirmed 优先且不被上限截断，其次未裁决候选；
 *  按 limit 限制候选数量，防止大库候选边爆炸 */
export function inferredLayoutEdges(
  inferredEdges: ErEdgeInfo[],
  inferredStatus: Record<string, 'confirmed' | 'ignored'>,
  limit: number,
): ErEdgeInfo[] {
  const active = inferredEdges.filter((e) => inferredStatus[e.id] !== 'ignored')
  const confirmed = active.filter((e) => inferredStatus[e.id] === 'confirmed')
  const pending = active.filter((e) => inferredStatus[e.id] !== 'confirmed')
  // 用户已确认的全部保留（即使超过 limit），剩余配额给未裁决候选
  return [...confirmed, ...pending].slice(0, Math.max(confirmed.length, limit))
}
