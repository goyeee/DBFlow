import { describe, expect, it, vi } from 'vitest'

// 该模块链 import 了 api/commands（内部引 @tauri-apps/api），测试环境打桩
vi.mock('../../api/commands', () => ({ api: {} }))

import { valuesToInput, type FormValues } from './ConnectionFormModal'

function baseValues(ssh: FormValues['ssh']): FormValues {
  return {
    name: 't',
    groupId: null,
    color: '',
    host: 'mysql-b',
    port: 3306,
    user: 'root',
    defaultDatabase: '',
    dbPassword: 'pw',
    clearPassword: false,
    charset: '',
    connectTimeoutSecs: 10,
    comment: '',
    sslMode: 'preferred',
    ssh,
  }
}

describe('valuesToInput 表单值 → 提交体', () => {
  it('SSH 开关开且填了主机/用户 → ssh 配置完整保留（回归：字符串扁平 key 曾致其被丢弃）', () => {
    const input = valuesToInput(
      baseValues({
        enabled: true,
        host: '127.0.0.1',
        port: 2222,
        user: 'dbjump',
        authMethod: 'password',
        password: 'p',
        targetHostOverride: '',
      }),
      null,
    )
    expect(input.ssh).toEqual({
      host: '127.0.0.1',
      port: 2222,
      user: 'dbjump',
      auth: { type: 'password' },
      targetHostOverride: null,
    })
  })

  it('SSH 开关关 → ssh 为 null（直连）', () => {
    const input = valuesToInput(
      baseValues({ enabled: false, host: '127.0.0.1', user: 'dbjump' }),
      null,
    )
    expect(input.ssh).toBeNull()
  })

  it('私钥认证映射 keyPath；目标主机覆盖透传', () => {
    const input = valuesToInput(
      baseValues({
        enabled: true,
        host: 'jump',
        user: 'u',
        authMethod: 'privateKey',
        keyPath: '~/.ssh/id_ed25519',
        targetHostOverride: '10.0.0.5',
      }),
      null,
    )
    expect(input.ssh?.auth).toEqual({ type: 'privateKey', keyPath: '~/.ssh/id_ed25519' })
    expect(input.ssh?.targetHostOverride).toBe('10.0.0.5')
  })
})
