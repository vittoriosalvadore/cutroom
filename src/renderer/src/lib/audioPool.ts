import type { Clip, Project, Track } from '../types'
import { dbToLinear } from '../types'
import { getAudioContext, resumeAudioContext } from './audioContext'
import { getAudioEntry, type AudioEntry } from './audioCache'
import { getDenoiseEntry, type DenoiseEntry } from './denoiseCache'
import { computeFadeSchedule, fadeGainAt } from './fades'
import { setMeterAnalyser } from './audioMeter'
import { resolveDuck } from '../state/selectors'
import type { VideoPool } from './videoPool'

/**
 * Which AudioBuffer (if any) should back a clip's preview playback this
 * frame: the denoised version when enabled and ready, else the plain decoded
 * source for audio-track clips. Video-track clips fall back to null (the
 * caller then uses the <video> element's own audio tap) UNLESS denoise is
 * ready for them too, in which case they switch to this same buffer path —
 * a video clip's audio has no other way to be denoised in preview, since the
 * element's decoded audio can't be filtered in place.
 * Exported (and covered by audioPool.test.ts) despite this file being mostly
 * WebAudio glue, because getting this substitution wrong either silences a
 * clip or double-plays it.
 */
export function resolvePreviewBuffer(
  clip: Clip,
  track: Track,
  audioEntry: AudioEntry | undefined,
  denoiseEntry: DenoiseEntry | undefined
): AudioBuffer | null {
  if (clip.denoiseEnabled && denoiseEntry?.status === 'ready' && denoiseEntry.buffer) {
    return denoiseEntry.buffer
  }
  if (track.kind !== 'audio') return null
  return audioEntry?.status === 'ready' && audioEntry.buffer ? audioEntry.buffer : null
}

// The per-track gate/duck AudioWorklet processor. Loaded once per context; if it
// ever fails to load, every track stays on the plain input->panner path so gate
// and duck silently do nothing and audio NEVER dies.
let workletPromise: Promise<void> | null = null
let workletReady = false
let workletFailed = false
function ensureDynamicsWorklet(ctx: AudioContext): void {
  if (workletPromise || workletFailed) return
  if (!ctx.audioWorklet) {
    workletFailed = true
    return
  }
  workletPromise = ctx.audioWorklet
    .addModule(new URL('./worklets/dynamics.worklet.js', import.meta.url))
    .then(() => {
      workletReady = true
    })
    .catch((e) => {
      workletFailed = true
      console.warn('[cutroom] dynamics worklet failed to load; gate/duck disabled', e)
    })
}

// ---------------------------------------------------------------------------
// Realtime preview audio. The rAF playhead is the sole clock; this engine is a
// one-way follower. sync() is the audio analogue of compositor.render.
//
// Two source kinds:
//  • audio-track clips -> a one-shot BufferSource per clip (sample-accurate),
//    through clipGain (volume + scheduled fades) -> trackGain (mute/dB).
//  • video-track clips -> the <video> element's own audio, tapped via a
//    MediaElementAudioSourceNode and gained per-frame from the clip envelope.
// Both feed a master limiter -> destination, with an analyser tap for the meter.
// ---------------------------------------------------------------------------

interface LiveSource {
  source: AudioBufferSourceNode
  gain: GainNode
  buffer: AudioBuffer
  startedCtxTime: number
  startedSrcOffset: number
  wanted: boolean
}

interface VideoAudio {
  source: MediaElementAudioSourceNode
  gain: GainNode
  wanted: boolean
}

const DRIFT_TOLERANCE = 0.05

export class AudioPool {
  private ctx: AudioContext
  private master: DynamicsCompressorNode
  private analyser: AnalyserNode
  private trackChains = new Map<
    string,
    { input: GainNode; dynamics: AudioWorkletNode | null; panner: StereoPannerNode }
  >()
  private trackMuted = new Map<string, boolean>()
  // trackId -> the trigger track currently wired into its duck sidechain input.
  private duckEdges = new Map<string, string>()
  private live = new Map<string, LiveSource>()
  private videoAudio = new Map<string, VideoAudio>()

  constructor() {
    this.ctx = getAudioContext()
    ensureDynamicsWorklet(this.ctx)
    this.master = this.ctx.createDynamicsCompressor()
    this.master.threshold.value = -1
    this.master.knee.value = 0
    this.master.ratio.value = 20
    this.master.attack.value = 0.003
    this.master.release.value = 0.1
    this.master.connect(this.ctx.destination)

    // Tap the master for the level meter (analyser is a sink; no onward connect).
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.master.connect(this.analyser)
    setMeterAnalyser(this.analyser)
  }

  /** Lazily route a <video> element's audio through WebAudio. Returns its gain. */
  private ensureVideoAudio(mediaId: string, el: HTMLVideoElement): VideoAudio | null {
    const existing = this.videoAudio.get(mediaId)
    if (existing) return existing
    try {
      const source = this.ctx.createMediaElementSource(el)
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(this.master)
      el.muted = false // audio now flows through WebAudio; controlled by `gain`
      const entry: VideoAudio = { source, gain, wanted: true }
      this.videoAudio.set(mediaId, entry)
      return entry
    } catch {
      // createMediaElementSource throws if the element was already tapped.
      return null
    }
  }

  /**
   * Per-track input node. Chain: gain (mute + audioGain dB) -> [dynamics] ->
   * stereo panner -> master. The dynamics worklet (gate/duck) is inserted ONCE,
   * the first time a track needs it and the module is ready; thereafter it stays
   * and just runs passthrough when gate/duck are off, so toggling never reclicks.
   */
  private trackInput(track: Track, project: Project): GainNode {
    let chain = this.trackChains.get(track.id)
    if (!chain) {
      const input = this.ctx.createGain()
      const panner = this.ctx.createStereoPanner()
      input.connect(panner)
      panner.connect(this.master)
      chain = { input, dynamics: null, panner }
      this.trackChains.set(track.id, chain)
    }
    const muted = !!track.muted
    const target = muted ? 0 : dbToLinear(track.audioGain ?? 0)
    if (this.trackMuted.get(track.id) !== muted) {
      const now = this.ctx.currentTime
      chain.input.gain.cancelScheduledValues(now)
      chain.input.gain.setValueAtTime(chain.input.gain.value, now)
      chain.input.gain.linearRampToValueAtTime(target, now + 0.005)
      this.trackMuted.set(track.id, muted)
    } else {
      chain.input.gain.value = target
    }
    chain.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, track.pan ?? 0)), this.ctx.currentTime, 0.01)

    const resolved = resolveDuck(track, project.tracks)
    const needsFx =
      !!track.gate?.enabled || !!track.eq?.enabled || !!track.comp?.enabled || resolved != null
    if (needsFx && !chain.dynamics && workletReady && !workletFailed) {
      try {
        const node = new AudioWorkletNode(this.ctx, 'cutroom-dynamics', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        })
        // The worklet starts passthrough (gain 1), so swapping it in is
        // sample-continuous. Disconnect ONLY the input->panner edge so any
        // sidechain taps from this input (it may be a duck trigger) survive.
        chain.input.disconnect(chain.panner)
        chain.input.connect(node)
        node.connect(chain.panner)
        chain.dynamics = node
      } catch (e) {
        workletFailed = true
        console.warn('[cutroom] could not create dynamics node; gate/duck disabled', e)
      }
    }
    if (chain.dynamics) {
      const now = this.ctx.currentTime
      const p = chain.dynamics.parameters
      const set = (name: string, val: number): void => {
        const ap = p.get(name)
        if (ap) ap.setTargetAtTime(val, now, 0.01)
      }
      const eq = track.eq
      set('eqEnabled', eq?.enabled ? 1 : 0)
      set('eqLowDb', eq?.lowDb ?? 0)
      set('eqMidDb', eq?.midDb ?? 0)
      set('eqHighDb', eq?.highDb ?? 0)
      const cmp = track.comp
      set('compEnabled', cmp?.enabled ? 1 : 0)
      set('compThresholdDb', cmp?.thresholdDb ?? -18)
      set('compRatio', cmp?.ratio ?? 3)
      set('compAttackMs', cmp?.attackMs ?? 20)
      set('compReleaseMs', cmp?.releaseMs ?? 200)
      set('compMakeupDb', cmp?.makeupDb ?? 0)
      const g = track.gate
      set('gateEnabled', g?.enabled ? 1 : 0)
      set('gateThresholdDb', g?.thresholdDb ?? -45)
      set('gateRangeDb', g?.rangeDb ?? -60)
      set('gateRatio', g?.ratio ?? 2)
      set('gateAttackMs', g?.attackMs ?? 5)
      set('gateReleaseMs', g?.releaseMs ?? 120)
      set('duckEnabled', resolved ? 1 : 0)
      set('duckThresholdDb', resolved?.thresholdDb ?? -30)
      set('duckRatio', resolved ? Math.min(20, resolved.ratio) : 8)
      set('duckAttackMs', resolved?.attackMs ?? 15)
      set('duckReleaseMs', resolved?.releaseMs ?? 250)
    }
    return chain.input
  }

  /**
   * Reconcile duck sidechain edges: each ducked track's dynamics input[1] is fed
   * from its trigger track's post-fader signal (the trigger `input` node, which
   * also feeds its own panner — fan-out is fine). Idempotent via duckEdges so we
   * never double-connect or leave a stale edge.
   */
  private syncDuckEdges(project: Project): void {
    const trackById = new Map(project.tracks.map((t) => [t.id, t]))
    for (const track of project.tracks) {
      if (track.kind !== 'audio') continue
      const chain = this.trackChains.get(track.id)
      const resolved = resolveDuck(track, project.tracks)
      const want = resolved && chain?.dynamics ? resolved.triggerTrackId : null
      const prev = this.duckEdges.get(track.id) ?? null
      if (want === prev) continue
      if (prev) {
        const prevChain = this.trackChains.get(prev)
        if (prevChain && chain?.dynamics) {
          try {
            prevChain.input.disconnect(chain.dynamics)
          } catch {
            /* already gone */
          }
        }
        this.duckEdges.delete(track.id)
      }
      if (want && chain?.dynamics) {
        const trigTrack = trackById.get(want)
        if (trigTrack) {
          this.trackInput(trigTrack, project) // ensure the trigger chain exists
          const trigChain = this.trackChains.get(want)
          if (trigChain) {
            try {
              trigChain.input.connect(chain.dynamics, 0, 1)
              this.duckEdges.set(track.id, want)
            } catch {
              /* connect can throw if already connected; map keeps us idempotent */
            }
          }
        }
      }
    }
  }

  private startClip(clip: Clip, track: Track, playhead: number, project: Project, buffer: AudioBuffer): void {
    const ctx = this.ctx
    const speed = clip.speed ?? 1
    const e0 = Math.max(0, playhead - clip.startSec)
    const srcOffset = clip.inSec + e0 * speed
    if (srcOffset < 0 || srcOffset >= buffer.duration) return

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()

    const t0 = ctx.currentTime
    const ops = computeFadeSchedule(e0, {
      volume: clip.volume ?? 1,
      fadeInSec: clip.fadeInSec ?? 0,
      fadeOutSec: clip.fadeOutSec ?? 0,
      durationSec: clip.durationSec
    })
    gain.gain.cancelScheduledValues(t0)
    for (const op of ops) {
      const at = t0 + Math.max(0, op.atOffset)
      if (op.kind === 'set') gain.gain.setValueAtTime(op.value, at)
      else gain.gain.linearRampToValueAtTime(op.value, at)
    }

    source.playbackRate.value = speed // pitches with speed, like tape
    source.connect(gain)
    gain.connect(this.trackInput(track, project))

    // playDur is in SOURCE seconds; at playbackRate=speed it covers `remaining`
    // timeline seconds (= remaining*speed of source).
    const remaining = Math.max(0, clip.durationSec - e0)
    const playDur = Math.min(remaining * speed, Math.max(0, buffer.duration - srcOffset))
    source.start(t0, srcOffset, playDur)

    source.onended = (): void => {
      const cur = this.live.get(clip.id)
      if (cur && cur.source === source) {
        try {
          gain.disconnect()
        } catch {
          /* already gone */
        }
        this.live.delete(clip.id)
      }
    }

    this.live.set(clip.id, {
      source,
      gain,
      buffer,
      startedCtxTime: t0,
      startedSrcOffset: srcOffset,
      wanted: true
    })
  }

  private stopClip(clipId: string): void {
    const ls = this.live.get(clipId)
    if (!ls) return
    try {
      ls.source.onended = null
      ls.source.stop()
    } catch {
      /* may already be stopped */
    }
    try {
      ls.source.disconnect()
      ls.gain.disconnect()
    } catch {
      /* already disconnected */
    }
    this.live.delete(clipId)
  }

  /** Reconcile playing sources to the playhead. Call after each render. */
  sync(project: Project, playhead: number, playing: boolean, videoPool?: VideoPool): void {
    const now = this.ctx.currentTime
    if (!playing) {
      for (const id of [...this.live.keys()]) this.stopClip(id)
      for (const v of this.videoAudio.values()) v.gain.gain.setTargetAtTime(0, now, 0.01)
      return
    }
    resumeAudioContext()

    for (const ls of this.live.values()) ls.wanted = false
    for (const v of this.videoAudio.values()) v.wanted = false

    const trackById = new Map(project.tracks.map((t) => [t.id, t]))
    for (const clip of Object.values(project.clips)) {
      const track = trackById.get(clip.trackId)
      if (!track) continue
      if (playhead < clip.startSec || playhead >= clip.startSec + clip.durationSec) continue

      const audioEntry = clip.mediaId ? getAudioEntry(clip.mediaId) : undefined
      const denoiseEntry = clip.mediaId ? getDenoiseEntry(clip.mediaId) : undefined
      const buffer = resolvePreviewBuffer(clip, track, audioEntry, denoiseEntry)

      if (buffer) {
        this.trackInput(track, project) // keep mute/gain/pan + gate/duck current
        const existing = this.live.get(clip.id)
        if (existing) {
          const sp = clip.speed ?? 1
          const expected = clip.inSec + (playhead - clip.startSec) * sp
          const actual = existing.startedSrcOffset + (this.ctx.currentTime - existing.startedCtxTime) * sp
          // A buffer swap (denoise just finished on a live clip) always
          // restarts too, even with zero drift, so playback hot-switches to
          // the denoised audio instead of finishing the clip on the original.
          if (Math.abs(actual - expected) > DRIFT_TOLERANCE || existing.buffer !== buffer) {
            this.stopClip(clip.id)
            this.startClip(clip, track, playhead, project, buffer)
          } else {
            existing.wanted = true
          }
        } else {
          this.startClip(clip, track, playhead, project, buffer)
        }
      } else if (track.kind === 'video' && videoPool && clip.mediaId) {
        const media = project.media[clip.mediaId]
        if (!media || media.kind !== 'video' || !media.path) continue
        const el = videoPool.getElement(clip.mediaId)
        if (!el) continue
        const va = this.ensureVideoAudio(clip.mediaId, el)
        if (!va) continue
        va.wanted = true
        const env = fadeGainAt(playhead - clip.startSec, {
          volume: clip.volume ?? 1,
          fadeInSec: clip.fadeInSec ?? 0,
          fadeOutSec: clip.fadeOutSec ?? 0,
          durationSec: clip.durationSec
        })
        const trackMul = track.muted ? 0 : dbToLinear(track.audioGain ?? 0)
        va.gain.gain.setTargetAtTime(env * trackMul, now, 0.01)
      }
    }

    // Wire/unwire duck sidechains now that every live track's chain exists.
    this.syncDuckEdges(project)

    for (const [id, ls] of [...this.live.entries()]) {
      if (!ls.wanted) this.stopClip(id)
    }
    for (const v of this.videoAudio.values()) {
      if (!v.wanted) v.gain.gain.setTargetAtTime(0, now, 0.01)
    }
  }

  dispose(): void {
    for (const id of [...this.live.keys()]) this.stopClip(id)
    for (const v of this.videoAudio.values()) {
      try {
        v.source.disconnect()
        v.gain.disconnect()
      } catch {
        /* already gone */
      }
    }
    this.videoAudio.clear()
    this.duckEdges.clear()
    for (const chain of this.trackChains.values()) {
      try {
        chain.input.disconnect()
        chain.dynamics?.disconnect()
        chain.panner.disconnect()
      } catch {
        /* already gone */
      }
    }
    setMeterAnalyser(null)
    try {
      this.analyser.disconnect()
    } catch {
      /* already gone */
    }
    try {
      this.master.disconnect()
    } catch {
      /* already gone */
    }
    this.trackChains.clear()
    this.trackMuted.clear()
  }
}
