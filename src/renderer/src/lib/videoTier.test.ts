import { describe, it, expect, afterEach } from 'vitest'
import { extensionTier, hasDisplayRotation, resolveTier } from './videoTier'
import type { MediaItem } from '../types'

describe('extensionTier', () => {
  it('returns webcodecs for mp4', () => {
    expect(extensionTier('/path/clip.mp4')).toBe('webcodecs')
  })
  it('returns webcodecs for m4v', () => {
    expect(extensionTier('/path/clip.m4v')).toBe('webcodecs')
  })
  it('returns webcodecs for mov', () => {
    expect(extensionTier('/path/clip.mov')).toBe('webcodecs')
  })
  it('returns video-element for mkv', () => {
    expect(extensionTier('/path/clip.mkv')).toBe('video-element')
  })
  it('returns video-element for webm', () => {
    expect(extensionTier('/path/clip.webm')).toBe('video-element')
  })
  it('returns video-element for avi', () => {
    expect(extensionTier('/path/clip.avi')).toBe('video-element')
  })
  it('is case-insensitive', () => {
    expect(extensionTier('/path/CLIP.MP4')).toBe('webcodecs')
  })
  it('returns video-element for an unknown extension', () => {
    expect(extensionTier('/path/clip.xyz')).toBe('video-element')
  })
  it('returns video-element for no extension', () => {
    expect(extensionTier('/path/clip')).toBe('video-element')
  })
})

describe('resolveTier', () => {
  const media = (path: string): MediaItem => ({ id: 'm', name: 'm', path, kind: 'video', durationSec: 0 })
  const g = globalThis as { VideoDecoder?: unknown }

  afterEach(() => {
    delete g.VideoDecoder
  })

  it('falls back to video-element when VideoDecoder is unavailable (node env)', async () => {
    delete g.VideoDecoder
    expect(await resolveTier(media('/a.mp4'), async () => 'avc1.42E01E')).toBe('video-element')
  })

  it('never probes non-MP4 extensions', async () => {
    g.VideoDecoder = { isConfigSupported: async () => ({ supported: true }) }
    let probed = false
    const tier = await resolveTier(media('/a.mkv'), async () => {
      probed = true
      return 'vp9'
    })
    expect(tier).toBe('video-element')
    expect(probed).toBe(false)
  })

  it('returns webcodecs when the probe finds a supported codec', async () => {
    g.VideoDecoder = { isConfigSupported: async () => ({ supported: true }) }
    expect(await resolveTier(media('/a.mp4'), async () => 'avc1.42E01E')).toBe('webcodecs')
  })

  it('falls back when the codec is unsupported', async () => {
    g.VideoDecoder = { isConfigSupported: async () => ({ supported: false }) }
    expect(await resolveTier(media('/a.mp4'), async () => 'hev1.1.6.L93.B0')).toBe('video-element')
  })

  it('falls back when the probe fails', async () => {
    g.VideoDecoder = { isConfigSupported: async () => ({ supported: true }) }
    expect(await resolveTier(media('/a.mp4'), async () => Promise.reject(new Error('boom')))).toBe('video-element')
  })
})

describe('hasDisplayRotation', () => {
  const ONE = 0x10000 // 1.0 in 16.16 fixed point
  const W = 0x40000000 // 1.0 in 2.30 fixed point
  it('is false for the identity matrix or a missing one', () => {
    expect(hasDisplayRotation([ONE, 0, 0, 0, ONE, 0, 0, 0, W])).toBe(false)
    expect(hasDisplayRotation(new Int32Array([ONE, 0, 0, 0, ONE, 0, 0, 0, W]))).toBe(false)
    expect(hasDisplayRotation(undefined)).toBe(false)
  })
  it('is true for 90/180/270 degree rotations (phone footage)', () => {
    expect(hasDisplayRotation([0, ONE, 0, -ONE, 0, 0, 1080 * ONE, 0, W])).toBe(true) // 90
    expect(hasDisplayRotation([-ONE, 0, 0, 0, -ONE, 0, 1920 * ONE, 1080 * ONE, W])).toBe(true) // 180
    expect(hasDisplayRotation([0, -ONE, 0, ONE, 0, 0, 0, 1920 * ONE, W])).toBe(true) // 270
  })
  it('ignores pure scale/translation', () => {
    expect(hasDisplayRotation([2 * ONE, 0, 0, 0, 2 * ONE, 0, 10 * ONE, 0, W])).toBe(false)
  })
})
