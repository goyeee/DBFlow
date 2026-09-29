import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Empty,
  InputNumber,
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
  CloseCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  PlusOutlined,
  RedoOutlined,
} from '@ant-design/icons'
import {
  emptyDataTargetState,
  selKey,
  useDataCompareStore,
  type DataTarget,
} from '../../stores/dataCompare'
import { useConnectionsStore } from '../../stores/connections'
import { useSessionStore } from '../../stores/session'
import type { DatabaseBrief, RowAction } from '../../api/types'
import { errText } from '../connection/ConnectionTree'
import { COLOR_PRESETS } from '../connection/colors'
import { connFilterOption } from '../connection/connSelectSearch'
import { SqlView } from '../compare/SqlView'
import { SideBySideDiff, TableDiffGrid } from './DiffResultGrids'

/** 部署预览最多直接渲染的语句数（超出折叠为统计） */
const PREVIEW_RENDER_LIMIT = 300

/** 工具菜单 → 数据同步：选择（单目标/多目标切换） → 对比结果 → 部署 */
export function DataSyncModal() {
  const dc = useDataCompareStore()
  // 结果页：是否显示两端一致的表（Navicat「显示相同的表和其他」）
  const [showEqualTables, setShowEqualTables] = useState(false)
  const connections = useConnectionsStore((s) => s.connections)
  const groups = useConnectionsStore((s) => s.groups)
  const connected = useSessionStore((s) => s.connected)
  const connect = useSessionStore((s) => s.connect)

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
  const filterConn = connFilterOption(connections)

  const ensureConnected = async (connectionId: string): Promise<boolean> => {
    if (connected[connectionId]) return true
    return connect(connectionId)
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // WebView 剪贴板 API 不可用时退回 execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    message.success('已复制到剪贴板')
  }

  const findConn = (id: string | null) => connections.find((c) => c.id === id)
  const groupNameOf = (id: string | null): string => {
    const p = findConn(id)
    if (!p) return '--'
    if (!p.groupId) return '未分组'
    return groups.find((g) => g.id === p.groupId)?.name ?? '未分组'
  }

  useEffect(() => {
    useDataCompareStore.getState().syncConnected(Object.keys(connected))
  }, [connected, connections])

  if (!dc.modalOpen) return null

  const activeState =
    (dc.activeTargetKey && dc.targetStates[dc.activeTargetKey]) || emptyDataTargetState()
  const activeTarget = dc.targets.find((t) => t.key === dc.activeTargetKey)

  const readyTargets = dc.targets.filter((t) => t.connectionId && t.database)
  const canRunCompare =
    !!dc.source.connectionId &&
    !!dc.source.database &&
    readyTargets.length > 0 &&
    dc.effectiveTables().length > 0

  const doCompare = () => {
    dc.runCompare().catch((e) => message.error(errText(e)))
  }

  // ───────── 选择页 ─────────

  const sourceProfile = findConn(dc.source.connectionId)
  const keylessNames = new Set(
    dc.tableKeys.filter((k) => !k.keyColumns).map((k) => k.name),
  )

  const sourcePanel = () => {
    const infoRows: [string, string][] = [
      ['分组', groupNameOf(dc.source.connectionId)],
      ['数据库类型', 'MySQL'],
      ['名称', sourceProfile?.name ?? '--'],
      ['主机', sourceProfile?.host ?? '--'],
      ['端口', sourceProfile ? String(sourceProfile.port) : '--'],
      [
        '服务器版本',
        (sourceProfile && connected[sourceProfile.id]?.serverVersion) || '--',
      ],
    ]
    return (
      <div className="cmp-pane">
        <div className="cmp-pane-title">源</div>
        <div className="cmp-field">
          <div className="cmp-field-label">连接</div>
          <Select
            style={{ width: '100%' }}
            placeholder={connectionOptions.length === 0 ? '请先创建一个连接' : '选择连接'}
            value={dc.source.connectionId ?? undefined}
            options={connectionOptions}
            showSearch
            filterOption={filterConn}
            onChange={async (v) => {
              const ok = await ensureConnected(v)
              if (!ok) return
              dc.setSourceConn(v).catch((e) => message.error(errText(e)))
            }}
          />
        </div>
        <div className="cmp-field">
          <div className="cmp-field-label">数据库</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择数据库"
            value={dc.source.database ?? undefined}
            disabled={!dc.source.connectionId}
            loading={dc.loadingSourceDbs}
            showSearch
            optionFilterProp="value"
            options={dc.sourceDbs.map((d) => ({
              value: d.name,
              label: (
                <span>
                  <DatabaseOutlined style={{ marginRight: 6, color: '#4a90d9' }} />
                  {d.name}
                </span>
              ),
            }))}
            onChange={(v) => dc.setSourceDb(v)}
          />
        </div>
        <div className="cmp-field">
          <div className="cmp-field-label">对比范围</div>
          <Segmented
            block
            value={dc.scopeAll ? 'all' : 'tables'}
            options={[
              { value: 'tables', label: '指定表' },
              { value: 'all', label: '全部表' },
            ]}
            onChange={(v) => dc.setScopeAll(v === 'all')}
          />
        </div>
        {!dc.scopeAll && (
          <div className="cmp-field">
            <Select
              mode="multiple"
              allowClear
              showSearch
              style={{ width: '100%' }}
              placeholder="选择要对比的表"
              disabled={!dc.source.database}
              loading={dc.loadingSourceTables}
              value={dc.sourceTables}
              options={dc.sourceTableList.map((t) => ({
                value: t.name,
                label: t.name,
                disabled: keylessNames.has(t.name),
              }))}
              onChange={(v) => dc.setSourceTables(v)}
            />
            {keylessNames.size > 0 && (
              <div className="dcmp-hint">
                {keylessNames.size} 张表无主键/可用唯一索引，不可数据对比（已置灰）
              </div>
            )}
          </div>
        )}
        <div className="cmp-field">
          <div className="cmp-field-label">高级选项</div>
          <div className="dcmp-options">
            <span>分块大小</span>
            <InputNumber
              size="small"
              min={500}
              max={50000}
              step={500}
              value={dc.options.chunkSize}
              onChange={(v) => dc.setOption('chunkSize', v ?? 5000)}
            />
            <span>明细上限/类别</span>
            <InputNumber
              size="small"
              min={100}
              max={100000}
              step={100}
              value={dc.options.maxDetailRows}
              onChange={(v) => dc.setOption('maxDetailRows', v ?? 1000)}
            />
          </div>
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

  const targetRow = (t: DataTarget, index: number) => {
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
              showSearch
              filterOption={filterConn}
              onChange={async (v) => {
                const ok = await ensureConnected(v)
                if (!ok) return
                dc.setTargetConnMulti(t.key, v).catch((e) => message.error(errText(e)))
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
              options={t.dbs.map((d: DatabaseBrief) => ({ value: d.name, label: d.name }))}
              onChange={(v) => dc.setTargetDbMulti(t.key, v)}
            />
            <Tooltip title="删除该目标">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => dc.removeTarget(t.key)}
                disabled={dc.targets.length <= 1}
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

  const targetsPanel = () => (
    <div className="cmp-pane cmp-targets-pane">
      <div className="cmp-pane-title">目标列表</div>
      <div className="cmp-targets-list">{dc.targets.map((t, i) => targetRow(t, i))}</div>
      <Button
        type="dashed"
        block
        icon={<PlusOutlined />}
        disabled={dc.targets.length >= 8}
        onClick={dc.addTarget}
        style={{ marginTop: 8 }}
      >
        添加目标
      </Button>
    </div>
  )

  /** 单目标模式：与结构同步一致的目标面板，绑定 targets[0] */
  const singleTargetPanel = () => {
    const t0 = dc.targets[0]
    if (!t0) return null
    const profile = findConn(t0.connectionId)
    const infoRows: [string, string][] = [
      ['分组', groupNameOf(t0.connectionId)],
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
            value={t0.connectionId ?? undefined}
            options={connectionOptions}
            showSearch
            filterOption={filterConn}
            onChange={async (v) => {
              const ok = await ensureConnected(v)
              if (!ok) return
              dc.setTargetConnMulti(t0.key, v).catch((e) => message.error(errText(e)))
            }}
          />
        </div>
        <div className="cmp-field">
          <div className="cmp-field-label">数据库</div>
          <Select
            style={{ width: '100%' }}
            placeholder="选择数据库"
            value={t0.database ?? undefined}
            disabled={!t0.connectionId}
            loading={t0.loadingDbs}
            showSearch
            optionFilterProp="value"
            options={t0.dbs.map((d: DatabaseBrief) => ({
              value: d.name,
              label: (
                <span>
                  <DatabaseOutlined style={{ marginRight: 6, color: '#4a90d9' }} />
                  {d.name}
                </span>
              ),
            }))}
            onChange={(v) => dc.setTargetDbMulti(t0.key, v)}
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

  // ───────── 结果页 ─────────

  const visibleTargets = dc.targets.filter((t) => t.database)
  const effectiveActiveKey =
    dc.activeTargetKey && visibleTargets.some((t) => t.key === dc.activeTargetKey)
      ? dc.activeTargetKey
      : visibleTargets[0]?.key

  const targetTabs = dc.step !== 'select' && visibleTargets.length > 0 && (
    <Tabs
      activeKey={effectiveActiveKey}
      onChange={(k) => dc.setActiveTarget(k)}
      size="small"
      className="cmp-target-tabs"
      items={visibleTargets.map((t) => {
        const st = dc.targetStates[t.key]
        const diffRows = (st?.tables ?? []).reduce(
          (n, x) => n + x.counts.insert + x.counts.update + x.counts.delete,
          0,
        )
        const conn = findConn(t.connectionId)
        const color = conn?.color ? (COLOR_PRESETS[conn.color] ?? conn.color) : undefined
        return {
          key: t.key,
          label: (
            <span className="cmp-target-tab-label">
              {color && (
                <span
                  className="color-dot"
                  style={{ background: color, marginRight: 6, verticalAlign: 'middle' }}
                />
              )}
              {conn ? `${conn.name} / ${t.database}` : t.database}
              {st?.error ? (
                <CloseCircleOutlined style={{ color: '#ff4d4f', marginLeft: 4 }} />
              ) : diffRows > 0 ? (
                <Badge count={diffRows} size="small" style={{ marginLeft: 4 }} />
              ) : null}
            </span>
          ),
        }
      })}
    />
  )

  const diffTables = activeState.tables
  const activeDetail = activeState.activeTable
    ? activeState.details[activeState.activeTable] ?? null
    : null

  // Navicat 式结果页：上方表级总表 + 下方行级左右对照
  const diffBody = (
    <div className="dcmp-navi-layout">
      <div className="dcmp-grid-toolbar">
        <Checkbox
          checked={showEqualTables}
          onChange={(e) => setShowEqualTables(e.target.checked)}
        >
          显示相同的表
        </Checkbox>
        {activeState.activeTable && (
          <span className="dcmp-msg">当前表：{activeState.activeTable}</span>
        )}
      </div>
      <div className="dcmp-table-grid">
        <TableDiffGrid
          tables={showEqualTables
            ? diffTables
            : diffTables.filter((t) => t.status !== 'equal')}
          selected={activeState.selected}
          uncheckedRows={activeState.uncheckedRows}
          activeTable={activeState.activeTable}
          onSelectTable={(name) => void dc.setActiveTable(name)}
          onToggleAction={(table, action, checked) =>
            dc.setTableChecked(table, [action], checked)
          }
          onToggleTable={(t, checked) =>
            dc.setTableChecked(
              t.table,
              (['insert', 'update', 'delete'] as RowAction[]).filter((a) => t.counts[a] > 0),
              checked,
            )
          }
        />
      </div>
      <SideBySideDiff
        preview={activeDetail}
        loading={activeState.detailLoading}
        filter={activeState.rowFilter}
        onFilterChange={dc.setRowFilter}
        isRowChecked={(action, rowKey) => {
          if (!activeState.activeTable) return false
          const id = selKey(activeState.activeTable, action)
          return (
            activeState.selected.includes(id) &&
            !(activeState.uncheckedRows[id] ?? []).includes(rowKey)
          )
        }}
        onRowChecked={(action, rowKey, checked, siblingKeys) => {
          if (activeState.activeTable) {
            dc.setRowChecked(activeState.activeTable, action, rowKey, checked, siblingKeys)
          }
        }}
        onToggleAllRows={(checked, entries) => {
          if (!activeState.activeTable) return
          // entries 已按当前筛选过滤（组件给出），筛选到某类别时全选不波及其他类别
          dc.setRowsChecked(activeState.activeTable, entries, checked)
        }}
      />
    </div>
  )

  // ───────── 部署页 ─────────

  const preview = activeState.preview ?? []
  const deleteCount = preview.filter((s) => s.action === 'delete').length
  const previewText = preview
    .slice(0, PREVIEW_RENDER_LIMIT)
    .map((s) => s.sql.replace(/;\s*$/, ''))
    .join(';\n\n')

  const deployBody = (
    <>
      {activeTarget && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8, flex: 'none' }}
          message={`当前目标：${activeTarget.database} @ ${findConn(activeTarget.connectionId)?.name ?? activeTarget.connectionId}`}
        />
      )}
      <Alert
        type={deleteCount > 0 ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 8 }}
        message={
          `将执行 ${preview.length} 条语句` +
          (deleteCount > 0
            ? `，其中 ${deleteCount} 条为 DELETE（删除目标端数据，不可恢复）`
            : '')
        }
      />
      {deleteCount > 1000 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message={`⚠️ 将删除超过 1000 条 DELETE 语句（共 ${deleteCount} 条），请确认目标端这些数据确实多余`}
        />
      )}
      <div className="cmp-deploy-list">
        <SqlView
          sql={
            preview.length > PREVIEW_RENDER_LIMIT
              ? `-- 共 ${preview.length} 条语句，仅显示前 ${PREVIEW_RENDER_LIMIT} 条\n\n${previewText}`
              : previewText || null
          }
          emptyText="没有勾选任何差异（返回上一步勾选）"
        />
      </div>
      {activeState.applying && (
        <div style={{ marginTop: 8 }}>
          <Spin size="small" /> 正在按表事务执行 {preview.length} 条语句…
        </div>
      )}
      {activeState.applyResults && (
        <Alert
          style={{ marginTop: 8 }}
          type={activeState.applyResults.every((r) => r.ok) ? 'success' : 'error'}
          showIcon
          message={
            `执行完成：成功 ${activeState.applyResults.filter((r) => r.ok).length} 个表` +
            `，失败 ${activeState.applyResults.filter((r) => !r.ok).length} 个表` +
            (activeState.applyElapsedMs != null
              ? `，耗时 ${(activeState.applyElapsedMs / 1000).toFixed(1)} 秒`
              : '')
          }
        />
      )}
      {activeState.applyResults?.some((r) => !r.ok) && (
        <div style={{ marginTop: 8 }}>
          {activeState.applyResults
            .filter((r) => !r.ok)
            .map((r) => (
              <div key={r.table} className="cmp-deploy-error">
                表 {r.table} 失败（已回滚该表）：{r.error}
              </div>
            ))}
        </div>
      )}
    </>
  )

  const summaryHeader = (
    <div className="cmp-summary">
      <div className="cmp-summary-text right">
        <div className="cmp-summary-conn">{sourceProfile?.name ?? '--'}</div>
        <div className="cmp-summary-db">{dc.source.database ?? '--'}</div>
      </div>
      <DatabaseOutlined className="cmp-summary-icon" style={{ color: '#52a86e' }} />
      <ArrowRightOutlined className="cmp-summary-arrow" />
      <div className="cmp-summary-text">
        <div className="cmp-summary-conn">{readyTargets.length} 个目标</div>
        <div className="cmp-summary-db">
          {readyTargets
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

  const progressOverlay = dc.comparing && (
    <div className="cmp-progress-mask">
      <div className="cmp-progress-card">
        <div className="cmp-progress-title">
          <DatabaseOutlined style={{ marginRight: 8 }} />
          正在比较数据…
        </div>
        <Progress percent={50} status="active" showInfo={false} />
        <div className="cmp-progress-phase">
          {(dc.comparePhase ?? '').replace('target ', '目标 ')}
        </div>
        <div style={{ textAlign: 'right' }}>
          <Button size="small" onClick={dc.cancelCompare}>
            取消
          </Button>
        </div>
      </div>
    </div>
  )

  const anyApply = Object.values(dc.targetStates).some((s) => s.applying)

  return (
    <Modal
      open
      title="数据同步"
      width={1300}
      footer={null}
      onCancel={() => !anyApply && dc.closeModal()}
      maskClosable={false}
      destroyOnHidden
      className="sync-schema-modal"
    >
      <div className="cmp-window" onContextMenu={(e) => e.preventDefault()}>
        <div className="cmp-step-title">
          {dc.step === 'select' ? '选择数据库' : dc.step === 'diff' ? '对比结果' : '部署'}
        </div>
        {summaryHeader}

        {dc.step === 'select' && (
          <div className="cmp-step-body">
            <div style={{ textAlign: 'center', marginBottom: 10 }}>
              <Segmented
                value={dc.mode}
                options={[
                  { value: 'single', label: '单目标' },
                  { value: 'multi', label: '多目标' },
                ]}
                onChange={(v) => dc.setMode(v as 'single' | 'multi')}
              />
            </div>
            <div className={`cmp-panes ${dc.mode === 'multi' ? 'multi' : ''}`}>
              {sourcePanel()}
              {dc.mode === 'single' ? singleTargetPanel() : targetsPanel()}
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
              <Button onClick={dc.closeModal}>取消</Button>
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

        {dc.step === 'diff' && (
          <div className="cmp-step-body">
            {targetTabs}
            {activeState.error && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 8, flex: 'none' }}
                message={
                  <span className="cmp-error-text">{activeState.error.message}</span>
                }
                action={
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => void copyText(activeState.error!.message)}
                  >
                    复制
                  </Button>
                }
              />
            )}
            {!activeState.error && diffTables.length === 0 ? (
              <Empty description="两端数据一致，无需同步" style={{ padding: 60 }} />
            ) : (
              !activeState.error && diffBody
            )}
            <div className="cmp-footer">
              <Button onClick={dc.closeModal}>取消</Button>
              <Button onClick={dc.backToSelect}>上一步</Button>
              <Button icon={<RedoOutlined />} onClick={doCompare} loading={dc.comparing}>
                重新比较
              </Button>
              <Button
                type="primary"
                disabled={dc.comparing || activeState.selected.length === 0}
                onClick={() => dc.gotoDeploy().catch((e) => message.error(errText(e)))}
              >
                下一步 ({activeState.selected.length})
              </Button>
            </div>
          </div>
        )}

        {dc.step === 'deploy' && (
          <div className="cmp-step-body">
            {targetTabs}
            {deployBody}
            <div className="cmp-footer">
              {activeState.applyResults ? (
                <>
                  <Button onClick={dc.closeModal}>关闭</Button>
                  <Button
                    icon={<RedoOutlined />}
                    onClick={doCompare}
                    loading={dc.comparing}
                    type="primary"
                  >
                    重新比较
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={dc.closeModal} disabled={activeState.applying}>
                    取消
                  </Button>
                  <Button onClick={dc.backToDiff} disabled={activeState.applying}>
                    上一步
                  </Button>
                  <Button
                    type="primary"
                    danger={deleteCount > 0}
                    loading={activeState.applying}
                    onClick={() => dc.deploy().catch((e) => message.error(errText(e)))}
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
