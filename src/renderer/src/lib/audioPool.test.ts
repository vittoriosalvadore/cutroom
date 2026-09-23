import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DYNAMICS_DISPOSE_MESSAGE, DYNAMICS_NODE_OPTIONS, resolvePreviewBuffer } from './audioPool'
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

describe('dynamics worklet wiring', () => {
  it('forces a stereo down-mix into the processor (5.1 sources)', () => {
    expect(DYNAMICS_NODE_OPTIONS.channelCount).toBe(2)
    expect(DYNAMICS_NODE_OPTIONS.channelCountMode).toBe('explicit')
    expect(DYNAMICS_NODE_OPTIONS.outputChannelCount).toEqual([2])
  })

  // Load the classic worklet script with stubbed AudioWorkletGlobalScope globals.
  type Params = Record<string, Float32Array>
  type Proc = {
    port: { onmessage: ((e: { data: unknown }) => void) | null }
    process(i: Float32Array[][], o: Float32Array[][], p: Params): boolean
  }
  type ProcCtor = (new () => Proc) & { parameterDescriptors: Array<{ name: string; defaultValue: number }> }
  function loadProcessor(): { proc: Proc; params: Params } {
    const src = readFileSync(new URL('./worklets/dynamics.worklet.js', import.meta.url), 'utf8')
    let Ctor: ProcCtor | null = null
    class AudioWorkletProcessor {
      port = { onmessage: null }
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(
      AudioWorkletProcessor,
      (_name: string, c: ProcCtor) => {
        Ctor = c
      },
      48000
    )
    const C = Ctor as unknown as ProcCtor
    const params: Params = {}
    for (const d of C.parameterDescriptors) params[d.name] = new Float32Array([d.defaultValue])
    return { proc: new C(), params }
  }

  it('stays finite with more than two input channels (EQ + gate + comp on)', () => {
    const { proc, params } = loadProcessor()
    params.eqEnabled[0] = 1
    params.eqLowDb[0] = 6
    params.gateEnabled[0] = 1
    params.compEnabled[0] = 1
    const input = Array.from({ length: 6 }, () => new Float32Array(128).fill(0.25))
    const out = [new Float32Array(128), new Float32Array(128)]
    for (let q = 0; q < 4; q++) expect(proc.process([input, []], [out], params)).toBe(true)
    expect(out.every((ch) => ch.every(Number.isFinite))).toBe(true)
  })

  it('returns false from process() after the dispose message', () => {
    const { proc, params } = loadProcessor()
    const out = [new Float32Array(128), new Float32Array(128)]
    expect(proc.process([[new Float32Array(128)], []], [out], params)).toBe(true)
    proc.port.onmessage?.({ data: DYNAMICS_DISPOSE_MESSAGE })
    expect(proc.process([[new Float32Array(128)], []], [out], params)).toBe(false)
  })
})
