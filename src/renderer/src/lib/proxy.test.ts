import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../types'
import { formatBytes, frameLayoutSize, previewSourcePath, shouldAutoProxy, type ProxyEntry } from './proxy'

const video = (w?: number, h?: number): MediaItem => ({
  id: 'm1',
  name: 'a.mp4',
  path: '/footage/a.mp4',
  kind: 'video',
  durationSec: 10,
  width: w,
  height: h
})

const ready: ProxyEntry = { status: 'ready', progress: 1, proxyPath: '/cache/p.mp4' }

describe('shouldAutoProxy', () => {
  it('only for probed video whose short side exceeds 1080', () => {
    expect(shouldAutoProxy(video(3840, 2160))).toBe(true)
    expect(shouldAutoProxy(video(2560, 1440))).toBe(true)
    expect(shouldAutoProxy(video(2160, 3840))).toBe(true) // portrait 4K
    expect(shouldAutoProxy(video(1920, 1080))).toBe(false)
    expect(shouldAutoProxy(video(1080, 1920))).toBe(false) // portrait 1080p
    expect(shouldAutoProxy(video())).toBe(false) // not probed yet
  })

  it('never for images, audio or sourceless media', () => {
    expect(shouldAutoProxy({ ...video(4000, 3000), kind: 'image' })).toBe(false)
    expect(shouldAutoProxy({ ...video(3840, 2160), kind: 'audio' })).toBe(false)
    expect(shouldAutoProxy({ ...video(3840, 2160), path: '' })).toBe(false)
  })
})

describe('previewSourcePath', () => {
  const m = video(3840, 2160)

  it('uses a ready proxy when proxies are on', () => {
    expect(previewSourcePath(m, ready, { useProxies: true })).toBe('/cache/p.mp4')
  })

  it('falls back to the original when off, missing or not ready', () => {
    expect(previewSourcePath(m, ready, { useProxies: false })).toBe(m.path)
    expect(previewSourcePath(m, undefined, { useProxies: true })).toBe(m.path)
    expect(previewSourcePath(m, { status: 'processing', progress: 0.4 }, { useProxies: true })).toBe(m.path)
    expect(previewSourcePath(m, { status: 'error', progress: 0, error: 'x' }, { useProxies: true })).toBe(m.path)
  })

  it('export (exact) always decodes the original', () => {
    expect(previewSourcePath(m, ready, { useProxies: true, exact: true })).toBe(m.path)
  })
})

describe('frameLayoutSize', () => {
  it('lays a proxy out by the original size, so geometry is unchanged', () => {
    expect(frameLayoutSize(video(3840, 2160), { width: 1280, height: 720 }, true)).toEqual({ width: 3840, height: 2160 })
    // Rounding pixel in a proxy's aspect doesn't leak into the layout.
    expect(frameLayoutSize(video(1998, 1080), { width: 1332, height: 720 }, true)).toEqual({ width: 1998, height: 1080 })
  })

  it('uses the decoded size for originals or when the original is unprobed', () => {
    expect(frameLayoutSize(video(3840, 2160), { width: 3840, height: 2160 }, false)).toEqual({ width: 3840, height: 2160 })
    expect(frameLayoutSize(video(), { width: 1280, height: 720 }, true)).toEqual({ width: 1280, height: 720 })
  })
})

describe('formatBytes', () => {
  it('formats MB and GB', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(1.5 * 1024 ** 2)).toBe('1.5 MB')
    expect(formatBytes(250 * 1024 ** 2)).toBe('250 MB')
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2.3 GB')
  })
})
