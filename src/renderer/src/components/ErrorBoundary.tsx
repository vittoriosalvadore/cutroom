import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useEditor } from '../state/store'
import { serializeProject } from '../lib/projectFile'

// A render crash must not lose work. On catch we flush the current project to the
// recovery file and flag a pending recovery, then show a reload screen instead of
// a blank window — the next launch offers to restore.

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      const st = useEditor.getState()
      const json = serializeProject(st.project, { savedPath: st.projectFilePath, timestamp: Date.now() })
      void window.cutroom?.writeRecovery(json)
      void window.cutroom?.markRecoveryPending()
    } catch {
      /* best effort — never throw from the boundary */
    }
    console.error('[cutroom] render crash:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <div className="crash-card">
            <h2>Something went wrong</h2>
            <p>Your work has been saved to recovery. Reload to pick up where you left off.</p>
            <pre className="crash-detail">{this.state.error.message}</pre>
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
