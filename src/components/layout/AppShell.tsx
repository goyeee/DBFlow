import { useEffect } from 'react'
import { Button, Empty, Layout, Menu, Space, Tabs, Tooltip, message } from 'antd'
import {
  FolderAddOutlined,
  ImportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { api } from '../../api/commands'
import { useConnectionsStore } from '../../stores/connections'
import { useCompareStore } from '../../stores/compare'
import { useSessionStore } from '../../stores/session'
import { useUiStore } from '../../stores/ui'
import { ConnectionTree } from '../connection/ConnectionTree'
import { TableColumnsView } from '../table/TableColumnsView'
import { SyncSchemaModal } from '../compare/SyncSchemaModal'
import { errText } from '../connection/ConnectionTree'

export function AppShell() {
  const load = useConnectionsStore((s) => s.load)
  const openForm = useUiStore((s) => s.openForm)
  const openGroupModal = useUiStore((s) => s.openGroupModal)
  const setNavicatOpen = useUiStore((s) => s.setNavicatOpen)
  const openSyncSchema = useCompareStore((s) => s.openModal)
  const tabs = useSessionStore((s) => s.tabs)
  const activeTab = useSessionStore((s) => s.activeTab)
  const setActiveTab = useSessionStore((s) => s.setActiveTab)
  const closeTab = useSessionStore((s) => s.closeTab)

  useEffect(() => {
    load().catch((e) => message.error(errText(e)))
  }, [load])

  return (
    <Layout className="app-shell">
      <Layout.Header className="menubar">
        <Menu
          mode="horizontal"
          selectable={false}
          className="menubar-menu"
          onClick={({ key }) => {
            if (key === 'schema-sync') openSyncSchema()
          }}
          items={[
            {
              key: 'tools',
              label: '工具',
              children: [{ key: 'schema-sync', label: '结构同步…' }],
            },
          ]}
        />
      </Layout.Header>

      <Layout className="app-body">
        <Layout.Sider width={280} theme="light" className="sider">
          <div className="sider-header">
            <span className="app-title">DBFlow</span>
            <Space size={2}>
              <Tooltip title="新建连接">
                <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => openForm({ mode: 'create' })} />
              </Tooltip>
              <Tooltip title="新建分组">
                <Button type="text" size="small" icon={<FolderAddOutlined />} onClick={() => openGroupModal({ mode: 'create' })} />
              </Tooltip>
              <Tooltip title="从 Navicat 导入">
                <Button type="text" size="small" icon={<ImportOutlined />} onClick={() => setNavicatOpen(true)} />
              </Tooltip>
              <Tooltip title="刷新（重载连接配置 + 已连接会话的库/表列表）">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    load().catch((e) => message.error(errText(e)))
                    useSessionStore
                      .getState()
                      .refreshConnected()
                      .catch((e) => message.error(errText(e)))
                  }}
                />
              </Tooltip>
              <Tooltip title="打开配置目录">
                <Button
                  type="text"
                  size="small"
                  icon={<SettingOutlined />}
                  onClick={() => api.openConfigDir().catch((e) => message.error(errText(e)))}
                />
              </Tooltip>
            </Space>
          </div>
          <div className="sider-body">
            <ConnectionTree />
          </div>
        </Layout.Sider>

        <Layout.Content className="content">
          {tabs.length === 0 ? (
            <div className="content-empty">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span>
                    在左侧展开一个连接浏览数据库
                    <br />
                    双击表查看列结构；「工具 → 结构同步」对比两个库
                  </span>
                }
              />
            </div>
          ) : (
            <Tabs
              type="editable-card"
              hideAdd
              activeKey={activeTab ?? undefined}
              onChange={(k) => setActiveTab(k)}
              onEdit={(k, action) => {
                if (action === 'remove') closeTab(String(k))
              }}
              items={tabs.map((t) => ({
                key: t.key,
                label: `${t.database}/${t.table}`,
                children: <TableColumnsView tab={t} />,
              }))}
            />
          )}
        </Layout.Content>
      </Layout>

      <SyncSchemaModal />
    </Layout>
  )
}
