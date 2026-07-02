import { describe, it, expect } from 'vitest'
import { RestoreMachine } from './webglRestore'

describe('webglRestore.RestoreMachine', () => {
  it('starts idle', () => {
    const m = new RestoreMachine()
    expect(m.state).toBe('idle')
  })

  it('enters reconnecting on context loss and requests a rebuild on restore', () => {
    const m = new RestoreMachine()
    m.onLost()
    expect(m.state).toBe('reconnecting')
    const needsRebuild = m.onRestored()
    expect(needsRebuild).toBe(true)
    expect(m.state).toBe('idle')
  })

  it('does not request a rebuild when restoring from idle (no loss happened)', () => {
    const m = new RestoreMachine()
    expect(m.onRestored()).toBe(false)
    expect(m.state).toBe('idle')
  })

  it('enters failed after maxRetries consecutive restores without going stable', () => {
    const m = new RestoreMachine()
    // Each loss→restore without markStable() between them counts as a flapping
    // retry. After maxRetries restores, the NEXT restore pushes into 'failed'.
    for (let i = 0; i < m.maxRetries; i++) {
      m.onLost()
      m.onRestored()
    }
    // One more flap should trip into failed on restore.
    m.onLost()
    const needsRebuild = m.onRestored()
    expect(m.state).toBe('failed')
    expect(needsRebuild).toBe(true) // still rebuilds the final attempt
  })

  it('resets the retry counter after a stable idle period', () => {
    const m = new RestoreMachine()
    m.onLost()
    m.onRestored()
    m.markStable()
    // Now a fresh loss should not carry prior retries — stays well under cap.
    m.onLost()
    m.onRestored()
    expect(m.state).toBe('idle')
  })
})
