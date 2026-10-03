import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  Tabs,
  Tooltip,
  message,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons'

import { api } from '../../api/commands'
import { useErStore } from '../../stores/er'
import { useErTab, useErTabKey } from './erTabContext'
import { applyColumnNameRename, colDraftToSchema, schemaToColDraft, snapshotTableToSchema } from './modelSchema'
import { SqlView } from '../compare/SqlView'
import type { ErColumnSchema, ErFkSchema, ErIndexSchema, ErTableSchema } from '../../api/types'

/** 单行草稿的唯一键（增删行稳定 key） */
let uidSeq = 0
const nextUid = () => `u${++uidSeq}`

interface ColDraft {
  uid: string
  name: string
  dataType: string
  nullable: boolean
  /** 三态：null=无默认，''=DEFAULT ''，其余为字面值（库侧语义区分二者） */
  default: string | null
  autoInc: boolean
  /** ON UPDATE CURRENT_TIMESTAMP（时间列自动更新） */
  onUpdateTs: boolean
  comment: string
  extraRest: string // 除 auto_increment 外的 extra 原样保留（如 on update current_timestamp）
  /** 列级字符集/排序规则：设计器不提供编辑 UI，但必须透传——
   *  剥成 null 会让 copy-on-edit 后的「不改就存」出假「改」角标、
   *  每个字符串列在 diff 里出假 MODIFY */
  characterSet: string | null
  collation: string | null
}
interface IdxDraft {
  uid: string
  name: string
  columns: string[]
  unique: boolean
  indexType: string
  isPrimary: boolean
  subParts: (number | null)[]
  directions: (string | null)[]
}
interface FkDraft {
  uid: string
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: string | null
  onUpdate: string | null
}

const TYPE_SUGGESTIONS = [
  'int', 'int unsigned', 'bigint', 'bigint unsigned', 'tinyint', 'smallint',
  'varchar(64)', 'varchar(255)', 'text', 'longtext',
  'decimal(10,2)', 'double', 'date', 'datetime', 'timestamp', 'json',
]

function colToDraft(c: ErColumnSchema): ColDraft {
  return { uid: nextUid(), ...schemaToColDraft(c) }
}
function draftToCol(c: ColDraft): ErColumnSchema {
  return colDraftToSchema(c)
}
function idxToDraft(i: ErIndexSchema): IdxDraft {
  return {
    uid: nextUid(),
    name: i.name,
    columns: [...i.columns],
    unique: i.unique,
    indexType: i.indexType ?? 'BTREE',
    isPrimary: i.isPrimary,
    subParts: [...i.subParts],
    directions: [...i.directions],
  }
}
function draftToIdx(i: IdxDraft): ErIndexSchema {
  return {
    name: i.name.trim(),
    columns: i.columns,
    unique: i.isPrimary || i.unique,
    isPrimary: i.isPrimary,
    indexType: i.indexType,
    subParts: i.columns.map((_, k) => i.subParts[k] ?? null),
    directions: i.columns.map((_, k) => i.directions[k] ?? null),
  }
}
function fkToDraft(f: ErFkSchema): FkDraft {
  return {
    uid: nextUid(),
    name: f.name,
    columns: [...f.columns],
    refTable: f.refTable,
    refColumns: [...f.refColumns],
    onDelete: f.onDelete,
    onUpdate: f.onUpdate,
  }
}
function draftToFk(f: FkDraft, tableName: string): ErFkSchema {
  return {
    name: f.name.trim(),
    table: tableName,
    columns: f.columns,
    refTable: f.refTable,
    refColumns: f.refColumns,
    onDelete: f.onDelete,
    onUpdate: f.onUpdate,
  }
}

const FK_ACTIONS = ['CASCADE', 'RESTRICT', 'SET NULL', 'NO ACTION']

interface DesignerDraft {
  name: string
  comment: string
  engine: string
  collation: string
  cols: ColDraft[]
  idxs: IdxDraft[]
  fks: FkDraft[]
}

/** 表设计器：列/索引/外键/表选项四个 Tab + 底部实时 DDL 预览。
 *  打开已同步表 = copy-on-edit（保存时与库一致则不落 schema） */
export function ErTableDesigner() {
  const tabKey = useErTabKey()
  const designerTable = useErTab((t) => t.designerTable)
  const graph = useErTab((t) => t.graph)
  const snapshot = useErTab((t) => t.snapshot)
  const modelTables = useErTab((t) => t.modelTables)
  const database = useErTab((t) => t.database)

  const lower = designerTable ?? null
  const [draft, setDraft] = useState<DesignerDraft | null>(null)
  const [ddl, setDdl] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!lower || !graph || !snapshot) {
      setDraft(null)
      return
    }
    // tombstone 表不进设计器（保存会绕过恢复语义）
    if (modelTables?.[lower]?.deleted) {
      setDraft(null)
      return
    }
    const src =
      modelTables?.[lower]?.schema ??
      (() => {
        const t = snapshot.tables.find((s) => s.name.toLowerCase() === lower)
        if (!t) return null
        const fks = snapshot.foreignKeys.filter((f) => f.table.toLowerCase() === lower)
        return snapshotTableToSchema(t, fks)
      })()
    if (!src) {
      setDraft(null)
      return
    }
    setDraft({
      name: src.name,
      comment: src.comment ?? '',
      engine: src.engine ?? '',
      collation: src.collation ?? '',
      cols: src.columns.map(colToDraft),
      idxs: src.indexes.map(idxToDraft),
      fks: src.foreignKeys.map(fkToDraft),
    })
    // graph/snapshot 只在打开/切换表时读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lower])

  const toSchema = useMemo(
    () =>
      draft
        ? {
            name: draft.name.trim(),
            engine: draft.engine === '' ? null : draft.engine,
            collation: draft.collation === '' ? null : draft.collation,
            comment: draft.comment === '' ? null : draft.comment,
            columns: draft.cols.map(draftToCol),
            indexes: draft.idxs.map(draftToIdx),
            foreignKeys: draft.fks.map((f) => draftToFk(f, draft.name.trim())),
          }
        : null,
    [draft],
  )

  // 实时 DDL 预览（防抖 300ms）
  useEffect(() => {
    if (!toSchema || !database || !draft) return
    const h = setTimeout(() => {
      api
        .previewTableDdl(database, toSchema)
        .then(setDdl)
        .catch(() => setDdl(''))
    }, 300)
    return () => clearTimeout(h)
  }, [toSchema, database, draft])

  if (!lower || !draft || !graph) return null
  const modelStatus = graph.tables[lower]?.modelStatus
  const inDb = !!snapshot?.tables.some((s) => s.name.toLowerCase() === lower)
  const close = () => useErStore.getState().setDesignerTable(tabKey, null)

  const colNameOptions = draft.cols.map((c) => ({ value: c.name, label: c.name }))
  const tableOptions = Object.values(graph.tables).map((t) => ({ value: t.name, label: t.name }))
  const refColOptions = (tableName: string) =>
    (graph.tables[tableName.toLowerCase()]?.columns ?? []).map((c) => ({
      value: c.name,
      label: `${c.name} ${c.dataType}`,
    }))

  const save = async () => {
    if (!toSchema) return
    setSaving(true)
    try {
      const r = useErStore.getState().saveTableSchema(tabKey, lower, toSchema as ErTableSchema)
      if (!r.ok) message.warning(r.error ?? '保存失败')
      else {
        message.success('已保存到模型（未应用至库）')
        close()
      }
    } finally {
      setSaving(false)
    }
  }

  /** 草稿行更新小助手（不可变更新单行） */
  const setCols = (fn: (cols: ColDraft[]) => ColDraft[]) =>
    setDraft((d) => (d ? { ...d, cols: fn(d.cols) } : d))
  const setIdxs = (fn: (idxs: IdxDraft[]) => IdxDraft[]) =>
    setDraft((d) => (d ? { ...d, idxs: fn(d.idxs) } : d))
  const setFks = (fn: (fks: FkDraft[]) => FkDraft[]) =>
    setDraft((d) => (d ? { ...d, fks: fn(d.fks) } : d))

  const moveCol = (i: number, dir: -1 | 1) => {
    setCols((cols) => {
      const j = i + dir
      if (j < 0 || j >= cols.length) return cols
      const next = [...cols]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const colRows = draft.cols.map((c, i) => (
    <div className="erd-row" key={c.uid}>
      <Input
        size="small"
        style={{ width: 140 }}
        placeholder="列名"
        value={c.name}
        onChange={(e) => {
          // 改名传播到索引与外键的列引用（逐键触发，引用跟着走）
          setDraft((d) => (d ? applyColumnNameRename(d, c.name, e.target.value) : d))
        }}
      />
      <Input
        size="small"
        style={{ width: 150 }}
        list="erd-type-suggest"
        placeholder="类型"
        value={c.dataType}
        onChange={(e) => setCols((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, dataType: e.target.value } : x)))}
      />
      <datalist id="erd-type-suggest">
        {TYPE_SUGGESTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <Checkbox
        checked={c.nullable}
        onChange={(e) => setCols((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, nullable: e.target.checked } : x)))}
      >
        NULL
      </Checkbox>
      <Checkbox
        checked={c.default === null}
        onChange={(e) =>
          setCols((cs) =>
            cs.map((x) => (x.uid === c.uid ? { ...x, default: e.target.checked ? null : '' } : x)),
          )
        }
      >
        无默认
      </Checkbox>
      <Input
        size="small"
        style={{ width: 96 }}
        placeholder="默认值"
        disabled={c.default === null}
        value={c.default ?? ''}
        onChange={(e) => setCols((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, default: e.target.value } : x)))}
      />
      <Checkbox
        checked={c.autoInc}
        onChange={(e) => setCols((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, autoInc: e.target.checked } : x)))}
      >
        自增
      </Checkbox>
      <Checkbox
        checked={c.onUpdateTs}
        onChange={(e) => setCols((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, onUpdateTs: e.target.checked } : x)))}
      >
        更新时间
      </Checkbox>
      <Input
        size="small"
        style={{ flex: 1 }}
        placeholder="注释"
        value={c.comment}
        onChange={(e) => setCols((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, comment: e.target.value } : x)))}
      />
      <Space size={2}>
        <Tooltip title="在此行下方插入新列">
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() =>
              setCols((cs) => {
                const next = [...cs]
                next.splice(i + 1, 0, {
                  uid: nextUid(),
                  name: '',
                  dataType: '',
                  nullable: true,
                  default: null,
                  autoInc: false,
                  onUpdateTs: false,
                  comment: '',
                  extraRest: '',
                  characterSet: null,
                  collation: null,
                })
                return next
              })
            }
          />
        </Tooltip>
        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => moveCol(i, -1)} />
        <Button
          size="small"
          type="text"
          icon={<ArrowDownOutlined />}
          disabled={i === draft.cols.length - 1}
          onClick={() => moveCol(i, 1)}
        />
        <Button
          size="small"
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => setCols((cs) => cs.filter((x) => x.uid !== c.uid))}
        />
      </Space>
    </div>
  ))

  const idxRows = draft.idxs.map((ix) => (
    <div className="erd-row" key={ix.uid}>
      <Input
        size="small"
        style={{ width: 150 }}
        placeholder="索引名"
        value={ix.name}
        disabled={ix.isPrimary}
        onChange={(e) => setIdxs((xs) => xs.map((x) => (x.uid === ix.uid ? { ...x, name: e.target.value } : x)))}
      />
      <Select
        mode="multiple"
        size="small"
        style={{ flex: 1 }}
        placeholder="列"
        value={ix.columns}
        options={colNameOptions}
        onChange={(v) =>
          setIdxs((xs) =>
            xs.map((x) => (x.uid === ix.uid ? { ...x, columns: v, subParts: [], directions: [] } : x)),
          )
        }
      />
      {ix.isPrimary ? (
        <span className="erd-tag">PRIMARY</span>
      ) : (
        <>
          <Checkbox
            checked={ix.unique}
            onChange={(e) => setIdxs((xs) => xs.map((x) => (x.uid === ix.uid ? { ...x, unique: e.target.checked } : x)))}
          >
            唯一
          </Checkbox>
          <Select
            size="small"
            style={{ width: 100 }}
            value={ix.indexType}
            options={['BTREE', 'HASH', 'FULLTEXT'].map((t) => ({ value: t, label: t }))}
            onChange={(v) => setIdxs((xs) => xs.map((x) => (x.uid === ix.uid ? { ...x, indexType: v } : x)))}
          />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => setIdxs((xs) => xs.filter((x) => x.uid !== ix.uid))}
          />
        </>
      )}
    </div>
  ))

  const fkRows = draft.fks.map((f) => (
    <div className="erd-row" key={f.uid}>
      <Input
        size="small"
        style={{ width: 150 }}
        placeholder="外键名"
        value={f.name}
        onChange={(e) => setFks((fs) => fs.map((x) => (x.uid === f.uid ? { ...x, name: e.target.value } : x)))}
      />
      <Select
        mode="multiple"
        size="small"
        style={{ flex: 1 }}
        placeholder="本表列"
        value={f.columns}
        options={colNameOptions}
        onChange={(v) => setFks((fs) => fs.map((x) => (x.uid === f.uid ? { ...x, columns: v } : x)))}
      />
      <Select
        size="small"
        style={{ width: 140 }}
        showSearch
        placeholder="引用表"
        value={f.refTable || undefined}
        options={tableOptions}
        onChange={(v) => setFks((fs) => fs.map((x) => (x.uid === f.uid ? { ...x, refTable: v, refColumns: [] } : x)))}
      />
      <Select
        mode="multiple"
        size="small"
        style={{ flex: 1 }}
        placeholder="引用列"
        value={f.refColumns}
        options={refColOptions(f.refTable)}
        onChange={(v) => setFks((fs) => fs.map((x) => (x.uid === f.uid ? { ...x, refColumns: v } : x)))}
      />
      <Select
        size="small"
        allowClear
        style={{ width: 110 }}
        placeholder="ON DELETE"
        value={f.onDelete ?? undefined}
        options={FK_ACTIONS.map((a) => ({ value: a, label: `删除 ${a}` }))}
        onChange={(v) => setFks((fs) => fs.map((x) => (x.uid === f.uid ? { ...x, onDelete: v ?? null } : x)))}
      />
      <Select
        size="small"
        allowClear
        style={{ width: 110 }}
        placeholder="ON UPDATE"
        value={f.onUpdate ?? undefined}
        options={FK_ACTIONS.map((a) => ({ value: a, label: `更新 ${a}` }))}
        onChange={(v) => setFks((fs) => fs.map((x) => (x.uid === f.uid ? { ...x, onUpdate: v ?? null } : x)))}
      />
      <Button
        size="small"
        type="text"
        danger
        icon={<DeleteOutlined />}
        onClick={() => setFks((fs) => fs.filter((x) => x.uid !== f.uid))}
      />
    </div>
  ))

  return (
    <Modal
      open
      title={`表设计器 · ${draft.name || '（未命名）'}${
        modelStatus === 'new'
          ? ' · 新建（未应用）'
          : modelStatus === 'edited'
            ? ' · 已编辑（未应用）'
            : ''
      }`}
      width={960}
      onCancel={close}
      destroyOnHidden
      footer={[
        <Button key="c" onClick={close}>
          取消
        </Button>,
        <Button key="s" type="primary" loading={saving} onClick={save}>
          保存
        </Button>,
      ]}
    >
      <div className="erd-head">
        <span className="erd-field">
          表名
          <Input
            size="small"
            style={{ width: 180 }}
            value={draft.name}
            disabled={inDb}
            onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
          />
        </span>
      </div>
      {inDb && (
        <Alert
          type="info"
          showIcon
          style={{ margin: '8px 0' }}
          message="已存在于库中的表不能改名；保存后需在「应用变更」中执行才会修改数据库"
        />
      )}
      <Tabs
        size="small"
        items={[
          {
            key: 'cols',
            label: `列（${draft.cols.length}）`,
            children: (
              <div className="erd-rows">
                {colRows}
                <Button
                  size="small"
                  type="dashed"
                  icon={<PlusOutlined />}
                  style={{ width: 120 }}
                  onClick={() =>
                    setCols((cs) => [
                      ...cs,
                      {
                        uid: nextUid(),
                        name: '',
                        dataType: '',
                        nullable: true,
                        default: null,
                        autoInc: false,
                        onUpdateTs: false,
                        comment: '',
                        extraRest: '',
                        characterSet: null,
                        collation: null,
                      },
                    ])
                  }
                >
                  加列
                </Button>
              </div>
            ),
          },
          {
            key: 'idxs',
            label: `索引（${draft.idxs.length}）`,
            children: (
              <div className="erd-rows">
                {idxRows}
                <Button
                  size="small"
                  type="dashed"
                  icon={<PlusOutlined />}
                  style={{ width: 120 }}
                  onClick={() =>
                    setIdxs((xs) => [
                      ...xs,
                      {
                        uid: nextUid(),
                        name: '',
                        columns: [],
                        unique: false,
                        indexType: 'BTREE',
                        isPrimary: false,
                        subParts: [],
                        directions: [],
                      },
                    ])
                  }
                >
                  加索引
                </Button>
              </div>
            ),
          },
          {
            key: 'fks',
            label: `外键（${draft.fks.length}）`,
            children: (
              <div className="erd-rows">
                {fkRows}
                <Button
                  size="small"
                  type="dashed"
                  icon={<PlusOutlined />}
                  style={{ width: 120 }}
                  onClick={() =>
                    setFks((fs) => [
                      ...fs,
                      {
                        uid: nextUid(),
                        name: '',
                        columns: [],
                        refTable: '',
                        refColumns: [],
                        onDelete: null,
                        onUpdate: null,
                      },
                    ])
                  }
                >
                  加外键
                </Button>
              </div>
            ),
          },
          {
            key: 'opts',
            label: '表选项',
            children: (
              <div className="erd-rows">
                <div className="erd-row">
                  <span className="erd-field">
                    引擎
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={draft.engine || 'InnoDB'}
                      options={['InnoDB', 'MyISAM', 'MEMORY'].map((v) => ({ value: v, label: v }))}
                      onChange={(v) => setDraft((d) => (d ? { ...d, engine: v } : d))}
                    />
                  </span>
                  <span className="erd-field">
                    排序规则
                    <Input
                      size="small"
                      style={{ width: 170 }}
                      placeholder="utf8mb4_general_ci"
                      value={draft.collation}
                      onChange={(e) => setDraft((d) => (d ? { ...d, collation: e.target.value } : d))}
                    />
                  </span>
                </div>
                <div className="erd-row">
                  <span className="erd-field">
                    注释
                    <Input
                      size="small"
                      style={{ width: 400 }}
                      value={draft.comment}
                      onChange={(e) => setDraft((d) => (d ? { ...d, comment: e.target.value } : d))}
                    />
                  </span>
                </div>
              </div>
            ),
          },
        ]}
      />
      <div className="erd-ddl-title">DDL 预览（外键以独立 ALTER 追加）</div>
      <SqlView sql={ddl || null} emptyText="（填写列后显示建表语句）" />
    </Modal>
  )
}
