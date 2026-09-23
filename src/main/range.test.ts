import { describe, it, expect } from 'vitest'
import { parseRange } from './range'

describe('parseRange', () => {
  it('parses closed, open and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })
  it('clamps an end past EOF and a suffix longer than the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })
  it('reports unsatisfiable ranges instead of serving the whole file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=5000-6000', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=10-5', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })
  it('ignores malformed or multi-range headers', () => {
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull()
  })
})
