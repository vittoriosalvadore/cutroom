import { describe, it, expect } from 'vitest'
import { defaultTranscribeLanguage, isSilent, modelHub, splitAtQuiet } from './transcribeOptions'

describe('transcribe options', () => {
  it('uses multilingual checkpoints', () => {
    expect(modelHub('base')).toBe('Xenova/whisper-base')
    expect(modelHub('small')).toBe('Xenova/whisper-small')
    expect(modelHub('tiny')).not.toMatch(/\.en$/)
  })

  it('derives the spoken language from the OS locale', () => {
    expect(defaultTranscribeLanguage('it-IT')).toBe('italian')
    expect(defaultTranscribeLanguage('en_US')).toBe('english')
    expect(defaultTranscribeLanguage('xx')).toBe('auto')
    expect(defaultTranscribeLanguage(undefined)).toBe('auto')
  })
})

describe('splitAtQuiet', () => {
  const sr = 1000
  it('covers the input with windows no longer than the max, cut at the quiet spot', () => {
    // 25 s of "speech" with a quiet gap at 8.0–8.3 s
    const pcm = new Float32Array(25 * sr).fill(0.5)
    pcm.fill(0, 8000, 8300)
    const w = splitAtQuiet(pcm, sr, 10, 3)
    expect(w[0][0]).toBe(0)
    expect(w[0][1]).toBeGreaterThanOrEqual(8000)
    expect(w[0][1]).toBeLessThanOrEqual(8300)
    for (let i = 1; i < w.length; i++) expect(w[i][0]).toBe(w[i - 1][1])
    expect(w[w.length - 1][1]).toBe(pcm.length)
    for (const [a, b] of w) expect(b - a).toBeLessThanOrEqual(10 * sr)
  })

  it('returns one window when the input fits', () => {
    expect(splitAtQuiet(new Float32Array(500), sr, 10, 3)).toEqual([[0, 500]])
  })

  it('detects silent windows', () => {
    const pcm = new Float32Array(1000)
    expect(isSilent(pcm, 0, 1000)).toBe(true)
    pcm.fill(0.2)
    expect(isSilent(pcm, 0, 1000)).toBe(false)
  })
})
