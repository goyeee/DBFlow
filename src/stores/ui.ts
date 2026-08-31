import { create } from 'zustand'
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

export const useUiStore = create<UiState>((set) => ({
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
}))
