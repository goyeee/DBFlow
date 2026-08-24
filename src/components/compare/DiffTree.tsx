import { useMemo } from 'react'
import { Checkbox, Table } from 'antd'
import { ArrowRightOutlined, CaretRightFilled, TableOutlined } from '@ant-design/icons'
import {
  buildDiffTree,
  collectItemIds,
  useCompareStore,
  type DiffNode,
} from '../../stores/compare'

/**
 * 结果页三列树表（Navicat：源对象 | 操作 | 目标对象）。
 * 行内顺序：[勾选框][折叠箭头] 源对象 → 目标对象——勾选框与展开箭头同列、
 * 随层级一起缩进（对勾有层次）。
 */
export function DiffTree() {
  const report = useCompareStore((s) => s.report)
  const groupMode = useCompareStore((s) => s.groupMode)
  const selectedIds = useCompareStore((s) => s.selectedIds)
  const reportId = useCompareStore((s) => s.reportId)
  const activeTable = useCompareStore((s) => s.activeTable)
  const activeItemId = useCompareStore((s) => s.activeItemId)
  const setItemsChecked = useCompareStore((s) => s.setItemsChecked)
  const setActive = useCompareStore((s) => s.setActive)

  const nodes = useMemo(() => buildDiffTree(report ?? [], groupMode), [report, groupMode])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // 分组行默认展开，表行默认收起（Navicat 同款）
  const defaultExpandedRowKeys = useMemo(() => nodes.map((n) => n.key), [nodes])

  const activate = (node: DiffNode) => {
    if (node.nodeType === 'group') {
      setActive(null, null)
      return
    }
    if (node.itemId) {
      // 明细行：记表名 + 该项 id
      setActive(node.table ?? null, node.itemId)
      return
    }
    // 表行：只记表名（部署脚本按表展示该表全部内容）
    setActive(node.table ?? null, null)
  }

  const isActive = (node: DiffNode): boolean => {
    if (node.nodeType === 'group') return false
    if (node.itemId) return activeItemId === node.itemId
    return activeTable === node.table && activeItemId === null
  }

  /** 节点勾选态：叶子看自身；父行由子孙折算（全勾/半选/未勾） */
  const checkState = (node: DiffNode) => {
    const ids = node.itemId ? [node.itemId] : collectItemIds(node.children ?? [])
    const n = ids.filter((id) => selectedSet.has(id)).length
    return {
      checked: ids.length > 0 && n === ids.length,
      indeterminate: n > 0 && n < ids.length,
    }
  }

  const toggleNode = (node: DiffNode, checked: boolean) => {
    const ids = node.itemId ? [node.itemId] : collectItemIds(node.children ?? [])
    setItemsChecked(ids, checked)
  }

  /** 分组行标题列：标题 + 已选择/共 n 个 */
  const groupTitle = (node: DiffNode) => {
    const ids = collectItemIds(node.children ?? [])
    const sel = ids.filter((id) => selectedSet.has(id)).length
    return (
      <span className="dt-group-title">
        {node.groupTitle}（已选择 {sel} 个（共 {ids.length} 个））
      </span>
    )
  }

  /** 源/目标对象单元格：图标 + 名称 + 灰色描述 */
  const objCell = (
    name: string | null | undefined,
    desc: string | null | undefined,
    node: DiffNode,
  ) => {
    if (name == null) return null
    return (
      <span className="dt-obj">
        {node.kind === 'table' && (
          <TableOutlined style={{ color: '#6a9bd8', marginRight: 5, fontSize: 12 }} />
        )}
        <span className="dt-name">{name}</span>
        {desc && (
          <span className="dt-desc" title={desc}>
            {desc}
          </span>
        )}
        {node.dangerous && <span className="dt-danger">危险</span>}
      </span>
    )
  }

  return (
    <Table<DiffNode>
      key={reportId}
      size="small"
      rowKey="key"
      dataSource={nodes}
      pagination={false}
      sticky
      showHeader
      className="diff-tree"
      expandable={{
        defaultExpandedRowKeys,
        indentSize: 14,
        expandIconColumnIndex: 0,
        // 首列折叠箭头 + 勾选框，随层级一起缩进；箭头展开时旋转 90°（动效）
        expandIcon: ({ expanded, expandable, record, onExpand }) => {
          const node = record as DiffNode
          const st = checkState(node)
          return (
            <span className="dt-ctrl" onClick={(e) => e.stopPropagation()}>
              <span
                className={`dt-expand${expandable ? '' : ' dt-expand-leaf'}${expanded ? ' dt-expand-open' : ''}`}
                onClick={(e) => {
                  if (!expandable) return
                  e.stopPropagation()
                  onExpand(record, e)
                }}
              >
                <CaretRightFilled />
              </span>
              <Checkbox
                checked={st.checked}
                indeterminate={st.indeterminate}
                onChange={(e) => toggleNode(node, e.target.checked)}
              />
            </span>
          )
        },
      }}
      onRow={(node) => ({ onClick: () => activate(node) })}
      rowClassName={(node) => {
        const cls: string[] = []
        if (isActive(node)) cls.push('dt-row-active')
        // 非分组行（表行/明细）在展开时播放淡入动画
        if (node.nodeType !== 'group') cls.push('dt-row-child')
        return cls.join(' ')
      }}
      columns={[
        {
          // 控制列：勾选框 + 折叠箭头（展开图标渲染在此列，随层级缩进）
          title: '',
          key: 'ctrl',
          width: 92,
          render: () => null,
        },
        {
          // 分组标题 / 源对象
          title: '源对象',
          key: 'source',
          render: (_, node) =>
            node.nodeType === 'group'
              ? groupTitle(node)
              : objCell(node.sourceName, node.sourceDesc, node),
        },
        {
          title: '操作',
          key: 'op',
          width: 52,
          align: 'center',
          render: () => <ArrowRightOutlined style={{ color: '#1677ff', fontSize: 12 }} />,
        },
        {
          title: '目标对象',
          key: 'target',
          render: (_, node) =>
            node.nodeType === 'group' ? null : objCell(node.targetName, node.targetDesc, node),
        },
      ]}
    />
  )
}
