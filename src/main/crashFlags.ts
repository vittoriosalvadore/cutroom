// ---------------------------------------------------------------------------
// Pure decision: given a process/window event, should we flag recovery pending
// so the next launch offers recovered work? Extracted from the Electron
// event-wiring so the decision is unit-testable without a BrowserWindow.
//
// Only events that imply lost work (a crash, OOM, or hang that the React
// ErrorBoundary likely didn't catch) are flagged. A clean renderer exit is not.
// ---------------------------------------------------------------------------

export type CrashEvent =
  | { kind: 'render-process-gone'; reason: string }
  | { kind: 'gpu-process-crashed' }
  | { kind: 'unresponsive' }
  | { kind: string }

export function shouldFlagRecovery(e: CrashEvent): boolean {
  if (e.kind === 'render-process-gone') {
    const reason = (e as { reason: string }).reason
    return reason !== 'clean-exit'
  }
  if (e.kind === 'gpu-process-crashed') return true
  if (e.kind === 'unresponsive') return true
  return false
}
