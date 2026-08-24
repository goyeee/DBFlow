import { Form, Input, InputNumber, Radio, Switch } from 'antd'
import { useWatch } from 'antd/es/form/Form'

/**
 * SSH 隧道表单段。字段名嵌套在主表单的 ssh 命名空间下：
 *   ssh.enabled / ssh.host / ssh.port / ssh.user / ssh.authMethod
 *   ssh.password / ssh.keyPath / ssh.keyPassphrase / ssh.targetHostOverride
 * 提交时由父组件把 enabled 转换成 ssh: SshTunnelConfig | null。
 */
export function SshTunnelFields() {
  // 注意：Form.Item name 与 useWatch 必须用数组路径——
  // 字符串 'ssh.enabled' 是"一个带点的扁平 key"，不会嵌套到 ssh 对象下，
  // 曾导致 enabled 读不到、ssh 配置被静默丢弃（隧道连接变成直连）。
  const enabled = useWatch(['ssh', 'enabled']) ?? false
  const authMethod = useWatch(['ssh', 'authMethod']) ?? 'password'

  return (
    <>
      <Form.Item
        name={['ssh', 'enabled']}
        label="使用 SSH 隧道"
        valuePropName="checked"
        tooltip="通过跳板机连接数据库（本地 → SSH 跳板 → 数据库）"
      >
        <Switch />
      </Form.Item>

      {enabled && (
        <>
          <Form.Item
            name={['ssh', 'host']}
            label="SSH 主机"
            rules={[{ required: true, message: '请填写跳板机地址' }]}
          >
            <Input placeholder="jump.example.com" />
          </Form.Item>
          <Form.Item name={['ssh', 'port']} label="SSH 端口" initialValue={22}>
            <InputNumber min={1} max={65535} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item
            name={['ssh', 'user']}
            label="SSH 用户名"
            rules={[{ required: true, message: '请填写 SSH 用户名' }]}
          >
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item name={['ssh', 'authMethod']} label="认证方式">
            <Radio.Group>
              <Radio.Button value="password">密码</Radio.Button>
              <Radio.Button value="privateKey">私钥</Radio.Button>
            </Radio.Group>
          </Form.Item>
          {authMethod === 'password' ? (
            <Form.Item
              name={['ssh', 'password']}
              label="SSH 密码"
              extra={sshPasswordExtra}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          ) : (
            <>
              <Form.Item
                name={['ssh', 'keyPath']}
                label="私钥路径"
                rules={[{ required: true, message: '请填写私钥文件路径' }]}
              >
                <Input placeholder="~/.ssh/id_ed25519" />
              </Form.Item>
              <Form.Item name={['ssh', 'keyPassphrase']} label="私钥口令" extra={sshPasswordExtra}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <Form.Item
            name={['ssh', 'targetHostOverride']}
            label="目标主机覆盖"
            tooltip="留空 = 用上面填的数据库主机。跳板机视角的内网地址与公网地址不同时填这里"
          >
            <Input placeholder="10.0.0.5（跳板机可达的内网地址）" allowClear />
          </Form.Item>
        </>
      )}
    </>
  )
}

const sshPasswordExtra = (
  <span className="field-extra">保存在系统钥匙串中，不落盘为明文</span>
)
