import { Drawer, Descriptions, Popconfirm, Table, Tag } from 'antd'

import { useErStore } from '../../stores/er'
import { erCanvasApi } from './erCanvasApi'
import { useErTab, useErTabKey } from './erTabContext'
import type { ErEdgeInfo, ErTable } from './transform'

/** 可点击跳转的关联表名：切换抽屉并在画布定位该表 */
function RelatedName({ name, tabKey }: { name: string; tabKey: string }) {
  return (
    <a
      onClick={() => {
        useErStore.getState().setDrawerTable(tabKey, name.toLowerCase())
        erCanvasApi.focusTable?.(name)
      }}
    >
      {name}
    </a>
  )
}

/** 一条关系行：列映射 + 关联表 + ON 规则；推断关系标注裁决状态，手动关联可删除 */
function RelationRow({
  info,
  outgoing,
  inferred,
  tabKey,
  onRemove,
}: {
  info: ErEdgeInfo
  outgoing: boolean
  inferred: boolean
  tabKey: string
  /** 提供时显示删除入口（仅手动关联） */
  onRemove?: () => void
}) {
  const other = outgoing ? info.targetTable : info.sourceTable
  const otherCols = outgoing ? info.targetColumns : info.sourceColumns
  const selfCols = outgoing ? info.sourceColumns : info.targetColumns
  const rules = [info.onDelete && `ON DELETE ${info.onDelete}`, info.onUpdate && `ON UPDATE ${info.onUpdate}`]
    .filter(Boolean)
    .join(' ')
  return (
    <li>
      {!outgoing && '← 来自 '}
      <RelatedName name={other} tabKey={tabKey} />
      {outgoing && ' → '}
      <span className="er-muted">
        {selfCols.join(', ')}
        {outgoing ? ' ↔ ' : ' ↔ '}
        {otherCols.join(', ')}
      </span>
      {inferred && <Tag style={{ marginLeft: 6 }}>推断</Tag>}
      {info.kind === 'manual' && (
        <Tag color="purple" style={{ marginLeft: 6 }}>
          手动
        </Tag>
      )}
      {rules && <span className="er-fk-rule"> {rules}</span>}
      {onRemove && (
        <Popconfirm title="删除该手动关联？" okText="删除" cancelText="取消" onConfirm={onRemove}>
          <a className="er-rel-remove">删除</a>
        </Popconfirm>
      )}
    </li>
  )
}

/** 表详情抽屉：列（含默认值）/ 索引 / 真实外键与推断关系（画布上只放摘要） */
export function ErDrawer() {
  const tabKey = useErTabKey()
  // 抽屉由双击节点打开（drawerTable），与单击选中（selectedTable）解耦
  const drawerTable = useErTab((t) => t.drawerTable)
  const graph = useErTab((t) => t.graph)
  const inferredEdges = useErTab((t) => t.inferredEdges)
  const manualEdges = useErTab((t) => t.manualEdges)
  const inferredStatus = useErTab((t) => t.inferredStatus)

  const table: ErTable | undefined = drawerTable ? graph?.tables[drawerTable] : undefined
  const lower = drawerTable

  const fkOut = lower ? graph?.fkEdges.filter((e) => e.sourceTable.toLowerCase() === lower) ?? [] : []
  const fkIn = lower ? graph?.fkEdges.filter((e) => e.targetTable.toLowerCase() === lower) ?? [] : []
  // 推断关系：含已确认，排除已忽略
  const infOut = lower
    ? (inferredEdges ?? []).filter(
        (e) => e.sourceTable.toLowerCase() === lower && inferredStatus?.[e.id] !== 'ignored',
      )
    : []
  const infIn = lower
    ? (inferredEdges ?? []).filter(
        (e) => e.targetTable.toLowerCase() === lower && inferredStatus?.[e.id] !== 'ignored',
      )
    : []
  // 手动关联：自引用边只进 out 组，避免同一边在列表里出现两次（React key 冲突）
  const manOut = lower
    ? (manualEdges ?? []).filter((e) => e.sourceTable.toLowerCase() === lower)
    : []
  const manIn = lower
    ? (manualEdges ?? []).filter(
        (e) =>
          e.targetTable.toLowerCase() === lower && e.sourceTable.toLowerCase() !== lower,
      )
    : []
  const removeManual = (edgeId: string) =>
    useErStore.getState().removeManualEdge(tabKey, edgeId)

  return (
    <Drawer
      title={table ? table.name : ''}
      placement="right"
      width={560}
      open={!!table}
      onClose={() => useErStore.getState().setDrawerTable(tabKey, null)}
    >
      {table && (
        <>
          {table.comment && (
            <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="注释">{table.comment}</Descriptions.Item>
            </Descriptions>
          )}

          <h4>列（{table.columns.length}）</h4>
          <Table
            size="small"
            rowKey="name"
            pagination={false}
            dataSource={table.columns}
            scroll={{ y: 300 }}
            columns={[
              {
                title: '列',
                dataIndex: 'name',
                render: (v, r) => (
                  <span>
                    {r.key === 'pk' && (
                      <Tag color="gold" style={{ marginRight: 4 }}>PK</Tag>
                    )}
                    {r.key === 'unique' && (
                      <Tag color="cyan" style={{ marginRight: 4 }}>UK</Tag>
                    )}
                    {v}
                  </span>
                ),
              },
              { title: '类型', dataIndex: 'dataType', width: 130 },
              { title: '可空', dataIndex: 'nullable', width: 50, render: (v) => (v ? '是' : '否') },
              { title: '默认值', dataIndex: 'default', width: 100, render: (v) => v ?? <span className="er-muted">—</span> },
              { title: '注释', dataIndex: 'comment', ellipsis: true },
            ]}
          />

          <h4 style={{ marginTop: 16 }}>索引（{table.indexes.length}）</h4>
          <Table
            size="small"
            rowKey="name"
            pagination={false}
            dataSource={table.indexes}
            scroll={{ y: 200 }}
            columns={[
              {
                title: '索引',
                dataIndex: 'name',
                render: (v, r) => (
                  <span>
                    {r.primary && <Tag color="gold">主键</Tag>}
                    {r.unique && !r.primary && <Tag color="cyan">唯一</Tag>}
                    {v}
                  </span>
                ),
              },
              { title: '列', dataIndex: 'columns', render: (v: string[]) => v.join(', ') },
              { title: '类型', dataIndex: 'indexType', width: 90, render: (v) => v ?? '—' },
            ]}
          />

          <h4 style={{ marginTop: 16 }}>关系</h4>
          {fkOut.length + fkIn.length + manOut.length + manIn.length + infOut.length + infIn.length > 0 ? (
            <>
              {(fkOut.length + fkIn.length) > 0 && (
                <>
                  <div className="er-rel-group">真实外键</div>
                  <ul className="er-fk-list">
                    {fkOut.map((e) => (
                      <RelationRow key={e.id} info={e} outgoing inferred={false} tabKey={tabKey} />
                    ))}
                    {fkIn.map((e) => (
                      <RelationRow key={e.id} info={e} outgoing={false} inferred={false} tabKey={tabKey} />
                    ))}
                  </ul>
                </>
              )}
              {(manOut.length + manIn.length) > 0 && (
                <>
                  <div className="er-rel-group">手动关联</div>
                  <ul className="er-fk-list">
                    {manOut.map((e) => (
                      <RelationRow
                        key={e.id}
                        info={e}
                        outgoing
                        inferred={false}
                        tabKey={tabKey}
                        onRemove={() => removeManual(e.id)}
                      />
                    ))}
                    {manIn.map((e) => (
                      <RelationRow
                        key={e.id}
                        info={e}
                        outgoing={false}
                        inferred={false}
                        tabKey={tabKey}
                        onRemove={() => removeManual(e.id)}
                      />
                    ))}
                  </ul>
                </>
              )}
              {(infOut.length + infIn.length) > 0 && (
                <>
                  <div className="er-rel-group">命名推断</div>
                  <ul className="er-fk-list">
                    {infOut.map((e) => (
                      <RelationRow key={e.id} info={e} outgoing inferred tabKey={tabKey} />
                    ))}
                    {infIn.map((e) => (
                      <RelationRow key={e.id} info={e} outgoing={false} inferred tabKey={tabKey} />
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <span className="er-muted">无</span>
          )}
        </>
      )}
    </Drawer>
  )
}
