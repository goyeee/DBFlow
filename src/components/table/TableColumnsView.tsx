import { useEffect, useState } from 'react'
import { Alert, Spin, Table, Tag } from 'antd'
import type { ColumnBrief } from '../../api/types'
import type { TableTab } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { errText } from '../connection/ConnectionTree'

/** 双击表后打开的标签页内容：列结构信息 */
export function TableColumnsView({ tab }: { tab: TableTab }) {
  const describeTable = useSessionStore((s) => s.describeTable)
  const [columns, setColumns] = useState<ColumnBrief[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const cols = await describeTable(tab.connectionId, tab.database, tab.table)
        if (!cancelled) setColumns(cols)
      } catch (e) {
        if (!cancelled) setError(errText(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [describeTable, tab.connectionId, tab.database, tab.table])

  return (
    <div className="table-cols-view" style={{ padding: 12 }}>
      <div style={{ marginBottom: 8, color: '#888' }}>
        {tab.database} <span style={{ margin: '0 4px' }}>/</span> {tab.table}
        <span style={{ marginLeft: 12, fontSize: 12 }}>（结构对比与同步将在后续版本提供）</span>
      </div>
      {loading && <Spin />}
      {error && <Alert type="error" showIcon message={error} />}
      {columns && (
        <Table
          size="small"
          rowKey="name"
          pagination={false}
          dataSource={columns}
          columns={[
            {
              title: '列名',
              dataIndex: 'name',
              width: 200,
              render: (v, r) =>
                r.key === 'PRI' ? (
                  <span>
                    <Tag color="gold" style={{ marginRight: 4 }}>
                      PK
                    </Tag>
                    {v}
                  </span>
                ) : (
                  v
                ),
            },
            { title: '类型', dataIndex: 'dataType', width: 180 },
            {
              title: '可空',
              dataIndex: 'nullable',
              width: 70,
              render: (v) => (v ? '是' : '否'),
            },
            {
              title: '键',
              dataIndex: 'key',
              width: 70,
              render: (v) =>
                v === 'PRI' ? '主键' : v === 'UNI' ? '唯一' : v === 'MUL' ? '索引' : '',
            },
            { title: '默认值', dataIndex: 'default', width: 140 },
            { title: '额外', dataIndex: 'extra', width: 130 },
            { title: '注释', dataIndex: 'comment' },
          ]}
        />
      )}
    </div>
  )
}
