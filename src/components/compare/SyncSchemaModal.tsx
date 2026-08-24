import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Modal,
  Progress,
  Select,
  Spin,
  Tabs,
  message,
} from 'antd'
import {
  ApiOutlined,
  ArrowRightOutlined,
  CaretRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  RedoOutlined,
  SwapOutlined,
  TableOutlined,
} from '@ant-design/icons'
import { useCompareStore, type CompareEndpoint, type CompareStep } from '../../stores/compare'
import { useConnectionsStore } from '../../stores/connections'
import { useSessionStore } from '../../stores/session'
import type { ConnectionProfile } from '../../api/types'
import { errText } from '../connection/ConnectionTree'
import { DiffTree } from './DiffTree'
import { SqlView } from './SqlView'

/** 对比进度阶段 → 进度条百分比与文案（对照 Navicat「正在比较数据库…/正在获取表」） */
const PHASE_META: Record<string, { percent: number; text: string }> = {
  connect: { percent: 15, text: '正在连接…' },
  fetch_source: { percent: 40, text: '正在获取表（源端）' },
  fetch_target: { percent: 65, text: '正在获取表（目标端）' },
  diff: { percent: 90, text: '正在比对对象' },
}

/** 工具菜单 → 结构同步：选择 → 对比结果 → 部署（参照 Navicat 交互） */
export function SyncSchemaModal() {
  const cmp = useCompareStore()
  const connections = useConnectionsStore((s) => s.connections)
  const groups = useConnectionsStore((s) => s.groups)
  const connected = useSessionStore((s) => s.connected)

  // 只有已建立连接的连接可选（对比需要两端会话）
  const connectedOptions = useMemo(
    () =>
      connections
        .filter((c) => connected[c.id])
        .map((c) => ({
          value: c.id,
          label: (
            <span>
              <ApiOutlined style={{ marginRight: 6, color: '#52a86e' }} />
              {c.name}（{c.host}:{c.port}）
            </span>
          ),
        })),
    [connections, connected],
  )

  const selected = useMemo(
    () => (cmp.report ?? []).filter((i) => cmp.selectedIds.includes(i.id)),
    [cmp.report, cmp.selectedIds],
  )
  // DDL 比较展示规则：
  //  - 选中表行 → 该表完整 DDL
  //  - 选中「表级叶子」（tbl: 建表/删表）→ 该 item 的 DDL（一侧为「不存在」）
  //  - 选中字段/索引明细 → 不展示 DDL 比较（只看部署脚本）
  const activeItem = useMemo(() => {
    if (!cmp.activeTable) return null
    if (cmp.activeItemId) {
      const item = (cmp.report ?? []).find((i) => i.id === cmp.activeItemId)
      return item && item.id.startsWith('tbl:') ? item : null
    }
    return (cmp.report ?? []).find((i) => i.table === cmp.activeTable) ?? null
  }, [cmp.report, cmp.activeItemId, cmp.activeTable])

  // 左树里断开（或删除）连接后，清掉引用该连接的端点选择（否则下拉显示裸 id、对比必失败）
  useEffect(() => {
    useCompareStore.getState().syncConnected(Object.keys(connected))
  }, [connected, connections])

  // ── 对比结果页：上（差异列表）下（DDL/部署脚本）分隔条，可拖拽调整高度 ──
  const stepBodyRef = useRef<HTMLDivElement>(null)
  const [bottomHeight, setBottomHeight] = useState(300)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const initializedRef = useRef(false)

  // 首次对比出结果时，把底部区域设为可用高度的一半（上下各占一半）
  useEffect(() => {
    if (cmp.step === 'diff' && cmp.report && cmp.report.length > 0 && !initializedRef.current) {
      initializedRef.current = true
      const el = stepBodyRef.current
      if (el) {
        // 可用高度 ≈ 容器总高 - 工具栏(~30) - 分隔条(~14) - 底栏(~44)
        const available = el.clientHeight - 88
        setBottomHeight(Math.max(120, Math.floor(available / 2)))
      }
    }
  }, [cmp.step, cmp.report])

  const onResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: bottomHeight }
    const move = (ev: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const total = stepBodyRef.current?.clientHeight ?? 600
      const delta = drag.startY - ev.clientY // 向上拖 delta>0 → 底部区域变大
      const maxH = Math.floor(total * 0.75)
      const minH = 100
      setBottomHeight(Math.min(maxH, Math.max(minH, drag.startH + delta)))
    }
    const up = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'row-resize'
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  if (!cmp.modalOpen) return null

  const findConn = (id: string | null): ConnectionProfile | undefined =>
    connections.find((c) => c.id === id)
  const groupNameOf = (p: ConnectionProfile | undefined): string => {
    if (!p) return '--'
    if (!p.groupId) return '未分组'
    return groups.find((g) => g.id === p.groupId)?.name ?? '未分组'
  }

  const bothReady =
    cmp.source.connectionId && cmp.source.database && cmp.target.connectionId && cmp.target.database

  const doCompare = () => {
    cmp.runCompare().catch((e) => message.error(errText(e)))
  }

  const STEP_TITLES: Record<CompareStep, string> = {
    select: '选择数据库',
    diff: '对比结果',
    deploy: '部署',
  }

  /** 顶部居中摘要：源连接/库 → 目标连接/库（图 7/8/9 头部） */
  const summarySide = (ep: CompareEndpoint, color: string, alignRight: boolean) => {
    const conn = findConn(ep.connectionId)
    return (
      <>
        <div className={`cmp-summary-text ${alignRight ? 'right' : ''}`}>
          <div className="cmp-summary-conn">{conn?.name ?? '--'}</div>
          <div className="cmp-summary-db">{ep.database ?? '--'}</div>
        </div>
        <DatabaseOutlined className="cmp-summary-icon" style={{ color }} />
      </>
    )
  }
  const summaryHeader = (
    <div className="cmp-summary">
      {summarySide(cmp.source, '#52a86e', true)}
      <ArrowRightOutlined className="cmp-summary-arrow" />
      {summarySide(cmp.target, '#4a90d9', false)}
    </div>
  )

  const stepTitle = <div className="cmp-step-title">{STEP_TITLES[cmp.step]}</div>

  /** 端点选择面板：源/目标各一列，下方挂信息块（图 9） */
  const endpointPanel = (role: 'source' | 'target') => {
    const isSource = role === 'source'
    const ep = isSource ? cmp.source : cmp.target
    const dbs = isSource ? cmp.sourceDbs : cmp.targetDbs
    const loading = isSource ? cmp.loadingSourceDbs : cmp.loadingTargetDbs
    const profile = findConn(ep.connectionId)
    const infoRows: [string, string][] = [
      ['分组', groupNameOf(profile)],
      ['数据库类型', 'MySQL'],
      ['名称', profile?.name ?? '--'],
      ['主机', profile?.host ?? '--'],
      ['端口', profile ? String(profile.port) : '--'],
      ['服务器版本', (profile && connected[profile.id]?.serverVersion) || '--'],
    ]
    return (
      <div className="cmp-pane">
        <div className="cmp-pane-title">{isSource ? '源' : '目标'}</div>
        <div className="cmp-field">
          <div className="cmp-field-label">连接</div>
          <Select
            style={{ width: '100%' }}
            placeholder={connectedOptions.length === 0 ? '请先在左侧连接一个数据库' : '选择连接'}
            value={ep.connectionId ?? undefined}
            options={connectedOptions}
            onChange={(v) => {
              const fn = isSource ? cmp.setSourceConn : cmp.setTargetConn
              fn(v).catch((e) => message.error(errText(e)))
            }}
          />
        </div>
        <div className="cmp-field">
          <div className="cmp-field-label">数据库</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择数据库"
            value={ep.database ?? undefined}
            disabled={!ep.connectionId}
            loading={loading}
            options={dbs.map((d) => ({
              value: d.name,
              label: (
                <span>
                  <DatabaseOutlined style={{ marginRight: 6, color: '#4a90d9' }} />
                  {d.name}
                </span>
              ),
            }))}
            onChange={(v) => (isSource ? cmp.setSourceDb(v) : cmp.setTargetDb(v))}
          />
        </div>
        <div className="cmp-pane-info">
          <div className="cmp-pane-title">信息</div>
          {infoRows.map(([label, value]) => (
            <div key={label} className="cmp-info-row">
              <span className="cmp-info-label">{label}:</span>
              <span className="cmp-info-value">{value}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  /** 对比进行中的进度弹层（图 7：正在比较数据库… + 取消） */
  const phase = PHASE_META[cmp.comparePhase ?? 'connect'] ?? PHASE_META.connect
  const progressOverlay = cmp.comparing && (
    <div className="cmp-progress-mask">
      <div className="cmp-progress-card">
        <div className="cmp-progress-title">
          <DatabaseOutlined style={{ marginRight: 8 }} />
          正在比较数据库…
        </div>
        <Progress percent={phase.percent} status="active" showInfo={false} />
        <div className="cmp-progress-phase">{phase.text}</div>
        <div style={{ textAlign: 'right' }}>
          <Button size="small" onClick={cmp.cancelCompare}>
            取消
          </Button>
        </div>
      </div>
    </div>
  )

  /** 部署脚本文本：跟随选中行——明细只显该项、表行显该表全部、未选中显所有勾选项 */
  const deployItems = cmp.activeItemId
    ? (cmp.report ?? []).filter((i) => i.id === cmp.activeItemId)
    : cmp.activeTable
      ? (cmp.report ?? []).filter((i) => i.table === cmp.activeTable)
      : selected
  const deployScript = deployItems
    .map((i) => i.sql)
    .filter((s): s is string => !!s)
    .join(';\n\n')

  const selectedSqls = selected.map((i) => i.sql).filter((s): s is string => !!s)
  const dangerousSelected = selected.filter((i) => i.dangerous).length

  return (
    <Modal
      open
      title="结构同步"
      width={1300}
      footer={null}
      onCancel={() => !cmp.applying && cmp.closeModal()}
      maskClosable={false}
      destroyOnHidden
      className="sync-schema-modal"
    >
      <div className="cmp-window" onContextMenu={(e) => e.preventDefault()}>
        {stepTitle}
        {summaryHeader}

        {/* ───── 第一步：选择源/目标（图 7/9） ───── */}
        {cmp.step === 'select' && (
          <div className="cmp-step-body">
            <div className="cmp-panes">
              {endpointPanel('source')}
              <div className="cmp-swap">
                <Button type="text" icon={<SwapOutlined />} onClick={cmp.swap} title="交换源与目标" />
              </div>
              {endpointPanel('target')}
            </div>
            {connectedOptions.length === 0 && (
              <Alert
                style={{ margin: '12px 16px 0' }}
                type="info"
                showIcon
                message="没有已连接的数据库——请先在左侧树中打开至少一个连接（两端可以是同一连接的不同库）"
              />
            )}
            <div className="cmp-footer">
              <Button onClick={cmp.closeModal}>取消</Button>
              <Button
                type="primary"
                icon={<CaretRightOutlined />}
                disabled={!bothReady}
                onClick={doCompare}
              >
                比较
              </Button>
            </div>
          </div>
        )}

        {/* ───── 第二步：对比结果（图 8） ───── */}
        {cmp.step === 'diff' && (
          <div className="cmp-step-body" ref={stepBodyRef}>
            <div className="cmp-diff-toolbar">
              <Select
                value={cmp.groupMode}
                style={{ width: 130 }}
                options={[
                  { value: 'action', label: '按操作分组' },
                  { value: 'object', label: '按对象分组' },
                ]}
                onChange={(v) => cmp.setGroupMode(v)}
              />
            </div>
            {(cmp.report ?? []).length === 0 ? (
              <Empty description="两端结构一致，无需同步" style={{ padding: 60 }} />
            ) : (
              <>
                <div className="cmp-tree-wrap">
                  <DiffTree />
                </div>
                <div
                  className="cmp-resizer"
                  onMouseDown={onResizerMouseDown}
                  title="上下拖动调整两区域高度"
                />
                <Tabs
                  className="cmp-bottom-tabs"
                  size="small"
                  style={{ height: bottomHeight }}
                  items={[
                    {
                      key: 'ddl',
                      label: 'DDL 比较',
                      children: activeItem ? (
                        <div className="cmp-ddl-compare">
                          <div className="cmp-ddl-pane">
                            <div className="cmp-ddl-pane-title">
                              <TableOutlined style={{ marginRight: 6 }} />
                              {activeItem.table}
                              <span className="cmp-ddl-side-tag source">源</span>
                            </div>
                            <SqlView sql={activeItem.sourceDdl} emptyText="（源端不存在该表）" />
                          </div>
                          <div className="cmp-ddl-pane">
                            <div className="cmp-ddl-pane-title">
                              <TableOutlined style={{ marginRight: 6 }} />
                              {activeItem.table}
                              <span className="cmp-ddl-side-tag target">目标</span>
                            </div>
                            <SqlView sql={activeItem.targetDdl} emptyText="（目标端不存在该表）" />
                          </div>
                        </div>
                      ) : (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="点击上方表行查看两端 DDL 对比"
                          style={{ paddingTop: 40 }}
                        />
                      ),
                    },
                    {
                      key: 'sql',
                      label: '部署脚本',
                      children: (
                        <SqlView
                          sql={deployScript ? `${deployScript};` : null}
                          emptyText="未勾选任何对象（勾选后此处显示将要执行的全部语句）"
                        />
                      ),
                    },
                  ]}
                />
              </>
            )}
            <div className="cmp-footer">
              <Button onClick={cmp.closeModal}>取消</Button>
              <Button onClick={cmp.backToSelect}>上一步</Button>
              <Button icon={<RedoOutlined />} onClick={doCompare} loading={cmp.comparing}>
                重新比较
              </Button>
              <Button
                type="primary"
                disabled={cmp.comparing || selected.length === 0}
                onClick={cmp.gotoDeploy}
              >
                下一步 ({selected.length})
              </Button>
            </div>
          </div>
        )}

        {/* ───── 第三步：部署 ───── */}
        {cmp.step === 'deploy' && (
          <div className="cmp-step-body">
            <Alert
              type={dangerousSelected > 0 ? 'warning' : 'info'}
              showIcon
              message={`将执行 ${selectedSqls.length} 条语句${dangerousSelected > 0 ? `，其中 ${dangerousSelected} 条为删除类操作（不可恢复）` : ''}`}
            />
            <div className="cmp-deploy-list">
              {selectedSqls.map((sql, i) => {
                const r = cmp.applyResults?.[i]
                return (
                  <div key={i} className="cmp-deploy-item">
                    {r &&
                      (r.ok ? (
                        <CheckCircleOutlined style={{ color: '#52c41a' }} />
                      ) : (
                        <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                      ))}
                    <div className="cmp-deploy-sql">
                      <SqlView sql={sql} emptyText="" />
                    </div>
                  </div>
                )
              })}
            </div>
            {cmp.applying && (
              <div style={{ marginTop: 8 }}>
                <Spin size="small" /> 正在逐条执行 {selectedSqls.length} 条语句…
              </div>
            )}
            {cmp.applyResults && (
              <Alert
                style={{ marginTop: 8 }}
                type={cmp.applyResults.every((r) => r.ok) ? 'success' : 'error'}
                showIcon
                message={
                  `执行完成：成功 ${cmp.applyResults.filter((r) => r.ok).length} 条` +
                  `，失败 ${cmp.applyResults.filter((r) => !r.ok).length} 条` +
                  (cmp.applyElapsedMs != null
                    ? `，耗时 ${(cmp.applyElapsedMs / 1000).toFixed(1)} 秒`
                    : '')
                }
              />
            )}
            {cmp.applyResults && cmp.applyResults.some((r) => !r.ok) && (
              <div style={{ marginTop: 8 }}>
                {cmp.applyResults
                  .filter((r) => !r.ok)
                  .map((r, i) => (
                    <div key={i} className="cmp-deploy-error">
                      失败：{r.sql.slice(0, 80)}… — {r.error}
                    </div>
                  ))}
              </div>
            )}
            <div className="cmp-footer">
              {cmp.applyResults ? (
                <>
                  <Button onClick={cmp.closeModal}>关闭</Button>
                  <Button
                    icon={<RedoOutlined />}
                    onClick={doCompare}
                    loading={cmp.comparing}
                    type="primary"
                  >
                    重新比较
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={cmp.closeModal} disabled={cmp.applying}>
                    取消
                  </Button>
                  <Button onClick={cmp.backToDiff} disabled={cmp.applying}>
                    上一步
                  </Button>
                  <Button
                    type="primary"
                    danger={dangerousSelected > 0}
                    loading={cmp.applying}
                    onClick={() => cmp.deploy().catch((e) => message.error(errText(e)))}
                  >
                    开始
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {progressOverlay}
    </Modal>
  )
}
