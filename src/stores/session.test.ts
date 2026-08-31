import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/commands', () => ({ api: {} }))

import { useSessionStore } from './session'

const initialState = useSessionStore.getState()

beforeEach(() => {
  useSessionStore.setState(initialState, true)
})

describe('标签页：预览与正式打开', () => {
  it('单击表打开预览标签', () => {
    useSessionStore.getState().previewTable('c1', 'db1', 't1')
    const s = useSessionStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].preview).toBe(true)
    expect(s.activeTab).toBe('c1/db1/t1')
  })

  it('再次单击另一张表会替换当前预览标签', () => {
    useSessionStore.getState().previewTable('c1', 'db1', 't1')
    useSessionStore.getState().previewTable('c1', 'db1', 't2')
    const s = useSessionStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].key).toBe('c1/db1/t2')
    expect(s.tabs[0].preview).toBe(true)
  })

  it('双击（openTable）把预览标签转正', () => {
    useSessionStore.getState().previewTable('c1', 'db1', 't1')
    useSessionStore.getState().openTable('c1', 'db1', 't1')
    const s = useSessionStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].preview).toBe(false)
  })

  it('openTable 新表时保留已有预览标签并新增正式标签', () => {
    useSessionStore.getState().previewTable('c1', 'db1', 't1')
    useSessionStore.getState().openTable('c1', 'db1', 't2')
    const s = useSessionStore.getState()
    expect(s.tabs).toHaveLength(2)
    expect(s.tabs[0]).toMatchObject({ key: 'c1/db1/t1', preview: true })
    expect(s.tabs[1]).toMatchObject({ key: 'c1/db1/t2', preview: false })
  })

  it('单击已存在的正式标签仅激活，不重复添加', () => {
    useSessionStore.getState().openTable('c1', 'db1', 't1')
    useSessionStore.getState().previewTable('c1', 'db1', 't1')
    const s = useSessionStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].preview).toBe(false)
  })
})

describe('标签页：批量关闭', () => {
  function open3() {
    useSessionStore.getState().openTable('c1', 'db1', 't1')
    useSessionStore.getState().openTable('c1', 'db1', 't2')
    useSessionStore.getState().openTable('c1', 'db1', 't3')
  }

  it('关闭其他：只保留指定标签', () => {
    open3()
    useSessionStore.getState().closeOtherTabs('c1/db1/t2')
    const s = useSessionStore.getState()
    expect(s.tabs.map((t) => t.key)).toEqual(['c1/db1/t2'])
    // 激活标签被关掉时回退到保留的那个
    expect(s.activeTab).toBe('c1/db1/t2')
  })

  it('关闭其他：激活标签保留时不变', () => {
    open3()
    useSessionStore.getState().setActiveTab('c1/db1/t3')
    useSessionStore.getState().closeOtherTabs('c1/db1/t3')
    expect(useSessionStore.getState().activeTab).toBe('c1/db1/t3')
  })

  it('关闭右侧：截断右侧，激活标签被关掉时回退到分界处', () => {
    open3()
    useSessionStore.getState().setActiveTab('c1/db1/t3')
    useSessionStore.getState().closeTabsToRight('c1/db1/t1')
    const s = useSessionStore.getState()
    expect(s.tabs.map((t) => t.key)).toEqual(['c1/db1/t1'])
    expect(s.activeTab).toBe('c1/db1/t1')
  })

  it('关闭右侧：最右侧标签是无操作', () => {
    open3()
    useSessionStore.getState().closeTabsToRight('c1/db1/t3')
    expect(useSessionStore.getState().tabs).toHaveLength(3)
  })

  it('关闭数据库：只关掉该连接该库的标签，激活标签被关掉时回退', () => {
    open3() // c1/db1/t1..t3
    useSessionStore.getState().openTable('c1', 'db2', 't1')
    useSessionStore.getState().openTable('c2', 'db1', 't1')
    useSessionStore.getState().setActiveTab('c1/db1/t2')
    useSessionStore.getState().closeDatabaseTabs('c1', 'db1')
    const s = useSessionStore.getState()
    expect(s.tabs.map((t) => t.key)).toEqual(['c1/db2/t1', 'c2/db1/t1'])
    expect(s.activeTab).toBe('c1/db2/t1')
  })

  it('关闭数据库：该库没有打开的标签时不动任何状态', () => {
    open3()
    useSessionStore.getState().setActiveTab('c1/db1/t2')
    useSessionStore.getState().closeDatabaseTabs('c1', 'db9')
    const s = useSessionStore.getState()
    expect(s.tabs).toHaveLength(3)
    expect(s.activeTab).toBe('c1/db1/t2')
  })
})
