// ---------------------------------------------------------------------------
// WebGL context-loss state machine. A lost GPU context must look like
// "reconnecting", not a crash. Pure transitions (no DOM) so it is unit-testable;
// the compositor/Preview own the actual GL rebuild + canvas listeners.
//
//   idle  --onLost-->  reconnecting  --onRestored-->  idle (rebuild once)
//                                   \
//                                    --too many flapping retries-->  failed
//
// "Flapping" = repeated loss/restore cycles without a stable idle period in
// between. A single restore that then stays stable resets the counter.
// ---------------------------------------------------------------------------

export type RestoreState = 'idle' | 'reconnecting' | 'failed'

export class RestoreMachine {
  state: RestoreState = 'idle'
  /** Max consecutive loss/restore cycles (no stable period between) before we
   *  give up and surface "failed". High enough to ride out a transient burst. */
  readonly maxRetries = 5
  private retries = 0

  /** Call from the webglcontextlost handler. */
  onLost(): void {
    if (this.state === 'failed') return
    this.state = 'reconnecting'
  }

  /**
   * Call from the webglcontextrestored handler. Returns true if the caller must
   * rebuild the GL program/textures now (exactly once per restore). Returns
   * false when no loss happened (spurious restore). After maxRetries flapping
   * restores, transitions to 'failed' (but still returns true for this final
   * rebuild attempt).
   */
  onRestored(): boolean {
    if (this.state !== 'reconnecting') return false
    this.retries++
    if (this.retries > this.maxRetries) {
      this.state = 'failed'
      return true
    }
    this.state = 'idle'
    return true
  }

  /** Call once a restored context has survived a stable render cycle. Only
   *  meaningful while 'idle': if the context was lost again in the meantime
   *  ('reconnecting') it must NOT flip to idle — the next onRestored() would
   *  then see no loss, skip the rebuild and leave the preview black. */
  markStable(): void {
    if (this.state !== 'idle') return
    this.retries = 0
  }

  /** Reset to initial (e.g. on a deliberate compositor recreate). */
  reset(): void {
    this.retries = 0
    this.state = 'idle'
  }
}
