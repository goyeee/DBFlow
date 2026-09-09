import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import App from './App'
import './styles.css'

dayjs.locale('zh-cn')

// 在 html 根元素上标记平台，供 CSS 做 macOS 红绿灯避让等差异化样式
document.documentElement.dataset.platform = /Mac|Macintosh/.test(navigator.userAgent)
  ? 'macos'
  : 'other'

// 全局禁用 webview 默认右键菜单（Reload / Inspect Element）。
// 放行输入控件（复制/粘贴/全选的编辑菜单）；树节点的自定义右键菜单走
// React 合成事件，preventDefault 不影响它。
document.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement | null
  if (el?.closest('input, textarea, [contenteditable="true"]')) return
  e.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{}}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
