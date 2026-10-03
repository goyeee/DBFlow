import { Button, Dropdown, Space, Tooltip, message } from 'antd'
import type { MenuProps } from 'antd'
import {
  ApartmentOutlined,
  EllipsisOutlined,
  FolderAddOutlined,
  ImportOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { api } from '../../api/commands'
import { useConnectionsStore } from '../../stores/connections'
import { useCompareStore } from '../../stores/compare'
import { useDataCompareStore } from '../../stores/dataCompare'
import { useSessionStore } from '../../stores/session'
import { useUiStore } from '../../stores/ui'
import { errText } from '../connection/ConnectionTree'

export function TitleBar() {
  const openForm = useUiStore((s) => s.openForm)
  const openGroupModal = useUiStore((s) => s.openGroupModal)
  const setNavicatOpen = useUiStore((s) => s.setNavicatOpen)
  const siderCollapsed = useUiStore((s) => s.siderCollapsed)
  const toggleSider = useUiStore((s) => s.toggleSider)
  const openSyncSchema = useCompareStore((s) => s.openModal)
  const openDataSync = useDataCompareStore((s) => s.openModal)
  const load = useConnectionsStore((s) => s.load)
  const refreshConnected = useSessionStore((s) => s.refreshConnected)

  const handleRefresh = () => {
    load().catch((e) => message.error(errText(e)))
    refreshConnected().catch((e) => message.error(errText(e)))
  }

  const moreItems: MenuProps['items'] = [
    {
      key: 'new-group',
      label: '新建分组',
      icon: <FolderAddOutlined />,
      onClick: () => openGroupModal({ mode: 'create' }),
    },
    {
      key: 'navicat-import',
      label: '从 Navicat 导入',
      icon: <ImportOutlined />,
      onClick: () => setNavicatOpen(true),
    },
    {
      key: 'refresh',
      label: '刷新',
      icon: <ReloadOutlined />,
      onClick: handleRefresh,
    },
    { type: 'divider' },
    {
      key: 'settings',
      label: '打开配置目录',
      icon: <SettingOutlined />,
      onClick: () => api.openConfigDir().catch((e) => message.error(errText(e))),
    },
  ]

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-logo" data-tauri-drag-region="no-drag">
        <img src="/logo.png" alt="DBFlow" className="titlebar-logo-img" />
        <span>DBFlow</span>
      </div>
      <Space size={2} className="titlebar-actions" data-tauri-drag-region="no-drag">
        <Tooltip title={siderCollapsed ? '显示侧边栏' : '隐藏侧边栏'} placement="bottom">
          <Button
            type="text"
            size="small"
            className="titlebar-btn"
            data-tauri-drag-region="no-drag"
            icon={siderCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={toggleSider}
          />
        </Tooltip>
        <Tooltip title="新建连接" placement="bottom">
          <Button
            type="text"
            size="small"
            className="titlebar-btn"
            data-tauri-drag-region="no-drag"
            icon={<PlusOutlined />}
            onClick={() => openForm({ mode: 'create' })}
          >
            新建连接
          </Button>
        </Tooltip>
        <Tooltip title="结构同步" placement="bottom">
          <Button
            type="text"
            size="small"
            className="titlebar-btn"
            data-tauri-drag-region="no-drag"
            icon={<ApartmentOutlined />}
            onClick={openSyncSchema}
          >
            结构同步
          </Button>
        </Tooltip>
        <Tooltip title="数据同步" placement="bottom">
          <Button
            type="text"
            size="small"
            className="titlebar-btn"
            data-tauri-drag-region="no-drag"
            icon={<SwapOutlined />}
            onClick={openDataSync}
          >
            数据同步
          </Button>
        </Tooltip>
        <Dropdown menu={{ items: moreItems }} placement="bottomLeft">
          <Button
            type="text"
            size="small"
            className="titlebar-btn"
            data-tauri-drag-region="no-drag"
            icon={<EllipsisOutlined />}
          >
            更多
          </Button>
        </Dropdown>
      </Space>
    </header>
  )
}
