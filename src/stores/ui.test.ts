import { beforeEach, describe, expect, it } from 'vitest'

// node 测试环境无 localStorage：注入内存版，供 persist 使用
function memoryStorage(): Storage {
  let data: Record<string, string> = {}
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v
    },
    removeItem: (k) => {
      delete data[k]
    },
    clear: () => {
      data = {}
    },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length
    },
  }
}
;(globalThis as unknown as { localStorage: Storage }).localStorage = memoryStorage()

const { useUiStore } = await import('./ui')

const initialState = useUiStore.getState()

beforeEach(() => {
  globalThis.localStorage.clear()
  useUiStore.setState(initialState, true)
})

describe('侧边栏显隐', () => {
  it('默认为展开', () => {
    expect(useUiStore.getState().siderCollapsed).toBe(false)
  })

  it('toggleSider 在展开/隐藏之间切换', () => {
    useUiStore.getState().toggleSider()
    expect(useUiStore.getState().siderCollapsed).toBe(true)
    useUiStore.getState().toggleSider()
    expect(useUiStore.getState().siderCollapsed).toBe(false)
  })

  it('setSiderCollapsed 直接设置状态', () => {
    useUiStore.getState().setSiderCollapsed(true)
    expect(useUiStore.getState().siderCollapsed).toBe(true)
  })

  it('隐藏状态持久化到 localStorage', () => {
    useUiStore.getState().setSiderCollapsed(true)
    const raw = globalThis.localStorage.getItem('dbflow-ui')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).state.siderCollapsed).toBe(true)
  })
})

describe('ER 小地图显隐', () => {
  it('默认显示', () => {
    expect(useUiStore.getState().erMiniMap).toBe(true)
  })

  it('setErMiniMap 设置并持久化', () => {
    useUiStore.getState().setErMiniMap(false)
    expect(useUiStore.getState().erMiniMap).toBe(false)
    const raw = globalThis.localStorage.getItem('dbflow-ui')
    expect(JSON.parse(raw as string).state.erMiniMap).toBe(false)
  })
})
