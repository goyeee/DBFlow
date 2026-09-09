import { useMemo, useRef } from 'react'
import { Checkbox, Empty, Select, Spin, Table, Tag, Tooltip } from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'
import type { RowAction, RowPreviewFilter, TableDataDiff, TableRowsPreview } from '../../api/types'

const ACTIONS: RowAction[] = ['insert', 'update', 'delete']
const ACTION_TITLE: Record<RowAction, string> = {
  insert: '插入',
  update: '更新',
  delete: '删除',
  equal: '相同',
}

function tableMessage(t: TableDataDiff): string | null {
  if (t.status === 'skipped') return t.skipReason ?? '无法对比'
  if (t.status === 'missingOnTarget') return '目标端缺表，请先执行结构同步'
  if (t.status === 'missingOnSource') return '源端缺表'
  if (t.truncated) return '明细超过上限仅展示部分行，计数为精确值'
  return null
}

/** 可参与勾选的动作（计数 > 0） */
const selectableActions = (t: TableDataDiff): RowAction[] =>
  ACTIONS.filter((a) => t.counts[a] > 0)

// ───────────────────────── 表级总表（Navicat 式） ─────────────────────────

export function TableDiffGrid({
  tables,
  selected,
  activeTable,
  onSelectTable,
  onToggleAction,
  onToggleTable,
}: {
  tables: TableDataDiff[]
  selected: string[]
  activeTable: string | null
  onSelectTable: (table: string) => void
  onToggleAction: (table: string, action: RowAction, checked: boolean) => void
  onToggleTable: (t: TableDataDiff, checked: boolean) => void
}) {
  const comparable = (t: TableDataDiff) => t.status === 'different' || t.status === 'equal'

  // 表头全选：作用于当前展示的全部「有差异」表的可勾选动作
  const allIds = tables.flatMap((t) =>
    t.status === 'different' ? selectableActions(t).map((a) => `${t.table}:${a}`) : [],
  )
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.includes(id))
  const allSome = allIds.some((id) => selected.includes(id))

  const columns = [
    {
      title: (
        <Checkbox
          checked={allChecked}
          indeterminate={!allChecked && allSome}
          disabled={allIds.length === 0}
          onChange={(e) => {
            for (const t of tables) {
              if (t.status !== 'different') continue
              onToggleTable(t, e.target.checked)
            }
          }}
        />
      ),
      key: '__check',
      width: 36,
      render: (_: unknown, t: TableDataDiff) => {
        if (t.status !== 'different') return null
        const ids = selectableActions(t).map((a) => `${t.table}:${a}`)
        const checked = ids.length > 0 && ids.every((id) => selected.includes(id))
        const some = ids.some((id) => selected.includes(id))
        return (
          <Checkbox
            checked={checked}
            indeterminate={!checked && some}
            onChange={(e) => onToggleTable(t, e.target.checked)}
          />
        )
      },
    },
    {
      title: '源表',
      dataIndex: 'table',
      key: 'src',
      render: (name: string, t: TableDataDiff) => (
        <span className={t.status === 'equal' ? 'dcmp-equal-text' : undefined}>
          {t.status === 'missingOnSource' ? '—' : name}
          {t.truncated && (
            <Tooltip title="明细超过上限仅展示部分行，计数为精确值">
              <Tag style={{ marginLeft: 6 }}>截断</Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: '目标表',
      key: 'dst',
      render: (_: unknown, t: TableDataDiff) => (
        <span className={t.status === 'equal' ? 'dcmp-equal-text' : undefined}>
          {t.status === 'missingOnTarget' ? '—' : t.table}
        </span>
      ),
    },
    ...ACTIONS.map((action) => ({
      title: <span className={`dcmp-cat-${action}`}>{ACTION_TITLE[action]}</span>,
      key: action,
      width: 92,
      render: (_: unknown, t: TableDataDiff) => {
        const count = t.counts[action]
        if (t.status !== 'different') return <span className="dcmp-count-zero">0</span>
        if (count === 0) {
          return (
            <Checkbox disabled checked={false}>
              <span className="dcmp-count-zero">0</span>
            </Checkbox>
          )
        }
        const id = `${t.table}:${action}`
        return (
          <Checkbox
            checked={selected.includes(id)}
            onChange={(e) => onToggleAction(t.table, action, e.target.checked)}
            className={`dcmp-cat dcmp-cat-${action}`}
          >
            <span className={action === 'delete' ? 'dcmp-delete-count' : undefined}>
              {count.toLocaleString()}
            </span>
          </Checkbox>
        )
      },
    })),
    {
      title: '相同',
      key: 'equal',
      width: 80,
      render: (_: unknown, t: TableDataDiff) => (
        <span className="dcmp-count-zero">{t.counts.equal.toLocaleString()}</span>
      ),
    },
    {
      title: '消息',
      key: 'msg',
      render: (_: unknown, t: TableDataDiff) => {
        const msg = tableMessage(t)
        return msg ? <span className="dcmp-msg">{msg}</span> : null
      },
    },
  ]

  return (
    <Table<TableDataDiff>
      size="small"
      rowKey="table"
      columns={columns as never}
      dataSource={tables}
      pagination={false}
      onRow={(t) => ({
        onClick: () => {
          if (comparable(t)) onSelectTable(t.table)
        },
        style: comparable(t) ? { cursor: 'pointer' } : undefined,
      })}
      rowClassName={(t) => (t.table === activeTable ? 'dcmp-table-active' : '')}
    />
  )
}

// ───────────────────────── 行级左右对照（Navicat 式） ─────────────────────────

type RowFilter = RowPreviewFilter

const FILTER_ORDER: RowFilter[] = ['all', 'different', 'insert', 'update', 'delete', 'equal']
const FILTER_TITLE: Record<RowFilter, string> = {
  all: '所有行',
  different: '不同',
  ...ACTION_TITLE,
}

interface PaneRow {
  action: RowAction
  /** 行主键串（\u0001 连接），行级勾选用 */
  rowKey: string
  src: string[] | null
  tgt: string[] | null
  changed: boolean[]
}

const rowKeyOf = (key: string[]) => key.join('\u0001')

function buildPaneRows(preview: TableRowsPreview, filter: RowFilter): PaneRow[] {
  const match = (a: RowAction) =>
    filter === 'all' || (filter === 'different' && a !== 'equal') || filter === a
  return preview.rows
    .filter((r) => match(r.action))
    .map((r) => ({
      action: r.action,
      rowKey: rowKeyOf(r.key),
      src: r.source
        ? [...r.source, ...Array(Math.max(0, preview.columns.length - r.source.length)).fill('')]
        : null,
      tgt: r.target
        ? [...r.target, ...Array(Math.max(0, preview.columns.length - r.target.length)).fill('')]
        : null,
      changed: r.changed,
    }))
}

/** 三区滚动同步：左右面板横纵互同步，行勾选窄条只跟随纵向（无横向内容） */
function useSyncedScroll() {
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const checksRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)
  const onScroll = (side: 'left' | 'right' | 'checks') => (e: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current) return
    syncing.current = true
    const src = e.currentTarget
    const otherPane = side === 'left' ? rightRef.current : side === 'right' ? leftRef.current : null
    // 纵向同步到所有区（勾选条 overflow hidden，仅被赋值）；横向只在两面板间同步
    const targets: Array<HTMLDivElement | null> =
      side === 'checks' ? [leftRef.current, rightRef.current] : [checksRef.current, otherPane]
    for (const el of targets) {
      if (!el) continue
      el.scrollTop = src.scrollTop
      if (el === otherPane) el.scrollLeft = src.scrollLeft
    }
    syncing.current = false
  }
  return { leftRef, rightRef, checksRef, onScroll }
}

function CheckStrip({
  rows,
  isRowChecked,
  onRowChecked,
  onToggleAll,
  checksRef,
  onScroll,
}: {
  rows: PaneRow[]
  isRowChecked: (action: RowAction, rowKey: string) => boolean
  onRowChecked: (action: RowAction, rowKey: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  checksRef: React.RefObject<HTMLDivElement | null>
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
}) {
  const syncable = rows.filter((r) => r.action !== 'equal')
  const checkedCount = syncable.filter((r) => isRowChecked(r.action, r.rowKey)).length
  const allChecked = syncable.length > 0 && checkedCount === syncable.length
  const some = checkedCount > 0
  return (
    <div className="dcmp-rowchecks">
      <div className="dcmp-rowchecks-head dcmp-rowchecks-head-check">
        <Checkbox
          checked={allChecked}
          indeterminate={!allChecked && some}
          disabled={syncable.length === 0}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
      </div>
      <div className="dcmp-rowchecks-scroll" ref={checksRef} onScroll={onScroll}>
        <table className="dcmp-check-table">
          {/* 占位表头：与数据面板的列头行等高，保证首行对齐 */}
          <thead>
            <tr>
              <th className="dcmp-check-head-cell" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rowKey} className={`dcmp-row-${r.action}`}>
                <td>
                  <Checkbox
                    disabled={r.action === 'equal'}
                    checked={r.action !== 'equal' && isRowChecked(r.action, r.rowKey)}
                    onChange={(e) => onRowChecked(r.action, r.rowKey, e.target.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PaneTable({
  side,
  tableName,
  columns,
  rows,
  scrollRef,
  onScroll,
}: {
  side: 'src' | 'tgt'
  tableName: string
  columns: string[]
  rows: PaneRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
}) {
  return (
    <section className="dcmp-pane">
      <div className={`dcmp-pane-head dcmp-pane-head-${side}`}>
        <DatabaseOutlined
          style={{ marginRight: 6, color: side === 'src' ? '#52a86e' : '#4a90d9' }}
        />
        {side === 'src' ? '源端' : '目标端'} {tableName}
      </div>
      <div className="dcmp-pane-scroll" ref={scrollRef} onScroll={onScroll}>
        <table className="dcmp-pane-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={`${c}:${i}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${side}:${r.rowKey}`} className={`dcmp-row-${r.action}`}>
                {columns.map((_, i) => {
                  const arr = side === 'src' ? r.src : r.tgt
                  // 缺失侧留白（整行仍有插入/删除的背景色提示）
                  const value = arr?.[i] ?? ''
                  return (
                    <td key={i} className={r.changed[i] ? 'dcmp-cell-changed' : undefined}>
                      {value}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配行" style={{ padding: 24 }} />
        )}
      </div>
    </section>
  )
}

export function SideBySideDiff({
  preview,
  loading,
  filter,
  onFilterChange,
  isRowChecked,
  onRowChecked,
  onToggleAllRows,
}: {
  preview: TableRowsPreview | null
  loading: boolean
  /** 筛选状态在 store 中：部署往返后保留 */
  filter: RowFilter
  onFilterChange: (f: RowFilter) => void
  isRowChecked: (action: RowAction, rowKey: string) => boolean
  onRowChecked: (action: RowAction, rowKey: string, checked: boolean) => void
  /** 勾选条表头全选：作用于当前筛选出的可同步行 */
  onToggleAllRows: (checked: boolean) => void
}) {
  const { leftRef, rightRef, checksRef, onScroll } = useSyncedScroll()

  const rows = useMemo(() => {
    if (!preview) return []
    return buildPaneRows(preview, filter)
  }, [preview, filter])

  const counts = useMemo(() => {
    const base = { all: 0, different: 0, insert: 0, update: 0, delete: 0, equal: 0 }
    if (!preview) return base
    for (const r of preview.rows) {
      base.all++
      if (r.action === 'equal') base.equal++
      else {
        base.different++
        base[r.action]++
      }
    }
    return base
  }, [preview])

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin /> 正在加载行级数据…
      </div>
    )
  }
  if (!preview) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="点击上方表名查看行级对照"
        style={{ paddingTop: 40 }}
      />
    )
  }

  return (
    <div className="dcmp-sbs">
      <div className="dcmp-sbs-toolbar">
        <Select<RowFilter>
          size="small"
          style={{ width: 190 }}
          value={filter}
          onChange={onFilterChange}
          options={FILTER_ORDER.map((f) => ({
            value: f,
            label: `${FILTER_TITLE[f]}（${counts[f].toLocaleString()}）`,
          }))}
        />
        {preview.truncated && (
          <span className="dcmp-msg">
            行数达到预览上限，仅显示前 {preview.rows.length} 行；上方计数为精确值
          </span>
        )}
      </div>
      <div className="dcmp-sbs-panes">
        {/* 行勾选窄条：贴弹窗左侧、与源/目标数据隔开；表头为全选框 */}
        <CheckStrip
          rows={rows}
          isRowChecked={isRowChecked}
          onRowChecked={onRowChecked}
          onToggleAll={onToggleAllRows}
          checksRef={checksRef}
          onScroll={onScroll('checks')}
        />
        <PaneTable
          side="src"
          tableName={preview.table}
          columns={preview.columns}
          rows={rows}
          scrollRef={leftRef}
          onScroll={onScroll('left')}
        />
        <div className="dcmp-sbs-divider" />
        <PaneTable
          side="tgt"
          tableName={preview.table}
          columns={preview.columns}
          rows={rows}
          scrollRef={rightRef}
          onScroll={onScroll('right')}
        />
      </div>
    </div>
  )
}
