/**
 * 关系高亮的节点/列标记（纯函数）。
 *
 * 悬停边 / 左键选中边 / 选中表联动 / 点字段点亮这四类高亮要落在两端表节点与
 * 参与列上。之前是直接 toggle DOM class——但画布开着虚拟化
 * （onlyRenderVisibleElements），视口外的表节点不在 DOM 里标不上；滚动把它
 * 带进视口时节点重新挂载，React 重建 DOM 又把已标的 class 冲掉。
 * 改成声明式：这里把高亮算成 nodeId → 标记集合，节点 className 与列行
 * class 都由渲染层据 data 输出，虚拟化重挂载也正确。
 */

/** 四类高亮（对应 CSS 的 er-node-{kind} / er-col-{kind}，可叠加）：
 *  related=悬停边、sel=选中边、tsel=选中表联动、fpick=点字段点亮 */
export type MarkKind = 'related' | 'sel' | 'tsel' | 'fpick'

export interface NodeMark {
  /** 节点级标记（表边框高亮） */
  node: MarkKind[]
  /** 参与列（小写）→ 列级标记（列行高亮） */
  cols: Record<string, MarkKind[]>
}

/** 往数组追加元素（去重，保持首次出现序） */
function pushDedup(list: MarkKind[], kinds: MarkKind[]): MarkKind[] {
  const out = [...list]
  for (const k of kinds) if (!out.includes(k)) out.push(k)
  return out
}

/**
 * 把「每条边生效的高亮类型」展开成节点/列标记。
 * @param edges 边的 id、两端节点与参与列（列名保持原始大小写，输出时转小写）
 * @param kindsByEdge 边 id → 生效的标记类型（空数组/未知 id 的边忽略）
 */
export function collectNodeMarks(
  edges: {
    id: string
    source: string
    target: string
    sourceColumns: string[]
    targetColumns: string[]
  }[],
  kindsByEdge: Record<string, MarkKind[]>,
): Map<string, NodeMark> {
  const out = new Map<string, NodeMark>()
  const markOf = (nodeId: string): NodeMark => {
    let m = out.get(nodeId)
    if (!m) {
      m = { node: [], cols: {} }
      out.set(nodeId, m)
    }
    return m
  }
  for (const e of edges) {
    const kinds = kindsByEdge[e.id]
    if (!kinds?.length) continue
    for (const [nodeId, columns] of [
      [e.source, e.sourceColumns],
      [e.target, e.targetColumns],
    ] as const) {
      const mark = markOf(nodeId)
      mark.node = pushDedup(mark.node, kinds)
      for (const c of columns) {
        const key = c.toLowerCase()
        mark.cols[key] = pushDedup(mark.cols[key] ?? [], kinds)
      }
    }
  }
  return out
}
