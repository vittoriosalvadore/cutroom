// ---------------------------------------------------------------------------
// Convolution-reverb impulse response, shared VERBATIM by the preview (renderer:
// AudioBuffer -> ConvolverNode) and the export (main: float WAV -> FFmpeg afir).
// Pure: no electron / DOM / Node imports, so both processes (and vitest) can
// import it, and preview and export convolve with the SAME samples.
//
// The IR is exponentially-decaying stereo noise from a seeded PRNG:
//   pre-delay (silence) -> 5 ms onset ramp -> noise * 10^(-3 t / decay)
// i.e. `decaySec` is the RT60 (the tail is 60 dB down at its end). Tone is a
// one-pole low-pass whose cutoff glides down over the tail (highs die first,
// like a real room); it has unity DC gain, so darker tones lose treble without
// changing the level of the low end.
//
// Level: the IR is scaled so the UNFILTERED noise tail has unit energy per
// channel (sum h^2 = 1), so a broadband signal comes out of the wet path at
// roughly its dry loudness. Neither side applies its own normalization on top:
// the ConvolverNode is created with normalize = false and afir runs with
// irnorm=-1:irgain=1 (a plain convolution), so wet levels match exactly.
//
// Determinism: only +, *, Math.exp/Math.pow and a 32-bit integer PRNG, in a
// fixed order, then rounded to Float32 — identical in main and renderer (same
// V8). Parameters are in seconds, so an IR built at the AudioContext rate and
// one built at the project rate describe the same reverb.
// ---------------------------------------------------------------------------

/** Reverb shape (what the IR depends on). */
export interface ReverbShape {
  /** RT60 in seconds. */
  decaySec: number
  /** Silence before the tail, in ms. */
  preDelayMs: number
  /** 0 = dark (early high-frequency damping) .. 1 = bright. */
  tone: number
}

/** Full per-track reverb settings as they reach the export (mix = wet 0..1). */
export interface ReverbSettings extends ReverbShape {
  mix: number
}

/** Accepted ranges (the Inspector sliders use the same bounds). */
export const REVERB_LIMITS = {
  mix: [0, 1],
  decaySec: [0.1, 10],
  preDelayMs: [0, 250],
  tone: [0, 1]
} as const

export const REVERB_DEFAULTS: ReverbSettings = { mix: 0.25, decaySec: 1.8, preDelayMs: 20, tone: 0.5 }

function clampTo(v: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback
}

/** Clamp every field into range; non-numeric / non-finite values take the default. */
export function clampReverb(r: Partial<Record<keyof ReverbSettings, unknown>>): ReverbSettings {
  return {
    mix: clampTo(r.mix, REVERB_LIMITS.mix, REVERB_DEFAULTS.mix),
    decaySec: clampTo(r.decaySec, REVERB_LIMITS.decaySec, REVERB_DEFAULTS.decaySec),
    preDelayMs: clampTo(r.preDelayMs, REVERB_LIMITS.preDelayMs, REVERB_DEFAULTS.preDelayMs),
    tone: clampTo(r.tone, REVERB_LIMITS.tone, REVERB_DEFAULTS.tone)
  }
}

/**
 * Equal-power dry/wet crossfade for `mix` in [0, 1]: 0 = dry only, 1 = wet
 * only, and uncorrelated dry + wet keep constant power in between. The preview
 * gain nodes and the export `volume` filters both use exactly these values.
 */
export function reverbMixGains(mix: number): { dry: number; wet: number } {
  const m = Math.max(0, Math.min(1, Number.isFinite(mix) ? mix : 0))
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) }
}

/** IR length in samples (pre-delay + RT60 tail). */
export function reverbIRLength(shape: ReverbShape, sampleRate: number): number {
  const s = clampReverb(shape)
  return Math.round((s.preDelayMs / 1000) * sampleRate) + Math.max(1, Math.ceil(s.decaySec * sampleRate))
}

/** Cache key: two shapes with the same key produce identical IRs. */
export function reverbShapeKey(shape: ReverbShape, sampleRate: number): string {
  const s = clampReverb(shape)
  return `${sampleRate}:${s.decaySec}:${s.preDelayMs}:${s.tone}`
}

/** mulberry32: a tiny, well-mixed 32-bit PRNG. Returns floats in [-1, 1). */
function noise(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

// Fixed per-channel seeds: the same reverb always gets the same IR, and the two
// channels are decorrelated (which is what makes the tail sound wide).
const SEEDS = [0x2545f491, 0x9e3779b9]
const ONSET_SEC = 0.005

/**
 * Generate the stereo IR for `shape` at `sampleRate`. Deterministic: equal
 * inputs give bit-identical output.
 */
export function generateReverbIR(shape: ReverbShape, sampleRate: number): [Float32Array, Float32Array] {
  const s = clampReverb(shape)
  const sr = Math.max(8000, Math.round(sampleRate))
  const pre = Math.round((s.preDelayMs / 1000) * sr)
  const tail = Math.max(1, Math.ceil(s.decaySec * sr))
  const onset = Math.max(1, Math.round(ONSET_SEC * sr))
  // Per-sample amplitude decay: 10^(-3 / (RT60 * sr)) -> -60 dB after decaySec.
  const decayStep = Math.pow(10, -3 / (s.decaySec * sr))
  // Low-pass cutoff glides from fcStart to fcEnd across the tail (exponentially).
  const fcStart = 1000 * Math.pow(16, s.tone) // 1 kHz (dark) .. 16 kHz (bright)
  const fcEnd = fcStart * (0.15 + 0.35 * s.tone)
  const fcStep = Math.pow(fcEnd / fcStart, 1 / tail)

  const raw = [new Float64Array(tail), new Float64Array(tail)]
  let energy = 0
  for (let c = 0; c < 2; c++) {
    const rnd = noise(SEEDS[c])
    let env = 1
    for (let n = 0; n < tail; n++) {
      const ramp = n < onset ? (n + 1) / onset : 1
      const v = rnd() * env * ramp
      raw[c][n] = v
      energy += v * v
      env *= decayStep
    }
  }
  // Unit energy per channel (average of the two) for the unfiltered tail.
  const gain = energy > 0 ? 1 / Math.sqrt(energy / 2) : 0

  const out: [Float32Array, Float32Array] = [new Float32Array(pre + tail), new Float32Array(pre + tail)]
  for (let c = 0; c < 2; c++) {
    let fc = fcStart
    let y = 0
    const r = raw[c]
    const o = out[c]
    for (let n = 0; n < tail; n++) {
      // One-pole low-pass, unity DC gain: y += k (x - y), k from the cutoff.
      const k = 1 - Math.exp((-2 * Math.PI * Math.min(fc, sr * 0.45)) / sr)
      y += k * (r[n] - y)
      o[pre + n] = y * gain
      fc *= fcStep
    }
  }
  return out
}

/**
 * Encode channels as a 32-bit IEEE-float WAV (format 3), interleaved. Float
 * keeps the IR bit-exact on its way into FFmpeg (no 16-bit quantization).
 */
export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nc = channels.length
  const n = nc > 0 ? channels[0].length : 0
  const dataBytes = n * nc * 4
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 3, true) // WAVE_FORMAT_IEEE_FLOAT
  v.setUint16(22, nc, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * nc * 4, true)
  v.setUint16(32, nc * 4, true)
  v.setUint16(34, 32, true)
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)
  let off = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      v.setFloat32(off, channels[c][i], true)
      off += 4
    }
  }
  return new Uint8Array(buf)
}
