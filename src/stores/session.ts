import { create } from 'zustand'
import { api } from '../api/commands'
import type { AppErrorInfo, ColumnBrief, ConnectResult, DatabaseBrief, TableBrief } from '../api/types'

export interface TableTab {
  key: string
  type: 'table'
  connectionId: string
  database: string
  table: string
  /** 首次单击为预览标签，双击/编辑后转正 */
  preview?: boolean
}

export type WorkTab = TableTab

interface SessionState {
  /** connectionId → 连接结果 */
  connected: Record<string, ConnectResult>
  /** 正在连接中的 connectionId 集合 */
  connecting: Record<string, boolean>
  /** 树加载错误：nodeKey → 错误文案 */
  errors: Record<string, string>
  dbsCache: Record<string, DatabaseBrief[]>
  tablesCache: Record<string, TableBrief[]>
  tabs: WorkTab[]
  activeTab: string | null

  connect: (id: string, trustHostKey?: string) => Promise<boolean>
  forceReconnect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  loadDatabases: (id: string, force?: boolean) => Promise<DatabaseBrief[]>
  loadTables: (id: string, database: string, force?: boolean) => Promise<TableBrief[]>
  describeTable: (id: string, database: string, table: string) => Promise<ColumnBrief[]>
  /** 左上角刷新：强制重拉所有已连接会话的库列表，并清空表缓存（展开时重新拉） */
  refreshConnected: () => Promise<void>
  /** 单击表：预览打开（同一时刻只有一个预览标签） */
  previewTable: (connectionId: string, database: string, table: string) => void
  /** 双击表/另存预览：正式打开 */
  openTable: (connectionId: string, database: string, table: string) => void
  closeTab: (key: string) => void
  /** 关闭除 key 外的所有标签（key 不存在时清空全部） */
  closeOtherTabs: (key: string) => void
  /** 关闭 key 右侧的所有标签 */
  closeTabsToRight: (key: string) => void
  /** 关闭某连接某库下的所有表标签（导航树数据库节点右键"关闭"） */
  closeDatabaseTabs: (connectionId: string, database: string) => void
  setActiveTab: (key: string | null) => void
  setError: (nodeKey: string, message: string | null) => void
}

export const useSessionStore = create<SessionState>((set, get) => {
  /** 通用"断线重连一次"包装：操作失败且判断为连接丢失时，先 forceReconnect 再重试 */
  const withReconnect = withSessionReconnect

  return {
    connected: {},
  connecting: {},
  errors: {},
  dbsCache: {},
  tablesCache: {},
  tabs: [],
  activeTab: null,

  connect: async (id, trustHostKey) => {
    if (get().connected[id]) return true
    set((s) => ({ connecting: { ...s.connecting, [id]: true } }))
    try {
      const result = await api.connect(id, trustHostKey)
      set((s) => ({ connected: { ...s.connected, [id]: result } }))
      return true
    } finally {
      set((s) => {
        const connecting = { ...s.connecting }
        delete connecting[id]
        return { connecting }
      })
    }
  },

  /** 后端会话丢失（如编辑保存后被断开）时强制重建连接 */
  forceReconnect: async (id) => {
    set((s) => {
      const connected = { ...s.connected }
      delete connected[id]
      return { connected }
    })
    await get().connect(id)
  },

  disconnect: async (id) => {
    await api.disconnect(id)
    set((s) => {
      const connected = { ...s.connected }
      delete connected[id]
      const dbsCache = { ...s.dbsCache }
      delete dbsCache[id]
      // 同时清掉该连接的表级缓存（前缀 `${id}/`）
      const tablesCache: Record<string, TableBrief[]> = {}
      for (const [k, v] of Object.entries(s.tablesCache)) {
        if (!k.startsWith(`${id}/`)) tablesCache[k] = v
      }
      // 关掉该连接下所有打开的表标签
      const tabs = s.tabs.filter((t) => t.type === 'table' && t.connectionId !== id)
      const activeTab =
        s.activeTab && tabs.some((t) => t.key === s.activeTab) ? s.activeTab : tabs[0]?.key ?? null
      return { connected, dbsCache, tablesCache, tabs, activeTab }
    })
  },

  loadDatabases: async (id, force = false) => {
    const cached = get().dbsCache[id]
    if (cached && !force) return cached
    const dbs = await withReconnect(id, () => api.listDatabases(id))
    set((s) => ({ dbsCache: { ...s.dbsCache, [id]: dbs } }))
    return dbs
  },

  loadTables: async (id, database, force = false) => {
    const cacheKey = `${id}/${database}`
    const cached = get().tablesCache[cacheKey]
    if (cached && !force) return cached
    const tables = await withReconnect(id, () => api.listTables(id, database))
    set((s) => ({ tablesCache: { ...s.tablesCache, [cacheKey]: tables } }))
    return tables
  },

  describeTable: async (id, database, table) => {
    return withReconnect(id, () => api.describeTable(id, database, table))
  },

  refreshConnected: async () => {
    const ids = Object.keys(get().connected)
    // 先清表缓存（外面可能新建/删除了表），再强制重拉库列表
    set({ tablesCache: {} })
    await Promise.allSettled(ids.map((id) => get().loadDatabases(id, true)))
  },

  previewTable: (connectionId, database, table) => {
    const key = `${connectionId}/${database}/${table}`
    set((s) => {
      const existing = s.tabs.find((t) => t.key === key)
      if (existing) {
        return { activeTab: key }
      }
      const previewIdx = s.tabs.findIndex((t) => t.preview)
      const tab: TableTab = {
        key,
        type: 'table',
        connectionId,
        database,
        table,
        preview: true,
      }
      const tabs =
        previewIdx !== -1
          ? s.tabs.map((t, i) => (i === previewIdx ? tab : t))
          : [...s.tabs, tab]
      return { tabs, activeTab: key }
    })
  },

  openTable: (connectionId, database, table) => {
    const key = `${connectionId}/${database}/${table}`
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.key === key)
      if (idx !== -1) {
        if (s.tabs[idx].preview) {
          const tabs = [...s.tabs]
          tabs[idx] = { ...tabs[idx], preview: false }
          return { tabs, activeTab: key }
        }
        return { activeTab: key }
      }
      const tab: TableTab = {
        key,
        type: 'table',
        connectionId,
        database,
        table,
        preview: false,
      }
      return { tabs: [...s.tabs, tab], activeTab: key }
    })
  },

  closeTab: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key)
      return {
        tabs,
        activeTab: s.activeTab === key ? tabs[tabs.length - 1]?.key ?? null : s.activeTab,
      }
    }),

  closeOtherTabs: (key) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key === key)
      return {
        tabs,
        activeTab: s.activeTab && tabs.some((t) => t.key === s.activeTab) ? s.activeTab : tabs[0]?.key ?? null,
      }
    }),

  closeTabsToRight: (key) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.key === key)
      if (idx === -1) return {}
      const tabs = s.tabs.slice(0, idx + 1)
      return {
        tabs,
        activeTab: s.activeTab && tabs.some((t) => t.key === s.activeTab) ? s.activeTab : key,
      }
    }),

  closeDatabaseTabs: (connectionId, database) =>
    set((s) => {
      const tabs = s.tabs.filter(
        (t) => !(t.connectionId === connectionId && t.database === database),
      )
      if (tabs.length === s.tabs.length) return {}
      return {
        tabs,
        activeTab:
          s.activeTab && tabs.some((t) => t.key === s.activeTab)
            ? s.activeTab
            : tabs[0]?.key ?? null,
      }
    }),

  setActiveTab: (key) => set({ activeTab: key }),

  setError: (nodeKey, message) =>
    set((s) => {
      const errors = { ...s.errors }
      if (message) errors[nodeKey] = message
      else delete errors[nodeKey]
      return { errors }
    }),
  }
})

/** 断线自愈包装（供其他 store 复用）：连接失效类错误（EOF/not_found 等）时
 *  先强制重连一次再重试操作；密码错误等认证类失败不在此列，原样抛出 */
export async function withSessionReconnect<T>(
  connectionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (e) {
    const err = e as AppErrorInfo
    const retryable =
      err?.code === 'not_found' ||
      /EOF|broken pipe|Connection reset|expected to read|network|communicating|timed out|timeout|closed/i.test(
        err?.message || '',
      )
    const denied =
      /Access denied|用户名或密码错误|认证失败|authentication|password/i.test(err?.message || '')
    if (!retryable || denied) throw e
    await useSessionStore.getState().forceReconnect(connectionId)
    return await operation()
  }
}
