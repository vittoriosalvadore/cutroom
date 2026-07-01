// Cutroom per-track audio FX, in ONE processor: 3-band EQ + compressor + noise
// gate + sidechain ducker.
//
// This file is loaded verbatim by AudioWorklet.addModule() and runs in the
// AudioWorkletGlobalScope, which has NO module system — so it must be plain,
// dependency-free classic JavaScript (no import/export, no TypeScript).
//
// input[0] = the track signal (post fader, pre pan). input[1] = the OPTIONAL
// duck trigger ("key") — another track's post-fader signal. output[0] = the
// processed track signal. All params are k-rate (one value per render quantum).
//
// Signal flow per sample: EQ -> [gate gain] x [comp gain] x [duck gain]. The EQ
// uses RBJ-cookbook biquads, matching FFmpeg bass/equalizer/treble on export;
// the dynamics approximate FFmpeg agate/acompressor/sidechaincompress (same
// knobs/units, perceptually matched). Preview is the WYSIWYG reference.

const MIN_DB = -100
const EPS = 1e-7

// EQ band centre frequencies (Hz). Mirrored by the export filter graph.
const EQ_LOW_HZ = 120
const EQ_MID_HZ = 1000
const EQ_MID_Q = 1.0
const EQ_HIGH_HZ = 8000

function dbToLin(db) {
  return Math.pow(10, db / 20)
}
function linToDb(x) {
  return 20 * Math.log10(x < EPS ? EPS : x)
}
// One-pole smoothing coefficient for a time constant in milliseconds.
function coef(ms, sr) {
  if (ms <= 0) return 0
  return Math.exp(-1 / ((sr * ms) / 1000))
}

// RBJ-cookbook biquad with per-channel state (transposed direct form II).
class Biquad {
  constructor() {
    this.b0 = 1
    this.b1 = 0
    this.b2 = 0
    this.a1 = 0
    this.a2 = 0
    this.z1 = [0, 0]
    this.z2 = [0, 0]
  }
  set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
  }
  lowShelf(f0, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * f0) / sr
    const c = Math.cos(w0)
    const alpha = (Math.sin(w0) / 2) * Math.SQRT2 // shelf slope S=1
    const sa = 2 * Math.sqrt(A) * alpha
    this.set(
      A * (A + 1 - (A - 1) * c + sa),
      2 * A * (A - 1 - (A + 1) * c),
      A * (A + 1 - (A - 1) * c - sa),
      A + 1 + (A - 1) * c + sa,
      -2 * (A - 1 + (A + 1) * c),
      A + 1 + (A - 1) * c - sa
    )
  }
  highShelf(f0, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * f0) / sr
    const c = Math.cos(w0)
    const alpha = (Math.sin(w0) / 2) * Math.SQRT2
    const sa = 2 * Math.sqrt(A) * alpha
    this.set(
      A * (A + 1 + (A - 1) * c + sa),
      -2 * A * (A - 1 + (A + 1) * c),
      A * (A + 1 + (A - 1) * c - sa),
      A + 1 - (A - 1) * c + sa,
      2 * (A - 1 - (A + 1) * c),
      A + 1 - (A - 1) * c - sa
    )
  }
  peaking(f0, Q, gainDb, sr) {
    const A = Math.pow(10, gainDb / 40)
    const w0 = (2 * Math.PI * f0) / sr
    const c = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Q)
    this.set(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A)
  }
  process(x, ch) {
    const y = this.b0 * x + this.z1[ch]
    this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch]
    this.z2[ch] = this.b2 * x - this.a2 * y
    return y
  }
}

class DynamicsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = 'k-rate'
    return [
      { name: 'eqEnabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'eqLowDb', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: k },
      { name: 'eqMidDb', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: k },
      { name: 'eqHighDb', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: k },
      { name: 'compEnabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'compThresholdDb', defaultValue: -18, minValue: MIN_DB, maxValue: 0, automationRate: k },
      { name: 'compRatio', defaultValue: 3, minValue: 1, maxValue: 20, automationRate: k },
      { name: 'compAttackMs', defaultValue: 20, minValue: 0, maxValue: 2000, automationRate: k },
      { name: 'compReleaseMs', defaultValue: 200, minValue: 0, maxValue: 5000, automationRate: k },
      { name: 'compMakeupDb', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: k },
      { name: 'gateEnabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'gateThresholdDb', defaultValue: -45, minValue: MIN_DB, maxValue: 0, automationRate: k },
      { name: 'gateRangeDb', defaultValue: -60, minValue: MIN_DB, maxValue: 0, automationRate: k },
      { name: 'gateRatio', defaultValue: 2, minValue: 1, maxValue: 20, automationRate: k },
      { name: 'gateAttackMs', defaultValue: 5, minValue: 0, maxValue: 2000, automationRate: k },
      { name: 'gateReleaseMs', defaultValue: 120, minValue: 0, maxValue: 5000, automationRate: k },
      { name: 'duckEnabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
      { name: 'duckThresholdDb', defaultValue: -30, minValue: MIN_DB, maxValue: 0, automationRate: k },
      { name: 'duckRatio', defaultValue: 8, minValue: 1, maxValue: 20, automationRate: k },
      { name: 'duckAttackMs', defaultValue: 15, minValue: 0, maxValue: 2000, automationRate: k },
      { name: 'duckReleaseMs', defaultValue: 250, minValue: 0, maxValue: 5000, automationRate: k }
    ]
  }

  constructor() {
    super()
    this.det = 0 // post-EQ signal level follower (linear)
    this.keyDet = 0 // trigger level follower (linear)
    this.gateGain = 1
    this.compGain = 1 // smoothed compressor gain-reduction (linear, <=1)
    this.duckGain = 1
    this.detCoef = coef(2, sampleRate)
    this.low = new Biquad()
    this.mid = new Biquad()
    this.high = new Biquad()
    this.eqLo = NaN
    this.eqMid = NaN
    this.eqHi = NaN
    this.eqd = [0, 0]
  }

  process(inputs, outputs, params) {
    const input = inputs[0]
    const key = inputs[1]
    const output = outputs[0]
    if (!input || input.length === 0) return true // nothing upstream -> silence

    const nCh = input.length
    const len = input[0].length
    const keyCh = key && key.length ? key.length : 0

    const eqOn = params.eqEnabled[0] >= 0.5
    if (eqOn) {
      const lo = params.eqLowDb[0]
      const md = params.eqMidDb[0]
      const hi = params.eqHighDb[0]
      if (lo !== this.eqLo || md !== this.eqMid || hi !== this.eqHi) {
        this.low.lowShelf(EQ_LOW_HZ, lo, sampleRate)
        this.mid.peaking(EQ_MID_HZ, EQ_MID_Q, md, sampleRate)
        this.high.highShelf(EQ_HIGH_HZ, hi, sampleRate)
        this.eqLo = lo
        this.eqMid = md
        this.eqHi = hi
      }
    }

    const compOn = params.compEnabled[0] >= 0.5
    const cThr = params.compThresholdDb[0]
    const cRatio = Math.max(1, params.compRatio[0])
    const cAtt = coef(params.compAttackMs[0], sampleRate)
    const cRel = coef(params.compReleaseMs[0], sampleRate)
    const cMakeup = dbToLin(params.compMakeupDb[0])

    const gateOn = params.gateEnabled[0] >= 0.5
    const gThr = params.gateThresholdDb[0]
    const gRange = params.gateRangeDb[0]
    const gRatio = Math.max(1, params.gateRatio[0])
    const gAtt = coef(params.gateAttackMs[0], sampleRate)
    const gRel = coef(params.gateReleaseMs[0], sampleRate)

    const duckOn = params.duckEnabled[0] >= 0.5 && keyCh > 0
    const dThr = params.duckThresholdDb[0]
    const dRatio = Math.max(1, params.duckRatio[0])
    const dAtt = coef(params.duckAttackMs[0], sampleRate)
    const dRel = coef(params.duckReleaseMs[0], sampleRate)

    const dc = this.detCoef

    for (let i = 0; i < len; i++) {
      // ---- EQ (per channel) + post-EQ level detector (RMS, mono-summed) ----
      let energy = 0
      for (let c = 0; c < nCh; c++) {
        let x = input[c][i]
        if (eqOn) x = this.high.process(this.mid.process(this.low.process(x, c), c), c)
        this.eqd[c] = x
        energy += x * x
      }
      const mono = Math.sqrt(energy / nCh)
      this.det = mono + (this.det - mono) * dc
      const lvl = linToDb(this.det)

      let keyMono = 0
      if (keyCh > 0) {
        let ke = 0
        for (let c = 0; c < keyCh; c++) {
          const s = key[c][i]
          ke += s * s
        }
        keyMono = Math.sqrt(ke / keyCh)
      }
      this.keyDet = keyMono + (this.keyDet - keyMono) * dc

      // ---- gate (downward expander) ----
      let gateTarget = 1
      if (gateOn) {
        let gdb = (gThr - lvl) * (1 - gRatio)
        if (gdb > 0) gdb = 0
        if (gdb < gRange) gdb = gRange
        gateTarget = dbToLin(gdb)
      }
      {
        const cf = gateTarget > this.gateGain ? gAtt : gRel
        this.gateGain = gateTarget + (this.gateGain - gateTarget) * cf
      }

      // ---- compressor (downward, on the post-EQ level) ----
      let compTarget = 1
      if (compOn) {
        const over = lvl - cThr
        if (over > 0) compTarget = dbToLin(-over * (1 - 1 / cRatio))
      }
      {
        // attack = engage reduction (gain falling); release = recover (rising)
        const cf = compTarget < this.compGain ? cAtt : cRel
        this.compGain = compTarget + (this.compGain - compTarget) * cf
      }

      // ---- duck (compressor keyed off the trigger) ----
      let duckTarget = 1
      if (duckOn) {
        const klvl = linToDb(this.keyDet)
        const over = klvl - dThr
        if (over > 0) duckTarget = dbToLin(-over * (1 - 1 / dRatio))
      }
      {
        const cf = duckTarget < this.duckGain ? dAtt : dRel
        this.duckGain = duckTarget + (this.duckGain - duckTarget) * cf
      }

      const g = this.gateGain * (compOn ? this.compGain * cMakeup : 1) * this.duckGain
      for (let c = 0; c < output.length; c++) {
        output[c][i] = this.eqd[c < nCh ? c : 0] * g
      }
    }
    return true
  }
}

registerProcessor('cutroom-dynamics', DynamicsProcessor)
