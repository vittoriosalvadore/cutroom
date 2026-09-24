// ---------------------------------------------------------------------------
// Pure FFmpeg argument builder for the export audio-mux pass. No electron / fs /
// child_process imports here, so it can be unit-tested in plain Node.
//
// Input 0 is the silent video; inputs 1..N are the audible source files. Each
// audio input is trimmed to its used span, re-timed, gained, faded, and delayed
// to its timeline position, then all are summed (amix, no auto-normalize) and
// brick-limited. Video is stream-copied (never re-encoded); audio is AAC in MP4
// or Opus in WebM, matching the pass-1 container.
//
// Filter order aresample -> atrim -> asetpts -> volume -> afade -> adelay is
// mandatory; reordering produces wrong timing or silence.
//
// Reverb impulse responses (one float WAV per reverb track, written by
// audioMux.ts from the shared generator) are extra inputs AFTER the sources.
// ---------------------------------------------------------------------------

import { clampReverb, reverbIRLength, reverbMixGains, type ReverbSettings } from '../shared/reverb'

/** Resolved per-track gate (see renderer TrackGate). */
export interface MuxGate {
  thresholdDb: number
  rangeDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}
/** Resolved per-track ducker (see renderer TrackDuck). */
export interface MuxDuck {
  triggerTrackId: string
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}
/** Per-track 3-band EQ (see renderer TrackEQ). */
export interface MuxEQ {
  lowDb: number
  midDb: number
  highDb: number
}
/** Per-track convolution reverb (see renderer TrackReverb); mix = wet 0..1. */
export type MuxReverb = ReverbSettings
/** Per-track compressor (see renderer TrackComp). */
export interface MuxComp {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}

export interface MuxClip {
  path: string
  startSec: number
  durationSec: number
  inSec: number
  volume: number
  fadeInSec: number
  fadeOutSec: number
  trackGainDb: number
  pan: number
  /** Playback speed (1 = normal). Pitches audio like tape (asetrate). */
  speed: number
  /** Owning track id — clips group into per-track submixes when track FX is used. */
  trackId: string
  gate?: MuxGate
  duck?: MuxDuck
  eq?: MuxEQ
  comp?: MuxComp
  reverb?: MuxReverb
}

/**
 * The source span a clip consumes = durationSec * speed (it reads that many
 * source seconds, played back over durationSec of timeline).
 */
export function clipSrcSpan(c: MuxClip): number {
  return c.durationSec * (c.speed && c.speed > 0 ? c.speed : 1)
}

/**
 * Speed filter for the per-clip chain. asetrate reinterprets the samples faster
 * (and higher-pitched, matching the preview's BufferSource.playbackRate), then
 * aresample returns to the project rate. Empty at speed 1, so non-speed clips
 * keep the byte-identical chain.
 */
export function speedFilter(speed: number, sampleRate: number): string {
  if (!speed || Math.abs(speed - 1) < 1e-3) return ''
  return `asetrate=${Math.round(sampleRate * speed)},aresample=${sampleRate},asetpts=PTS-STARTPTS,`
}

/**
 * Equal-power stereo pan gains for `pan` in [-1, 1]. Mirrors WebAudio's
 * StereoPannerNode mono algorithm exactly, so panning a mono source sounds
 * identical in the preview and the export.
 */
export function panGains(pan: number): { left: number; right: number } {
  const p = Math.max(-1, Math.min(1, pan))
  const theta = ((p + 1) / 2) * (Math.PI / 2)
  return { left: Math.cos(theta), right: Math.sin(theta) }
}

/**
 * `pan` filter for an already-STEREO signal that reproduces WebAudio's
 * StereoPannerNode stereo-input algorithm exactly (the side being panned away
 * from is folded into the other with an equal-power gain). Used for the reverb
 * wet branch, which is always stereo in both preview and export.
 */
export function stereoPanFilter(pan: number): string {
  const p = Math.max(-1, Math.min(1, pan))
  const x = p <= 0 ? p + 1 : p
  const gl = Math.cos((x * Math.PI) / 2).toFixed(5)
  const gr = Math.sin((x * Math.PI) / 2).toFixed(5)
  return p <= 0 ? `pan=stereo|c0=c0+${gl}*c1|c1=${gr}*c1` : `pan=stereo|c0=${gl}*c0|c1=c1+${gr}*c0`
}

export interface BuildMuxArgsOptions {
  silentPath: string
  outputPath: string
  sampleRate: number
  clips: MuxClip[]
  /**
   * Exact output length (the video's). apad makes the audio infinite so it
   * always spans the video; -shortest alone is meant to cut it back, but with
   * a stream-copied video FFmpeg 7 never stops, so the length is also set
   * explicitly with -t.
   */
  durationSec?: number
  /**
   * When set, the filtergraph is passed as `-filter_complex_script <path>`
   * (the caller writes `buildMuxGraph(...)` there) instead of inline. A long
   * timeline's graph easily exceeds the Windows 32K command-line limit.
   */
  filterScriptPath?: string
  /**
   * Reverb IR WAV paths, one per `planReverbs(clips)` entry and in that order.
   * They become inputs N+1.. after the sources; the graph's afir filters
   * reference them by that index.
   */
  irPaths?: string[]
  /** Output container (default mp4 = AAC). webm = Opus, which only runs at 48 kHz. */
  container?: 'mp4' | 'webm'
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * Clamp fades to >=0 and scale them down proportionally if they overlap. A pure
 * mirror of the renderer's fades.ts clampFades (main must not import renderer
 * code) so the exported envelope matches the preview when fadeIn+fadeOut > dur.
 */
function clampFades(fadeInSec: number, fadeOutSec: number, durationSec: number): [number, number] {
  let fi = Math.max(0, fadeInSec || 0)
  let fo = Math.max(0, fadeOutSec || 0)
  if (durationSec > 0 && fi + fo > durationSec) {
    const scale = durationSec / (fi + fo)
    fi *= scale
    fo *= scale
  }
  return [fi, fo]
}

/** Clamp to [lo, hi]; non-finite values fall back to `fallback`. */
function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback
}

// FFmpeg rejects out-of-range filter options and aborts the whole mux, while
// the Inspector sliders allow e.g. attack = 0 ms. These mirror the option
// ranges of agate / acompressor / sidechaincompress.
const MIN_THRESHOLD = 0.000976563
const attackMs = (v: number, max: number): number => clampNum(v, 0.01, max, 20)
const releaseMs = (v: number): number => clampNum(v, 0.01, 9000, 250)
const ratio = (v: number): number => clampNum(v, 1, 20, 2)
const threshold = (db: number): string => clampNum(dbToLinear(db), MIN_THRESHOLD, 1, 0.125).toFixed(6)

/**
 * One FFmpeg input per unique source path (inputs 1..N; 0 is the video). A
 * source used by several clips is opened once and fanned out with asplit, so
 * a cut-heavy timeline doesn't spawn one decoder (and one `-i`) per clip.
 * Returns the unique paths, the asplit prelude chains, and each clip's source
 * pad label. Single-use sources keep the plain `[k:a]` label.
 */
function planInputs(clips: MuxClip[]): { paths: string[]; prelude: string[]; labels: string[] } {
  const paths: string[] = []
  const users = new Map<string, number[]>()
  clips.forEach((c, i) => {
    if (!users.has(c.path)) {
      users.set(c.path, [])
      paths.push(c.path)
    }
    users.get(c.path)!.push(i)
  })
  const labels: string[] = new Array(clips.length)
  const prelude: string[] = []
  paths.forEach((p, k) => {
    const input = k + 1
    const idx = users.get(p)!
    if (idx.length === 1) {
      labels[idx[0]] = `[${input}:a]`
      return
    }
    idx.forEach((i, j) => (labels[i] = `[s${input}_${j}]`))
    prelude.push(`[${input}:a]asplit=${idx.length}${idx.map((_, j) => `[s${input}_${j}]`).join('')}`)
  })
  return { paths, prelude, labels }
}

/**
 * The reverb tracks that need an impulse response, in the order their IR
 * inputs are passed to FFmpeg (track first-seen order). Settings are clamped
 * here (main never trusts the renderer's numbers); a zero mix is no reverb.
 */
export function planReverbs(clips: MuxClip[]): { trackId: string; reverb: ReverbSettings }[] {
  const out: { trackId: string; reverb: ReverbSettings }[] = []
  const seen = new Set<string>()
  for (const c of clips) {
    if (seen.has(c.trackId)) continue
    seen.add(c.trackId)
    if (!c.reverb) continue
    const reverb = clampReverb(c.reverb)
    if (reverb.mix > 0) out.push({ trackId: c.trackId, reverb })
  }
  return out
}

/** The full mux filtergraph (see buildMuxArgs). */
export function buildMuxGraph(clips: MuxClip[], sampleRate: number): string {
  const { paths, prelude, labels } = planInputs(clips)
  // Projects with NO gate/duck use the original flat per-clip graph (verified,
  // byte-stable). Only when a track enables gate/duck do we switch to per-track
  // submixing, which is what lets a gate act on a track's mix and a ducker key
  // off another track.
  const usesTrackFx = clips.some((c) => c.gate || c.duck || c.eq || c.comp || c.reverb)
  const graph = usesTrackFx
    ? buildFxGraph(clips, labels, sampleRate, paths.length + 1)
    : buildFlatGraph(clips, labels, sampleRate)
  return [...prelude, graph].join(';')
}

export function buildMuxArgs(opts: BuildMuxArgsOptions): string[] {
  const { silentPath, outputPath, sampleRate, clips, filterScriptPath, durationSec } = opts
  const args: string[] = ['-y', '-i', silentPath]
  for (const p of planInputs(clips).paths) args.push('-i', p)
  for (const p of opts.irPaths ?? []) args.push('-i', p)

  if (filterScriptPath) args.push('-filter_complex_script', filterScriptPath)
  else args.push('-filter_complex', buildMuxGraph(clips, sampleRate))

  // The audio codec follows the container of the pass-1 video being copied:
  // AAC in MP4, Opus in WebM (Opus only runs at 48 kHz, so it is resampled).
  const webm = opts.container === 'webm'
  args.push(
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    ...(webm ? ['-c:a', 'libopus', '-b:a', '160k', '-ar', '48000'] : ['-c:a', 'aac', '-b:a', '192k', '-ar', String(sampleRate)]),
    '-ac', '2',
    '-shortest',
    ...(durationSec && Number.isFinite(durationSec) && durationSec > 0 ? ['-t', durationSec.toFixed(3)] : []),
    ...(webm ? [] : ['-movflags', '+faststart']),
    // Explicit muxer: the caller may write to a `.part` name and rename on success.
    '-f', webm ? 'webm' : 'mp4',
    outputPath
  )
  return args
}

/**
 * Original flat path: one chain per clip, summed by a single amix. apad pads the
 * mix with trailing silence so the audio always spans the full video; -shortest
 * then clips it back to the exact video length. Without apad, audio that ends
 * before the timeline would truncate the whole export.
 */
function buildFlatGraph(clips: MuxClip[], labels: string[], sampleRate: number): string {
  const chains = clips.map((c, i) => {
    const vol = (c.volume ?? 1) * dbToLinear(c.trackGainDb ?? 0)
    let chain =
      `${labels[i]}aresample=${sampleRate},` +
      `atrim=start=${c.inSec.toFixed(3)}:end=${(c.inSec + clipSrcSpan(c)).toFixed(3)},` +
      `asetpts=PTS-STARTPTS,` +
      `${speedFilter(c.speed, sampleRate)}` +
      `volume=${vol.toFixed(4)}`
    const [fi, fo] = clampFades(c.fadeInSec, c.fadeOutSec, c.durationSec)
    if (fi > 0) chain += `,afade=t=in:st=0:d=${fi.toFixed(3)}`
    if (fo > 0) {
      chain += `,afade=t=out:st=${Math.max(0, c.durationSec - fo).toFixed(3)}:d=${fo.toFixed(3)}`
    }
    if (c.pan && Math.abs(c.pan) > 0.001) {
      const { left, right } = panGains(c.pan)
      chain += `,aformat=channel_layouts=stereo,pan=stereo|c0=${left.toFixed(5)}*c0|c1=${right.toFixed(5)}*c1`
    }
    chain += `,adelay=${Math.round(c.startSec * 1000)}:all=1[a${i}]`
    return chain
  })

  let graph = chains.join(';')
  if (clips.length === 1) {
    graph += `;[a0]alimiter=limit=0.97,apad[aout]`
  } else {
    const labels = clips.map((_, i) => `[a${i}]`).join('')
    graph += `;${labels}amix=inputs=${clips.length}:normalize=0:duration=longest,alimiter=limit=0.97,apad[aout]`
  }
  return graph
}

/**
 * Per-track FX path. Clips are mixed per track, then each track bus runs
 * trackGain -> [gate] -> [duck] -> [pan], and the buses are summed. Each duck's
 * sidechain key is split from its trigger's PRE-duck bus (so even mutual A<->B
 * ducking stays a DAG), padded with apad so a short trigger can't truncate the
 * longer ducked track, and forced to stereo (sidechaincompress needs matching
 * layouts). dB levels -> linear; times stay in ms; every option is clamped to
 * FFmpeg's accepted range. Reverb sits after the duck and before the pan (as in
 * the preview chain), on its own dry/wet split; `irBase` is the FFmpeg input
 * index of the first reverb IR.
 */
function buildFxGraph(clips: MuxClip[], labels: string[], sampleRate: number, irBase: number): string {
  const G: string[] = []
  const irInput = new Map(planReverbs(clips).map((r, j) => [r.trackId, { input: irBase + j, reverb: r.reverb }]))

  // 1. per-clip -> [c{i}] (clip volume + fades only; trackGain & pan move to the bus)
  clips.forEach((c, i) => {
    let chain =
      `${labels[i]}aresample=${sampleRate},` +
      `atrim=start=${c.inSec.toFixed(3)}:end=${(c.inSec + clipSrcSpan(c)).toFixed(3)},` +
      `asetpts=PTS-STARTPTS,` +
      `${speedFilter(c.speed, sampleRate)}` +
      `volume=${(c.volume ?? 1).toFixed(4)}`
    const [fi, fo] = clampFades(c.fadeInSec, c.fadeOutSec, c.durationSec)
    if (fi > 0) chain += `,afade=t=in:st=0:d=${fi.toFixed(3)}`
    if (fo > 0) {
      chain += `,afade=t=out:st=${Math.max(0, c.durationSec - fo).toFixed(3)}:d=${fo.toFixed(3)}`
    }
    chain += `,adelay=${Math.round(c.startSec * 1000)}:all=1[c${i}]`
    G.push(chain)
  })

  // group clip indices by track (first-seen order); keep a representative clip
  // per track for the track-level settings (trackGain / pan / gate / duck).
  const order: string[] = []
  const byTrack = new Map<string, number[]>()
  const rep = new Map<string, MuxClip>()
  clips.forEach((c, i) => {
    if (!byTrack.has(c.trackId)) {
      byTrack.set(c.trackId, [])
      order.push(c.trackId)
      rep.set(c.trackId, c)
    }
    byTrack.get(c.trackId)!.push(i)
  })
  const trackK = new Map<string, number>()
  order.forEach((tid, k) => trackK.set(tid, k))

  // 2. per-track bus -> [bus_k] = amix(clips) -> volume(trackGain) -> [gate]
  order.forEach((tid, k) => {
    const info = rep.get(tid)!
    const idx = byTrack.get(tid)!
    const ins = idx.map((i) => `[c${i}]`).join('')
    let bus =
      idx.length === 1
        ? `${ins}volume=${dbToLinear(info.trackGainDb ?? 0).toFixed(4)}`
        : `${ins}amix=inputs=${idx.length}:normalize=0:duration=longest,volume=${dbToLinear(info.trackGainDb ?? 0).toFixed(4)}`
    // EQ -> gate -> compressor (mirrors the preview worklet's signal flow). RBJ
    // shelving/peaking matches the worklet biquads; acompressor pairs with the
    // worklet's compressor (same knobs, perceptually matched).
    if (info.eq) {
      bus +=
        `,bass=g=${info.eq.lowDb}:f=120` +
        `,equalizer=f=1000:t=q:w=1:g=${info.eq.midDb}` +
        `,treble=g=${info.eq.highDb}:f=8000`
    }
    if (info.gate) {
      bus +=
        `,agate=threshold=${threshold(info.gate.thresholdDb)}` +
        `:range=${clampNum(dbToLinear(info.gate.rangeDb), 0, 1, 0.06125).toFixed(6)}` +
        `:ratio=${ratio(info.gate.ratio)}:attack=${attackMs(info.gate.attackMs, 9000)}` +
        `:release=${releaseMs(info.gate.releaseMs)}:detection=rms`
    }
    if (info.comp) {
      bus +=
        `,acompressor=threshold=${threshold(info.comp.thresholdDb)}` +
        `:ratio=${ratio(info.comp.ratio)}:attack=${attackMs(info.comp.attackMs, 2000)}` +
        `:release=${releaseMs(info.comp.releaseMs)}` +
        `:makeup=${clampNum(dbToLinear(info.comp.makeupDb), 1, 64, 1).toFixed(4)}`
    }
    bus += `[bus_${k}]`
    G.push(bus)
  })

  // 3. which track buses are duck triggers, and how many consumers each has
  const consumers = new Map<number, number[]>() // triggerK -> [consumerK...]
  order.forEach((tid, k) => {
    const d = rep.get(tid)!.duck
    if (!d) return
    const trigK = trackK.get(d.triggerTrackId)
    if (trigK === undefined) return // trigger has no audible clips -> degrade to passthrough
    if (!consumers.has(trigK)) consumers.set(trigK, [])
    consumers.get(trigK)!.push(k)
  })

  // 4. split each trigger bus into a main + one key per consumer (key is PRE-duck)
  for (const [trigK, cons] of consumers) {
    const keys = cons.map((cK) => `[key_${trigK}_${cK}]`).join('')
    G.push(`[bus_${trigK}]asplit=${cons.length + 1}[main_${trigK}]${keys}`)
  }

  // 5. each track terminal [t_k]: main -> [duck] -> [pan]
  order.forEach((tid, k) => {
    const info = rep.get(tid)!
    let term = consumers.has(k) ? `[main_${k}]` : `[bus_${k}]`
    const trigK = info.duck ? trackK.get(info.duck.triggerTrackId) : undefined
    if (info.duck && trigK !== undefined) {
      G.push(`[key_${trigK}_${k}]aformat=channel_layouts=stereo,apad[kp_${trigK}_${k}]`)
      G.push(`${term}aformat=channel_layouts=stereo[md_${k}]`)
      G.push(
        `[md_${k}][kp_${trigK}_${k}]sidechaincompress=` +
          `threshold=${threshold(info.duck.thresholdDb)}:ratio=${ratio(info.duck.ratio)}` +
          `:attack=${attackMs(info.duck.attackMs, 2000)}:release=${releaseMs(info.duck.releaseMs)}[dk_${k}]`
      )
      term = `[dk_${k}]`
    }
    const panned = !!info.pan && Math.abs(info.pan) > 0.001
    const { left, right } = panGains(info.pan ?? 0)
    const panFilter = `pan=stereo|c0=${left.toFixed(5)}*c0|c1=${right.toFixed(5)}*c1`
    const ir = irInput.get(tid)
    if (ir) {
      // Reverb: split -> dry (volume) + wet (afir with the shared IR, volume),
      // each panned like the preview's two StereoPanners, then summed.
      // Both branches reach stereo through `pan` filters, which accept any
      // input layout: an aformat on either branch would make FFmpeg convert the
      // bus BEFORE the asplit (at swresample's -3 dB mono upmix) for both.
      //  • wet: unity upmix (mono FC -> both sides at full level, as a WebAudio
      //    ConvolverNode treats mono; stereo passes through), padded by the IR
      //    length so the tail rings out past the last clip, convolved with
      //    irnorm=-1:irgain=1 = no auto-gain (the IR is pre-normalized, see
      //    shared/reverb.ts), then WebAudio's exact stereo pan law.
      //  • dry: exactly the no-reverb terminal (mono -> stereo at -3 dB, as
      //    swresample does, then the same pan gains), so a 0% mix changes nothing.
      const { dry, wet } = reverbMixGains(ir.reverb.mix)
      const padSec = reverbIRLength(ir.reverb, sampleRate) / sampleRate
      const dl = panned ? left : 1
      const dr = panned ? right : 1
      const up = Math.SQRT1_2
      G.push(`${term}asplit=2[rd_${k}][rw_${k}]`)
      G.push(`[rw_${k}]pan=stereo|FL=FL+FC|FR=FR+FC,apad=pad_dur=${padSec.toFixed(3)}[rx_${k}]`)
      G.push(
        `[rx_${k}][${ir.input}:a]afir=irnorm=-1:irgain=1,volume=${wet.toFixed(6)}` +
          `${panned ? `,${stereoPanFilter(info.pan)}` : ''}[rwo_${k}]`
      )
      G.push(
        `[rd_${k}]volume=${dry.toFixed(6)},pan=stereo` +
          `|FL=${dl.toFixed(5)}*FL+${(dl * up).toFixed(5)}*FC|FR=${dr.toFixed(5)}*FR+${(dr * up).toFixed(5)}*FC[rdo_${k}]`
      )
      G.push(`[rdo_${k}][rwo_${k}]amix=inputs=2:normalize=0:duration=longest[t_${k}]`)
    } else if (panned) {
      G.push(`${term}aformat=channel_layouts=stereo,${panFilter}[t_${k}]`)
    } else {
      G.push(`${term}anull[t_${k}]`)
    }
  })

  // 6. sum track terminals -> limiter -> pad
  const terms = order.map((_, k) => `[t_${k}]`).join('')
  if (order.length === 1) {
    G.push(`[t_0]alimiter=limit=0.97,apad[aout]`)
  } else {
    G.push(`${terms}amix=inputs=${order.length}:normalize=0:duration=longest,alimiter=limit=0.97,apad[aout]`)
  }
  return G.join(';')
}
