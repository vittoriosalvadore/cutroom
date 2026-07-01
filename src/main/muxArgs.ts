// ---------------------------------------------------------------------------
// Pure FFmpeg argument builder for the export audio-mux pass. No electron / fs /
// child_process imports here, so it can be unit-tested in plain Node.
//
// Input 0 is the silent video; inputs 1..N are the audible source files. Each
// audio input is trimmed to its used span, re-timed, gained, faded, and delayed
// to its timeline position, then all are summed (amix, no auto-normalize) and
// brick-limited. Video is stream-copied (never re-encoded).
//
// Filter order aresample -> atrim -> asetpts -> volume -> afade -> adelay is
// mandatory; reordering produces wrong timing or silence.
// ---------------------------------------------------------------------------

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

export interface BuildMuxArgsOptions {
  silentPath: string
  outputPath: string
  sampleRate: number
  clips: MuxClip[]
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

export function buildMuxArgs(opts: BuildMuxArgsOptions): string[] {
  const { silentPath, outputPath, sampleRate, clips } = opts
  const args: string[] = ['-y', '-i', silentPath]
  for (const c of clips) args.push('-i', c.path)

  // Projects with NO gate/duck use the original flat per-clip graph (verified,
  // byte-stable). Only when a track enables gate/duck do we switch to per-track
  // submixing, which is what lets a gate act on a track's mix and a ducker key
  // off another track.
  const usesTrackFx = clips.some((c) => c.gate || c.duck || c.eq || c.comp)
  const graph = usesTrackFx ? buildFxGraph(clips, sampleRate) : buildFlatGraph(clips, sampleRate)

  args.push(
    '-filter_complex', graph,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', String(sampleRate),
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
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
function buildFlatGraph(clips: MuxClip[], sampleRate: number): string {
  const chains = clips.map((c, i) => {
    const input = i + 1 // input 0 is the video
    const vol = (c.volume ?? 1) * dbToLinear(c.trackGainDb ?? 0)
    let chain =
      `[${input}:a]aresample=${sampleRate},` +
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
 * layouts). dB levels -> linear; times stay in ms; ratio clamped to FFmpeg's 20.
 */
function buildFxGraph(clips: MuxClip[], sampleRate: number): string {
  const G: string[] = []

  // 1. per-clip -> [c{i}] (clip volume + fades only; trackGain & pan move to the bus)
  clips.forEach((c, i) => {
    const input = i + 1
    let chain =
      `[${input}:a]aresample=${sampleRate},` +
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
        `,agate=threshold=${dbToLinear(info.gate.thresholdDb).toFixed(6)}` +
        `:range=${dbToLinear(info.gate.rangeDb).toFixed(6)}` +
        `:ratio=${info.gate.ratio}:attack=${info.gate.attackMs}:release=${info.gate.releaseMs}:detection=rms`
    }
    if (info.comp) {
      bus +=
        `,acompressor=threshold=${dbToLinear(info.comp.thresholdDb).toFixed(6)}` +
        `:ratio=${info.comp.ratio}:attack=${info.comp.attackMs}:release=${info.comp.releaseMs}` +
        `:makeup=${dbToLinear(info.comp.makeupDb).toFixed(4)}`
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
      const r = Math.min(20, info.duck.ratio)
      G.push(`[key_${trigK}_${k}]aformat=channel_layouts=stereo,apad[kp_${trigK}_${k}]`)
      G.push(`${term}aformat=channel_layouts=stereo[md_${k}]`)
      G.push(
        `[md_${k}][kp_${trigK}_${k}]sidechaincompress=` +
          `threshold=${dbToLinear(info.duck.thresholdDb).toFixed(6)}:ratio=${r}` +
          `:attack=${info.duck.attackMs}:release=${info.duck.releaseMs}[dk_${k}]`
      )
      term = `[dk_${k}]`
    }
    if (info.pan && Math.abs(info.pan) > 0.001) {
      const { left, right } = panGains(info.pan)
      G.push(`${term}aformat=channel_layouts=stereo,pan=stereo|c0=${left.toFixed(5)}*c0|c1=${right.toFixed(5)}*c1[t_${k}]`)
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
