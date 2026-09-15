import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataTargetReport, TableDataDiff } from '../api/types'

// store 依赖 api/commands（内部引 @tauri-apps/api），测试环境整体打桩
vi.mock('../api/commands', () => ({
  api: {
    listDatabases: vi.fn(async () => [{ name: 'db1' }, { name: 'db2' }]),
    listTables: vi.fn(async () => [{ name: 't1' }]),
    listTableKeys: vi.fn(async () => [{ name: 't1', keyColumns: ['id'] }]),
    compareDataMulti: vi.fn(),
    getTableDiffDetail: vi.fn(),
    getTableRowsPreview: vi.fn(),
    previewDataSync: vi.fn(),
    applyDataSync: vi.fn(),
    onDataCompareProgress: vi.fn(async () => () => {}),
  },
}))

import { api } from '../api/commands'
import {
  emptyDataTargetState,
  toSelections,
  useDataCompareStore,
} from './dataCompare'

const mockCompare = vi.mocked(api.compareDataMulti)
const mockPreviewRows = vi.mocked(api.getTableRowsPreview)
const mockPreview = vi.mocked(api.previewDataSync)
const mockApply = vi.mocked(api.applyDataSync)

const initialState = useDataCompareStore.getState()

beforeEach(() => {
  useDataCompareStore.setState(initialState, true)
  mockCompare.mockReset()
  mockPreviewRows.mockReset()
  mockPreview.mockReset()
  mockApply.mockReset()
})

function tableDiff(table: string, insert = 0, update = 0, del = 0): TableDataDiff {
  return {
    table,
    status: insert + update + del > 0 ? 'different' : 'equal',
    keyColumns: ['id'],
    columns: ['id', 'name'],
    counts: { insert, update, delete: del, equal: 0 },
    truncated: false,
    rows: [],
  }
}

function report(key: string, tables: TableDataDiff[]): DataTargetReport {
  return { reportId: `rid-${key}`, key, connectionId: `c-${key}`, database: 'db2', tables, error: null }
}

/** 进入"已打开弹窗、选好源与两个目标"的状态 */
function openMulti() {
  useDataCompareStore.setState({
    modalOpen: true,
    source: { connectionId: 'c1', database: 'db1' },
    targets: [
      { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
      { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [], loadingDbs: false },
    ],
    activeTargetKey: 'k1',
    scopeAll: false,
    sourceTables: ['t1'],
  })
}

describe('数据对比勾选逻辑', () => {
  it('toSelections 解析 table:action（表名含冒号也安全）', () => {
    expect(toSelections(['my:table:delete', 't1:insert'])).toEqual([
      { table: 'my:table', action: 'delete' },
      { table: 't1', action: 'insert' },
    ])
  })
})

describe('数据同步弹窗状态机', () => {
  it('对比结果按目标分发，默认全不选，激活第一个目标进入结果页', async () => {
    openMulti()
    mockCompare.mockResolvedValue([
      report('k1', [tableDiff('t1', 2, 1)]),
      report('k2', [tableDiff('t1', 0, 0, 7)]),
    ])
    await useDataCompareStore.getState().runCompare()

    const s = useDataCompareStore.getState()
    expect(s.step).toBe('diff')
    expect(s.activeTargetKey).toBe('k1')
    expect(s.targetStates.k1.tables[0].counts.insert).toBe(2)
    // 默认全不选，由用户自行勾选要同步的数据
    expect(s.targetStates.k1.selected).toEqual([])
    expect(s.targetStates.k2.selected).toEqual([])
    expect(mockCompare).toHaveBeenCalledWith(
      'c1', 'db1', ['t1'],
      [
        { key: 'k1', connectionId: 'c2', database: 'db2' },
        { key: 'k2', connectionId: 'c3', database: 'db3' },
      ],
      expect.anything(),
    )
  })

  it('目标失败不阻塞其他目标，错误写入该目标状态', async () => {
    openMulti()
    mockCompare.mockResolvedValue([
      { reportId: '', key: 'k1', connectionId: 'c2', database: 'db2', tables: [], error: { code: 'db', message: '连接失败' } },
      report('k2', [tableDiff('t1', 1)]),
    ])
    await useDataCompareStore.getState().runCompare()
    const s = useDataCompareStore.getState()
    expect(s.targetStates.k1.error?.message).toBe('连接失败')
    expect(s.targetStates.k2.tables).toHaveLength(1)
  })

  it('行级预览按需拉取并缓存，重复点击不重复请求', async () => {
    openMulti()
    mockCompare.mockResolvedValue([report('k1', [tableDiff('t1', 1)]), report('k2', [])])
    await useDataCompareStore.getState().runCompare()

    mockPreviewRows.mockResolvedValue({
      table: 't1',
      columns: ['id', 'name'],
      keyColumns: ['id'],
      truncated: false,
      rows: [
        { action: 'insert', key: ['1'], source: ['1', 'a'], target: null, changed: [] },
        { action: 'equal', key: ['2'], source: ['2', 'b'], target: ['2', 'b'], changed: [false, false] },
      ],
    })
    await useDataCompareStore.getState().setActiveTable('t1')
    let st = useDataCompareStore.getState().targetStates.k1
    expect(st.details.t1.rows).toHaveLength(2)
    expect(mockPreviewRows).toHaveBeenCalledWith('rid-k1', 't1', 20000)

    await useDataCompareStore.getState().setActiveTable('t1')
    expect(mockPreviewRows).toHaveBeenCalledTimes(1)
    st = useDataCompareStore.getState().targetStates.k1
    expect(st.activeTable).toBe('t1')
  })

  it('行级勾选：取消勾选记入 uncheckedRows，勾回则移除；部署时透传 excludeKeys', async () => {
    openMulti()
    mockCompare.mockResolvedValue([report('k1', [tableDiff('t1', 2, 1)])])
    await useDataCompareStore.getState().runCompare()

    const dc = useDataCompareStore.getState()
    // 默认全不选 → 显式勾上 insert + update 两类再验证行级排除
    dc.setTableChecked('t1', ['insert', 'update'], true)
    // insert 默认全勾 → 取消一行
    dc.setRowChecked('t1', 'insert', '5', false)
    let st = useDataCompareStore.getState().targetStates.k1
    expect(st.selected).toContain('t1:insert')
    expect(st.uncheckedRows['t1:insert']).toEqual(['5'])

    // 勾回
    dc.setRowChecked('t1', 'insert', '5', true)
    st = useDataCompareStore.getState().targetStates.k1
    expect(st.uncheckedRows['t1:insert']).toEqual([])

    // 再取消一行后部署，excludeKeys 应带上
    dc.setRowChecked('t1', 'insert', '7', false)
    mockPreview.mockResolvedValue([])
    await useDataCompareStore.getState().gotoDeploy()
    expect(mockPreview).toHaveBeenCalledWith('rid-k1', [
      { table: 't1', action: 'insert', excludeKeys: [['7']] },
      { table: 't1', action: 'update' },
    ])
  })

  it('setRowsChecked 批量取消/勾选：部署透传全部 excludeKeys', async () => {
    openMulti()
    mockCompare.mockResolvedValue([report('k1', [tableDiff('t1', 3)])])
    await useDataCompareStore.getState().runCompare()
    const dc = useDataCompareStore.getState()
    dc.setTableChecked('t1', ['insert'], true)

    dc.setRowsChecked(
      't1',
      [
        { action: 'insert', rowKey: '1' },
        { action: 'insert', rowKey: '2' },
        { action: 'insert', rowKey: '3' },
      ],
      false,
    )
    let st = useDataCompareStore.getState().targetStates.k1
    expect(st.uncheckedRows['t1:insert']).toEqual(['1', '2', '3'])

    dc.setRowsChecked('t1', [{ action: 'insert', rowKey: '2' }], true)
    st = useDataCompareStore.getState().targetStates.k1
    expect(st.uncheckedRows['t1:insert']).toEqual(['1', '3'])

    mockPreview.mockResolvedValue([])
    await useDataCompareStore.getState().gotoDeploy()
    expect(mockPreview).toHaveBeenCalledWith('rid-k1', [
      { table: 't1', action: 'insert', excludeKeys: [['1'], ['3']] },
    ])
  })

  it('整类勾上会清空该类别的行级排除', async () => {
    openMulti()
    mockCompare.mockResolvedValue([report('k1', [tableDiff('t1', 2)])])
    await useDataCompareStore.getState().runCompare()
    const dc = useDataCompareStore.getState()
    dc.setTableChecked('t1', ['insert'], true)
    dc.setRowChecked('t1', 'insert', '5', false)
    expect(useDataCompareStore.getState().targetStates.k1.uncheckedRows['t1:insert']).toEqual(['5'])

    dc.setTableChecked('t1', ['insert'], true)
    const st = useDataCompareStore.getState().targetStates.k1
    expect(st.selected).toContain('t1:insert')
    expect(st.uncheckedRows['t1:insert']).toBeUndefined()
  })

  it('勾选未勾选类别中的一行：只选该行，其余同类行进排除清单', async () => {
    openMulti()
    mockCompare.mockResolvedValue([report('k1', [tableDiff('t1', 3, 1)])])
    await useDataCompareStore.getState().runCompare()
    const dc = useDataCompareStore.getState()

    // 模拟用户在上方取消 insert 整类（delete 默认未勾）
    dc.setTableChecked('t1', ['insert'], false)
    expect(useDataCompareStore.getState().targetStates.k1.selected).not.toContain('t1:insert')

    // 勾选 insert 类别中的一行：只选这一行，其余行被排除
    dc.setRowChecked('t1', 'insert', '5', true, ['5', '6', '7'])
    const st = useDataCompareStore.getState().targetStates.k1
    expect(st.selected).toContain('t1:insert')
    expect(st.uncheckedRows['t1:insert']).toEqual(['6', '7'])

    // 部署预览应带上排除清单
    mockPreview.mockResolvedValue([])
    await useDataCompareStore.getState().gotoDeploy()
    expect(mockPreview).toHaveBeenCalledWith(
      'rid-k1',
      expect.arrayContaining([
        { table: 't1', action: 'insert', excludeKeys: [['6'], ['7']] },
      ]),
    )
  })

  it('部署：预览 → 执行，结果写入当前目标', async () => {
    openMulti()
    mockCompare.mockResolvedValue([report('k1', [tableDiff('t1', 2)]), report('k2', [])])
    await useDataCompareStore.getState().runCompare()
    // 默认全不选 → 用户自行勾选后再进入部署
    useDataCompareStore.getState().setTableChecked('t1', ['insert'], true)

    const statements = [{ table: 't1', action: 'insert' as const, sql: 'INSERT ...' }]
    mockPreview.mockResolvedValue(statements)
    await useDataCompareStore.getState().gotoDeploy()
    expect(useDataCompareStore.getState().step).toBe('deploy')
    expect(mockPreview).toHaveBeenCalledWith('rid-k1', [{ table: 't1', action: 'insert' }])

    mockApply.mockResolvedValue([{ table: 't1', ok: true, appliedCount: 1, error: null }])
    await useDataCompareStore.getState().deploy()
    const st = useDataCompareStore.getState().targetStates.k1
    expect(st.applyResults?.[0].ok).toBe(true)
    expect(mockApply).toHaveBeenCalledWith('c2', statements)
  })

  it('取消后迟到的对比结果被丢弃（runSeq 过期）', async () => {
    openMulti()
    let resolve!: (v: DataTargetReport[]) => void
    mockCompare.mockReturnValue(new Promise((r) => (resolve = r)))
    const p = useDataCompareStore.getState().runCompare()
    useDataCompareStore.getState().cancelCompare()
    resolve([report('k1', [tableDiff('t1', 1)])])
    await p
    const s = useDataCompareStore.getState()
    expect(s.step).toBe('select')
    expect(Object.keys(s.targetStates)).toHaveLength(0)
  })
})

describe('单/多目标模式切换', () => {
  it('默认单目标模式', () => {
    expect(useDataCompareStore.getState().mode).toBe('single')
  })

  it('openModal 保证至少有一个目标行', () => {
    useDataCompareStore.getState().openModal()
    const s = useDataCompareStore.getState()
    expect(s.targets).toHaveLength(1)
    expect(s.activeTargetKey).toBe(s.targets[0].key)
  })

  it('单 → 多：现有目标成为第一行，可继续添加', () => {
    useDataCompareStore.setState({
      mode: 'single',
      targets: [{ key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false }],
      activeTargetKey: 'k1',
    })
    useDataCompareStore.getState().setMode('multi')
    const s = useDataCompareStore.getState()
    expect(s.mode).toBe('multi')
    expect(s.targets.map((t) => t.key)).toEqual(['k1'])
    expect(s.activeTargetKey).toBe('k1')
    s.addTarget()
    expect(useDataCompareStore.getState().targets).toHaveLength(2)
  })

  it('多 → 单：只保留激活目标的端点', () => {
    openMulti() // k1/k2 两个目标，激活 k1
    useDataCompareStore.setState({ mode: 'multi' })
    useDataCompareStore.getState().setMode('single')
    const s = useDataCompareStore.getState()
    expect(s.mode).toBe('single')
    expect(s.targets.map((t) => t.key)).toEqual(['k1'])
    expect(s.targets[0].connectionId).toBe('c2')
    expect(s.targets[0].database).toBe('db2')
    expect(s.activeTargetKey).toBe('k1')
  })

  it('多 → 单时保留激活目标（而非第一个）', () => {
    openMulti()
    useDataCompareStore.setState({ mode: 'multi', activeTargetKey: 'k2' })
    useDataCompareStore.getState().setMode('single')
    const s = useDataCompareStore.getState()
    expect(s.targets.map((t) => t.key)).toEqual(['k2'])
    expect(s.targets[0].database).toBe('db3')
  })

  it('同模式切换是无操作，不清状态', () => {
    openMulti()
    useDataCompareStore.setState({ mode: 'multi', targetStates: { k1: emptyDataTargetState() } })
    useDataCompareStore.getState().setMode('multi')
    const s = useDataCompareStore.getState()
    expect(s.mode).toBe('multi')
    expect(s.targets).toHaveLength(2)
    expect(s.targetStates.k1).toBeDefined()
  })

  it('单 → 多时目标列表为空则补一行', () => {
    useDataCompareStore.setState({ mode: 'single', targets: [], activeTargetKey: null })
    useDataCompareStore.getState().setMode('multi')
    const s = useDataCompareStore.getState()
    expect(s.mode).toBe('multi')
    expect(s.targets).toHaveLength(1)
    expect(s.activeTargetKey).toBe(s.targets[0].key)
  })
})
