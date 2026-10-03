import { useMemo, useState } from 'react'
import { Modal, Select, message } from 'antd'

import { useErStore } from '../../stores/er'
import { useErTab, useErTabKey } from './erTabContext'

/**
 * 添加手动关联对话框：级联选择「源表.列 → 目标表.列」。
 * 画布上直接拖拽两列连线、选中两个表自动弹出（preset 预填两表）也能添加；
 * 对话框适合表多、拖拽找不到目标的场景。
 */
export function ErManualModal({
  open,
  onClose,
  preset,
}: {
  open: boolean
  onClose: () => void
  /** 打开时预填的两张表（画布选中两表进入），列留给用户选 */
  preset?: { srcTable: string; tgtTable: string }
}) {
  const tabKey = useErTabKey()
  const graph = useErTab((t) => t.graph)
  const [srcTable, setSrcTable] = useState<string | undefined>(preset?.srcTable)
  const [srcCol, setSrcCol] = useState<string>()
  const [tgtTable, setTgtTable] = useState<string | undefined>(preset?.tgtTable)
  const [tgtCol, setTgtCol] = useState<string>()

  const tableNames = useMemo(
    () => (graph ? Object.values(graph.tables).map((t) => t.name).sort() : []),
    [graph],
  )
  /** 某表的列选项（ label 带类型，可按列名搜索） */
  const colOptions = (table?: string) =>
    graph?.tables[table?.toLowerCase() ?? '']?.columns.map((c) => ({
      value: c.name,
      label: `${c.name} · ${c.dataType}`,
    })) ?? []

  const reset = () => {
    setSrcTable(undefined)
    setSrcCol(undefined)
    setTgtTable(undefined)
    setTgtCol(undefined)
  }
  const close = () => {
    reset()
    onClose()
  }

  const ready = srcTable && srcCol && tgtTable && tgtCol
  const submit = () => {
    if (!ready) return
    const r = useErStore.getState().addManualEdge(tabKey, {
      sourceTable: srcTable,
      sourceColumn: srcCol,
      targetTable: tgtTable,
      targetColumn: tgtCol,
    })
    if (!r.ok) {
      message.warning(r.error ?? '无法添加关联')
      return
    }
    message.success('已添加手动关联')
    close()
  }

  const tableSelect = (
    value: string | undefined,
    onChange: (v: string | undefined) => void,
    placeholder: string,
  ) => (
    <Select
      showSearch
      optionFilterProp="label"
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      options={tableNames.map((n) => ({ value: n, label: n }))}
      style={{ width: '46%' }}
      size="middle"
    />
  )
  const colSelect = (
    table: string | undefined,
    value: string | undefined,
    onChange: (v: string | undefined) => void,
  ) => (
    <Select
      showSearch
      optionFilterProp="label"
      placeholder="选择列"
      value={value}
      onChange={onChange}
      options={colOptions(table)}
      disabled={!table}
      style={{ width: '46%' }}
      size="middle"
    />
  )

  return (
    <Modal
      title="添加手动关联"
      open={open}
      onOk={submit}
      onCancel={close}
      okText="添加"
      cancelText="取消"
      okButtonProps={{ disabled: !ready }}
      width={520}
    >
      <div className="er-manual-form">
        <div className="er-manual-row">
          <span className="er-manual-label">引用方</span>
          {tableSelect(srcTable, (v) => {
            setSrcTable(v)
            setSrcCol(undefined)
          }, '源表')}
          {colSelect(srcTable, srcCol, setSrcCol)}
        </div>
        <div className="er-manual-arrow">→</div>
        <div className="er-manual-row">
          <span className="er-manual-label">被引用方</span>
          {tableSelect(tgtTable, (v) => {
            setTgtTable(v)
            setTgtCol(undefined)
          }, '目标表')}
          {colSelect(tgtTable, tgtCol, setTgtCol)}
        </div>
        <div className="er-manual-hint">
          若一端是表主键，保存时方向会自动调整为主键端作为被引用方；仅记录在本地模型文档，不修改数据库。
        </div>
      </div>
    </Modal>
  )
}
