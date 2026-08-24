import { create } from 'zustand'
import { api } from '../api/commands'
import type { ConnectionGroup, ConnectionProfile } from '../api/types'

interface ConnectionsState {
  groups: ConnectionGroup[]
  connections: ConnectionProfile[]
  loaded: boolean
  load: () => Promise<void>
  upsertLocal: (profile: ConnectionProfile) => void
  removeLocal: (id: string) => void
}

export const useConnectionsStore = create<ConnectionsState>((set) => ({
  groups: [],
  connections: [],
  loaded: false,

  load: async () => {
    const snapshot = await api.listConnections()
    set({ groups: snapshot.groups, connections: snapshot.connections, loaded: true })
  },

  upsertLocal: (profile) =>
    set((s) => {
      const idx = s.connections.findIndex((c) => c.id === profile.id)
      const connections = [...s.connections]
      if (idx >= 0) connections[idx] = profile
      else connections.push(profile)
      return { connections }
    }),

  removeLocal: (id) =>
    set((s) => ({ connections: s.connections.filter((c) => c.id !== id) })),
}))
