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
  uncheckedRows,
  activeTable,
  onSelectTable,
  onToggleAction,
  onToggleTable,
}: {
  tables: TableDataDiff[]
  selected: string[]
  /** 行级排除清单（`表:动作` → 被排除的行 key）：表级勾选框需据此联动显示 */
  uncheckedRows: Record<string, string[]>
  activeTable: string | null
  onSelectTable: (table: string) => void
  onToggleAction: (table: string, action: RowAction, checked: boolean) => void
  onToggleTable: (t: TableDataDiff, checked: boolean) => void
}) {
  const comparable = (t: TableDataDiff) => t.status === 'different' || t.status === 'equal'

  /** 类别勾选态（计入行级排除）：全排除视为未勾选，部分排除为半选 */
  const actionState = (
    t: TableDataDiff,
    a: RowAction,
  ): { checked: boolean; partial: boolean } => {
    const id = `${t.table}:${a}`
    if (!selected.includes(id) || t.counts[a] === 0) return { checked: false, partial: false }
    const excluded = uncheckedRows[id]?.length ?? 0
    if (excluded >= t.counts[a]) return { checked: false, partial: false }
    return { checked: excluded === 0, partial: excluded > 0 }
  }

  // 表头全选：作用于当前展示的全部「有差异」表的可勾选动作
  const allStates = tables.flatMap((t) =>
    t.status === 'different' ? selectableActions(t).map((a) => actionState(t, a)) : [],
  )
  const allChecked = allStates.length > 0 && allStates.every((st) => st.checked)
  const allSome = allStates.some((st) => st.checked || st.partial)

  const columns = [
    {
      title: (
        <Checkbox
          checked={allChecked}
          indeterminate={!allChecked && allSome}
          disabled={allStates.length === 0}
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
        const acts = selectableActions(t)
        const states = acts.map((a) => actionState(t, a))
        const checked = states.length > 0 && states.every((st) => st.checked)
        const some = states.some((st) => st.checked || st.partial)
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
      width: 110,
      render: (_: unknown, t: TableDataDiff) => {
        const total = t.counts[action]
        if (t.status !== 'different') return <span className="dcmp-count-zero">0</span>
        if (total === 0) {
          return (
            <Checkbox disabled checked={false}>
              <span className="dcmp-count-zero">0/0</span>
            </Checkbox>
          )
        }
        const excluded = uncheckedRows[`${t.table}:${action}`]?.length ?? 0
        const checkedCount = Math.max(0, total - excluded)
        const st = actionState(t, action)
        return (
          <Checkbox
            checked={st.checked}
            indeterminate={st.partial}
            onChange={(e) => onToggleAction(t.table, action, e.target.checked)}
            className={`dcmp-cat dcmp-cat-${action}`}
          >
            <span className={action === 'delete' ? 'dcmp-delete-count' : undefined}>
              {checkedCount}/{total}
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
      className="dcmp-grid"
      columns={columns as never}
      dataSource={tables}
      pagination={false}
      onRow={(t) => ({
        onClick: () => {
          if (comparable(t)) onSelectTable(t.table)
        },
        // 行可点击（打开行级预览），但不用手型光标：结果数据区保持箭头指针
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

/** 双面板滚动同步：横纵互同步 */
function useSyncedScroll() {
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)
  const onScroll = (side: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current) return
    syncing.current = true
    const src = e.currentTarget
    const other = side === 'left' ? rightRef.current : leftRef.current
    if (other) {
      other.scrollTop = src.scrollTop
      other.scrollLeft = src.scrollLeft
    }
    syncing.current = false
  }
  return { leftRef, rightRef, onScroll }
}

interface CheckColumnProps {
  syncableCount: number
  allChecked: boolean
  someChecked: boolean
  onToggleAll: (checked: boolean) => void
  isRowChecked: (r: PaneRow) => boolean
  onRowChecked: (r: PaneRow, checked: boolean) => void
}

function PaneTable({
  side,
  tableName,
  columns,
  rows,
  scrollRef,
  onScroll,
  checks,
}: {
  side: 'src' | 'tgt'
  tableName: string
  columns: string[]
  rows: PaneRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
  /** 源端面板首列的行勾选列（sticky，与数据原生同滚，永不错位） */
  checks?: CheckColumnProps
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
              {checks && (
                <th className="dcmp-check-col dcmp-check-col-head">
                  <Checkbox
                    checked={checks.allChecked}
                    indeterminate={!checks.allChecked && checks.someChecked}
                    disabled={checks.syncableCount === 0}
                    onChange={(e) => checks.onToggleAll(e.target.checked)}
                  />
                </th>
              )}
              {columns.map((c, i) => (
                <th key={`${c}:${i}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${side}:${r.rowKey}`} className={`dcmp-row-${r.action}`}>
                {checks && (
                  <td className="dcmp-check-col">
                    <Checkbox
                      disabled={r.action === 'equal'}
                      checked={r.action !== 'equal' && checks.isRowChecked(r)}
                      onChange={(e) => checks.onRowChecked(r, e.target.checked)}
                    />
                  </td>
                )}
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
  /** siblingKeys = 该动作类别的全部行 key（含筛选外），勾选未勾选类别中的一行时需要 */
  onRowChecked: (
    action: RowAction,
    rowKey: string,
    checked: boolean,
    siblingKeys: string[],
  ) => void
  /** 勾选列表头全选：作用于当前筛选出的可同步行（entries 即这些行，组件按当前筛选给出） */
  onToggleAllRows: (
    checked: boolean,
    entries: { action: RowAction; rowKey: string }[],
  ) => void
}) {
  const { leftRef, rightRef, onScroll } = useSyncedScroll()

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

  const syncable = rows.filter((r) => r.action !== 'equal')
  const checkedCount = syncable.filter((r) => isRowChecked(r.action, r.rowKey)).length
  // 每个动作类别的全部行 key（不受筛选影响）：勾选单行时用于排除同类其余行
  const siblingsByAction = useMemo(() => {
    const m = new Map<RowAction, string[]>()
    if (preview) {
      for (const r of preview.rows) {
        if (r.action === 'equal') continue
        const arr = m.get(r.action)
        if (arr) arr.push(rowKeyOf(r.key))
        else m.set(r.action, [rowKeyOf(r.key)])
      }
    }
    return m
  }, [preview])
  const checkColumn: CheckColumnProps = {
    syncableCount: syncable.length,
    allChecked: syncable.length > 0 && checkedCount === syncable.length,
    someChecked: checkedCount > 0,
    // 全选只作用于当前筛选出的行：筛选到"插入"时点全选不得连带勾上更新/删除的行
    onToggleAll: (checked) =>
      onToggleAllRows(
        checked,
        syncable.map((r) => ({ action: r.action, rowKey: r.rowKey })),
      ),
    isRowChecked: (r) => isRowChecked(r.action, r.rowKey),
    onRowChecked: (r, checked) =>
      onRowChecked(r.action, r.rowKey, checked, siblingsByAction.get(r.action) ?? []),
  }

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
        <PaneTable
          side="src"
          tableName={preview.table}
          columns={preview.columns}
          rows={rows}
          scrollRef={leftRef}
          onScroll={onScroll('left')}
          checks={checkColumn}
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
