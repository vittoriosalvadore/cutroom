import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { isLocalFilePath, isOwnTempFile } from './paths'

describe('isLocalFilePath', () => {
  it('accepts absolute paths', () => {
    expect(isLocalFilePath(join(tmpdir(), 'a.mp4'))).toBe(true)
  })
  it('rejects relative paths, protocols and junk', () => {
    expect(isLocalFilePath('a.mp4')).toBe(false)
    expect(isLocalFilePath('http://example.com/a.mp4')).toBe(false)
    expect(isLocalFilePath('concat:/a.mp4|/b.mp4')).toBe(false)
    expect(isLocalFilePath('')).toBe(false)
    expect(isLocalFilePath(42)).toBe(false)
    expect(isLocalFilePath(join(tmpdir(), 'a\0b'))).toBe(false)
  })
})

describe('isOwnTempFile', () => {
  const tmp = tmpdir()
  it('accepts cutroom-* files directly in tmp', () => {
    expect(isOwnTempFile(join(tmp, 'cutroom-1-2-3-silent.mp4'), tmp)).toBe(true)
  })
  it('rejects other files, subdirs and traversal', () => {
    expect(isOwnTempFile(join(tmp, 'other.mp4'), tmp)).toBe(false)
    expect(isOwnTempFile(join(tmp, 'sub', 'cutroom-x.mp4'), tmp)).toBe(false)
    expect(isOwnTempFile(join(tmp, '..', 'cutroom-x.mp4'), tmp)).toBe(false)
    expect(isOwnTempFile('cutroom-x.mp4', tmp)).toBe(false)
  })
})
