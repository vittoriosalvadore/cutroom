import { describe, it, expect } from 'vitest'
import {
  MAX_SHUTTLE,
  SHUTTLE_MAX_HOLD_MS,
  advancePlayhead,
  formatShuttleRate,
  hasVideoAt,
  isRealtimeRate,
  nextShuttleRate,
  playStartSec,
  stepFrames,
  stepShuttleHold
} from './transport'
import type { Project } from '../types'

describe('nextShuttleRate (J/K/L)', () => {
  it('L from paused plays forward at 1×, then doubles up to the cap', () => {
    let r = nextShuttleRate(1, false, 1)
    expect(r).toBe(1)
    r = nextShuttleRate(r, true, 1)
    expect(r).toBe(2)
    r = nextShuttleRate(r, true, 1)
    expect(r).toBe(4)
    expect(nextShuttleRate(r, true, 1)).toBe(MAX_SHUTTLE)
  })

  it('J mirrors L in reverse', () => {
    expect(nextShuttleRate(1, false, -1)).toBe(-1)
    expect(nextShuttleRate(-1, true, -1)).toBe(-2)
    expect(nextShuttleRate(-2, true, -1)).toBe(-4)
    expect(nextShuttleRate(-4, true, -1)).toBe(-4)
  })

  it('switching direction restarts at 1× the other way', () => {
    expect(nextShuttleRate(4, true, -1)).toBe(-1)
    expect(nextShuttleRate(-2, true, 1)).toBe(1)
  })

  it('a stale fast rate while paused does not carry over', () => {
    expect(nextShuttleRate(4, false, 1)).toBe(1)
  })
})

describe('isRealtimeRate', () => {
  it('only 1× forward is real playback', () => {
    expect(isRealtimeRate(1)).toBe(true)
    for (const r of [2, 4, -1, -2, -4]) expect(isRealtimeRate(r)).toBe(false)
  })
})

describe('advancePlayhead', () => {
  it('moves by dt × rate', () => {
    expect(advancePlayhead(1, 0.5, 1, 10)).toEqual({ sec: 1.5, stop: false })
    expect(advancePlayhead(1, 0.5, 4, 10)).toEqual({ sec: 3, stop: false })
    expect(advancePlayhead(5, 0.5, -2, 10)).toEqual({ sec: 4, stop: false })
  })

  it('forward stops (clamped) at the timeline end', () => {
    expect(advancePlayhead(9.9, 0.5, 2, 10)).toEqual({ sec: 10, stop: true })
  })

  it('reverse stops (clamped) at 0', () => {
    expect(advancePlayhead(0.2, 0.5, -1, 10)).toEqual({ sec: 0, stop: true })
  })
})

describe('playStartSec', () => {
  it('nothing to play on an empty timeline', () => {
    expect(playStartSec(0, 1, 0)).toBeNull()
    expect(playStartSec(3, -1, 0)).toBeNull()
  })

  it('forward from (or past) the end rewinds to 0', () => {
    expect(playStartSec(10, 1, 10)).toBe(0)
    expect(playStartSec(12, 2, 10)).toBe(0)
    expect(playStartSec(4, 1, 10)).toBe(4)
  })

  it('reverse starts where it is, even at the end', () => {
    expect(playStartSec(10, -1, 10)).toBe(10)
  })
})

describe('stepFrames', () => {
  it('steps one frame on the grid', () => {
    expect(stepFrames(0, 30, 1)).toBeCloseTo(1 / 30)
    expect(stepFrames(1, 30, -1)).toBeCloseTo(29 / 30)
  })

  it('repeated steps land exactly on frames (no drift)', () => {
    let t = 0
    for (let i = 0; i < 90; i++) t = stepFrames(t, 30, 1)
    expect(t).toBe(3)
    for (let i = 0; i < 90; i++) t = stepFrames(t, 30, -1)
    expect(t).toBe(0)
  })

  it('snaps an off-grid playhead to the neighbouring frame in that direction', () => {
    // 0.51 s at 10 fps sits between frames 5 and 6.
    expect(stepFrames(0.51, 10, 1)).toBeCloseTo(0.6)
    expect(stepFrames(0.51, 10, -1)).toBeCloseTo(0.5)
  })

  it('a whole-second step at the project fps', () => {
    expect(stepFrames(2, 25, 25)).toBe(3)
    expect(stepFrames(2, 25, -25)).toBe(1)
  })

  it('never goes below 0 and tolerates a bad fps', () => {
    expect(stepFrames(0, 30, -1)).toBe(0)
    expect(stepFrames(0, 0, 1)).toBeCloseTo(1 / 30)
  })
})

describe('formatShuttleRate', () => {
  it('is empty at normal speed and shows direction + speed otherwise', () => {
    expect(formatShuttleRate(1)).toBe('')
    expect(formatShuttleRate(2)).toBe('▶▶ 2×')
    expect(formatShuttleRate(4)).toBe('▶▶ 4×')
    expect(formatShuttleRate(-1)).toBe('◀ 1×')
    expect(formatShuttleRate(-4)).toBe('◀◀ 4×')
  })
})

describe('stepShuttleHold (shuttle preview pacing)', () => {
  const STEP = 2 / 30

  it('holds while the requested frame is in flight', () => {
    const hold = { time: 5, at: 1000, landed: false }
    expect(stepShuttleHold(hold, 4.5, 1100, true, STEP)).toEqual({ hold, render: false })
  })

  it('jumps to the live playhead once the frame has landed', () => {
    const r = stepShuttleHold({ time: 5, at: 1000, landed: true }, 4.5, 1100, true, STEP)
    expect(r).toEqual({ hold: { time: 4.5, at: 1100, landed: false }, render: true })
  })

  it('waits for a move of at least minStep so the next request decodes a new frame', () => {
    const hold = { time: 5, at: 1000, landed: true }
    expect(stepShuttleHold(hold, 4.99, 1100, true, STEP).render).toBe(false)
  })

  it('gives up waiting after the max hold', () => {
    const r = stepShuttleHold({ time: 5, at: 1000, landed: false }, 3, 1000 + SHUTTLE_MAX_HOLD_MS, true, STEP)
    expect(r.render).toBe(true)
    expect(r.hold.time).toBe(3)
  })

  it('follows live when no video needs decoding', () => {
    const r = stepShuttleHold({ time: 5, at: 1000, landed: false }, 4.99, 1001, false, STEP)
    expect(r.render).toBe(true)
  })
})

describe('hasVideoAt', () => {
  const project = {
    id: 'p',
    name: 'T',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    media: {
      v: { id: 'v', name: 'a.mp4', path: '/a.mp4', kind: 'video', durationSec: 10 },
      i: { id: 'i', name: 'b.png', path: '/b.png', kind: 'image', durationSec: 0 }
    },
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', height: 68, muted: false, hidden: false },
      { id: 'v2', kind: 'video', name: 'V2', height: 68, muted: false, hidden: true }
    ],
    clips: {
      a: { id: 'a', trackId: 'v1', mediaId: 'v', startSec: 0, durationSec: 2, inSec: 0 },
      b: { id: 'b', trackId: 'v1', mediaId: 'i', startSec: 2, durationSec: 2, inSec: 0 },
      c: { id: 'c', trackId: 'v2', mediaId: 'v', startSec: 4, durationSec: 2, inSec: 0 }
    }
  } as Project

  it('is true only over a visible video clip', () => {
    expect(hasVideoAt(project, 1)).toBe(true)
    expect(hasVideoAt(project, 2)).toBe(false) // image
    expect(hasVideoAt(project, 5)).toBe(false) // hidden track
    expect(hasVideoAt(project, 7)).toBe(false) // gap
  })
})
