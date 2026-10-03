import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, message, Modal, Space } from 'antd'

import { useErStore } from '../../stores/er'
import { useSessionStore } from '../../stores/session'
import { errText } from '../connection/ConnectionTree'

/** 一个可选动作 */
interface ChoiceOption<T> {
  value: T
  label: string
  danger?: boolean
  primary?: boolean
}

/**
 * 命令式选择弹窗（独立 React 根；项目用默认 antd 主题）。
 * X / Esc / 遮罩一律不产生选择（closable/mask/keyboard 全关），
 * 只能点显式按钮；choices 中可放 value:null 作为中性「关闭」。
 */
export function askChoice<T>(opts: {
  title: ReactNode
  content?: ReactNode
  choices: ChoiceOption<T | null>[]
}): Promise<T | null> {
  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const finish = (v: T | null) => {
      root.unmount()
      container.remove()
      resolve(v)
    }
    root.render(
      <Modal
        title={opts.title}
        open
        closable={false}
        maskClosable={false}
        keyboard={false}
        width={460}
        footer={
          <Space>
            {opts.choices.map((c) => (
              <Button
                key={c.label}
                type={c.primary ? 'primary' : 'default'}
                danger={c.danger}
                onClick={() => finish(c.value)}
              >
                {c.label}
              </Button>
            ))}
          </Space>
        }
      >
        {opts.content}
      </Modal>,
    )
  })
}

/** 关闭确认的三种选择 */
type CloseChoice = 'save' | 'discard' | 'cancel'

function askCloseChoice(count: number): Promise<CloseChoice | null> {
  return askChoice<CloseChoice>({
    title: '有未保存的 ER 图布局',
    content: `${count} 个 ER 标签有未保存的布局修改。可保存后关闭，或放弃这些修改。`,
    choices: [
      { value: 'cancel', label: '取消' },
      { value: 'discard', label: '放弃修改', danger: true },
      { value: 'save', label: `保存后关闭（${count}）`, primary: true },
    ],
  })
}

/** 裁决一批脏分片：保存全部 / 放弃 → true；取消/关闭/保存失败 → false。
 *  空数组视为无需裁决、直接通过 */
async function resolveDirty(dirtyKeys: string[]): Promise<boolean> {
  if (dirtyKeys.length === 0) return true
  const choice = await askCloseChoice(dirtyKeys.length)
  if (choice === null || choice === 'cancel') return false
  if (choice === 'discard') return true
  const results = await Promise.allSettled(
    dirtyKeys.map((k) => useErStore.getState().save(k)),
  )
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )
  if (rejected.length > 0) {
    message.error(
      `${rejected.length} 个标签保存失败：` +
        rejected.map((r) => errText(r.reason)).join('；'),
    )
    return false
  }
  return true
}

/** 防止多个入口连续触发导致确认框堆叠 */
let inflight: Promise<boolean> | null = null
function withInflight(fn: () => Promise<boolean>): Promise<boolean> {
  if (inflight) return inflight
  inflight = fn().finally(() => {
    inflight = null
  })
  return inflight
}

/** 仅裁决脏分片（不执行关闭动作）：供窗口关闭拦截使用 */
export function guardDirtyTabs(dirtyKeys: string[]): Promise<boolean> {
  return withInflight(() => resolveDirty(dirtyKeys))
}

/**
 * 统一关闭标签守卫：候选标签里有 dirty 的 ER 分片则确认；
 * 通过后执行 performClose，并按 session 实际剩余标签清理已消失分片。
 */
export function guardCloseTabs(
  keys: string[],
  performClose: () => void,
): Promise<boolean> {
  return withInflight(async () => {
    const dirty = keys.filter((k) => useErStore.getState().tabs[k]?.dirty)
    if (!(await resolveDirty(dirty))) return false
    performClose()
    const openKeys = new Set(useSessionStore.getState().tabs.map((t) => t.key))
    useErStore
      .getState()
      .purgeTabs(keys.filter((k) => !openKeys.has(k)))
    return true
  })
}

/**
 * 断开连接守卫：该连接下有 dirty 的 ER 分片则确认；
 * 通过后执行 performDisconnect，并清掉该连接所有分片。
 */
export function guardDisconnect(
  connectionId: string,
  performDisconnect: () => void | Promise<void>,
): Promise<boolean> {
  return withInflight(async () => {
    const erTabs = useErStore.getState().tabs
    const dirty = Object.keys(erTabs).filter(
      (k) => erTabs[k].connectionId === connectionId && erTabs[k].dirty,
    )
    if (!(await resolveDirty(dirty))) return false
    await performDisconnect()
    const cur = useErStore.getState().tabs
    useErStore
      .getState()
      .purgeTabs(
        Object.keys(cur).filter((k) => cur[k].connectionId === connectionId),
      )
    return true
  })
}
