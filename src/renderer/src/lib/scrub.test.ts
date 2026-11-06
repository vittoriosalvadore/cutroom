import { describe, it, expect } from 'vitest'
import {
  GRAIN_FADE_SEC,
  GRAIN_INTERVAL_MS,
  GRAIN_SEC,
  MIN_MOVE_SEC,
  grainEnvelope,
  grainSpan,
  reverseInto,
  scrubDirection,
  scrubTargets,
  shouldGrain
} from './scrub'
import type { Clip, Project, Track } from '../types'

const buf = { duration: 60, label: 'buf' } as unknown as AudioBuffer

function project(clips: Partial<Clip>[], tracks: Partial<Track>[] = [{ id: 'a1', kind: 'audio', muted: false }]): Project {
  const byId: Record<string, Clip> = {}
  clips.forEach((c, i) => {
    const id = c.id ?? `c${i}`
    byId[id] = { id, trackId: 'a1', mediaId: 'm1', startSec: 0, durationSec: 10, inSec: 0, ...c } as Clip
  })
  return { tracks: tracks as Track[], clips: byId } as unknown as Project
}

describe('shouldGrain (throttle)', () => {
  it('always lets the first grain through', () => {
    expect(shouldGrain(null, 0, 3)).toBe(true)
  })

  it('waits GRAIN_INTERVAL_MS between grains', () => {
    const last = { lastMs: 1000, lastTime: 1 }
    expect(shouldGrain(last, 1000 + GRAIN_INTERVAL_MS - 1, 2)).toBe(false)
    expect(shouldGrain(last, 1000 + GRAIN_INTERVAL_MS, 2)).toBe(true)
  })

  it('stays quiet while the playhead is held still', () => {
    const last = { lastMs: 0, lastTime: 5 }
    expect(shouldGrain(last, 10_000, 5)).toBe(false)
    expect(shouldGrain(last, 10_000, 5 + MIN_MOVE_SEC / 2)).toBe(false)
    expect(shouldGrain(last, 10_000, 5 - 2 * MIN_MOVE_SEC)).toBe(true)
  })
})

describe('scrubTargets', () => {
  const always = (): AudioBuffer => buf

  it('finds the clip under the playhead with its source time', () => {
    const p = project([{ startSec: 2, inSec: 1.5, durationSec: 4 }])
    const [g] = scrubTargets(p, 3, always)
    expect(g.srcOffset).toBeCloseTo(2.5)
    expect(g.gain).toBe(1)
    expect(g.buffer).toBe(buf)
  })

  it('maps timeline time through clip speed', () => {
    const p = project([{ startSec: 1, inSec: 0, durationSec: 4, speed: 2 }])
    expect(scrubTargets(p, 2, always)[0].srcOffset).toBeCloseTo(2)
  })

  it('applies the clip envelope (volume × fades) and skips silence', () => {
    const p = project([{ startSec: 0, durationSec: 10, volume: 0.5, fadeInSec: 2 }])
    expect(scrubTargets(p, 1, always)[0].gain).toBeCloseTo(0.25)
    expect(scrubTargets(p, 0, always)).toEqual([]) // gain 0 at the very start of a fade-in
    expect(scrubTargets(project([{ volume: 0 }]), 1, always)).toEqual([])
  })

  it('skips muted tracks, clips off the playhead, and media-less clips', () => {
    expect(scrubTargets(project([{}], [{ id: 'a1', kind: 'audio', muted: true }]), 1, always)).toEqual([])
    expect(scrubTargets(project([{ startSec: 5, durationSec: 2 }]), 7, always)).toEqual([]) // end is exclusive
    expect(scrubTargets(project([{ mediaId: undefined }]), 1, always)).toEqual([])
  })

  it('skips clips with no buffer (audio only in a <video> element)', () => {
    const p = project(
      [{ id: 'v', trackId: 'v1' }, { id: 'a', trackId: 'a1' }],
      [
        { id: 'v1', kind: 'video', muted: false },
        { id: 'a1', kind: 'audio', muted: false }
      ]
    )
    const got = scrubTargets(p, 1, (_c, t) => (t.kind === 'audio' ? buf : null))
    expect(got.map((g) => g.clip.id)).toEqual(['a'])
  })
})

describe('grainSpan', () => {
  const clip = { inSec: 1, durationSec: 10, speed: 1 }

  it('forward reads GRAIN_SEC starting at the playhead', () => {
    const s = grainSpan(4, clip, 1, 60)!
    expect(s.start).toBe(4)
    expect(s.dur).toBeCloseTo(GRAIN_SEC)
  })

  it('reverse reads the GRAIN_SEC just before the playhead', () => {
    const s = grainSpan(4, clip, -1, 60)!
    expect(s.start).toBeCloseTo(4 - GRAIN_SEC)
    expect(s.dur).toBeCloseTo(GRAIN_SEC)
  })

  it('covers GRAIN_SEC of wall time at the clip speed', () => {
    expect(grainSpan(4, { ...clip, speed: 2 }, 1, 60)!.dur).toBeCloseTo(GRAIN_SEC * 2)
  })

  it('never reads outside the trimmed clip or the buffer', () => {
    // clip source range = [1, 11)
    expect(grainSpan(10.97, clip, 1, 60)!.dur).toBeCloseTo(0.03)
    expect(grainSpan(1.02, clip, -1, 60)).toEqual({ start: 1, dur: expect.closeTo(0.02) })
    expect(grainSpan(9.98, clip, 1, 10)!.dur).toBeCloseTo(0.02)
    // too little left right at the edge
    expect(grainSpan(10.995, clip, 1, 60)).toBeNull()
    expect(grainSpan(1, clip, -1, 60)).toBeNull()
  })
})

describe('grainEnvelope', () => {
  it('fades in, holds, and fades out to exactly 0 at the end', () => {
    const ops = grainEnvelope(0.8, GRAIN_SEC)
    expect(ops[0]).toEqual({ kind: 'set', value: 0, atOffset: 0 })
    expect(ops[1]).toEqual({ kind: 'ramp', value: 0.8, atOffset: GRAIN_FADE_SEC })
    expect(ops[2].value).toBe(0.8)
    expect(ops[2].atOffset).toBeCloseTo(GRAIN_SEC - GRAIN_FADE_SEC)
    expect(ops[3]).toEqual({ kind: 'ramp', value: 0, atOffset: GRAIN_SEC })
  })

  it('shrinks the fades for a very short grain (never overlapping)', () => {
    const ops = grainEnvelope(1, 0.015)
    expect(ops[1].atOffset).toBeCloseTo(0.005)
    expect(ops[2].atOffset).toBeCloseTo(0.01)
    expect(ops[2].atOffset).toBeGreaterThanOrEqual(ops[1].atOffset)
  })
})

describe('reverseInto / scrubDirection', () => {
  it('copies a span backwards', () => {
    const src = new Float32Array([0, 1, 2, 3, 4, 5])
    const dst = new Float32Array(3)
    reverseInto(src, 2, 3, dst)
    expect(Array.from(dst)).toEqual([4, 3, 2])
  })

  it('reads direction from successive playhead positions', () => {
    expect(scrubDirection(2, 3)).toBe(1)
    expect(scrubDirection(3, 2)).toBe(-1)
    expect(scrubDirection(2, 2)).toBe(1)
  })
})
