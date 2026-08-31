import { useEffect, useRef, useState } from 'react'
import { Button, Dropdown, Empty, Layout, Menu, Space, Tabs, Tooltip, message } from 'antd'
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
import { COLOR_PRESETS } from '../connection/colors'
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
  const closeOtherTabs = useSessionStore((s) => s.closeOtherTabs)
  const closeTabsToRight = useSessionStore((s) => s.closeTabsToRight)
  const openTable = useSessionStore((s) => s.openTable)
  const revealInTree = useUiStore((s) => s.revealInTree)
  const connections = useConnectionsStore((s) => s.connections)

  // 标签悬停全称弹层：0.5s 后显示在鼠标右下方（浅色自定义弹层，不用黑底 Tooltip）
  const [tabTip, setTabTip] = useState<{ x: number; y: number; title: string } | null>(null)
  const tipTimer = useRef<number | undefined>(undefined)
  const showTipLater = (e: React.MouseEvent, title: string) => {
    const { clientX, clientY } = e
    window.clearTimeout(tipTimer.current)
    tipTimer.current = window.setTimeout(() => {
      // 贴右边缘时往回拨，防止弹层超出视口
      const x = Math.min(clientX + 12, window.innerWidth - 380)
      setTabTip({ x, y: clientY + 16, title })
    }, 500)
  }
  const hideTip = () => {
    window.clearTimeout(tipTimer.current)
    setTabTip(null)
  }

  const tabColor = (connectionId: string) => {
    const c = connections.find((x) => x.id === connectionId)
    if (!c?.color) return undefined
    return COLOR_PRESETS[c.color] ?? c.color
  }

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
              items={tabs.map((t, i) => {
                const color = tabColor(t.connectionId)
                const connName = connections.find((c) => c.id === t.connectionId)?.name
                // 表名@数据库名(连接名)
                const title = `${t.table}@${t.database}${connName ? `(${connName})` : ''}`
                return {
                  key: t.key,
                  label: (
                    <Dropdown
                      trigger={['contextMenu']}
                      menu={{
                        items: [
                          { key: 'close', label: '关闭' },
                          {
                            key: 'close-right',
                            label: '关闭右侧',
                            disabled: i === tabs.length - 1,
                          },
                          {
                            key: 'close-others',
                            label: '关闭其他',
                            disabled: tabs.length <= 1,
                          },
                          { type: 'divider' },
                          { key: 'reveal', label: '导航栏打开' },
                        ],
                        onClick: ({ key: action }) => {
                          if (action === 'close') closeTab(t.key)
                          else if (action === 'close-right') closeTabsToRight(t.key)
                          else if (action === 'close-others') closeOtherTabs(t.key)
                          else if (action === 'reveal')
                            revealInTree(t.connectionId, t.database, t.table)
                        },
                      }}
                    >
                      <span
                        className="table-tab-label"
                        onDoubleClick={() =>
                          openTable(t.connectionId, t.database, t.table)
                        }
                        onMouseEnter={(e) => showTipLater(e, title)}
                        onMouseLeave={hideTip}
                        onContextMenu={hideTip}
                        style={{
                          fontStyle: t.preview ? 'italic' : undefined,
                          borderBottom: color ? `3px solid ${color}` : undefined,
                        }}
                      >
                        {title}
                      </span>
                    </Dropdown>
                  ),
                  children: <TableColumnsView tab={t} />,
                }
              })}
            />
          )}
        </Layout.Content>
      </Layout>

      <SyncSchemaModal />

      {tabTip && (
        <div className="tab-tip" style={{ left: tabTip.x, top: tabTip.y }}>
          {tabTip.title}
        </div>
      )}
    </Layout>
  )
}
