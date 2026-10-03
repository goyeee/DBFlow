import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ConnectionGroup, ConnectionProfile } from '../api/types'

export interface FormTarget {
  mode: 'create' | 'edit'
  profile?: ConnectionProfile
  defaultGroupId?: string | null
}

/** 请求左侧导航树定位到某张表（nonce 保证重复点击同一表也触发） */
export interface RevealTableTarget {
  connectionId: string
  database: string
  table: string
  nonce: number
}

interface UiState {
  /** 左侧连接栏是否隐藏（持久化，重启保持） */
  siderCollapsed: boolean
  setSiderCollapsed: (collapsed: boolean) => void
  toggleSider: () => void

  /** ER 画布右下角小地图是否显示（持久化） */
  erMiniMap: boolean
  setErMiniMap: (show: boolean) => void

  form: FormTarget | null
  openForm: (target: FormTarget) => void
  closeForm: () => void

  groupModal: { mode: 'create' | 'rename'; group?: ConnectionGroup } | null
  openGroupModal: (target: { mode: 'create' | 'rename'; group?: ConnectionGroup }) => void
  closeGroupModal: () => void

  navicatOpen: boolean
  setNavicatOpen: (open: boolean) => void

  revealTable: RevealTableTarget | null
  revealInTree: (connectionId: string, database: string, table: string) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      siderCollapsed: false,
      setSiderCollapsed: (siderCollapsed) => set({ siderCollapsed }),
      toggleSider: () => set((s) => ({ siderCollapsed: !s.siderCollapsed })),

      erMiniMap: true,
      setErMiniMap: (erMiniMap) => set({ erMiniMap }),

      form: null,
      openForm: (target) => set({ form: target }),
      closeForm: () => set({ form: null }),

      groupModal: null,
      openGroupModal: (target) => set({ groupModal: target }),
      closeGroupModal: () => set({ groupModal: null }),

      navicatOpen: false,
      setNavicatOpen: (open) => set({ navicatOpen: open }),

      revealTable: null,
      revealInTree: (connectionId, database, table) =>
        set((s) => ({
          revealTable: { connectionId, database, table, nonce: (s.revealTable?.nonce ?? 0) + 1 },
        })),
    }),
    {
      name: 'dbflow-ui',
      // 显式 storage：默认实现引用 window.localStorage，在非 window 环境会失效
      storage: createJSONStorage(() => localStorage),
      // 仅持久化跨会话偏好的 UI 状态，其余临时 UI 状态不入库
      partialize: (s) => ({ siderCollapsed: s.siderCollapsed, erMiniMap: s.erMiniMap }),
    },
  ),
)
