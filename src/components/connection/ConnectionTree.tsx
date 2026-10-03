import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dropdown, Empty, Modal, Spin, Tree, message } from 'antd'
import type { DataNode } from 'antd/es/tree'
import {
  ApiOutlined,
  ApartmentOutlined,
  DatabaseOutlined,
  DisconnectOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  PlusOutlined,
  TableOutlined,
} from '@ant-design/icons'
import type { AppErrorInfo, ConnectionProfile } from '../../api/types'
import { api } from '../../api/commands'
import { useConnectionsStore } from '../../stores/connections'
import { useSessionStore } from '../../stores/session'
import { useUiStore } from '../../stores/ui'
import { COLOR_PRESETS } from './colors'
import { guardCloseTabs, guardDisconnect } from '../er/closeGuard'

/**
 * nodeKey 编码：
 *   g:{groupId}          分组（'none' 为未分组）
 *   c:{connId}           连接
 *   d:{connId}:{db}      数据库（db 名 encodeURIComponent）
 *   t:{connId}:{db}:{table} 表
 */
function parseKey(key: string) {
  const [type, ...rest] = key.split(':')
  return { type, rest }
}

export function errText(e: unknown): string {
  const err = e as AppErrorInfo
  return err?.message || String(e)
}

// 树加载失败提示：固定 key 去重——反复失败时只更新同一个弹层，绝不堆叠
const showLoadError = (e: unknown) =>
  message.error({ content: errText(e), key: 'tree-load-error', duration: 3 })

export function ConnectionTree() {
  const { groups, connections } = useConnectionsStore()
  const session = useSessionStore()
  const ui = useUiStore()
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  // 加载失败的节点：计入受控 loadedKeys，阻断 rc-tree 的重试循环
  const [loadFailedKeys, setLoadFailedKeys] = useState<string[]>([])
  // 手动控制 loadedKeys：让 rc-tree 的 loadData 只在"缓存未加载"时触发，
  // 刷新/断开导致缓存清空后能自动重新加载，避免空缓存节点被反复请求
  const loadedKeys = useMemo(() => {
    const keys: string[] = []
    for (const c of connections) {
      if (session.dbsCache[c.id] !== undefined) {
        keys.push(`c:${c.id}`)
        for (const d of session.dbsCache[c.id]) {
          if (session.tablesCache[`${c.id}/${d.name}`] !== undefined) {
            keys.push(`d:${c.id}:${encodeURIComponent(d.name)}`)
          }
        }
      }
    }
    return [...keys, ...loadFailedKeys]
  }, [connections, session.dbsCache, session.tablesCache, loadFailedKeys])

  // 双击防抖：双击的第二次点击不再切换展开状态
  const lastClick = useRef<{ key: string; time: number }>({ key: '', time: 0 })

  /** 连接 + host key 指纹确认流程 */
  const ensureConnected = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await session.connect(id)
        return true
      } catch (e) {
        const err = e as AppErrorInfo
        if (err?.code === 'host_key_unknown' && err.detail) {
          return new Promise((resolve) => {
            Modal.confirm({
              title: '确认 SSH 主机指纹',
              content: (
                <div>
                  <p>首次连接该跳板机，服务器指纹：</p>
                  <p>
                    <code>{err.detail}</code>
                  </p>
                  <p>请与跳板机管理员核对后决定是否信任。</p>
                </div>
              ),
              okText: '信任并继续',
              cancelText: '取消',
              onOk: async () => {
                try {
                  await session.connect(id, err.detail)
                  resolve(true)
                } catch (e2) {
                  message.error(errText(e2))
                  resolve(false)
                }
              },
              onCancel: () => resolve(false),
            })
          })
        }
        throw e
      }
    },
    [session],
  )

  /** 展开某节点前保证其数据就绪：
   *  - 缓存命中直接过；未连接先连接
   *  - 后端会话丢失（not_found）自动重连重试一次
   *  - 并发去重（rc-tree 的 loadData 与主动触发同时进来时不重复请求）
   */
  const inflight = useRef<Map<string, Promise<void>>>(new Map())
  const ensureNodeLoaded = useCallback(
    async (key: string): Promise<void> => {
      const existing = inflight.current.get(key)
      if (existing) return existing

      const task = (async () => {
        const { type, rest } = parseKey(key)
        if (type === 'c') {
          const id = rest[0]
          const cached = session.dbsCache[id]
          // undefined 表示尚未加载；空数组表示"确实没有库"，不应重复请求
          if (cached === undefined) {
            const ok = await ensureConnected(id)
            if (!ok) throw new Error('连接失败')
            try {
              await session.loadDatabases(id)
            } catch (e) {
              if ((e as AppErrorInfo)?.code === 'not_found') {
                // 后端会话已丢（如编辑保存后被断开）→ 重建后重试
                await session.forceReconnect(id)
                await session.loadDatabases(id)
              } else {
                throw e
              }
            }
          }
        } else if (type === 'd') {
          const [id, db] = rest
          const dbName = decodeURIComponent(db)
          const cacheKey = `${id}/${dbName}`
          const cached = session.tablesCache[cacheKey]
          if (cached === undefined) {
            try {
              await session.loadTables(id, dbName)
            } catch (e) {
              if ((e as AppErrorInfo)?.code === 'not_found') {
                await session.forceReconnect(id)
                await session.loadTables(id, dbName)
              } else {
                throw e
              }
            }
          }
        }
      })().finally(() => inflight.current.delete(key))

      inflight.current.set(key, task)
      return task
    },
    [ensureConnected, session],
  )

  const loadData = useCallback(
    async (key: string): Promise<void> => {
      // 重试前先摘掉失败标记（若 rc-tree 已视为"已加载"，由 onExpand 手动触发重试）
      setLoadFailedKeys((prev) => prev.filter((k) => k !== key))
      try {
        await ensureNodeLoaded(key)
      } catch (e) {
        // 加载失败必须可见（之前静默吞掉会让节点"再也打不开"）。
        // 同时标记失败：rc-tree 对"展开但未加载"的节点每次渲染都会重新触发 loadData，
        // 不标记的话连接失败会陷入 无限重连 + 弹层风暴。
        setLoadFailedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]))
        showLoadError(e)
      }
    },
    [ensureNodeLoaded],
  )

  // 标签页右键"导航栏打开"：确保数据就绪 → 展开 分组/连接/库 → 选中表 → 滚动到可见
  const reveal = useUiStore((s) => s.revealTable)
  useEffect(() => {
    if (!reveal) return
    let cancelled = false
    const connKey = `c:${reveal.connectionId}`
    const dbKey = `d:${reveal.connectionId}:${encodeURIComponent(reveal.database)}`
    const tableKey = `t:${reveal.connectionId}:${encodeURIComponent(reveal.database)}:${encodeURIComponent(reveal.table)}`
    const groupId = connections.find((c) => c.id === reveal.connectionId)?.groupId
    const groupKey = `g:${groupId ?? 'none'}`
    ;(async () => {
      try {
        await ensureNodeLoaded(connKey)
        await ensureNodeLoaded(dbKey)
      } catch (e) {
        showLoadError(e)
        return
      }
      if (cancelled) return
      setExpandedKeys((prev) => [...new Set([...prev, groupKey, connKey, dbKey])])
      setSelectedKeys([tableKey])
      // 等展开后的树渲染完，再滚动到选中节点
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document
            .querySelector('.sider-body .ant-tree-treenode-selected')
            ?.scrollIntoView({ block: 'nearest' })
        }),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [reveal, connections, ensureNodeLoaded])

  const treeData = useMemo<DataNode[]>(() => {
    const connNode = (c: ConnectionProfile): DataNode => {
      const connected = !!session.connected[c.id]
      const connecting = !!session.connecting[c.id]
      const dbs = session.dbsCache[c.id] ?? []
      return {
        key: `c:${c.id}`,
        icon: connecting ? (
          <Spin size="small" />
        ) : connected ? (
          <LinkOutlined style={{ color: '#52c41a' }} />
        ) : (
          <ApiOutlined />
        ),
        title: (
          <span>
            {c.color && (
              <span
                className="color-dot"
                style={{ background: COLOR_PRESETS[c.color] ?? c.color }}
              />
            )}
            {c.name}
          </span>
        ),
        isLeaf: false,
        children: dbs.map((d) => {
          const cacheKey = `${c.id}/${d.name}`
          const tables = session.tablesCache[cacheKey] ?? []
          const dbKey = `d:${c.id}:${encodeURIComponent(d.name)}`
          // 展开即视为打开；折叠时若标签栏仍有该库的表，也保持打开状态
          const dbOpen =
            expandedKeys.includes(dbKey) ||
            session.tabs.some((tab) => tab.connectionId === c.id && tab.database === d.name)
          return {
            key: dbKey,
            icon: dbOpen ? (
              <DatabaseOutlined style={{ color: '#52c41a' }} />
            ) : (
              <DatabaseOutlined />
            ),
            title: d.name,
            isLeaf: false,
            children: tables.map((t) => {
              const tableKey = `t:${c.id}:${encodeURIComponent(d.name)}:${encodeURIComponent(t.name)}`
              const tableOpen = session.tabs.some(
                (tab) =>
                  tab.type === 'table' &&
                  tab.connectionId === c.id &&
                  tab.database === d.name &&
                  tab.table === t.name,
              )
              return {
                key: tableKey,
                icon: tableOpen ? (
                  <TableOutlined style={{ color: '#52c41a' }} />
                ) : (
                  <TableOutlined />
                ),
                title: t.comment ? <span title={t.comment}>{t.name}</span> : <span>{t.name}</span>,
                isLeaf: true,
              }
            }),
          }
        }),
      }
    }

    const nodes: DataNode[] = groups
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .map((g) => {
        const members = connections.filter((c) => c.groupId === g.id)
        return {
          key: `g:${g.id}`,
          icon: <FolderOpenOutlined />,
          title: `${g.name} (${members.length})`,
          isLeaf: false,
          children: members.map(connNode),
        }
      })

    const ungrouped = connections.filter((c) => !c.groupId)
    if (ungrouped.length > 0) {
      nodes.push({
        key: 'g:none',
        icon: <FolderOpenOutlined />,
        title: `未分组 (${ungrouped.length})`,
        isLeaf: false,
        children: ungrouped.map(connNode),
      })
    }
    return nodes
  }, [groups, connections, session.connected, session.connecting, session.dbsCache, session.tablesCache, expandedKeys, session.tabs])

  if (connections.length === 0 && groups.length === 0) {
    return (
      <div className="tree-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有连接">
          <a onClick={() => ui.openForm({ mode: 'create' })}>
            <PlusOutlined /> 新建连接
          </a>
        </Empty>
      </div>
    )
  }

  return (
    <Tree
      showIcon
      blockNode
      treeData={wrapContextMenu(treeData, { ensureConnected, setExpandedKeys })}
      expandedKeys={expandedKeys}
      selectedKeys={selectedKeys}
      loadedKeys={loadedKeys}
      onExpand={(keys) => {
        const next = keys as string[]
        // 展开状态由 rc-tree 的 loadData 自动加载子节点；这里只同步受控 keys
        setExpandedKeys(next)
        // 失败节点已被标记为"已加载"，rc-tree 不会再自动加载：用户再次展开时手动重试一次
        for (const k of next) {
          if (loadFailedKeys.includes(k)) loadData(k)
        }
      }}
      loadData={(node) => loadData(String(node.key))}
      onSelect={(keys, info) => {
        setSelectedKeys(keys as string[])
        const key = String(info.node.key)
        const { type, rest } = parseKey(key)

        // 双击的第二次点击（350ms 内同节点）用于正式打开表；非表节点双击不切换展开
        const now = Date.now()
        const last = lastClick.current
        const isDoubleClick = last.key === key && now - last.time < 350
        lastClick.current = { key, time: now }

        if (type === 't') {
          const [connId, db, table] = rest
          const database = decodeURIComponent(db)
          const tableName = decodeURIComponent(table)
          if (isDoubleClick) {
            session.openTable(connId, database, tableName)
          } else {
            session.previewTable(connId, database, tableName)
          }
          return
        }

        if (isDoubleClick) return

        // 单击连接/库/分组节点 = 展开/收起（loadData 由 rc-tree 自动触发）
        setExpandedKeys((prev) =>
          prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
        )
      }}
    />
  )
}

/** 给连接/分组节点挂右键菜单（不可变地重建树） */
function wrapContextMenu(
  nodes: DataNode[],
  ctx: {
    ensureConnected: (id: string) => Promise<boolean>
    setExpandedKeys: React.Dispatch<React.SetStateAction<string[]>>
  },
): DataNode[] {
  return nodes.map((node) => {
    const key = String(node.key)
    const { type, rest } = parseKey(key)
    let menu: React.ReactNode = node.title as React.ReactNode

    if (type === 'c') {
      menu = (
        <Dropdown
          trigger={['contextMenu']}
          menu={{
            items: [
              { key: 'connect', label: '打开连接', icon: <LinkOutlined /> },
              { key: 'disconnect', label: '断开连接', icon: <DisconnectOutlined /> },
              { key: 'edit', label: '编辑连接…' },
              { key: 'dup', label: '复制连接' },
              { type: 'divider' },
              { key: 'del', label: '删除连接', danger: true },
            ],
            onClick: async ({ key: action, domEvent }) => {
              domEvent.stopPropagation()
              const id = rest[0]
              const { connections: conns, removeLocal: rm } = useConnectionsStore.getState()
              const ui = useUiStore.getState()
              const conn = conns.find((c) => c.id === id)
              if (!conn) return
              if (action === 'edit') {
                ui.openForm({ mode: 'edit', profile: conn })
              } else if (action === 'dup') {
                try {
                  const dup = await api.duplicateConnection(id)
                  useConnectionsStore.getState().upsertLocal(dup)
                  message.success(`已复制为「${dup.name}」`)
                } catch (e) {
                  message.error(errText(e))
                }
              } else if (action === 'del') {
                Modal.confirm({
                  title: `删除连接「${conn.name}」？`,
                  content: '将同时删除钥匙串中保存的密码，不可恢复。',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    // 先过未保存布局守卫（含断开），取消则不删除
                    const proceed = await guardDisconnect(id, async () => {
                      if (useSessionStore.getState().connected[id]) {
                        await useSessionStore.getState().disconnect(id)
                      }
                    })
                    if (!proceed) return
                    await api.deleteConnection(id)
                    rm(id)
                    message.success('已删除')
                  },
                })
              } else if (action === 'connect') {
                const ok = await ctx.ensureConnected(id)
                if (ok) ctx.setExpandedKeys((prev) => [...new Set([...prev, `c:${id}`])])
              } else if (action === 'disconnect') {
                await guardDisconnect(id, async () => {
                  // 先折叠再断开；否则 rc-tree 看到 expandedKeys 还在、loadedKeys 已清空，
                  // 会立即 loadData 重连，导致“折叠了但图标还是绿色”
                  ctx.setExpandedKeys((prev) =>
                    prev.filter((k) => k !== `c:${id}` && !k.startsWith(`d:${id}:`)),
                  )
                  await useSessionStore.getState().disconnect(id)
                })
              }
            },
          }}
        >
          <span className="tree-node-title">{node.title as React.ReactNode}</span>
        </Dropdown>
      )
    } else if (type === 'd') {
      // 数据库节点右键：查看 ER 图 / 关闭（收起该节点，并关掉该库下所有已打开的标签）
      menu = (
        <Dropdown
          trigger={['contextMenu']}
          menu={{
            items: [
              { key: 'er', label: '查看 ER 图', icon: <ApartmentOutlined /> },
              { type: 'divider' },
              { key: 'close', label: '关闭' },
            ],
            onClick: async ({ key: action, domEvent }) => {
              domEvent.stopPropagation()
              const [id, db] = rest
              if (action === 'er') {
                if (await ctx.ensureConnected(id)) {
                  useSessionStore.getState().openErTab(id, decodeURIComponent(db))
                }
              } else if (action === 'close') {
                const database = decodeURIComponent(db)
                const closeKeys = useSessionStore
                  .getState()
                  .tabs.filter((t) => t.connectionId === id && t.database === database)
                  .map((t) => t.key)
                guardCloseTabs(closeKeys, () => {
                  useSessionStore.getState().closeDatabaseTabs(id, database)
                  ctx.setExpandedKeys((prev) => prev.filter((k) => k !== key))
                })
              }
            },
          }}
        >
          <span className="tree-node-title">{node.title as React.ReactNode}</span>
        </Dropdown>
      )
    } else if (type === 'g') {
      const isNone = rest[0] === 'none'
      menu = (
        <Dropdown
          trigger={['contextMenu']}
          menu={{
            items: [
              { key: 'new', label: '在此组新建连接…', icon: <PlusOutlined /> },
              ...(isNone
                ? []
                : [
                    { key: 'rename', label: '重命名分组…' },
                    { key: 'del', label: '删除分组', danger: true },
                  ]),
            ],
            onClick: async ({ key: action, domEvent }) => {
              domEvent.stopPropagation()
              const ui = useUiStore.getState()
              const groupId = isNone ? null : rest[0]
              const group = isNone
                ? null
                : useConnectionsStore.getState().groups.find((g) => g.id === rest[0])
              if (action === 'new') {
                ui.openForm({ mode: 'create', defaultGroupId: groupId })
              } else if (action === 'rename' && group) {
                ui.openGroupModal({ mode: 'rename', group })
              } else if (action === 'del' && group) {
                Modal.confirm({
                  title: `删除分组「${group.name}」？`,
                  content: '组内连接会移到"未分组"，连接本身不受影响。',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    await api.deleteGroup(group.id)
                    await useConnectionsStore.getState().load()
                  },
                })
              }
            },
          }}
        >
          <span className="tree-node-title">{node.title as React.ReactNode}</span>
        </Dropdown>
      )
    }

    return {
      ...node,
      title: menu,
      children: node.children ? wrapContextMenu(node.children, ctx) : node.children,
    }
  })
}
