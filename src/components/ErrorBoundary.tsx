import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'

interface Props {
  children: ReactNode
  /** 出错时的展示范围提示，如「ER 图」 */
  scope?: string
}

interface State {
  error: Error | null
}

/**
 * 渲染错误边界：子树渲染崩溃时显示错误信息，而不是整个窗口白屏。
 * 「重试」清空错误重新渲染子树；若错误依旧会再次进入此面板。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留完整堆栈到控制台，便于开发模式定位
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <Result
        status="error"
        title={`${this.props.scope ?? '界面'}渲染出错`}
        subTitle={
          <pre className="error-boundary-stack">
            {error.message}
            {'\n'}
            {error.stack}
          </pre>
        }
        extra={
          <Button type="primary" onClick={() => this.setState({ error: null })}>
            重试
          </Button>
        }
      />
    )
  }
}
