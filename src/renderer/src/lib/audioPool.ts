import type { Clip, Project, Track } from '../types'
import { dbToLinear } from '../types'
import { getAudioContext, resumeAudioContext } from './audioContext'
import { getAudioEntry, type AudioEntry } from './audioCache'
import { getDenoiseEntry, type DenoiseEntry } from './denoiseCache'
import { computeFadeSchedule, fadeGainAt } from './fades'
import { setMeterAnalyser } from './audioMeter'
import { resolveDuck, resolveReverb } from '../state/selectors'
import { generateReverbIR, reverbMixGains, reverbShapeKey, type ReverbShape } from '../../../shared/reverb'
import type { VideoPool } from './videoPool'
import { grainEnvelope, grainSpan, reverseInto, scrubTargets, shouldGrain, type ScrubThrottle } from './scrub'

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

/**
 * Node options for the per-track dynamics worklet. channelCount 2 +
 * 'explicit' makes WebAudio down-mix any source (5.1 → stereo) BEFORE the
 * processor: its per-channel filter state is stereo-sized, and a 6-channel
 * input would turn the biquads to NaN and silence the track for good.
 * Exported so the test can pin this down.
 */
export const DYNAMICS_NODE_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 2,
  numberOfOutputs: 1,
  outputChannelCount: [2],
  channelCount: 2,
  channelCountMode: 'explicit',
  channelInterpretation: 'speakers'
}

/** Message that makes the dynamics processor return false from process(),
 *  so the audio thread can release it once the node is disconnected. */
export const DYNAMICS_DISPOSE_MESSAGE = 'dispose'

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
  /** The element this tap was made from; the video pool may dispose and
   *  recreate a clip's element (idle eviction), making the tap stale. */
  el: HTMLVideoElement
  source: MediaElementAudioSourceNode
  gain: GainNode
  wanted: boolean
}

const DRIFT_TOLERANCE = 0.05
/** A changed reverb shape must hold this long before its IR is rebuilt:
 *  generating the IR (+ the convolver's own preprocessing) costs tens of ms
 *  on the main thread, so rebuilding mid-drag would stutter playback. */
const REVERB_SETTLE_MS = 250
/** Let the wet gain fade out before the convolver is unhooked (saves CPU). */
const REVERB_UNHOOK_MS = 200
/** Safety cap on scrub grains in flight (they normally number 1–2 per clip). */
const MAX_GRAINS = 24

/**
 * Build the ConvolverNode buffer for a reverb shape: the SAME samples the export
 * writes to its afir IR WAV (src/shared/reverb.ts), at the context's rate.
 */
export function buildReverbBuffer(ctx: BaseAudioContext, shape: ReverbShape): AudioBuffer {
  const [l, r] = generateReverbIR(shape, ctx.sampleRate)
  const buf = ctx.createBuffer(2, l.length, ctx.sampleRate)
  buf.getChannelData(0).set(l)
  buf.getChannelData(1).set(r)
  return buf
}

/**
 * A track's reverb send: tap -> convolver -> wet -> its own panner -> master.
 * A separate panner (not the dry one) keeps the dry path's channel count, and
 * so its pan law, exactly what it is without reverb; the export mirrors it by
 * panning its dry and wet branches separately. The convolver runs with
 * normalize = false: the IR is already level-normalized, and afir on export
 * applies no auto-gain either (irnorm=-1), so wet levels match.
 */
interface ReverbSend {
  convolver: ConvolverNode | null
  wet: GainNode
  panner: StereoPannerNode
  /** reverbShapeKey of the loaded IR. */
  key: string
  /** Latest requested shape key and when it was first seen (settle timer). */
  pendingKey: string
  pendingSince: number
  /** Whether tap -> convolver is connected. */
  hooked: boolean
  unhookTimer: number
}

interface TrackChain {
  input: GainNode
  dynamics: AudioWorkletNode | null
  /** Unity node after [dynamics]: the dry/wet split point. */
  tap: GainNode
  dry: GainNode
  panner: StereoPannerNode
  reverb: ReverbSend | null
}

export class AudioPool {
  private ctx: AudioContext
  private master: DynamicsCompressorNode
  private analyser: AnalyserNode
  private trackChains = new Map<string, TrackChain>()
  private trackMuted = new Map<string, boolean>()
  // trackId -> the trigger track currently wired into its duck sidechain input.
  private duckEdges = new Map<string, string>()
  private live = new Map<string, LiveSource>()
  /** Keyed by clip id, like the video pool: overlapping clips of one file each
   *  get their own element and gain. */
  private videoAudio = new Map<string, VideoAudio>()
  /** Scrub grains in flight: short one-shots that disconnect themselves on end. */
  private grains = new Map<AudioBufferSourceNode, GainNode>()
  private scrubThrottle: ScrubThrottle | null = null

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

  /** Disconnect and forget a clip's element tap. */
  private dropVideoAudio(clipId: string, v: VideoAudio): void {
    try {
      v.source.disconnect()
      v.gain.disconnect()
    } catch {
      /* already gone */
    }
    this.videoAudio.delete(clipId)
  }

  /** Lazily route a <video> element's audio through WebAudio. Returns its gain. */
  private ensureVideoAudio(clipId: string, el: HTMLVideoElement): VideoAudio | null {
    const existing = this.videoAudio.get(clipId)
    if (existing && existing.el === el) return existing
    // The pool replaced the element: drop the dead tap and tap the new one.
    if (existing) this.dropVideoAudio(clipId, existing)
    try {
      const source = this.ctx.createMediaElementSource(el)
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(this.master)
      el.muted = false // audio now flows through WebAudio; controlled by `gain`
      const entry: VideoAudio = { el, source, gain, wanted: true }
      this.videoAudio.set(clipId, entry)
      return entry
    } catch {
      // createMediaElementSource throws if the element was already tapped.
      return null
    }
  }

  /**
   * Per-track input node. Chain: gain (mute + audioGain dB) -> [dynamics] ->
   * tap -> dry -> stereo panner -> master, plus an optional reverb send off the
   * tap (see ReverbSend). The dynamics worklet (gate/duck) is inserted ONCE,
   * the first time a track needs it and the module is ready; thereafter it stays
   * and just runs passthrough when gate/duck are off, so toggling never reclicks.
   * tap and dry are unity gains when reverb is off, so the dry path is unchanged.
   */
  private trackInput(track: Track, project: Project): GainNode {
    let chain = this.trackChains.get(track.id)
    if (!chain) {
      const input = this.ctx.createGain()
      const tap = this.ctx.createGain()
      const dry = this.ctx.createGain()
      const panner = this.ctx.createStereoPanner()
      input.connect(tap)
      tap.connect(dry)
      dry.connect(panner)
      panner.connect(this.master)
      chain = { input, dynamics: null, tap, dry, panner, reverb: null }
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
        const node = new AudioWorkletNode(this.ctx, 'cutroom-dynamics', DYNAMICS_NODE_OPTIONS)
        // The worklet starts passthrough (gain 1), so swapping it in is
        // sample-continuous. Disconnect ONLY the input->tap edge so any
        // sidechain taps from this input (it may be a duck trigger) survive.
        chain.input.disconnect(chain.tap)
        chain.input.connect(node)
        node.connect(chain.tap)
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
    this.syncReverb(track, chain)
    return chain.input
  }

  /**
   * Reconcile a track's reverb send with its settings. The ConvolverNode is
   * created on first use and rebuilt (a fresh node, swapped in) only when the
   * IR shape changes — throttled so dragging the decay slider doesn't
   * regenerate a multi-second IR every frame. Turning reverb off fades the wet
   * gain, then unhooks the convolver so an idle reverb costs no CPU.
   */
  private syncReverb(track: Track, chain: TrackChain): void {
    const rv = resolveReverb(track)
    const now = this.ctx.currentTime
    const { dry, wet } = reverbMixGains(rv ? rv.mix : 0)
    chain.dry.gain.setTargetAtTime(dry, now, 0.01)
    let send = chain.reverb
    if (!rv) {
      if (send?.hooked && !send.unhookTimer) {
        send.wet.gain.setTargetAtTime(0, now, 0.01)
        const s = send
        s.unhookTimer = window.setTimeout(() => {
          s.unhookTimer = 0
          if (s.convolver && s.hooked) {
            try {
              chain.tap.disconnect(s.convolver)
            } catch {
              /* already gone */
            }
          }
          s.hooked = false
        }, REVERB_UNHOOK_MS)
      }
      return
    }
    if (!send) {
      const wetGain = this.ctx.createGain()
      wetGain.gain.value = 0
      const panner = this.ctx.createStereoPanner()
      wetGain.connect(panner)
      panner.connect(this.master)
      send = { convolver: null, wet: wetGain, panner, key: '', pendingKey: '', pendingSince: 0, hooked: false, unhookTimer: 0 }
      chain.reverb = send
    }
    if (send.unhookTimer) {
      window.clearTimeout(send.unhookTimer)
      send.unhookTimer = 0
    }
    const key = reverbShapeKey(rv, this.ctx.sampleRate)
    const wall = performance.now()
    if (send.key !== key && send.pendingKey !== key) {
      send.pendingKey = key
      send.pendingSince = wall
    }
    if (send.key !== key && (!send.convolver || wall - send.pendingSince >= REVERB_SETTLE_MS)) {
      try {
        const conv = this.ctx.createConvolver()
        conv.normalize = false // must be set before the buffer to take effect
        conv.buffer = buildReverbBuffer(this.ctx, rv)
        conv.connect(send.wet)
        if (send.convolver) {
          if (send.hooked) chain.tap.disconnect(send.convolver)
          send.convolver.disconnect()
        }
        send.convolver = conv
        send.hooked = false
        send.key = key
      } catch (e) {
        console.warn('[cutroom] could not build reverb', e)
      }
    }
    if (send.convolver && !send.hooked) {
      chain.tap.connect(send.convolver)
      send.hooked = true
    }
    send.wet.gain.setTargetAtTime(wet, now, 0.01)
    send.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, track.pan ?? 0)), now, 0.01)
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
    this.pruneTrackChains(project)
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
        const el = videoPool.getElement(clip.id)
        if (!el) continue
        const va = this.ensureVideoAudio(clip.id, el)
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
    for (const [id, v] of [...this.videoAudio.entries()]) {
      if (v.wanted) continue
      // The pool evicted this clip's element (or the clip is gone): drop the
      // tap so per-clip keys (new ids on every split) don't pile up.
      if (videoPool && videoPool.getElement(id) !== v.el) this.dropVideoAudio(id, v)
      else v.gain.gain.setTargetAtTime(0, now, 0.01)
    }
  }

  /** Disconnect a track chain and release its worklet processor. */
  private disposeChain(chain: TrackChain): void {
    try {
      chain.input.disconnect()
      chain.dynamics?.port.postMessage(DYNAMICS_DISPOSE_MESSAGE)
      chain.dynamics?.disconnect()
      chain.tap.disconnect()
      chain.dry.disconnect()
      chain.panner.disconnect()
      if (chain.reverb) {
        window.clearTimeout(chain.reverb.unhookTimer)
        chain.reverb.convolver?.disconnect()
        chain.reverb.wet.disconnect()
        chain.reverb.panner.disconnect()
      }
    } catch {
      /* already gone */
    }
  }

  /**
   * Tear down chains of tracks that no longer exist (deleted, or undone past
   * their creation) so their nodes and dynamics worklet don't run forever.
   * An undo that brings the track back simply rebuilds it via trackInput.
   */
  private pruneTrackChains(project: Project): void {
    if (this.trackChains.size === 0) return
    const ids = new Set(project.tracks.map((t) => t.id))
    for (const [id, chain] of [...this.trackChains.entries()]) {
      if (ids.has(id)) continue
      this.disposeChain(chain)
      this.trackChains.delete(id)
      this.trackMuted.delete(id)
      this.duckEdges.delete(id)
      // Its input fed other tracks' sidechains; disconnect() above cut those edges.
      for (const [ducked, trigger] of [...this.duckEdges.entries()]) {
        if (trigger === id) this.duckEdges.delete(ducked)
      }
    }
  }

  /**
   * Audio scrubbing (see lib/scrub): play one short windowed grain of every
   * buffer-backed clip under timeline time `timeSec`, through its track chain
   * (so mute / gain / pan / FX / reverb all apply). `direction` -1 plays the
   * audio just before the playhead, reversed. Throttled internally, so it is
   * safe to call on every playhead change while scrubbing or shuttling.
   * Returns the number of grains started (0 when throttled or nothing to play).
   */
  scrub(project: Project, timeSec: number, direction: 1 | -1): number {
    const nowMs = performance.now()
    if (!shouldGrain(this.scrubThrottle, nowMs, timeSec)) return 0
    this.scrubThrottle = { lastMs: nowMs, lastTime: timeSec }
    if (this.grains.size >= MAX_GRAINS) return 0
    const targets = scrubTargets(project, timeSec, (clip, track) =>
      resolvePreviewBuffer(
        clip,
        track,
        clip.mediaId ? getAudioEntry(clip.mediaId) : undefined,
        clip.mediaId ? getDenoiseEntry(clip.mediaId) : undefined
      )
    )
    if (targets.length === 0) return 0
    resumeAudioContext()
    const ctx = this.ctx
    const t0 = ctx.currentTime
    let started = 0
    for (const { clip, track, buffer, srcOffset, gain } of targets) {
      const span = grainSpan(srcOffset, clip, direction, buffer.duration)
      if (!span) continue
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
      const source = ctx.createBufferSource()
      if (direction < 0) {
        // A fresh little buffer holding the span backwards (~3.4k frames/ch).
        const s0 = Math.floor(span.start * buffer.sampleRate)
        const n = Math.max(1, Math.min(buffer.length - s0, Math.round(span.dur * buffer.sampleRate)))
        const rev = ctx.createBuffer(buffer.numberOfChannels, n, buffer.sampleRate)
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          reverseInto(buffer.getChannelData(c), s0, n, rev.getChannelData(c))
        }
        source.buffer = rev
      } else {
        source.buffer = buffer
      }
      source.playbackRate.value = speed // same pitch as 1× playback
      const g = ctx.createGain()
      const wallDur = span.dur / speed
      g.gain.cancelScheduledValues(t0)
      for (const op of grainEnvelope(gain, wallDur)) {
        if (op.kind === 'set') g.gain.setValueAtTime(op.value, t0 + op.atOffset)
        else g.gain.linearRampToValueAtTime(op.value, t0 + op.atOffset)
      }
      source.connect(g)
      g.connect(this.trackInput(track, project))
      if (direction < 0) source.start(t0, 0, span.dur)
      else source.start(t0, span.start, span.dur)
      source.onended = (): void => {
        try {
          source.disconnect()
          g.disconnect()
        } catch {
          /* already gone */
        }
        this.grains.delete(source)
      }
      this.grains.set(source, g)
      started += 1
    }
    // A ducked track's sidechain may never have been wired if nothing has played yet.
    if (started) this.syncDuckEdges(project)
    return started
  }

  dispose(): void {
    for (const [source, g] of this.grains) {
      try {
        source.onended = null
        source.stop()
        source.disconnect()
        g.disconnect()
      } catch {
        /* already gone */
      }
    }
    this.grains.clear()
    for (const id of [...this.live.keys()]) this.stopClip(id)
    for (const [id, v] of [...this.videoAudio.entries()]) this.dropVideoAudio(id, v)
    this.duckEdges.clear()
    for (const chain of this.trackChains.values()) this.disposeChain(chain)
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
