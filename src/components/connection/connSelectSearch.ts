import type { ConnectionProfile } from '../../api/types'

/** 连接下拉的搜索过滤：label 是 JSX（名称+主机+端口），antd 默认过滤对它无效，
 *  需按 value 反查连接后匹配名称/主机/端口（不区分大小写） */
export function connFilterOption(connections: ConnectionProfile[]) {
  return (input: string, option?: { value?: unknown }): boolean => {
    const c = connections.find((x) => x.id === option?.value)
    if (!c) return false
    const q = input.trim().toLowerCase()
    if (!q) return true
    return (
      c.name.toLowerCase().includes(q) ||
      c.host.toLowerCase().includes(q) ||
      String(c.port).includes(q)
    )
  }
}
