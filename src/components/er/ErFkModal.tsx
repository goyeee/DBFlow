import { useEffect, useMemo, useState } from 'react'
import { Input, Modal, Select, message } from 'antd'

import { useErStore } from '../../stores/er'
import { useErTab, useErTabKey } from './erTabContext'

const FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION']

/** 编辑态拖线建「模型外键」：确认约束名与 ON 规则（浏览态拖线仍走手动关联） */
export function ErFkModal(props: {
  open: boolean
  pending: {
    sourceTable: string
    sourceColumn: string
    targetTable: string
    targetColumn: string
  } | null
  onClose: () => void
}) {
  const tabKey = useErTabKey()
  const graph = useErTab((t) => t.graph)
  const [name, setName] = useState('')
  const [refCol, setRefCol] = useState('')
  const [onDelete, setOnDelete] = useState<string | null>(null)
  const [onUpdate, setOnUpdate] = useState<string | null>(null)

  const p = props.pending
  const defaultName = useMemo(
    () => (p ? `fk_${p.sourceTable.toLowerCase()}_${p.sourceColumn.toLowerCase()}` : ''),
    [p],
  )
  // 每次新的拖线会话重置全部字段（组件常驻，state 不会自动清）
  useEffect(() => {
    if (p) {
      setName('')
      setRefCol(p.targetColumn)
      setOnDelete(null)
      setOnUpdate(null)
    }
  }, [p])
  const effectiveName = name === '' ? defaultName : name

  // 方向：拖拽源 = 子表（外键所在表），目标 = 被引用表（主键端）
  const refColumns = (p ? graph?.tables[p.targetTable.toLowerCase()]?.columns : undefined) ?? []
  const refOptions = refColumns.map((c) => ({ value: c.name, label: `${c.name} ${c.dataType}` }))

  const submit = () => {
    if (!p) return
    const r = useErStore.getState().addModelFk(tabKey, {
      table: p.sourceTable,
      columns: [p.sourceColumn],
      refTable: p.targetTable,
      refColumns: [refCol || p.targetColumn],
      name: effectiveName,
      onDelete,
      onUpdate,
    })
    if (!r.ok) message.warning(r.error ?? '无法添加外键')
    else message.success('已添加模型外键（未应用至库）')
    props.onClose()
  }

  // Hook 全部在前；未打开/无 pending 用条件渲染兜底（理论上到不了这里）
  if (!props.open || !p) return null
  return (
    <Modal
      open
      title="添加模型外键"
      width={480}
      onCancel={props.onClose}
      onOk={submit}
      okText="添加"
      destroyOnHidden
    >
      <div className="er-fk-form">
        <div className="er-fk-line">
          {p.sourceTable}.{p.sourceColumn} → {p.targetTable}.
          <Select
            size="small"
            style={{ width: 160 }}
            value={refCol}
            options={refOptions}
            onChange={setRefCol}
          />
        </div>
        <label>
          约束名
          <Input size="small" value={effectiveName} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          ON DELETE
          <Select
            size="small"
            allowClear
            style={{ width: 140 }}
            value={onDelete ?? undefined}
            options={FK_ACTIONS.map((a) => ({ value: a, label: a }))}
            onChange={(v) => setOnDelete(v ?? null)}
          />
        </label>
        <label>
          ON UPDATE
          <Select
            size="small"
            allowClear
            style={{ width: 140 }}
            value={onUpdate ?? undefined}
            options={FK_ACTIONS.map((a) => ({ value: a, label: a }))}
            onChange={(v) => setOnUpdate(v ?? null)}
          />
        </label>
        <div className="er-fk-hint">
          应用变更时将在子表上生成 ADD FOREIGN KEY；紫色手动关联仍走画布拖线（浏览模式）。
        </div>
      </div>
    </Modal>
  )
}
