import { createContext, useContext, type ReactNode } from 'react'

import { useErStore, type ErTabState } from '../../stores/er'

const ErTabContext = createContext<{ tabKey: string } | null>(null)

/** ErView 给当前标签的所有 ER 子组件注入 tabKey */
export function ErTabProvider({
  tabKey,
  children,
}: {
  tabKey: string
  children: ReactNode
}) {
  return <ErTabContext.Provider value={{ tabKey }}>{children}</ErTabContext.Provider>
}

export function useErTabKey(): string {
  const ctx = useContext(ErTabContext)
  if (!ctx) throw new Error('ER 组件必须渲染在 ErView 的 ErTabProvider 内')
  return ctx.tabKey
}

/** 订阅当前标签分片的某个字段；分片未加载时返回 undefined */
export function useErTab<T>(selector: (t: ErTabState) => T): T | undefined {
  const { tabKey } = useContext(ErTabContext) ?? { tabKey: '' }
  if (!tabKey) throw new Error('useErTab 必须渲染在 ErView 的 ErTabProvider 内')
  return useErStore((s) => (s.tabs[tabKey] ? selector(s.tabs[tabKey]) : undefined))
}
