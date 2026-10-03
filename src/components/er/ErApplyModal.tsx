import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Empty, Modal, Space, Spin, Tabs, message } from 'antd'

import { api } from '../../api/commands'
import type { ApplyResultItem, DiffItem } from '../../api/types'
import { errText } from '../connection/ConnectionTree'
import { useErStore } from '../../stores/er'
import { buildDeployStatements } from '../../stores/compare'
import { useErTabKey } from './erTabContext'
import { SqlView } from '../compare/SqlView'

type Step = 'diff' | 'done'

const ACTION_TEXT: Record<string, string> = {
  create: '新建',
  drop: '删除',
  modify: '修改',
  rename: '改名',
  noop: '无操作',
}

/** 应用变更：差异确认（按表分组勾选，dangerous 默认不勾）→ 部署执行 → 完成态。
 *  diff 来源是「模型 vs 库实时结构」，执行走既有 apply_sync 逐条回报 */
export function ErApplyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tabKey = useErTabKey()
  const [items, setItems] = useState<DiffItem[] | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [activeItem, setActiveItem] = useState<DiffItem | null>(null)
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<ApplyResultItem[] | null>(null)
  const [step, setStep] = useState<Step>('diff')
  const [error, setError] = useState<string | null>(null)

  const runDiff = () =>
    useErStore
      .getState()
      .runErDiff(tabKey)
      .then((r) => {
        setItems(r)
        // 危险项默认不勾
        setSelectedIds(r.filter((i) => !i.dangerous).map((i) => i.id))
      })
      .catch((e) => setError(errText(e)))

  useEffect(() => {
    if (!open) return
    setItems(null)
    setSelectedIds([])
    setResults(null)
    setActiveItem(null)
    setStep('diff')
    setError(null)
    runDiff()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tabKey])

  const selected = useMemo(
    () => (items ?? []).filter((i) => selectedIds.includes(i.id)),
    [items, selectedIds],
  )
  const sqls = useMemo(() => buildDeployStatements(selected), [selected])
  const dangerousCount = selected.filter((i) => i.dangerous).length

  const byTable = useMemo(() => {
    const groups = new Map<string, DiffItem[]>()
    for (const i of items ?? []) {
      const list = groups.get(i.table) ?? []
      list.push(i)
      groups.set(i.table, list)
    }
    return [...groups.entries()]
  }, [items])

  /** 勾选「删表」时自动勾选其前置 DROP FK（引用该表的库外键）——
   *  只勾删表不勾删 FK 会执行失败（MySQL 拒绝删除被引用的表） */
  const toggle = (ids: string[], on: boolean) =>
    setSelectedIds((prev) => {
      const set = new Set(prev)
      for (const id of ids) {
        if (on) set.add(id)
        else set.delete(id)
      }
      if (on) {
        for (const t of (items ?? []).filter(
          (i) => ids.includes(i.id) && i.kind === 'table' && i.action === 'drop',
        )) {
          for (const fk of items ?? []) {
            if (
              fk.kind === 'foreignKey' &&
              fk.action === 'drop' &&
              (fk.refTable ?? '').toLowerCase() === t.table.toLowerCase()
            )
              set.add(fk.id)
          }
        }
      }
      return [...set]
    })

  /** 部署前校验：勾了删表但配套 DROP FK 被手动取消勾选 → 拦下并点名 */
  const missingFkDeps = (): string[] => {
    const sel = new Set(selectedIds)
    const out: string[] = []
    for (const t of selected.filter((i) => i.kind === 'table' && i.action === 'drop')) {
      for (const fk of items ?? []) {
        if (
          fk.kind === 'foreignKey' &&
          fk.action === 'drop' &&
          !sel.has(fk.id) &&
          (fk.refTable ?? '').toLowerCase() === t.table.toLowerCase()
        )
          out.push(`${fk.table}.${fk.name}`)
      }
    }
    return out
  }

  const deploy = async () => {
    const t = useErStore.getState().tabs[tabKey]
    if (!t) return
    const missing = missingFkDeps()
    if (missing.length > 0) {
      message.error(`删除表前需先删除引用它的外键：${missing.join('、')}（请一并勾选）`)
      return
    }
    setApplying(true)
    try {
      const rs = await api.applySync(t.connectionId, sqls)
      setResults(rs)
      setStep('done')
      // 刷新快照 + 自清理（零差异表清 schema、tombstone 移除、走线迁移）并自动保存
      await useErStore.getState().refreshAfterApply(tabKey)
      message.success(
        `执行完成：成功 ${rs.filter((r) => r.ok).length} 条，失败 ${rs.filter((r) => !r.ok).length} 条`,
      )
    } catch (e) {
      message.error(errText(e))
    } finally {
      setApplying(false)
    }
  }

  const diffBody = (
    <>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {items === null ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Spin tip="正在与数据库比对…" />
        </div>
      ) : items.length === 0 ? (
        <Empty description="模型与数据库结构一致，无需应用" style={{ padding: 40 }} />
      ) : (
        <div className="er-apply-list">
          {byTable.map(([table, list]) => {
            const ids = list.map((i) => i.id)
            const sel = ids.filter((id) => selectedIds.includes(id)).length
            return (
              <div key={table} className="er-apply-group">
                <div className="er-apply-group-head">
                  <Checkbox
                    checked={sel === ids.length}
                    indeterminate={sel > 0 && sel < ids.length}
                    onChange={(e) => toggle(ids, e.target.checked)}
                  />
                  <span className="er-apply-table">{table}</span>
                </div>
                {list.map((i) => (
                  <div
                    key={i.id}
                    className={`er-apply-item${activeItem?.id === i.id ? ' active' : ''}`}
                    onClick={() => setActiveItem(i)}
                  >
                    <Checkbox
                      checked={selectedIds.includes(i.id)}
                      onChange={(e) => toggle([i.id], e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className={`er-apply-action ${i.dangerous ? 'danger' : ''}`}>
                      {ACTION_TEXT[i.action] ?? i.action}
                    </span>
                    <span className="er-apply-desc">{i.name}</span>
                    <span className="er-apply-desc dim">
                      {i.sourceDesc ?? ''} {i.targetDesc ? `→ ${i.targetDesc}` : ''}
                    </span>
                    {i.dangerous && <span className="er-apply-danger">危险</span>}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </>
  )

  return (
    <Modal
      open={open}
      title="应用变更（模型 → 数据库）"
      width={980}
      onCancel={() => !applying && onClose()}
      maskClosable={false}
      destroyOnHidden
      footer={
        step === 'diff' ? (
          <Space>
            <Button onClick={onClose} disabled={applying}>
              取消
            </Button>
            <Button
              type="primary"
              danger={dangerousCount > 0}
              loading={applying}
              disabled={sqls.length === 0}
              onClick={deploy}
            >
              开始执行
              {sqls.length > 0
                ? `（${sqls.length} 条${dangerousCount ? `，含 ${dangerousCount} 条危险操作` : ''}）`
                : ''}
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <Button
              onClick={() => {
                setStep('diff')
                setItems(null)
                setError(null)
                runDiff()
              }}
            >
              重新比较
            </Button>
          </Space>
        )
      }
    >
      {step === 'diff' ? (
        <div className="er-apply-body">
          <div className="er-apply-top">{diffBody}</div>
          <Tabs
            className="er-apply-bottom"
            size="small"
            items={[
              {
                key: 'ddl',
                label: 'DDL 比较',
                children: activeItem ? (
                  <div className="er-apply-ddl">
                    <div>
                      <div className="er-apply-ddl-title">模型（源）</div>
                      <SqlView sql={activeItem.sourceDdl} emptyText="（不存在）" />
                    </div>
                    <div>
                      <div className="er-apply-ddl-title">数据库（目标）</div>
                      <SqlView sql={activeItem.targetDdl} emptyText="（不存在）" />
                    </div>
                  </div>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="点击差异项查看两侧 DDL"
                    style={{ paddingTop: 24 }}
                  />
                ),
              },
              {
                key: 'sql',
                label: '部署脚本',
                children: (
                  <SqlView
                    sql={sqls.length > 0 ? `${sqls.join(';\n\n')};` : null}
                    emptyText="未勾选任何对象（勾选后此处显示将要执行的全部语句）"
                  />
                ),
              },
            ]}
          />
        </div>
      ) : (
        results && (
          <>
            <Alert
              type={results.every((r) => r.ok) ? 'success' : 'error'}
              showIcon
              message={`执行完成：成功 ${results.filter((r) => r.ok).length} 条，失败 ${results.filter((r) => !r.ok).length} 条（DDL 不可回滚，结果以数据库为准）`}
            />
            <div style={{ marginTop: 8 }}>
              <SqlView
                sql={
                  sqls.length > 0
                    ? sqls
                        .map((sql, i) => {
                          const r = results[i]
                          return `${r ? (r.ok ? '-- ✓ 执行成功' : '-- ✗ 执行失败') : ''}\n${sql}`
                        })
                        .join(';\n\n')
                    : null
                }
                emptyText="没有勾选任何语句"
              />
            </div>
          </>
        )
      )}
    </Modal>
  )
}
