import { describe, it, expect } from 'vitest'
import { sanitize, DEFAULT_SETTINGS } from './settings'

describe('settings sanitize', () => {
  it('drops non-objects', () => {
    expect(sanitize(null)).toEqual({})
    expect(sanitize('nope')).toEqual({})
    expect(sanitize(42)).toEqual({})
  })

  it('keeps valid values', () => {
    const clean = sanitize({
      hardwareAcceleration: false,
      defaultFadeSec: 1.25,
      exportPreset: 'slow',
      theme: 'midnight',
      accent: '#abcdef',
      density: 'compact'
    })
    expect(clean.hardwareAcceleration).toBe(false)
    expect(clean.defaultFadeSec).toBe(1.25)
    expect(clean.exportPreset).toBe('slow')
    expect(clean.theme).toBe('midnight')
    expect(clean.accent).toBe('#abcdef')
    expect(clean.density).toBe('compact')
  })

  it('omits a NaN-coercing fade so the default is used (no NaN corruption)', () => {
    expect(sanitize({ defaultFadeSec: 'abc' })).not.toHaveProperty('defaultFadeSec')
    expect(sanitize({ defaultFadeSec: {} })).not.toHaveProperty('defaultFadeSec')
    expect(sanitize({ defaultFadeSec: NaN })).not.toHaveProperty('defaultFadeSec')
  })

  it('clamps out-of-range numbers to the UI bounds', () => {
    expect(sanitize({ defaultFadeSec: 99 }).defaultFadeSec).toBe(2)
    expect(sanitize({ defaultFadeSec: 0 }).defaultFadeSec).toBe(0.1)
    expect(sanitize({ exportCrf: 5 }).exportCrf).toBe(14)
    expect(sanitize({ exportCrf: 60 }).exportCrf).toBe(28)
  })

  it('rejects invalid enums and bad accent hex', () => {
    expect(sanitize({ theme: 'neon' })).not.toHaveProperty('theme')
    expect(sanitize({ exportPreset: 'turbo' })).not.toHaveProperty('exportPreset')
    expect(sanitize({ density: 'cozy' })).not.toHaveProperty('density')
    expect(sanitize({ accent: '#12' })).not.toHaveProperty('accent') // too short
    expect(sanitize({ accent: '#1234' })).not.toHaveProperty('accent') // 4-digit not valid CSS
    expect(sanitize({ accent: 'blue' })).not.toHaveProperty('accent')
    expect(sanitize({ accent: '#abc' }).accent).toBe('#abc') // 3-digit ok
  })

  it('treats a wrong-typed boolean string as invalid (not truthy)', () => {
    expect(sanitize({ snapping: 'false' })).not.toHaveProperty('snapping')
    expect(sanitize({ snapping: false }).snapping).toBe(false)
  })

  it('every default value survives a round-trip through sanitize', () => {
    expect(sanitize(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })
})
