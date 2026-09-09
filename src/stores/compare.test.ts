import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffItem } from '../api/types'

// store 依赖 api/commands（内部引 @tauri-apps/api），测试环境整体打桩
vi.mock('../api/commands', () => ({
  api: {
    listDatabases: vi.fn(async () => [{ name: 'db1' }, { name: 'db2' }]),
    listTables: vi.fn(async () => [{ name: 't1' }, { name: 't2' }]),
    compareSchema: vi.fn(),
    compareSchemaMulti: vi.fn(),
    applySync: vi.fn(),
    onCompareProgress: vi.fn(async () => () => {}),
    onCompareMultiProgress: vi.fn(async () => () => {}),
  },
}))

import { api } from '../api/commands'
import { buildDeployStatements, buildDiffTree, collectItemIds, emptyTargetState, groupByAction, useCompareStore } from './compare'

const mockCompare = vi.mocked(api.compareSchema)
const mockCompareMulti = vi.mocked(api.compareSchemaMulti)
const mockApply = vi.mocked(api.applySync)

const initialState = useCompareStore.getState()

beforeEach(() => {
  useCompareStore.setState(initialState, true)
  mockCompare.mockReset()
  mockCompareMulti.mockReset()
  mockApply.mockReset()
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function item(id: string, action: DiffItem['action'], dangerous = false): DiffItem {
  return {
    id,
    kind: 'column',
    action,
    table: 't1',
    name: id,
    sourceDesc: null,
    targetDesc: null,
    sql: `-- ${id}`,
    dangerous,
    sourceDdl: null,
    targetDdl: null,
  }
}

/** 进入"已打开弹窗、选好两端"的状态 */
function openWithEndpoints() {
  useCompareStore.setState({
    modalOpen: true,
    source: { connectionId: 'c1', database: 'db1' },
    target: { connectionId: 'c2', database: 'db2' },
  })
}

describe('结构同步弹窗状态机', () => {
  it('对比到"结构一致"后取消，再打开应回到选择页（用户反馈的回归）', async () => {
    openWithEndpoints()
    mockCompare.mockResolvedValue([])
    await useCompareStore.getState().runCompare()
    expect(useCompareStore.getState().step).toBe('diff')
    expect(useCompareStore.getState().report).toEqual([])

    useCompareStore.getState().closeModal()
    expect(useCompareStore.getState().modalOpen).toBe(false)
    expect(useCompareStore.getState().step).toBe('select')
    expect(useCompareStore.getState().report).toBeNull()

    useCompareStore.getState().openModal()
    expect(useCompareStore.getState().step).toBe('select')
    // 端点选择保留，不必重选
    expect(useCompareStore.getState().source.connectionId).toBe('c1')
  })

  it('对比进行中关闭弹窗，迟到的响应不得把弹窗状态顶回结果页', async () => {
    openWithEndpoints()
    const d = deferred<DiffItem[]>()
    mockCompare.mockReturnValue(d.promise)
    const p = useCompareStore.getState().runCompare()
    expect(useCompareStore.getState().comparing).toBe(true)

    useCompareStore.getState().closeModal()
    d.resolve([])
    await p

    const s = useCompareStore.getState()
    expect(s.step).toBe('select')
    expect(s.report).toBeNull()
    expect(s.comparing).toBe(false)
  })

  it('对比进行中改端点，旧响应作废', async () => {
    openWithEndpoints()
    const d = deferred<DiffItem[]>()
    mockCompare.mockReturnValue(d.promise)
    const p = useCompareStore.getState().runCompare()

    useCompareStore.getState().setTargetDb('dbX')
    d.resolve([item('a', 'create')])
    await p

    const s = useCompareStore.getState()
    expect(s.step).toBe('select')
    expect(s.report).toBeNull()
  })

  it('部署执行中禁止关闭弹窗', () => {
    useCompareStore.setState({ modalOpen: true, step: 'deploy', applying: true })
    useCompareStore.getState().closeModal()
    expect(useCompareStore.getState().modalOpen).toBe(true)
    expect(useCompareStore.getState().step).toBe('deploy')
  })

  it('执行中禁止回退到上一步', () => {
    useCompareStore.setState({ modalOpen: true, step: 'deploy', applying: true })
    useCompareStore.getState().backToDiff()
    useCompareStore.getState().backToSelect()
    expect(useCompareStore.getState().step).toBe('deploy')
  })

  it('结果页可返回选择页（上一步），端点与报告保留', async () => {
    openWithEndpoints()
    mockCompare.mockResolvedValue([item('a', 'create')])
    await useCompareStore.getState().runCompare()
    expect(useCompareStore.getState().step).toBe('diff')

    useCompareStore.getState().backToSelect()
    const s = useCompareStore.getState()
    expect(s.step).toBe('select')
    expect(s.source.database).toBe('db1')
    expect(s.report).toHaveLength(1)
  })

  it('连接断开后清空引用它的端点选择', () => {
    openWithEndpoints()
    useCompareStore.getState().syncConnected(['c2'])
    const s = useCompareStore.getState()
    expect(s.source.connectionId).toBeNull()
    expect(s.sourceDbs).toEqual([])
    expect(s.target.connectionId).toBe('c2')

    // 两端都在 → 不动
    useCompareStore.getState().syncConnected(['c2'])
    expect(useCompareStore.getState().target.connectionId).toBe('c2')
  })

  it('对比结果默认勾选非危险项，DROP 类不勾', async () => {
    openWithEndpoints()
    mockCompare.mockResolvedValue([item('a', 'create'), item('b', 'drop', true)])
    await useCompareStore.getState().runCompare()
    expect(useCompareStore.getState().selectedIds).toEqual(['a'])
  })

  it('空选择不能进入部署页', async () => {
    openWithEndpoints()
    mockCompare.mockResolvedValue([item('b', 'drop', true)])
    await useCompareStore.getState().runCompare()
    // 唯一的项是危险项，默认不勾 → 空选择
    useCompareStore.getState().gotoDeploy()
    expect(useCompareStore.getState().step).toBe('diff')

    useCompareStore.getState().toggle('b')
    useCompareStore.getState().gotoDeploy()
    expect(useCompareStore.getState().step).toBe('deploy')
  })

  it('部署成功后记录结果与耗时', async () => {
    openWithEndpoints()
    useCompareStore.setState({
      step: 'deploy',
      report: [item('a', 'create'), item('b', 'drop', true)],
      selectedIds: ['a', 'b'],
    })
    mockApply.mockResolvedValue([
      { sql: '-- a', ok: true, error: null },
      { sql: '-- b', ok: false, error: 'boom' },
    ])
    await useCompareStore.getState().deploy()
    const s = useCompareStore.getState()
    expect(mockApply).toHaveBeenCalledWith('c2', ['-- a', '-- b'])
    expect(s.applyResults).toHaveLength(2)
    expect(s.applyElapsedMs).not.toBeNull()
    expect(s.applying).toBe(false)
  })

  it('setCompareOption 更新对比对象选项', () => {
    useCompareStore.getState().setCompareOption('compareIndexes', false)
    useCompareStore.getState().setCompareOption('compareViews', true)
    expect(useCompareStore.getState().compareOptions).toEqual({
      compareIndexes: false,
      compareViews: true,
    })
  })

  it('runCompare 把对比选项传给后端', async () => {
    openWithEndpoints()
    useCompareStore.setState({
      compareOptions: { compareIndexes: false, compareViews: true },
    })
    mockCompare.mockResolvedValue([])
    await useCompareStore.getState().runCompare()
    expect(mockCompare).toHaveBeenCalledWith(
      'c1',
      'db1',
      'c2',
      'db2',
      undefined,
      { compareIndexes: false, compareViews: true },
    )
  })

  it('groupByAction 按 修改/创建/删除 分组', () => {
    const g = groupByAction([item('m', 'modify'), item('c', 'create'), item('d', 'drop', true)])
    expect(g.modify.map((i) => i.id)).toEqual(['m'])
    expect(g.create.map((i) => i.id)).toEqual(['c'])
    expect(g.drop.map((i) => i.id)).toEqual(['d'])
  })

  it('进度层取消：放弃等待，迟到的响应不得落地', async () => {
    openWithEndpoints()
    const d = deferred<DiffItem[]>()
    mockCompare.mockReturnValue(d.promise)
    const p = useCompareStore.getState().runCompare()
    expect(useCompareStore.getState().comparing).toBe(true)

    useCompareStore.getState().cancelCompare()
    expect(useCompareStore.getState().comparing).toBe(false)
    d.resolve([item('a', 'create')])
    await p

    const s = useCompareStore.getState()
    expect(s.step).toBe('select')
    expect(s.report).toBeNull()
  })

  it('对比成功后默认不高亮任何行，reportId 递增', async () => {
    openWithEndpoints()
    mockCompare.mockResolvedValue([item('a', 'create'), item('b', 'modify')])
    const before = useCompareStore.getState().reportId
    await useCompareStore.getState().runCompare()
    const s = useCompareStore.getState()
    expect(s.activeItemId).toBeNull()
    expect(s.reportId).toBe(before + 1)
  })

  it('setItemsChecked 批量勾选/取消（树表级联用）', () => {
    useCompareStore.setState({ selectedIds: ['a'] })
    useCompareStore.getState().setItemsChecked(['b', 'c'], true)
    expect(useCompareStore.getState().selectedIds).toEqual(['a', 'b', 'c'])
    useCompareStore.getState().setItemsChecked(['a', 'b'], false)
    expect(useCompareStore.getState().selectedIds).toEqual(['c'])
    // 重复勾选不重复添加
    useCompareStore.getState().setItemsChecked(['c'], true)
    expect(useCompareStore.getState().selectedIds).toEqual(['c'])
  })
})

/** 树构建专用工厂：可控 kind/table/name/id */
function ditem(
  id: string,
  kind: DiffItem['kind'],
  action: DiffItem['action'],
  table: string,
  name: string,
  dangerous = false,
): DiffItem {
  return {
    id,
    kind,
    action,
    table,
    name,
    sourceDesc: null,
    targetDesc: null,
    sql: `-- ${id}`,
    dangerous,
    sourceDdl: null,
    targetDdl: null,
  }
}

describe('多目标结构同步', () => {
  it('单目标 → 多目标：把当前目标端点转为第一个目标', () => {
    useCompareStore.setState({
      modalOpen: true,
      source: { connectionId: 'c1', database: 'db1' },
      target: { connectionId: 'c2', database: 'db2' },
      targetDbs: [{ name: 'db2' }],
    })
    useCompareStore.getState().setMode('multi')
    const s = useCompareStore.getState()
    expect(s.mode).toBe('multi')
    expect(s.targets).toHaveLength(1)
    expect(s.targets[0].connectionId).toBe('c2')
    expect(s.targets[0].database).toBe('db2')
    expect(s.activeTargetKey).toBe(s.targets[0].key)
    expect(s.target).toEqual({ connectionId: null, database: null })
  })

  it('多目标 → 单目标：把激活目标端点转回单目标', () => {
    useCompareStore.setState({
      modalOpen: true,
      mode: 'multi',
      source: { connectionId: 'c1', database: 'db1' },
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [{ name: 'db2' }], loadingDbs: false },
        { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [{ name: 'db3' }], loadingDbs: false },
      ],
      activeTargetKey: 'k2',
    })
    useCompareStore.getState().setMode('single')
    const s = useCompareStore.getState()
    expect(s.mode).toBe('single')
    expect(s.target).toEqual({ connectionId: 'c3', database: 'db3' })
    expect(s.targets).toHaveLength(0)
  })

  it('添加/删除目标', () => {
    useCompareStore.setState({ mode: 'multi' })
    useCompareStore.getState().addTarget()
    useCompareStore.getState().addTarget()
    expect(useCompareStore.getState().targets).toHaveLength(2)
    const key = useCompareStore.getState().targets[0].key
    useCompareStore.getState().removeTarget(key)
    expect(useCompareStore.getState().targets).toHaveLength(1)
  })

  it('runCompareMulti 把结果分发到各目标并加载第一个目标', async () => {
    useCompareStore.setState({
      modalOpen: true,
      mode: 'multi',
      source: { connectionId: 'c1', database: 'db1' },
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
        { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [], loadingDbs: false },
      ],
      activeTargetKey: 'k1',
    })
    mockCompareMulti.mockResolvedValue([
      { key: 'k1', connectionId: 'c2', database: 'db2', items: [item('a', 'create')], error: null },
      { key: 'k2', connectionId: 'c3', database: 'db3', items: [item('b', 'drop', true)], error: null },
    ])
    await useCompareStore.getState().runCompareMulti()
    const s = useCompareStore.getState()
    expect(s.step).toBe('diff')
    expect(s.targetStates['k1'].report).toHaveLength(1)
    expect(s.targetStates['k2'].report).toHaveLength(1)
    expect(s.report).toEqual(s.targetStates['k1'].report)
    expect(mockCompareMulti).toHaveBeenCalledWith(
      'c1',
      'db1',
      null,
      [
        { key: 'k1', connectionId: 'c2', database: 'db2' },
        { key: 'k2', connectionId: 'c3', database: 'db3' },
      ],
      { compareIndexes: true, compareViews: false },
    )
  })

  it('切换激活目标时状态隔离', () => {
    const k1State = { ...emptyTargetState(), selectedIds: ['a'], report: [item('a', 'create')] }
    const k2State = { ...emptyTargetState(), selectedIds: ['b'], report: [item('b', 'modify')] }
    useCompareStore.setState({
      mode: 'multi',
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
        { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [], loadingDbs: false },
      ],
      activeTargetKey: 'k1',
      targetStates: { k1: k1State, k2: k2State },
      ...k1State,
    })
    useCompareStore.getState().setActiveTarget('k2')
    const s = useCompareStore.getState()
    expect(s.selectedIds).toEqual(['b'])
    expect(s.report?.[0].id).toBe('b')
    // 切回 k1 应恢复
    useCompareStore.getState().setActiveTarget('k1')
    expect(useCompareStore.getState().selectedIds).toEqual(['a'])
  })

  it('切换激活目标时树的展开状态各自保留', () => {
    const k1State = {
      ...emptyTargetState(),
      report: [item('a', 'modify')],
      expandedKeys: ['grp:modify', 'tbn:modify:t1'],
    }
    const k2State = {
      ...emptyTargetState(),
      report: [item('b', 'modify')],
      expandedKeys: ['grp:modify'],
    }
    useCompareStore.setState({
      mode: 'multi',
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
        { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [], loadingDbs: false },
      ],
      activeTargetKey: 'k1',
      targetStates: { k1: k1State, k2: k2State },
      ...k1State,
    })
    useCompareStore.getState().setActiveTarget('k2')
    expect(useCompareStore.getState().expandedKeys).toEqual(['grp:modify'])
    // 切回 k1：用户展开过的表明细行仍保持展开
    useCompareStore.getState().setActiveTarget('k1')
    expect(useCompareStore.getState().expandedKeys).toEqual(['grp:modify', 'tbn:modify:t1'])
  })

  it('runCompareMulti 后默认展开分组行、收起表明细行', async () => {
    useCompareStore.setState({
      modalOpen: true,
      mode: 'multi',
      source: { connectionId: 'c1', database: 'db1' },
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
      ],
      activeTargetKey: 'k1',
    })
    mockCompareMulti.mockResolvedValue([
      { key: 'k1', connectionId: 'c2', database: 'db2', items: [item('col:t1.f', 'modify')], error: null },
    ])
    await useCompareStore.getState().runCompareMulti()
    const s = useCompareStore.getState()
    expect(s.expandedKeys).toEqual(['grp:modify'])
    expect(s.targetStates['k1'].expandedKeys).toEqual(['grp:modify'])
  })

  it('多目标部署按激活目标连接执行', async () => {
    useCompareStore.setState({
      mode: 'multi',
      source: { connectionId: 'c1', database: 'db1' },
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
        { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [], loadingDbs: false },
      ],
      activeTargetKey: 'k2',
      step: 'deploy',
      report: [item('a', 'create')],
      selectedIds: ['a'],
    })
    mockApply.mockResolvedValue([{ sql: '-- a', ok: true, error: null }])
    await useCompareStore.getState().deploy()
    expect(mockApply).toHaveBeenCalledWith('c3', ['-- a'])
  })

  it('syncConnected 移除多目标中已断开的目标', () => {
    useCompareStore.setState({
      mode: 'multi',
      source: { connectionId: 'c1', database: 'db1' },
      targets: [
        { key: 'k1', connectionId: 'c2', database: 'db2', dbs: [], loadingDbs: false },
        { key: 'k2', connectionId: 'c3', database: 'db3', dbs: [], loadingDbs: false },
      ],
      activeTargetKey: 'k1',
    })
    useCompareStore.getState().syncConnected(['c1', 'c3'])
    const s = useCompareStore.getState()
    expect(s.targets.map((t) => t.key)).toEqual(['k2'])
    expect(s.activeTargetKey).toBe('k2')
  })
})

describe('buildDiffTree 结果页树构建', () => {
  const fixture: DiffItem[] = [
    ditem('tblopt:tA', 'table', 'modify', 'tA', '(表选项)'),
    ditem('col:tA:c1', 'column', 'modify', 'tA', 'c1'),
    ditem('idx:tA:i1', 'index', 'modify', 'tA', 'i1'),
    ditem('tbl:tB', 'table', 'create', 'tB', 'tB'),
    ditem('tbl:tC', 'table', 'drop', 'tC', 'tC', true),
    ditem('col:tD:c9', 'column', 'drop', 'tD', 'c9', true),
  ]

  it('按操作分组：三组齐全且顺序为 修改/创建/删除，空组跳过', () => {
    const nodes = buildDiffTree(fixture, 'action')
    expect(nodes.map((n) => n.groupTitle)).toEqual([
      '要修改的对象',
      '要创建的对象',
      '要删除的对象',
    ])
    expect(nodes.map((n) => n.key)).toEqual(['grp:modify', 'grp:create', 'grp:drop'])

    // 修改组：tA 父行（3 明细）+ tD 父行（删列，1 明细）——表级分类下删列也归「要修改」
    const modify = nodes[0]
    expect(modify.children).toHaveLength(2)
    const [tA, tD] = modify.children!
    expect(tA.nodeType).toBe('table')
    expect(tA.sourceName).toBe('tA')
    expect(tA.children!.map((c) => c.key)).toEqual(['tblopt:tA', 'col:tA:c1', 'idx:tA:i1'])
    expect(tD.children![0].itemId).toBe('col:tD:c9')

    // 创建组：tB 是叶子行（无子节点）
    const tB = nodes[1].children![0]
    expect(tB.nodeType).toBe('item')
    expect(tB.itemId).toBe('tbl:tB')
    expect(tB.children).toBeUndefined()

    // 删除组：仅 tC 叶子（整表删除）
    const dropChildren = nodes[2].children!
    expect(dropChildren.map((c) => c.table)).toEqual(['tC'])
    expect(dropChildren[0].itemId).toBe('tbl:tC')
  })

  it('create 项只在源侧显示名称，drop 项只在目标侧', () => {
    const nodes = buildDiffTree(fixture, 'action')
    const tB = nodes[1].children![0]
    expect(tB.sourceName).toBe('tB')
    expect(tB.targetName).toBeNull()
    const tC = nodes[2].children![0]
    expect(tC.sourceName).toBeNull()
    expect(tC.targetName).toBe('tC')
  })

  it('rename 项单独分组，源显示旧名、目标显示新名', () => {
    const items: DiffItem[] = [
      {
        id: 'rename:old:new',
        kind: 'table',
        action: 'rename',
        table: 'old',
        name: 'new',
        sourceDesc: 'source',
        targetDesc: 'target',
        sql: 'RENAME TABLE `old` TO `new`',
        dangerous: false,
        sourceDdl: null,
        targetDdl: null,
      },
      ditem('tbl:tB', 'table', 'create', 'tB', 'tB'),
    ]
    const nodes = buildDiffTree(items, 'action')
    expect(nodes.map((n) => n.key)).toEqual(['grp:create', 'grp:rename'])
    const renameNode = nodes[1].children![0]
    expect(renameNode.nodeType).toBe('item')
    expect(renameNode.sourceName).toBe('old')
    expect(renameNode.targetName).toBe('new')
  })

  it('按对象分组：无分组行，表按名排序，混合操作挂同一表下', () => {
    const items: DiffItem[] = [
      ditem('col:tB:c1', 'column', 'modify', 'tB', 'c1'),
      ditem('tbl:tA', 'table', 'create', 'tA', 'tA'),
      ditem('idx:tB:i1', 'index', 'drop', 'tB', 'i1', true),
    ]
    const nodes = buildDiffTree(items, 'object')
    expect(nodes.every((n) => n.nodeType !== 'group')).toBe(true)
    expect(nodes.map((n) => n.table)).toEqual(['tA', 'tB'])
    const tB = nodes[1]
    expect(tB.children!.map((c) => c.key)).toEqual(['col:tB:c1', 'idx:tB:i1'])
  })

  it('视图差异按自身 action 分组', () => {
    const items: DiffItem[] = [
      ditem('view:v1', 'view', 'create', 'v1', 'v1'),
      ditem('view:v2', 'view', 'drop', 'v2', 'v2', true),
    ]
    const nodes = buildDiffTree(items, 'action')
    expect(nodes.map((n) => n.key)).toEqual(['grp:create', 'grp:drop'])
    expect(nodes[0].children![0].nodeType).toBe('item')
    expect(nodes[1].children![0].nodeType).toBe('item')
  })

  it('collectItemIds 收集全部叶子差异项', () => {
    const nodes = buildDiffTree(fixture, 'action')
    expect(collectItemIds(nodes).sort()).toEqual(
      ['tblopt:tA', 'col:tA:c1', 'idx:tA:i1', 'tbl:tB', 'tbl:tC', 'col:tD:c9'].sort(),
    )
  })
})

describe('buildDeployStatements 部署语句合并', () => {
  const col = (
    id: string,
    table: string,
    clause: string,
    action: DiffItem['action'] = 'modify',
  ): DiffItem => ({
    id,
    kind: 'column',
    action,
    table,
    name: id.split(':').pop()!,
    sourceDesc: null,
    targetDesc: null,
    sql: `ALTER TABLE \`db\`.\`${table}\` ${clause}`,
    sqlClause: clause,
    dangerous: action === 'drop',
    sourceDdl: null,
    targetDdl: null,
  })

  it('同表多个列变更合并为一条 ALTER，子句按输入顺序用逗号连接', () => {
    const statements = buildDeployStatements([
      col('col:t:a', 't', "MODIFY COLUMN `a` int NOT NULL"),
      col('col:t:b', 't', "ADD COLUMN `b` int NULL AFTER `a`", 'create'),
      col('col:t:c', 't', "DROP COLUMN `c`", 'drop'),
    ])
    expect(statements).toEqual([
      "ALTER TABLE `db`.`t` MODIFY COLUMN `a` int NOT NULL, ADD COLUMN `b` int NULL AFTER `a`, DROP COLUMN `c`",
    ])
  })

  it('单列变更就是一条独立 ALTER，不带多余逗号', () => {
    const statements = buildDeployStatements([col('col:t:a', 't', "MODIFY COLUMN `a` int NOT NULL")])
    expect(statements).toEqual(["ALTER TABLE `db`.`t` MODIFY COLUMN `a` int NOT NULL"])
  })

  it('不同表的列变更各自成条；索引/表级语句独立不合并', () => {
    const idx: DiffItem = {
      id: 'idx:t:ix', kind: 'index', action: 'create', table: 't', name: 'ix',
      sourceDesc: null, targetDesc: null,
      sql: 'ALTER TABLE `db`.`t` ADD INDEX `ix` (`a`)', dangerous: false,
      sourceDdl: null, targetDdl: null,
    }
    const createTable: DiffItem = {
      id: 'tbl:u', kind: 'table', action: 'create', table: 'u', name: 'u',
      sourceDesc: null, targetDesc: null, sql: 'CREATE TABLE `db`.`u` (...)', dangerous: false,
      sourceDdl: null, targetDdl: null,
    }
    const statements = buildDeployStatements([
      col('col:t:a', 't', "MODIFY COLUMN `a` int NOT NULL"),
      idx,
      col('col:t:b', 't', "MODIFY COLUMN `b` int NOT NULL"), // 被索引隔开：保守地另起一条
      col('col:u:x', 'u', "ADD COLUMN `x` int NULL FIRST", 'create'),
      createTable,
    ])
    expect(statements).toEqual([
      "ALTER TABLE `db`.`t` MODIFY COLUMN `a` int NOT NULL",
      'ALTER TABLE `db`.`t` ADD INDEX `ix` (`a`)',
      "ALTER TABLE `db`.`t` MODIFY COLUMN `b` int NOT NULL",
      "ALTER TABLE `db`.`u` ADD COLUMN `x` int NULL FIRST",
      'CREATE TABLE `db`.`u` (...)',
    ])
  })

  it('只勾选部分字段时，合并后的 ALTER 只包含勾选字段', () => {
    const all = [
      col('col:t:a', 't', "MODIFY COLUMN `a` int NOT NULL"),
      col('col:t:b', 't', "ADD COLUMN `b` int NULL AFTER `a`", 'create'),
      col('col:t:c', 't', "MODIFY COLUMN `c` varchar(64) NULL"),
    ]
    const selected = [all[0], all[2]]
    expect(buildDeployStatements(selected)).toEqual([
      "ALTER TABLE `db`.`t` MODIFY COLUMN `a` int NOT NULL, MODIFY COLUMN `c` varchar(64) NULL",
    ])
  })

  it('旧数据缺 sqlClause 时回退为整条 sql 独立执行', () => {
    const legacy: DiffItem = {
      ...col('col:t:a', 't', 'UNUSED'),
      sqlClause: null,
      sql: 'ALTER TABLE `db`.`t` MODIFY COLUMN `a` int NOT NULL',
    }
    expect(buildDeployStatements([legacy])).toEqual([
      'ALTER TABLE `db`.`t` MODIFY COLUMN `a` int NOT NULL',
    ])
  })
})
