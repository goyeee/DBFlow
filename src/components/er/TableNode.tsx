import { memo, useEffect, useRef } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { DownOutlined, KeyOutlined, RightOutlined } from '@ant-design/icons'

import { useErStore } from '../../stores/er'
import type { AnchorSide, EdgeAnchor } from './edgeAnchors'
import type { ErTable } from './transform'
import { useErTabKey } from './erTabContext'

export type TableNodeData = Record<string, unknown> & {
  table: ErTable
  collapsed: boolean
  /** 搜索命中/选中高亮 */
  highlight: boolean
  /** 图上建模状态：new/edited/deleted（角标渲染） */
  modelStatus?: 'new' | 'edited' | 'deleted'
  /** 搜索命中的列名（小写）→ 列行高亮 */
  matchedColumns?: string[]
  /** 关系高亮的列级标记（列名小写 → 标记类型），随选中/悬停关系线派生 */
  markCols?: Record<string, string[]>
  /** 关系线的表级锚点（边 id 定位），可落在任意面任意位置 */
  anchors?: EdgeAnchor[]
  /** 表头单击（才算选中表，追加式）；列行单击不选中表 */
  onHeaderClick?: (nodeId: string) => void
  /** 列行单击：点亮该列参与的关系线与两端表/列 */
  onColumnPick?: (tableId: string, column: string) => void
}

const POSITION_BY_SIDE: Record<AnchorSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
}

/** ER 表节点：表名头部（含折叠按钮）+ 列行（主键钥匙、类型、NN），可折叠为纯头部。
 *  关系线锚定在表边框的「锚点 Handle」（隐形，自动均布或被手拖覆盖），
 *  列行 Handle 仅用于拖拽创建手动关联 */
export const TableNode = memo(function TableNode({ id, data }: NodeProps) {
  const { table, collapsed, highlight, modelStatus, matchedColumns, markCols, anchors, onHeaderClick, onColumnPick } =
    data as TableNodeData
  const tabKey = useErTabKey()
  const updateNodeInternals = useUpdateNodeInternals()
  const toggleCollapsed = () =>
    useErStore
      .getState()
      .setCollapsed(tabKey, table.name.toLowerCase(), !collapsed)

  // 区分「点击」与「拖动」：pointerdown 记下位置，click 时位移超过阈值（拖了表）就不算点击
  const downAtRef = useRef<{ x: number; y: number } | null>(null)
  const markDown = (e: React.PointerEvent) => {
    downAtRef.current = { x: e.clientX, y: e.clientY }
  }
  const isClick = (e: React.MouseEvent) => {
    const d = downAtRef.current
    return !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 4
  }

  // 锚点位置变化（均布重排/手拖覆盖）不会触发节点 resize，React Flow 的句柄缓存不会自动重测，
  // 必须显式 updateNodeInternals，否则连线仍挂在旧锚点上
  useEffect(() => {
    updateNodeInternals(id)
  }, [updateNodeInternals, id, anchors])

  return (
    <>
      {/* 锚点 Handle 挂在节点 wrapper 下：.er-table-node 有 overflow:hidden，
          放在它外面避免被裁剪；百分比相对节点整体高度/宽度 */}
      {(anchors ?? []).map((a) => (
        <Handle
          key={`${a.type}-${a.edgeId}`}
          type={a.type}
          position={POSITION_BY_SIDE[a.side]}
          id={a.edgeId}
          className="er-handle-anchor"
          style={
            a.side === 'left' || a.side === 'right'
              ? { top: `${a.pct}%` }
              : { left: `${a.pct}%` }
          }
        />
      ))}
      <div
        className={`er-table-node${collapsed ? ' er-table-collapsed' : ''}${
          highlight ? ' er-table-highlight' : ''
        }`}
      >
        <div
          className="er-table-header"
          title={table.comment ?? table.name}
          onPointerDown={markDown}
          onClick={(e) => {
            // 只有表头才算选中表（不冒泡到节点级单击）
            e.stopPropagation()
            if (isClick(e)) onHeaderClick?.(id)
          }}
        >
          {modelStatus && (
            <span className={`er-model-badge er-model-badge-${modelStatus}`}>
              {modelStatus === 'new' ? '新' : modelStatus === 'edited' ? '改' : '删'}
            </span>
          )}
          <span className="er-table-name">{table.name}</span>
          {table.comment && <span className="er-table-comment">{table.comment}</span>}
          <span
            className="er-table-fold"
            title={collapsed ? '展开表' : '折叠表'}
            onClick={(e) => {
              // 不冒泡到表头/节点：折叠按钮不触发选中
              e.stopPropagation()
              toggleCollapsed()
            }}
          >
            {collapsed ? <RightOutlined /> : <DownOutlined />}
          </span>
        </div>
        {!collapsed && (
          <div className="er-table-columns">
            {table.columns.map((c) => (
              <div
                className={`er-col-row${
                  matchedColumns?.includes(c.name.toLowerCase()) ? ' er-col-match' : ''
                }${(markCols?.[c.name.toLowerCase()] ?? [])
                  .map((k) => ` er-col-${k}`)
                  .join('')}`}
                key={c.name}
                data-col={c.name.toLowerCase()}
                title={`${c.name} ${c.dataType}${c.comment ? ` · ${c.comment}` : ''}`}
                onPointerDown={markDown}
                onClick={(e) => {
                  // 点字段不算选中表：点亮该列参与的关系线与两端表/列
                  e.stopPropagation()
                  if (isClick(e)) onColumnPick?.(id, c.name)
                }}
              >
                <Handle
                  type="target"
                  position={Position.Left}
                  id={c.name}
                  className="er-handle"
                  onClick={(e) => e.stopPropagation()}
                />
                {c.key === 'pk' && <KeyOutlined className="er-col-pk" />}
                <span className={`er-col-name${c.key === 'pk' ? ' er-col-name-pk' : ''}`}>
                  {c.name}
                </span>
                <span className="er-col-type">
                  {c.dataType}
                  {c.nullable ? '' : ' ·NN'}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={c.name}
                  className="er-handle"
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
})
