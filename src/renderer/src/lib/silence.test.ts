import { describe, it, expect } from 'vitest'
import { findSilences } from './silence'

/** A minimal AudioBuffer stand-in — only getChannelData/duration/length are
 *  used by findSilences, so a real AudioBuffer isn't needed in a node test env. */
function makeBuffer(samples: Float32Array, sampleRate = 48000): AudioBuffer {
  return {
    getChannelData: () => samples,
    duration: samples.length / sampleRate,
    length: samples.length,
    sampleRate,
    numberOfChannels: 1
  } as unknown as AudioBuffer
}

/** amp seconds of a signal at `amplitude`, at 1000 samples/sec (keeps arrays small). */
function tone(seconds: number, amplitude: number, sr = 1000): Float32Array {
  const n = Math.round(seconds * sr)
  const out = new Float32Array(n)
  out.fill(amplitude)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const SR = 1000
const OPTS = { thresholdDb: -40, minSilenceSec: 0.3, minClipSec: 0.2 }

describe('findSilences', () => {
  it('finds no ranges in constant loud audio', () => {
    const buf = makeBuffer(tone(2, 0.5, SR), SR)
    expect(findSilences(buf, OPTS)).toEqual([])
  })

  it('finds a silent range surrounded by loud audio', () => {
    const buf = makeBuffer(concat(tone(1, 0.5, SR), tone(1, 0, SR), tone(1, 0.5, SR)), SR)
    const ranges = findSilences(buf, OPTS)
    expect(ranges.length).toBe(1)
    expect(ranges[0].startSec).toBeCloseTo(1, 1)
    expect(ranges[0].endSec).toBeCloseTo(2, 1)
  })

  it('ignores silences shorter than minSilenceSec', () => {
    // 0.1s silence, well under the 0.3s minimum.
    const buf = makeBuffer(concat(tone(1, 0.5, SR), tone(0.1, 0, SR), tone(1, 0.5, SR)), SR)
    expect(findSilences(buf, OPTS)).toEqual([])
  })

  it('merges two silences separated by a speech gap shorter than minClipSec', () => {
    // silence(0.4) + speech(0.1, under minClipSec=0.2) + silence(0.4) -> one merged range.
    const buf = makeBuffer(
      concat(tone(1, 0.5, SR), tone(0.4, 0, SR), tone(0.1, 0.5, SR), tone(0.4, 0, SR), tone(1, 0.5, SR)),
      SR
    )
    const ranges = findSilences(buf, OPTS)
    expect(ranges.length).toBe(1)
    expect(ranges[0].startSec).toBeCloseTo(1, 1)
    expect(ranges[0].endSec).toBeCloseTo(1.9, 1)
  })

  it('keeps two silences separate when the speech gap exceeds minClipSec', () => {
    const buf = makeBuffer(
      concat(tone(1, 0.5, SR), tone(0.4, 0, SR), tone(0.5, 0.5, SR), tone(0.4, 0, SR), tone(1, 0.5, SR)),
      SR
    )
    expect(findSilences(buf, OPTS).length).toBe(2)
  })

  it('treats a low-amplitude tone below threshold as silent', () => {
    // -40dB threshold -> linear ~0.01; a 0.001-amplitude tone should count as silent.
    const buf = makeBuffer(concat(tone(1, 0.5, SR), tone(0.5, 0.001, SR), tone(1, 0.5, SR)), SR)
    expect(findSilences(buf, OPTS).length).toBe(1)
  })

  it('does not drift on long files whose length is not a whole number of windows', () => {
    // 600 s + 1 sample at 1 kHz: a floor(length/total) window would be 19 samples
    // instead of 20, drifting ~25 s by the 500 s mark.
    const buf = makeBuffer(concat(tone(500, 0.5, SR), tone(2, 0, SR), tone(98, 0.5, SR), tone(0.001, 0.5, SR)), SR)
    const ranges = findSilences(buf, OPTS)
    expect(ranges.length).toBe(1)
    expect(ranges[0].startSec).toBeCloseTo(500, 2)
    expect(ranges[0].endSec).toBeCloseTo(502, 2)
  })

  it('uses the loudest channel, so speech on channel 1 only is not silence', () => {
    const left = concat(tone(1, 0.5, SR), tone(1, 0, SR), tone(1, 0.5, SR))
    const right = tone(3, 0.5, SR)
    const buf = {
      getChannelData: (ch: number) => (ch === 0 ? left : right),
      duration: 3,
      length: left.length,
      sampleRate: SR,
      numberOfChannels: 2
    } as unknown as AudioBuffer
    expect(findSilences(buf, OPTS)).toEqual([])
  })
})
