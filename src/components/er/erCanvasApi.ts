/** 画布能力注册表：ErCanvas 挂载时写入，工具栏（兄弟组件）调用。
 *  模块级可变引用是刻意为之——避免为跨组件调用把 reactFlow 实例塞进全局 store */
export const erCanvasApi: {
  /** 定位并适度缩放到某张表 */
  focusTable?: (name: string) => void
  /** 视野复位：全图自适应（重新布局后调用，防止用户迷失在巨大画布里） */
  fitAll?: () => void
  /** 当前选中（框选/点选）的表名列表（小写） */
  getSelectedTables?: () => string[]
  /** 导出整幅画布为 PNG data URL */
  exportPng?: () => Promise<string>
  /** 打开某条连线的右键信息/操作框（段中点手柄等在 portal 层，事件到不了 SVG 边组，借此转发） */
  edgeContextMenu?: (edgeId: string) => void
} = {}
