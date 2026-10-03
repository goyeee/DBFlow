import { Modal, Typography, message } from 'antd'
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'

import { api } from '../../api/commands'
import { errText } from '../connection/ConnectionTree'

/** DDL 预览弹窗：复制或保存 .sql */
export function ErDdlModal({
  open,
  sql,
  onClose,
}: {
  open: boolean
  sql: string
  onClose: () => void
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(sql)
    message.success('已复制到剪贴板')
  }
  const saveFile = async () => {
    try {
      const path = await saveFileDialog({
        title: '保存 DDL',
        defaultPath: 'schema.sql',
        filters: [{ name: 'SQL', extensions: ['sql'] }],
      })
      if (!path) return
      await api.exportErSql(path, sql)
      message.success('已保存')
      onClose()
    } catch (e) {
      message.error(errText(e))
    }
  }
  return (
    <Modal
      title="建表 DDL"
      open={open}
      onCancel={onClose}
      okText="复制"
      onOk={copy}
      cancelText="关闭"
      width={720}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        <a onClick={saveFile}>保存为 .sql 文件</a>
      </Typography.Paragraph>
      <pre className="er-ddl-pre">{sql}</pre>
    </Modal>
  )
}
