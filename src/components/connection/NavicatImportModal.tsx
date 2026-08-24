import { useMemo, useState } from 'react'
import { Alert, Button, Modal, Radio, Select, Space, Steps, Table, Tag, message } from 'antd'
import type { RadioChangeEvent } from 'antd'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import type { NavicatCandidate, NavicatImportSelection } from '../../api/types'
import { api } from '../../api/commands'
import { useConnectionsStore } from '../../stores/connections'
import { useUiStore } from '../../stores/ui'
import { errText } from './ConnectionTree'

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  plain: { color: 'green', text: '密码已解出' },
  master: { color: 'orange', text: '主密码保护' },
  unknown: { color: 'red', text: '无法解析' },
  empty: { color: 'default', text: '无密码' },
}

export function NavicatImportModal() {
  const open = useUiStore((s) => s.navicatOpen)
  const setOpen = useUiStore((s) => s.setNavicatOpen)
  const groups = useConnectionsStore((s) => s.groups)
  const loadConnections = useConnectionsStore((s) => s.load)

  const [step, setStep] = useState(0)
  const [mode, setMode] = useState<'scan' | 'file'>('scan')
  const [ncxPath, setNcxPath] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<NavicatCandidate[] | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [groupId, setGroupId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ imported: number; failed: { name: string; reason: string }[] } | null>(null)

  const groupOptions = useMemo(
    () => [
      { value: '', label: '未分组' },
      ...groups.map((g) => ({ value: g.id, label: g.name })),
    ],
    [groups],
  )

  if (!open) return null

  const reset = () => {
    setStep(0)
    setCandidates(null)
    setSelectedKeys([])
    setNcxPath(null)
    setResult(null)
  }

  const doScan = async () => {
    setScanning(true)
    try {
      let list: NavicatCandidate[]
      if (mode === 'scan') {
        list = await api.navicatScan()
      } else {
        if (!ncxPath) {
          message.warning('请先选择 .ncx 文件')
          return
        }
        list = await api.navicatImportNcx(ncxPath)
      }
      setCandidates(list)
      // 默认勾选所有可导入的 mysql 连接
      setSelectedKeys(
        list
          .filter((c) => c.kind === 'mysql')
          .map((c) => `${c.origin}|${c.sourceName}|${c.host}|${c.port}|${c.user}`),
      )
      if (list.length === 0) {
        message.info(
          mode === 'scan'
            ? '没有在本机发现 Navicat 连接（需要已安装 Navicat 并保存过连接）'
            : '该文件里没有解析出连接',
        )
      }
      setStep(1)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setScanning(false)
    }
  }

  const pickFile = async () => {
    const path = await openFileDialog({
      title: '选择 Navicat 导出的连接文件',
      filters: [{ name: 'Navicat 连接文件', extensions: ['ncx', 'xml'] }],
    })
    if (typeof path === 'string') setNcxPath(path)
  }

  const doImport = async () => {
    if (!candidates) return
    const selections: NavicatImportSelection[] = candidates
      .filter((c) => selectedKeys.includes(`${c.origin}|${c.sourceName}|${c.host}|${c.port}|${c.user}`))
      .map((c) => ({
        sourceName: c.sourceName,
        origin: c.origin,
        host: c.host,
        port: c.port,
        user: c.user,
        groupId: groupId || null,
        path: c.origin === 'NcxFile' ? ncxPath : null,
      }))
    if (selections.length === 0) {
      message.warning('请至少勾选一个连接')
      return
    }
    setImporting(true)
    try {
      const res = await api.navicatImport(selections)
      setResult(res)
      await loadConnections()
      setStep(2)
    } catch (e) {
      message.error(errText(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      open
      title="从 Navicat 导入连接"
      width={760}
      footer={null}
      onCancel={() => {
        setOpen(false)
        reset()
      }}
      destroyOnHidden
    >
      <Steps
        size="small"
        current={step}
        items={[{ title: '选择来源' }, { title: '勾选连接' }, { title: '完成' }]}
        style={{ margin: '16px 0' }}
      />

      {step === 0 && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Radio.Group
            value={mode}
            onChange={(e: RadioChangeEvent) => setMode(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="scan">自动扫描本机 Navicat</Radio.Button>
            <Radio.Button value="file">从导出文件（.ncx）</Radio.Button>
          </Radio.Group>

          {mode === 'file' ? (
            <Space>
              <Button onClick={pickFile}>选择文件…</Button>
              {ncxPath && <span className="mono-text">{ncxPath}</span>}
            </Space>
          ) : (
            <Alert
              type="info"
              showIcon
              message="将扫描本机 Navicat 的连接配置（macOS: ~/Library/Application Support/PremiumSoft*；Windows: 注册表），密码在导入时自动解密并存入系统钥匙串。"
            />
          )}

          <Button type="primary" loading={scanning} onClick={doScan}>
            {mode === 'scan' ? '开始扫描' : '解析文件'}
          </Button>
        </Space>
      )}

      {step === 1 && candidates && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Table
            size="small"
            rowKey={(c) => `${c.origin}|${c.sourceName}|${c.host}|${c.port}|${c.user}`}
            rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
            pagination={false}
            scroll={{ y: 320 }}
            dataSource={candidates}
            columns={[
              { title: '名称', dataIndex: 'sourceName' },
              {
                title: '类型',
                dataIndex: 'kind',
                width: 110,
                render: (k) =>
                  k === 'mysql' ? <Tag color="blue">MySQL</Tag> : <Tag>{k}</Tag>,
              },
              { title: '主机', dataIndex: 'host' },
              { title: '端口', dataIndex: 'port', width: 70 },
              { title: '用户', dataIndex: 'user', width: 90 },
              {
                title: '密码',
                dataIndex: 'passwordStatus',
                width: 110,
                render: (s) => {
                  const t = STATUS_TAG[s] ?? STATUS_TAG.unknown
                  return <Tag color={t.color}>{t.text}</Tag>
                },
              },
            ]}
          />
          <Space>
            <span>导入到分组：</span>
            <Select
              style={{ width: 200 }}
              value={groupId ?? ''}
              onChange={(v) => setGroupId(v || null)}
              options={groupOptions}
            />
          </Space>
          <Space>
            <Button onClick={() => setStep(0)}>上一步</Button>
            <Button type="primary" loading={importing} onClick={doImport}>
              导入所选（{selectedKeys.length}）
            </Button>
          </Space>
        </Space>
      )}

      {step === 2 && result && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type={result.failed.length === 0 ? 'success' : 'warning'}
            showIcon
            message={`成功导入 ${result.imported} 个连接${
              result.failed.length > 0 ? `，失败 ${result.failed.length} 个` : ''
            }`}
          />
          {result.failed.length > 0 && (
            <Table
              size="small"
              pagination={false}
              dataSource={result.failed}
              rowKey="name"
              columns={[
                { title: '名称', dataIndex: 'name' },
                { title: '失败原因', dataIndex: 'reason' },
              ]}
            />
          )}
          <Button
            type="primary"
            onClick={() => {
              setOpen(false)
              reset()
            }}
          >
            完成
          </Button>
        </Space>
      )}
    </Modal>
  )
}
