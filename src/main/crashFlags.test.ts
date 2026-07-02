import { describe, it, expect } from 'vitest'
import { shouldFlagRecovery } from './crashFlags'

describe('shouldFlagRecovery', () => {
  it('flags a renderer OOM', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'oom' })).toBe(true)
  })
  it('flags a renderer crash', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'crashed' })).toBe(true)
  })
  it('flags a killed renderer', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'killed' })).toBe(true)
  })
  it('does NOT flag a clean renderer exit', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'clean-exit' })).toBe(false)
  })
  it('flags a GPU process crash', () => {
    expect(shouldFlagRecovery({ kind: 'gpu-process-crashed' })).toBe(true)
  })
  it('flags an unresponsive renderer', () => {
    expect(shouldFlagRecovery({ kind: 'unresponsive' })).toBe(true)
  })
  it('does not flag an unknown event', () => {
    expect(shouldFlagRecovery({ kind: 'something-else' })).toBe(false)
  })
})
