import { create } from 'zustand'
import { api } from '../api/commands'
import type { ConnectResult, DatabaseBrief, TableBrief } from '../api/types'

export interface TableTab {
  key: string
  type: 'table'
  connectionId: string
  database: string
  table: string
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
  /** 左上角刷新：强制重拉所有已连接会话的库列表，并清空表缓存（展开时重新拉） */
  refreshConnected: () => Promise<void>
  openTable: (connectionId: string, database: string, table: string) => void
  closeTab: (key: string) => void
  setActiveTab: (key: string | null) => void
  setError: (nodeKey: string, message: string | null) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
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
    const dbs = await api.listDatabases(id)
    set((s) => ({ dbsCache: { ...s.dbsCache, [id]: dbs } }))
    return dbs
  },

  loadTables: async (id, database, force = false) => {
    const cacheKey = `${id}/${database}`
    const cached = get().tablesCache[cacheKey]
    if (cached && !force) return cached
    const tables = await api.listTables(id, database)
    set((s) => ({ tablesCache: { ...s.tablesCache, [cacheKey]: tables } }))
    return tables
  },

  refreshConnected: async () => {
    const ids = Object.keys(get().connected)
    // 先清表缓存（外面可能新建/删除了表），再强制重拉库列表
    set({ tablesCache: {} })
    await Promise.allSettled(ids.map((id) => get().loadDatabases(id, true)))
  },

  openTable: (connectionId, database, table) => {
    const key = `${connectionId}/${database}/${table}`
    set((s) => {
      const tab: TableTab = { key, type: 'table', connectionId, database, table }
      const tabs = s.tabs.some((t) => t.key === key) ? s.tabs : [...s.tabs, tab]
      return { tabs, activeTab: key }
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

  setActiveTab: (key) => set({ activeTab: key }),

  setError: (nodeKey, message) =>
    set((s) => {
      const errors = { ...s.errors }
      if (message) errors[nodeKey] = message
      else delete errors[nodeKey]
      return { errors }
    }),
}))
