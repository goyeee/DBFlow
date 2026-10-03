import { useEffect, useState } from 'react'
import '@xyflow/react/dist/style.css'
import { Alert, Button, Result, Spin } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { ReactFlowProvider } from '@xyflow/react'

import type { ErTab } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { useConnectionsStore } from '../../stores/connections'
import { LAYOUT_LIMIT, useErStore } from '../../stores/er'
import { ErCanvas } from './ErCanvas'
import { ErDrawer } from './ErDrawer'
import { ErTableDesigner } from './ErTableDesigner'
import { ErToolbar } from './ErToolbar'
import { ErTabProvider } from './erTabContext'

/** ER 图标签页容器。
 *  ER 状态按 tabKey 分片：仅在该分片首次不存在时加载，切走再切回保留状态；
 *  ErView 在非激活时卸载画布释放 DOM，但分片状态保留在 store */
export function ErView({ tab }: { tab: ErTab }) {
  const tabKey = tab.key
  const slice = useErStore((s) => s.tabs[tabKey])
  const active = useSessionStore((s) => s.activeTab) === tabKey
  // 推断边超限提示为本地一次性关闭（非持久）。注意：所有 Hook 必须在
  // 「if (!active) return null」之前——非激活渲染时 Hook 数量变化会直接崩掉整个界面
  const [limitHidden, setLimitHidden] = useState(false)

  useEffect(() => {
    if (!active || useErStore.getState().tabs[tabKey]) return
    // 连接名在调用时读取（避免响应式依赖造成重复加载）
    const name =
      useConnectionsStore
        .getState()
        .connections.find((c) => c.id === tab.connectionId)?.name ?? ''
    useErStore.getState().load(tabKey, tab.connectionId, tab.database, name)
  }, [active, tabKey, tab.connectionId, tab.database])

  if (!active) return null

  const status = slice?.status ?? 'idle'
  const tableCount = slice?.graph ? Object.keys(slice.graph.tables).length : 0
  const inferredCount = slice?.inferredEdges.length ?? 0

  const retry = () => {
    const name =
      useConnectionsStore
        .getState()
        .connections.find((c) => c.id === tab.connectionId)?.name ?? ''
    useErStore.getState().load(tabKey, tab.connectionId, tab.database, name)
  }

  return (
    <div className="er-view">
      {status === 'loading' && (
        <div className="er-center">
          <Spin tip="正在逆向数据库结构…" />
        </div>
      )}
      {status === 'error' && (
        <div className="er-center">
          <Result
            status="warning"
            title="加载失败"
            subTitle={slice?.error ?? undefined}
            extra={
              <Button icon={<ReloadOutlined />} onClick={retry}>
                重试
              </Button>
            }
          />
        </div>
      )}
      {status === 'ready' && tableCount === 0 && (
        <div className="er-center">
          <Result
            status="info"
            title="该库没有表"
            subTitle="逆向结果为 0 张表。可能是该账号无权限，或该库只有视图（视图不进入 ER 图）。"
            extra={
              <Button icon={<ReloadOutlined />} onClick={retry}>
                重新加载
              </Button>
            }
          />
        </div>
      )}
      {status === 'ready' && tableCount > 0 && (
        <ErTabProvider tabKey={tabKey}>
          {slice.docIssue && (
            <Alert
              type="warning"
              showIcon
              className="er-notice"
              message="模型文档读取失败"
              description={`${slice.docIssue}。已按无文档重新布局；此时保存会覆盖原文档。`}
              closable
              onClose={() => useErStore.getState().dismissDocIssue(tabKey)}
            />
          )}
          {!limitHidden && inferredCount > LAYOUT_LIMIT && (
            <Alert
              type="info"
              showIcon
              className="er-notice"
              message={`检测到 ${inferredCount} 条推断关系，仅前 ${LAYOUT_LIMIT} 条（已确认的除外）参与布局`}
              closable
              onClose={() => setLimitHidden(true)}
            />
          )}
          <ErToolbar />
          <div className="er-body">
            <ReactFlowProvider>
              <ErCanvas />
            </ReactFlowProvider>
          </div>
          <ErDrawer />
          <ErTableDesigner />
        </ErTabProvider>
      )}
    </div>
  )
}
