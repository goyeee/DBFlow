import { useMemo, useState } from 'react'
import { AutoComplete, Badge, Button, Dropdown, Input, Space, Switch, Tooltip, message } from 'antd'
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'
import {
  ApartmentOutlined,
  ExportOutlined,
  FileImageOutlined,
  LinkOutlined,
  SaveOutlined,
  CodeOutlined,
} from '@ant-design/icons'

import { api } from '../../api/commands'
import { errText } from '../connection/ConnectionTree'
import { useErStore } from '../../stores/er'
import { buildModelDoc } from './transform'
import { erCanvasApi } from './erCanvasApi'
import { askChoice } from './closeGuard'
import { ErDdlModal } from './ErDdlModal'
import { ErManualModal } from './ErManualModal'
import { useErTab, useErTabKey } from './erTabContext'

/** ER 工具栏：搜索定位 / 保存布局 / 重排 / 导出 PNG / 导出 DDL / 导出模型文档 / 推断关系开关 */
export function ErToolbar() {
  const tabKey = useErTabKey()
  const graph = useErTab((t) => t.graph)
  const dirty = useErTab((t) => t.dirty)
  const showInferred = useErTab((t) => t.showInferred)
  const search = useErTab((t) => t.search)
  const inferredEdges = useErTab((t) => t.inferredEdges)
  const inferredStatus = useErTab((t) => t.inferredStatus)
  const [ddlOpen, setDdlOpen] = useState(false)
  const [ddlSql, setDdlSql] = useState('')
  const [manualOpen, setManualOpen] = useState(false)

  const options = useMemo(() => {
    const q = search?.trim().toLowerCase()
    if (!q || !graph) return []
    return Object.values(graph.tables)
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.comment?.toLowerCase().includes(q) ?? false) ||
          t.columns.some((c) => c.name.toLowerCase().includes(q)),
      )
      .slice(0, 20)
      .map((t) => ({
        value: t.name,
        label: (
          <span>
            {t.name}
            <span style={{ color: '#999', marginLeft: 8 }}>
              {t.columns
                .filter((c) => c.name.toLowerCase().includes(q))
                .map((c) => c.name)
                .join(' ')}
            </span>
          </span>
        ),
      }))
  }, [graph, search])

  const onSelect = (name: string) => {
    useErStore.getState().setSelectedTable(tabKey, name.toLowerCase())
    erCanvasApi.focusTable?.(name)
  }

  const doSave = async () => {
    try {
      await useErStore.getState().save(tabKey)
      message.success('布局已保存')
    } catch (e) {
      message.error(errText(e))
    }
  }

  const doRelayout = async () => {
    // 手动布局会被覆盖，先二次确认（撤销可用 Ctrl+Z / undo）
    const answer = await askChoice<'continue'>({
      title: '重新自动布局',
      content: '将按真实 FK、手动关联与未忽略的推断关系重排所有表，手动调整的表位置、连线锚点与路径会被覆盖（可撤销）。',
      choices: [
        { value: 'continue', label: '继续重排', primary: true },
        { value: null, label: '取消' },
      ],
    })
    if (!answer) return
    useErStore.getState().relayout(tabKey)
    // 重排后视野复位到全图，避免迷失在旧视野的空白里
    erCanvasApi.fitAll?.()
  }

  const statusMap = inferredStatus ?? {}
  const pendingEdges = (inferredEdges ?? []).filter((e) => !statusMap[e.id])
  const ignoredEdges = (inferredEdges ?? []).filter((e) => statusMap[e.id] === 'ignored')

  /** 批量裁决所有未裁决的推断边（二次确认） */
  const doAdjudicateAll = async () => {
    const count = pendingEdges.length
    const answer = await askChoice<'confirmed' | 'ignored'>({
      title: '批量裁决推断关系',
      content: `还有 ${count} 条未裁决的推断关系，可全部确认真实存在，或全部忽略。`,
      choices: [
        { value: 'confirmed', label: `全部确认（${count}）`, primary: true },
        { value: 'ignored', label: `全部忽略（${count}）`, danger: true },
        { value: null, label: '取消' },
      ],
    })
    if (answer) useErStore.getState().adjudicateAll(tabKey, answer)
  }

  /** 从「已忽略」列表翻案：重置裁决，该边重新出现 */
  const restoreIgnored = (edgeId: string) =>
    useErStore.getState().adjudicateInferred(tabKey, edgeId, 'reset')

  const doExportPng = async () => {
    try {
      const dataUrl = await erCanvasApi.exportPng?.()
      if (!dataUrl) return
      const path = await saveFileDialog({
        title: '导出 ER 图',
        defaultPath: `${useErStore.getState().tabs[tabKey]?.database ?? 'er'}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      })
      if (!path) return
      await api.exportErImage(path, dataUrl)
      message.success('已导出图片')
    } catch (e) {
      message.error(errText(e))
    }
  }

  const doExportDdl = async () => {
    const s = useErStore.getState().tabs[tabKey]
    if (!s?.connectionId || !s.database || !s.graph) return
    const selected = erCanvasApi.getSelectedTables?.() ?? []
    // 传服务器真实表名（节点 id 是小写，大小写敏感库会匹配失败）
    const tables =
      selected.length > 0
        ? selected.map((id) => s.graph!.tables[id]?.name ?? id)
        : Object.values(s.graph.tables).map((t) => t.name)
    if (selected.length === 0) message.info('未选中表，将导出全部表')
    try {
      const sql = await api.exportTablesDdl(s.connectionId, s.database, tables)
      // 空结果（表名未命中）不打开预览窗，给明确提示
      if (!sql.trim()) {
        message.warning('没有可导出的内容：所选表在该库可能不存在')
        return
      }
      setDdlSql(sql)
      setDdlOpen(true)
    } catch (e) {
      message.error(errText(e))
    }
  }

  const doExportDoc = async () => {
    const s = useErStore.getState().tabs[tabKey]
    if (!s.connectionId || !s.database || !s.graph) return
    try {
      const path = await saveFileDialog({
        title: '导出 ER 模型文档',
        defaultPath: `${s.database}.er.json`,
        filters: [{ name: 'ER 模型文档', extensions: ['er.json'] }],
      })
      if (!path) return
      const doc = buildModelDoc({
        kind: 'mysql',
        database: s.database,
        connectionName: s.connectionName ?? '',
        positions: s.positions,
        collapsed: s.collapsed,
        fkEdges: s.graph.fkEdges,
        inferredEdges: s.inferredEdges,
        manualEdges: s.manualEdges,
        inferredStatus: s.inferredStatus,
        edgeRoutes: s.edgeRoutes,
        edgeAnchors: s.edgeAnchors,
        mfkEdges: s.graph.mfkEdges,
        modelTables: {},
      })
      await api.exportErModel(path, doc)
      message.success('已导出模型文档')
    } catch (e) {
      message.error(errText(e))
    }
  }

  return (
    <div className="er-toolbar">
      <AutoComplete
        value={search}
        options={options}
        onSearch={(v) => useErStore.getState().setSearch(tabKey, v)}
        onSelect={onSelect}
        style={{ width: 260 }}
      >
        <Input.Search placeholder="搜索表名 / 列名" allowClear size="small" />
      </AutoComplete>
      <Space size={4}>
        <Tooltip title="推断的关系（虚线）：点击连线可确认或忽略">
          <span className="er-toolbar-switch">
            推断{' '}
            <Switch
              size="small"
              checked={showInferred}
              onChange={(v) => useErStore.getState().setShowInferred(tabKey, v)}
            />
          </span>
        </Tooltip>
        <Tooltip title="批量裁决所有未裁决的推断关系">
          <Button size="small" disabled={pendingEdges.length === 0} onClick={doAdjudicateAll}>
            批量
          </Button>
        </Tooltip>
        <Dropdown
          disabled={ignoredEdges.length === 0}
          trigger={['click']}
          menu={{
            items: ignoredEdges.slice(0, 30).map((e) => ({
              key: e.id,
              label: `${e.sourceTable}.${e.sourceColumns[0]} → ${e.targetTable}`,
            })),
            onClick: ({ key }) => restoreIgnored(key),
          }}
        >
          <Button size="small">
            已忽略{ignoredEdges.length > 0 ? ` (${ignoredEdges.length})` : ''}
          </Button>
        </Dropdown>
        <Tooltip title="手动添加表间关联（也可在画布上悬停列行、拖拽两侧圆点连线）">
          <Button size="small" icon={<LinkOutlined />} onClick={() => setManualOpen(true)}>
            关联
          </Button>
        </Tooltip>
        <Tooltip title="重新自动布局（真实 FK + 手动关联 + 未忽略的推断关系）">
          <Button size="small" icon={<ApartmentOutlined />} onClick={doRelayout}>
            重新布局
          </Button>
        </Tooltip>
        <Tooltip title="保存布局与关系裁决（本地）">
          <Badge dot={dirty} offset={[-2, 2]}>
            <Button
              size="small"
              type={dirty ? 'primary' : 'default'}
              icon={<SaveOutlined />}
              onClick={doSave}
            >
              保存
            </Button>
          </Badge>
        </Tooltip>
        <Tooltip title="选中表导出建表 DDL（未选中则全部）">
          <Button size="small" icon={<CodeOutlined />} onClick={doExportDdl}>
            DDL
          </Button>
        </Tooltip>
        <Tooltip title="导出 PNG 图片">
          <Button size="small" icon={<FileImageOutlined />} onClick={doExportPng} />
        </Tooltip>
        <Tooltip title="导出模型文档（.er.json，可分享/入 git）">
          <Button size="small" icon={<ExportOutlined />} onClick={doExportDoc} />
        </Tooltip>
      </Space>
      <ErDdlModal open={ddlOpen} sql={ddlSql} onClose={() => setDdlOpen(false)} />
      <ErManualModal open={manualOpen} onClose={() => setManualOpen(false)} />
    </div>
  )
}
