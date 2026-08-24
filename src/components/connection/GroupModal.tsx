import { useEffect, useState } from 'react'
import { Form, Input, Modal, message } from 'antd'
import { api } from '../../api/commands'
import { useConnectionsStore } from '../../stores/connections'
import { useUiStore } from '../../stores/ui'
import { errText } from './ConnectionTree'

export function GroupModal() {
  const target = useUiStore((s) => s.groupModal)
  const close = useUiStore((s) => s.closeGroupModal)
  const load = useConnectionsStore((s) => s.load)
  const [form] = Form.useForm<{ name: string }>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (target) form.setFieldsValue({ name: target.group?.name ?? '' })
  }, [target, form])

  if (!target) return null

  const handleOk = async () => {
    try {
      const { name } = await form.validateFields()
      setSaving(true)
      if (target.mode === 'create') {
        await api.createGroup(name)
        message.success(`已创建分组「${name}」`)
      } else if (target.group) {
        await api.renameGroup(target.group.id, name)
        message.success('已重命名')
      }
      await load()
      close()
    } catch (e) {
      if (e && typeof e === 'object' && 'errorFields' in (e as object)) return
      message.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={target.mode === 'create' ? '新建分组' : '重命名分组'}
      okText={target.mode === 'create' ? '创建' : '保存'}
      cancelText="取消"
      confirmLoading={saving}
      onOk={handleOk}
      onCancel={close}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          name="name"
          label="分组名称"
          rules={[{ required: true, message: '请填写分组名称' }]}
        >
          <Input placeholder="生产环境" onPressEnter={handleOk} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
