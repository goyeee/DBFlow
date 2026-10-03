import type { ErEdgeInfo, ErGraph, ErTable } from './transform'

/**
 * 命名约定推断（项目实际约定，规则可解释）：
 * 表 T 的单列主键名是「表名 + ID」（如 Account 表主键 AccountID）；
 * 其他表中出现同名字段（忽略大小写），即认为该字段引用 T 的主键。
 *
 * 排除：自表（该字段就是自己的主键，自引用请用手动关联）、
 * 已被真实外键覆盖的列。
 * 主键名不是「表名 + ID」的表不参与——避免通用主键名（如 id）跨表乱配。
 */
export function inferEdges(graph: ErGraph): ErEdgeInfo[] {
  // 主键列名（小写）→ 符合约定的目标表
  const targetByPk = new Map<string, ErTable>()
  for (const t of Object.values(graph.tables)) {
    const pk = t.singlePrimaryKey
    if (pk && pk.toLowerCase() === `${t.name.toLowerCase()}id`) {
      targetByPk.set(pk.toLowerCase(), t)
    }
  }

  // 已被真实外键覆盖的（源表小写, 源列小写）
  const fkCovered = new Set(
    graph.fkEdges.flatMap((e) => {
      const src = e.sourceTable.toLowerCase()
      return e.sourceColumns.map((c) => `${src}.${c.toLowerCase()}`)
    }),
  )

  const edges: ErEdgeInfo[] = []
  for (const s of Object.values(graph.tables)) {
    const self = s.name.toLowerCase()
    for (const c of s.columns) {
      if (fkCovered.has(`${self}.${c.name.toLowerCase()}`)) continue
      const target = targetByPk.get(c.name.toLowerCase())
      if (!target || target.name.toLowerCase() === self) continue
      const pk = target.singlePrimaryKey!
      edges.push({
        id: `inf:${s.name}.${c.name}->${target.name}.${pk}`,
        kind: 'inferred',
        sourceTable: s.name,
        sourceColumns: [c.name],
        targetTable: target.name,
        targetColumns: [pk],
      })
    }
  }
  return edges
}
