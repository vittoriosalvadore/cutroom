import { describe, it, expect } from 'vitest'
import { activeWordIndex } from './compositor'
import type { WordTiming } from '../types'

const words: WordTiming[] = [
  { text: 'Hello', startSec: 0, endSec: 0.3 },
  { text: 'world', startSec: 0.3, endSec: 0.7 },
  { text: 'today', startSec: 0.9, endSec: 1.3 }
]

describe('activeWordIndex', () => {
  it('returns -1 for an empty word list', () => {
    expect(activeWordIndex([], 0.5)).toBe(-1)
  })

  it('returns -1 before the first word starts', () => {
    expect(activeWordIndex(words, -0.1)).toBe(-1)
  })

  it('returns the first word right at its start', () => {
    expect(activeWordIndex(words, 0)).toBe(0)
  })

  it('returns the word covering the given time', () => {
    expect(activeWordIndex(words, 0.5)).toBe(1)
  })

  it('sticks on the previous word during a gap between words', () => {
    expect(activeWordIndex(words, 0.8)).toBe(1)
  })

  it('returns the last word right at its start', () => {
    expect(activeWordIndex(words, 0.9)).toBe(2)
  })

  it('sticks on the last word after its own window ends', () => {
    expect(activeWordIndex(words, 5)).toBe(2)
  })
})
