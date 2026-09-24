import { describe, it, expect } from 'vitest'
import {
  clampReverb,
  encodeWavFloat32,
  generateReverbIR,
  reverbIRLength,
  reverbMixGains,
  reverbShapeKey,
  REVERB_DEFAULTS
} from './reverb'

const shape = { decaySec: 1.2, preDelayMs: 30, tone: 0.5 }
const energy = (a: Float32Array): number => a.reduce((s, v) => s + v * v, 0)

describe('generateReverbIR', () => {
  it('is deterministic: equal inputs give bit-identical IRs', () => {
    const [l1, r1] = generateReverbIR(shape, 48000)
    const [l2, r2] = generateReverbIR({ ...shape }, 48000)
    expect(Buffer.from(l1.buffer).equals(Buffer.from(l2.buffer))).toBe(true)
    expect(Buffer.from(r1.buffer).equals(Buffer.from(r2.buffer))).toBe(true)
  })

  it('pins the generator output (changing it breaks saved-project parity)', () => {
    const [l, r] = generateReverbIR({ decaySec: 0.5, preDelayMs: 0, tone: 0.5 }, 48000)
    // Spot-check a few samples; any change to the PRNG/envelope/filter shows here.
    const pick = (a: Float32Array): number[] => [10, 240, 1000, 12000].map((i) => Number(a[i].toFixed(6)))
    expect({ l: pick(l), r: pick(r) }).toMatchInlineSnapshot(`
      {
        "l": [
          0.000348,
          0.003014,
          -0.014134,
          0.000275,
        ],
        "r": [
          -0.000062,
          0.022431,
          -0.005144,
          -0.00041,
        ],
      }
    `)
  })

  it('different shapes give different IRs; the channels are decorrelated', () => {
    const [a] = generateReverbIR(shape, 48000)
    const [b] = generateReverbIR({ ...shape, tone: 0.9 }, 48000)
    expect(a.length).toBe(b.length)
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(false)
    const [l, r] = generateReverbIR(shape, 48000)
    let dot = 0
    for (let i = 0; i < l.length; i++) dot += l[i] * r[i]
    expect(Math.abs(dot) / Math.sqrt(energy(l) * energy(r))).toBeLessThan(0.1)
  })

  it('is pre-delay silence followed by an RT60 tail', () => {
    const sr = 48000
    const [l, r] = generateReverbIR(shape, sr)
    const pre = Math.round(0.03 * sr)
    expect(l.length).toBe(reverbIRLength(shape, sr))
    expect(l.length).toBe(pre + Math.ceil(1.2 * sr))
    expect(l.subarray(0, pre).every((v) => v === 0)).toBe(true)
    expect(r.subarray(0, pre).every((v) => v === 0)).toBe(true)
    expect(l[pre + 400]).not.toBe(0)
    // The last 10% of the tail carries a vanishing share of the energy (~-54 dB and down).
    const tail = l.subarray(Math.floor(l.length * 0.9))
    expect(energy(tail) / energy(l)).toBeLessThan(1e-4)
  })

  it('is level-normalized: ~unity gain in the audible band, independent of sample rate', () => {
    // Mean |H(f)|^2 over 100..2100 Hz (a random IR's response fluctuates per
    // frequency; the mean is its level). Preview builds the IR at the
    // AudioContext rate, export at the project rate — both must sound the same.
    const bandGain = (sr: number): number => {
      const [l] = generateReverbIR({ decaySec: 0.2, preDelayMs: 0, tone: 1 }, sr)
      let sum = 0
      let count = 0
      for (let f = 100; f <= 2100; f += 5) {
        let re = 0
        let im = 0
        const w = (2 * Math.PI * f) / sr
        for (let k = 0; k < l.length; k++) {
          re += l[k] * Math.cos(w * k)
          im -= l[k] * Math.sin(w * k)
        }
        sum += re * re + im * im
        count++
      }
      return 10 * Math.log10(sum / count)
    }
    const db = [44100, 48000, 96000].map(bandGain)
    for (const d of db) expect(Math.abs(d)).toBeLessThan(1.5)
    expect(Math.max(...db) - Math.min(...db)).toBeLessThan(1.5)
  })

  it('darker tones lose treble, not level at DC (unity-DC-gain low-pass)', () => {
    const [bright] = generateReverbIR({ decaySec: 1, preDelayMs: 0, tone: 1 }, 48000)
    const [dark] = generateReverbIR({ decaySec: 1, preDelayMs: 0, tone: 0 }, 48000)
    expect(energy(dark)).toBeLessThan(energy(bright) * 0.5)
  })

  it('clamps out-of-range shapes instead of producing huge / empty IRs', () => {
    const [l] = generateReverbIR({ decaySec: 1e9, preDelayMs: -5, tone: 7 }, 48000)
    expect(l.length).toBe(10 * 48000)
    const [m] = generateReverbIR({ decaySec: NaN, preDelayMs: NaN, tone: NaN }, 48000)
    expect(m.length).toBe(reverbIRLength(REVERB_DEFAULTS, 48000))
  })
})

describe('clampReverb', () => {
  it('clamps into the accepted ranges and defaults garbage', () => {
    expect(clampReverb({ mix: 2, decaySec: 0, preDelayMs: 999, tone: -1 })).toEqual({
      mix: 1,
      decaySec: 0.1,
      preDelayMs: 250,
      tone: 0
    })
    expect(clampReverb({ mix: 'x', decaySec: Infinity, preDelayMs: null, tone: undefined })).toEqual(REVERB_DEFAULTS)
  })
})

describe('reverbMixGains', () => {
  it('is an equal-power dry/wet crossfade', () => {
    expect(reverbMixGains(0)).toEqual({ dry: 1, wet: 0 })
    const one = reverbMixGains(1)
    expect(one.dry).toBeCloseTo(0, 12)
    expect(one.wet).toBe(1)
    for (const m of [0.1, 0.25, 0.5, 0.9]) {
      const { dry, wet } = reverbMixGains(m)
      expect(dry * dry + wet * wet).toBeCloseTo(1, 12)
    }
    expect(reverbMixGains(5)).toEqual(reverbMixGains(1))
    expect(reverbMixGains(NaN)).toEqual({ dry: 1, wet: 0 })
  })
})

describe('reverbShapeKey', () => {
  it('ignores mix (mix does not change the IR) but not the shape or rate', () => {
    expect(reverbShapeKey(shape, 48000)).toBe(reverbShapeKey({ ...shape }, 48000))
    expect(reverbShapeKey(shape, 48000)).not.toBe(reverbShapeKey(shape, 44100))
    expect(reverbShapeKey(shape, 48000)).not.toBe(reverbShapeKey({ ...shape, decaySec: 1.3 }, 48000))
  })
})

describe('encodeWavFloat32', () => {
  it('writes a float WAV whose samples round-trip exactly', () => {
    const [l, r] = generateReverbIR({ decaySec: 0.2, preDelayMs: 5, tone: 0.3 }, 48000)
    const wav = Buffer.from(encodeWavFloat32([l, r], 48000))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(3) // IEEE float
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.readUInt32LE(24)).toBe(48000)
    expect(wav.readUInt16LE(34)).toBe(32)
    expect(wav.readUInt32LE(40)).toBe(l.length * 8)
    expect(wav.length).toBe(44 + l.length * 8)
    for (const i of [0, 240, 241, 5000, l.length - 1]) {
      expect(wav.readFloatLE(44 + i * 8)).toBe(l[i])
      expect(wav.readFloatLE(44 + i * 8 + 4)).toBe(r[i])
    }
  })
})
