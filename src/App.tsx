import { AppShell } from './components/layout/AppShell'
import { ConnectionFormModal } from './components/connection/ConnectionFormModal'
import { GroupModal } from './components/connection/GroupModal'
import { NavicatImportModal } from './components/connection/NavicatImportModal'

export default function App() {
  return (
    <>
      <AppShell />
      <ConnectionFormModal />
      <GroupModal />
      <NavicatImportModal />
    </>
  )
}
