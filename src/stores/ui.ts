import { create } from 'zustand'
import type { ConnectionGroup, ConnectionProfile } from '../api/types'

export interface FormTarget {
  mode: 'create' | 'edit'
  profile?: ConnectionProfile
  defaultGroupId?: string | null
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
}))
