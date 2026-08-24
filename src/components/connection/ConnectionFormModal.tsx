import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Tabs,
  message,
} from 'antd'
import type { AppErrorInfo, ConnectionProfileInput, TestResult } from '../../api/types'
import { api } from '../../api/commands'
import { useConnectionsStore } from '../../stores/connections'
import { useSessionStore } from '../../stores/session'
import { useUiStore } from '../../stores/ui'
import { COLOR_OPTIONS } from './colors'
import { SshTunnelFields } from './SshTunnelFields'
import { errText } from './ConnectionTree'

export interface FormValues {
  name: string
  groupId: string | null
  color: string | null
  host: string
  port: number
  user: string
  defaultDatabase: string | null
  dbPassword: string | null
  clearPassword: boolean
  charset: string | null
  connectTimeoutSecs: number
  comment: string | null
  sslMode: 'disabled' | 'preferred' | 'required'
  ssh: {
    enabled: boolean
    host?: string
    port?: number
    user?: string
    authMethod?: 'password' | 'privateKey'
    password?: string | null
    keyPath?: string
    keyPassphrase?: string | null
    targetHostOverride?: string | null
  }
}

export function valuesToInput(v: FormValues, editingId: string | null): ConnectionProfileInput {
  const ssh =
    v.ssh?.enabled && v.ssh.host && v.ssh.user
      ? {
          host: v.ssh.host,
          port: v.ssh.port ?? 22,
          user: v.ssh.user,
          auth:
            v.ssh.authMethod === 'privateKey'
              ? ({ type: 'privateKey', keyPath: v.ssh.keyPath ?? '' } as const)
              : ({ type: 'password' } as const),
          targetHostOverride: emptyToNull(v.ssh.targetHostOverride),
        }
      : null
  return {
    id: editingId,
    name: v.name,
    groupId: v.groupId,
    color: v.color || null,
    db: 'mysql',
    host: v.host,
    port: v.port,
    user: v.user,
    defaultDatabase: emptyToNull(v.defaultDatabase),
    options: {
      sslMode: v.sslMode,
      connectTimeoutSecs: v.connectTimeoutSecs,
      charset: emptyToNull(v.charset),
      comment: emptyToNull(v.comment),
    },
    ssh,
  }
}

function emptyToNull(s: string | null | undefined): string | null {
  const t = s?.trim()
  return t ? t : null
}

const TAB_LABEL: Record<string, string> = {
  general: '常规',
  ssh: 'SSH',
  ssl: 'SSL',
  advanced: '高级',
}

/** 字段名 → 所在标签页（校验失败时自动切过去给用户看） */
function tabOfField(field: string): string {
  if (field === 'ssh' || field.startsWith('ssh.')) return 'ssh'
  if (field === 'sslMode') return 'ssl'
  if (['charset', 'connectTimeoutSecs', 'comment'].includes(field)) return 'advanced'
  return 'general'
}

export function ConnectionFormModal() {
  const target = useUiStore((s) => s.form)
  const closeForm = useUiStore((s) => s.closeForm)
  const { groups, upsertLocal } = useConnectionsStore()
  const [form] = Form.useForm<FormValues>()
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [activeTab, setActiveTab] = useState('general')

  /** 表单校验失败：切到第一个出错字段所在的标签页并提示（否则用户根本看不到错在哪） */
  const handleValidationError = (e: unknown) => {
    const err = e as { errorFields?: { name: (string | number)[] }[] }
    if (!err?.errorFields?.length) return false
    const field = String(err.errorFields[0].name[0] ?? '')
    const tab = tabOfField(field)
    setActiveTab(tab)
    message.warning(
      tab === activeTab
        ? '有必填项未填写'
        : `「${TAB_LABEL[tab]}」标签里有必填项未填写，已为你切换过去`,
    )
    return true
  }

  const editing = target?.profile ?? null

  useEffect(() => {
    if (!target) return
    setTestResult(null)
    const p = target.profile
    form.setFieldsValue({
      name: p?.name ?? '',
      groupId: p?.groupId ?? target.defaultGroupId ?? null,
      color: p?.color ?? '',
      host: p?.host ?? '127.0.0.1',
      port: p?.port ?? 3306,
      user: p?.user ?? 'root',
      defaultDatabase: p?.defaultDatabase ?? '',
      dbPassword: '',
      clearPassword: false,
      charset: p?.options.charset ?? '',
      connectTimeoutSecs: p?.options.connectTimeoutSecs ?? 10,
      comment: p?.options.comment ?? '',
      sslMode: p?.options.sslMode ?? 'preferred',
      ssh: {
        enabled: !!p?.ssh,
        host: p?.ssh?.host,
        port: p?.ssh?.port ?? 22,
        user: p?.ssh?.user,
        authMethod: p?.ssh?.auth.type === 'privateKey' ? 'privateKey' : 'password',
        password: '',
        keyPath: p?.ssh?.auth.type === 'privateKey' ? p.ssh.auth.keyPath : '',
        keyPassphrase: '',
        targetHostOverride: p?.ssh?.targetHostOverride ?? '',
      },
    })
  }, [target, form])

  const groupOptions = useMemo(
    () => [
      { value: '', label: '未分组' },
      ...groups.map((g) => ({ value: g.id, label: g.name })),
    ],
    [groups],
  )

  if (!target) return null

  const runTest = async (trustHostKey?: string): Promise<TestResult | null> => {
    try {
      const values = await form.validateFields()
      const input = valuesToInput(values, editing?.id ?? null)
      const v: FormValues = values
      setTesting(true)
      const result = await api.testConnection({
        input,
        dbPassword: v.dbPassword || undefined,
        sshPassword: v.ssh?.enabled && v.ssh.authMethod === 'password' ? v.ssh.password || undefined : undefined,
        sshKeyPassphrase: v.ssh?.enabled && v.ssh.authMethod === 'privateKey' ? v.ssh.keyPassphrase || undefined : undefined,
        trustHostKey,
      })
      setTestResult(result)
      return result
    } catch (e) {
      // 表单校验失败：切到出错标签提示；command 抛错：直接报错
      if (handleValidationError(e)) return null
      const err = e as AppErrorInfo
      if (err?.code === 'host_key_unknown' && err.detail) {
        Modal.confirm({
          title: '确认 SSH 主机指纹',
          content: (
            <div>
              <p>跳板机指纹：</p>
              <p>
                <code>{err.detail}</code>
              </p>
            </div>
          ),
          okText: '信任并继续',
          cancelText: '取消',
          onOk: () => runTest(err.detail),
        })
        return null
      }
      message.error(errText(e))
      return null
    } finally {
      setTesting(false)
    }
  }

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      const v: FormValues = values
      const input = valuesToInput(values, editing?.id ?? null)
      setSaving(true)
      const saved = await api.saveConnection({
        input,
        dbPassword: v.clearPassword ? '' : v.dbPassword || undefined,
        sshPassword:
          v.ssh?.enabled && v.ssh.authMethod === 'password'
            ? v.ssh.password || undefined
            : undefined,
        sshKeyPassphrase:
          v.ssh?.enabled && v.ssh.authMethod === 'privateKey'
            ? v.ssh.keyPassphrase || undefined
            : undefined,
      })
      upsertLocal(saved)
      // 编辑了已连接的连接 → 后端已断开旧会话，同步前端状态
      if (editing) await useSessionStore.getState().disconnect(editing.id)
      message.success(editing ? '已保存' : `已创建「${saved.name}」`)
      closeForm()
    } catch (e) {
      if (handleValidationError(e)) return
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={editing ? `编辑连接 · ${editing.name}` : '新建连接'}
      width={640}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={closeForm}
      destroyOnHidden
      footer={
        <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button loading={testing} onClick={() => runTest()}>
            测试连接
          </Button>
          <Space>
            <Button onClick={closeForm}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleOk}>
              保存
            </Button>
          </Space>
        </Space>
      }
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'general',
              label: '常规',
              forceRender: true,
              children: (
                <>
                  <Form.Item
                    name="name"
                    label="连接名称"
                    rules={[{ required: true, message: '请填写连接名称' }]}
                  >
                    <Input placeholder="本地开发库" />
                  </Form.Item>
                  <Space size="middle" style={{ display: 'flex' }}>
                    <Form.Item name="groupId" label="分组" style={{ minWidth: 220 }}>
                      <Select options={groupOptions} allowClear placeholder="未分组" />
                    </Form.Item>
                    <Form.Item name="color" label="颜色标签">
                      <Select options={COLOR_OPTIONS} style={{ width: 120 }} />
                    </Form.Item>
                  </Space>
                  <Space size="middle" style={{ display: 'flex' }}>
                    <Form.Item
                      name="host"
                      label="主机"
                      rules={[{ required: true, message: '请填写主机地址' }]}
                      style={{ flex: 1, minWidth: 260 }}
                    >
                      <Input placeholder="127.0.0.1" />
                    </Form.Item>
                    <Form.Item name="port" label="端口" rules={[{ required: true }]}>
                      <InputNumber min={1} max={65535} style={{ width: 110 }} />
                    </Form.Item>
                  </Space>
                  <Space size="middle" style={{ display: 'flex' }}>
                    <Form.Item
                      name="user"
                      label="用户名"
                      rules={[{ required: true, message: '请填写用户名' }]}
                    >
                      <Input placeholder="root" style={{ width: 180 }} />
                    </Form.Item>
                    <Form.Item
                      name="defaultDatabase"
                      label="默认数据库"
                      tooltip="连接后优先打开的库，可留空"
                    >
                      <Input placeholder="db_shop" style={{ width: 180 }} />
                    </Form.Item>
                  </Space>
                  <Form.Item
                    name="dbPassword"
                    label="密码"
                    extra={
                      editing?.hasPassword ? (
                        <Checkbox name="clearPassword" checked={false} style={{ display: 'none' }} />
                      ) : undefined
                    }
                  >
                    <Input.Password
                      placeholder={
                        editing?.hasPassword ? '（已保存密码，留空则不修改）' : '未设置'
                      }
                      autoComplete="new-password"
                    />
                  </Form.Item>
                  {editing?.hasPassword && (
                    <Form.Item name="clearPassword" valuePropName="checked" noStyle>
                      <Checkbox>清除已保存的密码</Checkbox>
                    </Form.Item>
                  )}
                </>
              ),
            },
            {
              key: 'ssh',
              label: 'SSH',
              forceRender: true,
              children: <SshTunnelFields />,
            },
            {
              key: 'ssl',
              label: 'SSL',
              forceRender: true,
              children: (
                <Form.Item name="sslMode" label="SSL 模式" initialValue="preferred">
                  <Radio.Group>
                    <Radio.Button value="disabled">禁用</Radio.Button>
                    <Radio.Button value="preferred">优先</Radio.Button>
                    <Radio.Button value="required">必须</Radio.Button>
                  </Radio.Group>
                </Form.Item>
              ),
            },
            {
              key: 'advanced',
              label: '高级',
              forceRender: true,
              children: (
                <>
                  <Form.Item name="charset" label="字符集" tooltip="如 utf8mb4，留空用驱动默认">
                    <Input placeholder="utf8mb4" style={{ width: 200 }} />
                  </Form.Item>
                  <Form.Item name="connectTimeoutSecs" label="连接超时（秒）" initialValue={10}>
                    <InputNumber min={1} max={120} style={{ width: 140 }} />
                  </Form.Item>
                  <Form.Item name="comment" label="备注">
                    <Input.TextArea rows={2} placeholder="这条连接的用途…" />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>

      {testResult && (
        <Alert
          style={{ marginTop: 8 }}
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          message={
            testResult.ok
              ? `连接成功 · MySQL ${testResult.serverVersion} · ${testResult.latencyMs}ms`
              : `连接失败：${testResult.error?.message ?? '未知错误'}`
          }
          action={
            !testResult.ok ? (
              <Button size="small" onClick={() => setTestResult(null)}>
                知道了
              </Button>
            ) : undefined
          }
        />
      )}
    </Modal>
  )
}
