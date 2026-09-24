import { describe, it, expect } from 'vitest'
import {
  addCurvePoint,
  buildCurvesLut,
  compileCurve,
  identityCurves,
  identityPoints,
  isIdentityCurves,
  isIdentityLut,
  MAX_CURVE_POINTS,
  monotoneTangents,
  moveCurvePoint,
  normalizePoints,
  removeCurvePoint,
  sanitizeCurves
} from './curves'
import type { ColorCurves } from '../types'

const S_CURVE = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.15 },
  { x: 0.75, y: 0.85 },
  { x: 1, y: 1 }
]

describe('compileCurve (monotone cubic)', () => {
  it('passes through every control point', () => {
    const f = compileCurve(S_CURVE)
    for (const p of S_CURVE) expect(f(p.x)).toBeCloseTo(p.y, 10)
  })

  it('is the identity for the default diagonal', () => {
    const f = compileCurve(identityPoints())
    for (let i = 0; i <= 20; i++) expect(f(i / 20)).toBeCloseTo(i / 20, 12)
  })

  it('never decreases for monotone data (no overshoot)', () => {
    // Steep step: a naive cubic would ring below 0.1 / above 0.9 here.
    const f = compileCurve([
      { x: 0, y: 0.1 },
      { x: 0.45, y: 0.1 },
      { x: 0.55, y: 0.9 },
      { x: 1, y: 0.9 }
    ])
    let prev = -1
    for (let i = 0; i <= 1000; i++) {
      const y = f(i / 1000)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(y).toBeGreaterThanOrEqual(0.1 - 1e-12)
      expect(y).toBeLessThanOrEqual(0.9 + 1e-12)
      prev = y
    }
  })

  it('holds flat outside the end points (black / white point)', () => {
    const f = compileCurve([
      { x: 0.2, y: 0 },
      { x: 0.8, y: 1 }
    ])
    expect(f(0)).toBe(0)
    expect(f(0.1)).toBe(0)
    expect(f(0.9)).toBe(1)
    expect(f(0.5)).toBeCloseTo(0.5, 10)
  })

  it('zeroes tangents at a local extremum', () => {
    const m = monotoneTangents([
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0 }
    ])
    expect(m[1]).toBe(0)
  })
})

describe('buildCurvesLut', () => {
  it('is the identity LUT for identity curves', () => {
    const lut = buildCurvesLut(identityCurves())
    expect(lut.length).toBe(1024)
    expect(isIdentityLut(lut)).toBe(true)
    expect(lut[3]).toBe(255)
  })

  it('composes channel(master(x))', () => {
    const invert = [
      { x: 0, y: 1 },
      { x: 1, y: 0 }
    ]
    const curves: ColorCurves = { ...identityCurves(), master: invert, r: invert }
    const lut = buildCurvesLut(curves)
    // Red: inverted twice = identity. Green/blue: inverted once.
    expect(lut[10 * 4]).toBe(10)
    expect(lut[10 * 4 + 1]).toBe(245)
    expect(lut[10 * 4 + 2]).toBe(245)
  })

  it('applies an S-curve: darker shadows, brighter highlights, fixed ends', () => {
    const lut = buildCurvesLut({ ...identityCurves(), master: S_CURVE })
    expect(lut[0]).toBe(0)
    expect(lut[255 * 4]).toBe(255)
    expect(lut[64 * 4]).toBeLessThan(64)
    expect(lut[192 * 4]).toBeGreaterThan(192)
  })
})

describe('isIdentityCurves', () => {
  it('is true for absent / default curves and extra points on the diagonal', () => {
    expect(isIdentityCurves(undefined)).toBe(true)
    expect(isIdentityCurves(identityCurves())).toBe(true)
    const onDiag = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.3 },
      { x: 1, y: 1 }
    ]
    expect(isIdentityCurves({ ...identityCurves(), g: onDiag })).toBe(true)
  })

  it('is false once any channel bends', () => {
    expect(isIdentityCurves({ ...identityCurves(), b: S_CURVE })).toBe(false)
  })
})

describe('normalizePoints / sanitizeCurves (project-file validation)', () => {
  it('clamps, sorts and drops malformed points', () => {
    const pts = normalizePoints([{ x: 1.5, y: 2 }, null, { x: 'a', y: 0 }, { x: 0.5, y: NaN }, { x: -1, y: -0.2 }, { x: 0.4, y: 0.6 }])
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 0.4, y: 0.6 },
      { x: 1, y: 1 }
    ])
  })

  it('drops near-duplicate x values and caps the count', () => {
    expect(normalizePoints([{ x: 0, y: 0 }, { x: 0.001, y: 0.5 }, { x: 1, y: 1 }])).toHaveLength(2)
    const many = Array.from({ length: 40 }, (_, i) => ({ x: i / 39, y: i / 39 }))
    expect(normalizePoints(many)).toHaveLength(MAX_CURVE_POINTS)
  })

  it('falls back to identity with fewer than two usable points', () => {
    expect(normalizePoints([{ x: 0.5, y: 0.5 }])).toEqual(identityPoints())
    expect(normalizePoints('nope')).toEqual(identityPoints())
  })

  it('returns undefined for absent, garbage or identity curves', () => {
    expect(sanitizeCurves(undefined)).toBeUndefined()
    expect(sanitizeCurves([1, 2])).toBeUndefined()
    expect(sanitizeCurves({ master: identityPoints() })).toBeUndefined()
  })

  it('keeps a real curve and fills missing channels with identity', () => {
    const c = sanitizeCurves({ r: S_CURVE })
    expect(c?.r).toEqual(S_CURVE)
    expect(c?.master).toEqual(identityPoints())
    expect(c?.b).toEqual(identityPoints())
  })
})

describe('curve editing helpers', () => {
  it('moveCurvePoint keeps x between neighbours and clamps y', () => {
    const moved = moveCurvePoint(S_CURVE, 1, 0.9, 1.4)
    expect(moved[1].x).toBeCloseTo(0.74, 10)
    expect(moved[1].y).toBe(1)
    expect(moveCurvePoint(S_CURVE, 0, -0.5, 0.2)[0]).toEqual({ x: 0, y: 0.2 })
    expect(S_CURVE[1]).toEqual({ x: 0.25, y: 0.15 }) // input untouched
  })

  it('addCurvePoint inserts in x order and refuses near-duplicates', () => {
    const r = addCurvePoint(identityPoints(), 0.5, 0.7)
    expect(r?.index).toBe(1)
    expect(r?.points.map((p) => p.x)).toEqual([0, 0.5, 1])
    expect(addCurvePoint(r!.points, 0.505, 0.2)).toBeNull()
  })

  it('addCurvePoint refuses past the point cap', () => {
    const full = Array.from({ length: MAX_CURVE_POINTS }, (_, i) => ({ x: i / (MAX_CURVE_POINTS - 1), y: 0 }))
    expect(addCurvePoint(full, 0.03, 0.5)).toBeNull()
  })

  it('removeCurvePoint keeps at least two points', () => {
    expect(removeCurvePoint(S_CURVE, 1)).toHaveLength(3)
    expect(removeCurvePoint(identityPoints(), 0)).toEqual(identityPoints())
  })
})
