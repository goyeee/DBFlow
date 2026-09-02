import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Empty,
  Modal,
  Progress,
  Segmented,
  Select,
  Spin,
  Tabs,
  Tooltip,
  message,
} from 'antd'
import {
  ApiOutlined,
  ArrowRightOutlined,
  CaretRightOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  PlusOutlined,
  RedoOutlined,
  SwapOutlined,
  TableOutlined,
} from '@ant-design/icons'
import { useCompareStore, type CompareEndpoint, type CompareStep, type MultiTarget } from '../../stores/compare'
import { useConnectionsStore } from '../../stores/connections'
import { useSessionStore } from '../../stores/session'
import type { ConnectionProfile, DatabaseBrief } from '../../api/types'
import { errText } from '../connection/ConnectionTree'
import { COLOR_PRESETS } from '../connection/colors'
import { DiffTree } from './DiffTree'
import { SqlView } from './SqlView'

/** 对比进度阶段 → 进度条百分比与文案 */
const PHASE_META: Record<string, { percent: number; text: string }> = {
  connect: { percent: 15, text: '正在连接…' },
  fetch_source: { percent: 40, text: '正在获取表（源端）' },
  fetch_target: { percent: 65, text: '正在获取表（目标端）' },
  diff: { percent: 90, text: '正在比对对象' },
}

/** 工具菜单 → 结构同步：选择 → 对比结果 → 部署 */
export function SyncSchemaModal() {
  const cmp = useCompareStore()
  const connections = useConnectionsStore((s) => s.connections)
  const groups = useConnectionsStore((s) => s.groups)
  const connected = useSessionStore((s) => s.connected)
  const connect = useSessionStore((s) => s.connect)

  // 弹窗内可以直接选择所有已保存连接；未连接时自动连接
  const connectionOptions = useMemo(
    () =>
      connections.map((c) => ({
        value: c.id,
        label: (
          <span>
            <ApiOutlined
              style={{ marginRight: 6, color: connected[c.id] ? '#52a86e' : '#999' }}
            />
            {c.name}（{c.host}:{c.port}）
          </span>
        ),
      })),
    [connections, connected],
  )

  /** 选择连接：若尚未建立会话则自动连接，失败时提示并终止 */
  const ensureConnected = async (connectionId: string): Promise<boolean> => {
    if (connected[connectionId]) return true
    return connect(connectionId)
  }

  const findConn = (id: string | null): ConnectionProfile | undefined =>
    connections.find((c) => c.id === id)
  const groupNameOf = (p: ConnectionProfile | undefined): string => {
    if (!p) return '--'
    if (!p.groupId) return '未分组'
    return groups.find((g) => g.id === p.groupId)?.name ?? '未分组'
  }

  /** 根据源库名对目标库做模糊匹配（忽略大小写，互相包含都算） */
  const fuzzyMatchDbs = (sourceDb: string | null, dbs: DatabaseBrief[]) => {
    if (!sourceDb) return []
    const term = sourceDb.toLowerCase()
    return dbs.filter((d) => {
      const name = d.name.toLowerCase()
      return name.includes(term) || term.includes(name)
    })
  }
  const isFuzzyMatch = (sourceDb: string | null, name: string) => {
    if (!sourceDb) return false
    const term = sourceDb.toLowerCase()
    const n = name.toLowerCase()
    return n.includes(term) || term.includes(n)
  }
  /** 把匹配项排在下拉列表前面 */
  const sortedDbs = (sourceDb: string | null, dbs: DatabaseBrief[]) => {
    if (!sourceDb) return dbs
    const matches: DatabaseBrief[] = []
    const others: DatabaseBrief[] = []
    for (const d of dbs) {
      if (isFuzzyMatch(sourceDb, d.name)) matches.push(d)
      else others.push(d)
    }
    return [...matches, ...others]
  }

  const selected = useMemo(
    () => (cmp.report ?? []).filter((i) => cmp.selectedIds.includes(i.id)),
    [cmp.report, cmp.selectedIds],
  )

  const activeItem = useMemo(() => {
    if (!cmp.activeTable) return null
    if (cmp.activeItemId) {
      const item = (cmp.report ?? []).find((i) => i.id === cmp.activeItemId)
      return item && item.id.startsWith('tbl:') ? item : null
    }
    return (cmp.report ?? []).find((i) => i.table === cmp.activeTable) ?? null
  }, [cmp.report, cmp.activeItemId, cmp.activeTable])

  useEffect(() => {
    useCompareStore.getState().syncConnected(Object.keys(connected))
  }, [connected, connections])

  const stepBodyRef = useRef<HTMLDivElement>(null)
  const [bottomHeight, setBottomHeight] = useState(300)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const initializedRef = useRef(false)

  // 目标库自动提示：选择目标连接后，如果目标连接里有与源库同名/相似的数据库，
  // 自动打开下拉框并把匹配项排在前面；有完全同名时自动预选上。
  const [openTargetDb, setOpenTargetDb] = useState(false)
  const [openMultiTargetDbKeys, setOpenMultiTargetDbKeys] = useState<Set<string>>(new Set())
  const triggeredTargetDbRef = useRef(false)
  const triggeredMultiTargetDbRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (
      !cmp.source.database ||
      cmp.target.database ||
      cmp.targetDbs.length === 0 ||
      triggeredTargetDbRef.current
    )
      return
    const matches = fuzzyMatchDbs(cmp.source.database, cmp.targetDbs)
    if (matches.length === 0) return
    triggeredTargetDbRef.current = true
    const exact = matches.find((d) => d.name.toLowerCase() === cmp.source.database!.toLowerCase())
    if (exact) cmp.setTargetDb(exact.name)
    setOpenTargetDb(true)
  }, [cmp.source.database, cmp.target.database, cmp.targetDbs])

  useEffect(() => {
    triggeredTargetDbRef.current = false
  }, [cmp.target.connectionId, cmp.source.database])

  useEffect(() => {
    if (!cmp.source.database) return
    const toOpen = new Set<string>()
    for (const t of cmp.targets) {
      if (!t.connectionId || t.database || t.dbs.length === 0) continue
      if (triggeredMultiTargetDbRef.current.has(t.key)) continue
      const matches = fuzzyMatchDbs(cmp.source.database, t.dbs)
      if (matches.length === 0) continue
      triggeredMultiTargetDbRef.current.add(t.key)
      const exact = matches.find((d) => d.name.toLowerCase() === cmp.source.database!.toLowerCase())
      if (exact) cmp.setTargetDbMulti(t.key, exact.name)
      toOpen.add(t.key)
    }
    if (toOpen.size > 0) {
      setOpenMultiTargetDbKeys((prev) => new Set([...prev, ...toOpen]))
    }
  }, [cmp.source.database, cmp.targets])

  useEffect(() => {
    if (cmp.step === 'diff' && cmp.report && cmp.report.length > 0 && !initializedRef.current) {
      initializedRef.current = true
      const el = stepBodyRef.current
      if (el) {
        const available = el.clientHeight - 88
        // 默认底部 DDL/脚本区占 1/3，给差异树留更多空间
        setBottomHeight(Math.max(120, Math.floor(available / 3)))
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
      const delta = drag.startY - ev.clientY
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

  const singleReady =
    cmp.source.connectionId &&
    cmp.source.database &&
    cmp.target.connectionId &&
    cmp.target.database

  const multiReadyTargets = cmp.targets.filter((t) => t.connectionId && t.database)
  const multiReady =
    cmp.source.connectionId && cmp.source.database && multiReadyTargets.length > 0

  const scopeReady = cmp.scopeAll || cmp.sourceTables.length > 0

  const doCompare = () => {
    const fn = cmp.mode === 'single' ? cmp.runCompare : cmp.runCompareMulti
    fn().catch((e) => message.error(errText(e)))
  }

  const STEP_TITLES: Record<CompareStep, string> = {
    select: '选择数据库',
    diff: '对比结果',
    deploy: '部署',
  }

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

  const summaryHeader =
    cmp.mode === 'single' ? (
      <div className="cmp-summary">
        {summarySide(cmp.source, '#52a86e', true)}
        <ArrowRightOutlined className="cmp-summary-arrow" />
        {summarySide(cmp.target, '#4a90d9', false)}
      </div>
    ) : (
      <div className="cmp-summary">
        {summarySide(cmp.source, '#52a86e', true)}
        <ArrowRightOutlined className="cmp-summary-arrow" />
        <div className="cmp-summary-text">
          <div className="cmp-summary-conn">{multiReadyTargets.length} 个目标</div>
          <div className="cmp-summary-db">
            {multiReadyTargets
              .map((t) => {
                const c = findConn(t.connectionId)
                return c ? `${c.name} / ${t.database}` : t.database
              })
              .join('、') || '--'}
          </div>
        </div>
        <DatabaseOutlined className="cmp-summary-icon" style={{ color: '#4a90d9' }} />
      </div>
    )

  const stepTitle = cmp.step === 'select' && (
    <div className="cmp-step-title">{STEP_TITLES[cmp.step]}</div>
  )

  /** 源端面板：连接 + 数据库 + 同步范围 */
  const sourcePanel = () => {
    const ep = cmp.source
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
        <div className="cmp-pane-title">源</div>
        <div className="cmp-field">
          <div className="cmp-field-label">连接</div>
          <Select
            style={{ width: '100%' }}
            placeholder={connectionOptions.length === 0 ? '请先创建一个连接' : '选择连接'}
            value={ep.connectionId ?? undefined}
            options={connectionOptions}
            onChange={async (v) => {
              const ok = await ensureConnected(v)
              if (!ok) return
              cmp.setSourceConn(v).catch((e) => message.error(errText(e)))
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
            loading={cmp.loadingSourceDbs}
            showSearch
            optionFilterProp="value"
            options={cmp.sourceDbs.map((d) => ({
              value: d.name,
              label: (
                <span>
                  <DatabaseOutlined style={{ marginRight: 6, color: '#4a90d9' }} />
                  {d.name}
                </span>
              ),
            }))}
            onChange={(v) => cmp.setSourceDb(v)}
          />
        </div>
        <div className="cmp-field">
          <div className="cmp-field-label">同步范围</div>
          <Segmented
            block
            value={cmp.scopeAll ? 'all' : 'tables'}
            options={[
              { value: 'all', label: '全部表' },
              { value: 'tables', label: '指定表' },
            ]}
            onChange={(v) => cmp.setScopeAll(v === 'all')}
          />
        </div>
        {!cmp.scopeAll && (
          <div className="cmp-field">
            <Select
              mode="multiple"
              allowClear
              showSearch
              style={{ width: '100%' }}
              placeholder="选择要同步的表"
              disabled={!ep.database}
              loading={cmp.loadingSourceTables}
              value={cmp.sourceTables}
              options={cmp.sourceTableList.map((t) => ({
                value: t.name,
                label: t.name,
              }))}
              onChange={(v) => cmp.setSourceTables(v)}
            />
          </div>
        )}
        <div className="cmp-field">
          <div className="cmp-field-label">对比对象</div>
          <Checkbox checked disabled>
            表
          </Checkbox>
          <Checkbox
            checked={cmp.compareOptions.compareIndexes}
            onChange={(e) => cmp.setCompareOption('compareIndexes', e.target.checked)}
            style={{ marginLeft: 12 }}
          >
            索引
          </Checkbox>
          <Checkbox
            checked={cmp.compareOptions.compareViews}
            onChange={(e) => cmp.setCompareOption('compareViews', e.target.checked)}
            style={{ marginLeft: 12 }}
          >
            视图
          </Checkbox>
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

  /** 单目标面板 */
  const singleTargetPanel = () => {
    const ep = cmp.target
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
        <div className="cmp-pane-title">目标</div>
        <div className="cmp-field">
          <div className="cmp-field-label">连接</div>
          <Select
            style={{ width: '100%' }}
            placeholder={connectionOptions.length === 0 ? '请先创建一个连接' : '选择连接'}
            value={ep.connectionId ?? undefined}
            options={connectionOptions}
            onChange={async (v) => {
              const ok = await ensureConnected(v)
              if (!ok) return
              triggeredTargetDbRef.current = false
              setOpenTargetDb(false)
              cmp.setTargetConn(v).catch((e) => message.error(errText(e)))
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
            loading={cmp.loadingTargetDbs}
            showSearch
            optionFilterProp="value"
            open={openTargetDb}
            onDropdownVisibleChange={(open) => setOpenTargetDb(open)}
            options={sortedDbs(cmp.source.database, cmp.targetDbs).map((d) => ({
              value: d.name,
              label: (
                <span>
                  <DatabaseOutlined style={{ marginRight: 6, color: '#4a90d9' }} />
                  {d.name}
                  {isFuzzyMatch(cmp.source.database, d.name) && (
                    <CheckCircleOutlined style={{ marginLeft: 6, color: '#52c41a' }} />
                  )}
                </span>
              ),
            }))}
            onChange={(v) => cmp.setTargetDb(v)}
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

  /** 多目标列表面板 */
  const multiTargetPanel = () => {
    const targetRow = (t: MultiTarget, index: number) => {
      const profile = findConn(t.connectionId)
      return (
        <div key={t.key} className="cmp-target-row">
          <div className="cmp-target-index">{index + 1}</div>
          <div className="cmp-target-content">
            <div className="cmp-target-fields">
              <Select
                style={{ flex: 1.4 }}
                placeholder="选择连接"
                value={t.connectionId ?? undefined}
                options={connectionOptions}
                onChange={async (v) => {
                  const ok = await ensureConnected(v)
                  if (!ok) return
                  triggeredMultiTargetDbRef.current.delete(t.key)
                  setOpenMultiTargetDbKeys((prev) => {
                    const next = new Set(prev)
                    next.delete(t.key)
                    return next
                  })
                  cmp.setTargetConnMulti(t.key, v).catch((e) => message.error(errText(e)))
                }}
              />
              <Select
                style={{ flex: 1 }}
                placeholder="选择数据库"
                value={t.database ?? undefined}
                disabled={!t.connectionId}
                loading={t.loadingDbs}
                showSearch
                optionFilterProp="value"
                open={openMultiTargetDbKeys.has(t.key)}
                onDropdownVisibleChange={(open) =>
                  setOpenMultiTargetDbKeys((prev) => {
                    const next = new Set(prev)
                    if (open) next.add(t.key)
                    else next.delete(t.key)
                    return next
                  })
                }
                options={sortedDbs(cmp.source.database, t.dbs).map((d: DatabaseBrief) => ({
                  value: d.name,
                  label: (
                    <span>
                      {d.name}
                      {isFuzzyMatch(cmp.source.database, d.name) && (
                        <CheckCircleOutlined style={{ marginLeft: 6, color: '#52c41a' }} />
                      )}
                    </span>
                  ),
                }))}
                onChange={(v) => cmp.setTargetDbMulti(t.key, v)}
              />
              <Tooltip title="删除该目标">
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => cmp.removeTarget(t.key)}
                  disabled={cmp.targets.length <= 1}
                />
              </Tooltip>
            </div>
            {profile && (
              <div className="cmp-target-info">
                {profile.name}（{profile.host}:{profile.port}）
              </div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="cmp-pane cmp-targets-pane">
        <div className="cmp-pane-title">目标列表</div>
        <div className="cmp-targets-list">
          {cmp.targets.map((t, i) => targetRow(t, i))}
        </div>
        <Button
          type="dashed"
          block
          icon={<PlusOutlined />}
          disabled={cmp.targets.length >= 8}
          onClick={cmp.addTarget}
          style={{ marginTop: 8 }}
        >
          添加目标
        </Button>
      </div>
    )
  }

  const rawPhase = cmp.comparePhase ?? 'connect'
  const isMultiPhase = rawPhase.startsWith('target ')
  const phase = isMultiPhase ? undefined : PHASE_META[rawPhase] ?? PHASE_META.connect
  const progressOverlay = cmp.comparing && (
    <div className="cmp-progress-mask">
      <div className="cmp-progress-card">
        <div className="cmp-progress-title">
          <DatabaseOutlined style={{ marginRight: 8 }} />
          正在比较数据库…
        </div>
        <Progress percent={phase?.percent ?? 50} status="active" showInfo={false} />
        <div className="cmp-progress-phase">
          {isMultiPhase ? rawPhase.replace('target ', '目标 ') : phase?.text}
        </div>
        <div style={{ textAlign: 'right' }}>
          <Button size="small" onClick={cmp.cancelCompare}>
            取消
          </Button>
        </div>
      </div>
    </div>
  )

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

  // 多目标模式的结果/部署页目标 Tabs：未选择库的目标不展示，标签显示连接名/库名
  const visibleTargets = cmp.targets.filter((t) => t.database)
  const effectiveActiveKey =
    cmp.activeTargetKey && visibleTargets.some((t) => t.key === cmp.activeTargetKey)
      ? cmp.activeTargetKey
      : visibleTargets[0]?.key
  const effectiveActiveTarget = visibleTargets.find((t) => t.key === effectiveActiveKey)

  const multiTargetTabs =
    cmp.mode === 'multi' && cmp.step !== 'select' ? (
      <Tabs
        activeKey={effectiveActiveKey}
        onChange={(k) => cmp.setActiveTarget(k)}
        size="small"
        className="cmp-target-tabs"
        items={visibleTargets.map((t) => {
          const isActive = t.key === effectiveActiveKey
          const st = cmp.targetStates[t.key]
          const report = isActive ? cmp.report : st?.report
          const selectedIds = isActive ? cmp.selectedIds : st?.selectedIds
          const totalCount = report?.length ?? 0
          const selectedCount =
            report?.filter((i) => selectedIds?.includes(i.id)).length ?? 0
          const hasError = !!st?.error
          const conn = findConn(t.connectionId)
          const color = conn?.color ? (COLOR_PRESETS[conn.color] ?? conn.color) : undefined
          const label = (
            <span className="cmp-target-tab-label">
              {color && (
                <span
                  className="color-dot"
                  style={{ background: color, marginRight: 6, verticalAlign: 'middle' }}
                />
              )}
              {conn ? `${conn.name} / ${t.database}` : t.database}
              {hasError ? (
                <CloseCircleOutlined style={{ color: '#ff4d4f', marginLeft: 4 }} />
              ) : totalCount > 0 ? (
                <Badge
                  count={`${selectedCount}/${totalCount}`}
                  size="small"
                  style={{ marginLeft: 4 }}
                />
              ) : null}
            </span>
          )
          return {
            key: t.key,
            label,
          }
        })}
      />
    ) : null

  const targetErrorAlert =
    cmp.mode === 'multi' && effectiveActiveTarget && cmp.targetStates[effectiveActiveTarget.key]?.error ? (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 8, flex: 'none' }}
        message={cmp.targetStates[effectiveActiveTarget.key]!.error!.message}
      />
    ) : null

  const canRunCompare =
    scopeReady && (cmp.mode === 'single' ? singleReady : multiReady)

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

        {cmp.step === 'select' && (
          <div className="cmp-step-body">
            <div style={{ textAlign: 'center', marginBottom: 10 }}>
              <Segmented
                value={cmp.mode}
                options={[
                  { value: 'single', label: '单目标' },
                  { value: 'multi', label: '多目标' },
                ]}
                onChange={(v) => cmp.setMode(v as 'single' | 'multi')}
              />
            </div>
            <div className={`cmp-panes ${cmp.mode === 'multi' ? 'multi' : ''}`}>
              {sourcePanel()}
              {cmp.mode === 'single' && (
                <div className="cmp-swap">
                  <Button
                    type="text"
                    icon={<SwapOutlined />}
                    onClick={cmp.swap}
                    title="交换源与目标"
                  />
                </div>
              )}
              {cmp.mode === 'single' ? singleTargetPanel() : multiTargetPanel()}
            </div>
            {connectionOptions.length === 0 && (
              <Alert
                style={{ margin: '12px 16px 0' }}
                type="info"
                showIcon
                message="没有可用的连接——请先在左侧新建一个连接"
              />
            )}
            <div className="cmp-footer">
              <Button onClick={cmp.closeModal}>取消</Button>
              <Button
                type="primary"
                icon={<CaretRightOutlined />}
                disabled={!canRunCompare}
                onClick={doCompare}
              >
                比较
              </Button>
            </div>
          </div>
        )}

        {cmp.step === 'diff' && (
          <div className="cmp-step-body" ref={stepBodyRef}>
            {multiTargetTabs}
            {targetErrorAlert}
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

        {cmp.step === 'deploy' && (
          <div className="cmp-step-body">
            {multiTargetTabs}
            {effectiveActiveTarget && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 8, flex: 'none' }}
                message={`当前目标：${effectiveActiveTarget.database} @ ${findConn(effectiveActiveTarget.connectionId)?.name ?? effectiveActiveTarget.connectionId}`}
              />
            )}
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
                    disabled={cmp.applying || selectedSqls.length === 0}
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
