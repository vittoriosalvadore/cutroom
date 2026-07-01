import { describe, it, expect } from 'vitest'
import { clampFades, computeFadeSchedule, fadeGainAt } from './fades'

describe('clampFades', () => {
  it('scales fades proportionally when they overlap', () => {
    const r = clampFades(6, 6, 4)
    expect(r.fadeInSec).toBeCloseTo(2)
    expect(r.fadeOutSec).toBeCloseTo(2)
  })
  it('passes fades through when they fit', () => {
    const r = clampFades(1, 2, 10)
    expect(r.fadeInSec).toBe(1)
    expect(r.fadeOutSec).toBe(2)
  })
  it('floors negatives at zero', () => {
    const r = clampFades(-1, -2, 10)
    expect(r.fadeInSec).toBe(0)
    expect(r.fadeOutSec).toBe(0)
  })
})

describe('computeFadeSchedule', () => {
  const P = { volume: 1, fadeInSec: 2, fadeOutSec: 2, durationSec: 10 }

  it('at clip head ramps from 0 up to volume', () => {
    const ops = computeFadeSchedule(0, P)
    expect(ops[0]).toEqual({ kind: 'set', value: 0, atOffset: 0 })
    expect(ops[1]).toEqual({ kind: 'ramp', value: 1, atOffset: 2 })
  })

  it('entering mid fade-in starts at the partial gain', () => {
    const ops = computeFadeSchedule(1, P)
    expect(ops[0].kind).toBe('set')
    expect(ops[0].value).toBeCloseTo(0.5) // 1/2 of the way in
    expect(ops[1]).toEqual({ kind: 'ramp', value: 1, atOffset: 1 }) // reaches V after remaining 1s
  })

  it('in the steady region holds volume then schedules the future fade-out', () => {
    const ops = computeFadeSchedule(5, P)
    expect(ops[0]).toEqual({ kind: 'set', value: 1, atOffset: 0 })
    // fade-out begins at D-fo=8 -> 3s from now, reaches 0 at D=10 -> 5s from now
    expect(ops[1]).toEqual({ kind: 'set', value: 1, atOffset: 3 })
    expect(ops[2]).toEqual({ kind: 'ramp', value: 0, atOffset: 5 })
  })

  it('entering mid fade-out starts at partial and ramps to zero', () => {
    const ops = computeFadeSchedule(9, P) // foStart=8, 1s of fade-out remains
    expect(ops[0].value).toBeCloseTo(0.5) // 1/2 of the way out
    expect(ops[ops.length - 1]).toEqual({ kind: 'ramp', value: 0, atOffset: 1 })
  })

  it('scales overlapping fades down to meet at a peak', () => {
    const ops = computeFadeSchedule(0, { volume: 1, fadeInSec: 8, fadeOutSec: 8, durationSec: 4 })
    // fi+fo=16 > 4 -> each clamped to 2
    expect(ops[1]).toEqual({ kind: 'ramp', value: 1, atOffset: 2 })
  })
})

describe('fadeGainAt', () => {
  const P = { volume: 0.8, fadeInSec: 2, fadeOutSec: 2, durationSec: 10 }
  it('ramps up through the fade-in', () => {
    expect(fadeGainAt(0, P)).toBeCloseTo(0)
    expect(fadeGainAt(1, P)).toBeCloseTo(0.4) // half of 0.8
    expect(fadeGainAt(2, P)).toBeCloseTo(0.8)
  })
  it('holds volume in the steady region', () => {
    expect(fadeGainAt(5, P)).toBeCloseTo(0.8)
  })
  it('ramps down through the fade-out', () => {
    expect(fadeGainAt(9, P)).toBeCloseTo(0.4) // half of 0.8
    expect(fadeGainAt(10, P)).toBeCloseTo(0)
  })
})
