import { describe, it, expect } from 'vitest'
import { resolvePreviewBuffer } from './audioPool'
import type { AudioEntry } from './audioCache'
import type { DenoiseEntry } from './denoiseCache'
import type { Clip, Track } from '../types'

const audioTrack = { id: 't1', kind: 'audio', name: 'A' } as Track
const videoTrack = { id: 't2', kind: 'video', name: 'V' } as Track
const clip = (denoiseEnabled?: boolean): Clip =>
  ({ id: 'c1', trackId: 't1', mediaId: 'm1', startSec: 0, durationSec: 5, inSec: 0, denoiseEnabled }) as Clip

const originalBuffer = { label: 'original' } as unknown as AudioBuffer
const denoisedBuffer = { label: 'denoised' } as unknown as AudioBuffer

describe('resolvePreviewBuffer', () => {
  it('prefers the denoised buffer when enabled and ready, regardless of track kind', () => {
    const audioEntry: AudioEntry = { status: 'ready', buffer: originalBuffer }
    const denoiseEntry: DenoiseEntry = { status: 'ready', buffer: denoisedBuffer }
    expect(resolvePreviewBuffer(clip(true), audioTrack, audioEntry, denoiseEntry)).toBe(denoisedBuffer)
    expect(resolvePreviewBuffer(clip(true), videoTrack, undefined, denoiseEntry)).toBe(denoisedBuffer)
  })

  it('falls back to the audio-track buffer while denoise is still processing', () => {
    const audioEntry: AudioEntry = { status: 'ready', buffer: originalBuffer }
    const denoiseEntry: DenoiseEntry = { status: 'processing' }
    expect(resolvePreviewBuffer(clip(true), audioTrack, audioEntry, denoiseEntry)).toBe(originalBuffer)
  })

  it('returns null for a video-track clip while denoise is not ready yet', () => {
    const denoiseEntry: DenoiseEntry = { status: 'processing' }
    expect(resolvePreviewBuffer(clip(true), videoTrack, undefined, denoiseEntry)).toBeNull()
  })

  it('returns the plain buffer for an audio-track clip with denoise off', () => {
    const audioEntry: AudioEntry = { status: 'ready', buffer: originalBuffer }
    expect(resolvePreviewBuffer(clip(false), audioTrack, audioEntry, undefined)).toBe(originalBuffer)
  })

  it('returns null for a video-track clip with denoise off (element-tap path instead)', () => {
    const audioEntry: AudioEntry = { status: 'ready', buffer: originalBuffer }
    expect(resolvePreviewBuffer(clip(false), videoTrack, audioEntry, undefined)).toBeNull()
  })

  it('returns null for an audio-track clip whose source is not decoded yet', () => {
    const audioEntry: AudioEntry = { status: 'loading' }
    expect(resolvePreviewBuffer(clip(false), audioTrack, audioEntry, undefined)).toBeNull()
  })

  it('returns null when both entries are absent', () => {
    expect(resolvePreviewBuffer(clip(false), audioTrack, undefined, undefined)).toBeNull()
  })
})
