import { describe, it, expect } from 'vitest'
import { frameFileName } from './frameGrab'

describe('frameFileName', () => {
  it('names a still after the project and its time', () => {
    expect(frameFileName('My Edit', 72.9)).toBe('My Edit 01m12s.png')
    expect(frameFileName('a/b:c', 0)).toBe('a b c 00m00s.png')
    expect(frameFileName('', 5)).toBe('frame 00m05s.png')
  })
})
