// ---------------------------------------------------------------------------
// Audio scrubbing math (pure, unit-tested; the WebAudio side is AudioPool.scrub).
//
// While the playhead is dragged on the ruler, or the J/K/L shuttle runs at any
// rate other than 1×, the preview plays short windowed "grains" of the audio
// under the playhead so the user hears where they are. Each grain is ~70 ms of
// source at the clip's own pitch, faded in and out so abutting grains never
// click, and routed through the clip's normal track chain (mute, gain, pan,
// EQ/dynamics, reverb). A new grain starts at most every GRAIN_INTERVAL_MS and
// only once the playhead has actually moved. Moving backwards (reverse shuttle
// or dragging left) plays the audio just BEFORE the playhead, reversed — the
// familiar tape-rocking sound.
//
// 1× playback never comes here: it stays on the sample-accurate BufferSource /
// <video> path in AudioPool.sync.
// ---------------------------------------------------------------------------

import type { Clip, Project, Track } from '../types'
import { fadeGainAt } from './fades'

/** Grain length in wall-clock seconds. */
export const GRAIN_SEC = 0.07
/** Fade in/out at each end of a grain (linear; short enough to keep the attack). */
export const GRAIN_FADE_SEC = 0.012
/** Minimum wall-clock gap between grain starts (grains overlap ~25 ms). */
export const GRAIN_INTERVAL_MS = 45
/** The playhead must move at least this far (timeline s) for a new grain. */
export const MIN_MOVE_SEC = 0.004
/** Grains shorter than this (source s, e.g. at a clip edge) are skipped. */
const MIN_GRAIN_SRC_SEC = 0.01

export interface ScrubThrottle {
  /** performance.now() of the last grain. */
  lastMs: number
  /** Timeline time of the last grain. */
  lastTime: number
}

/** Whether a grain may start now (throttle + "has it moved"). */
export function shouldGrain(last: ScrubThrottle | null, nowMs: number, timeSec: number): boolean {
  if (!last) return true
  if (nowMs - last.lastMs < GRAIN_INTERVAL_MS) return false
  return Math.abs(timeSec - last.lastTime) >= MIN_MOVE_SEC
}

export interface GrainTarget {
  clip: Clip
  track: Track
  buffer: AudioBuffer
  /** Source time under the playhead (seconds into the buffer). */
  srcOffset: number
  /** Clip envelope (volume × fades) at the playhead. */
  gain: number
}

/**
 * The clips a grain at timeline `timeSec` should sound, with their source
 * position and envelope gain. `bufferFor` supplies the AudioBuffer the preview
 * would play for a clip (see resolvePreviewBuffer) or null — a clip whose
 * audio only lives in a <video> element has nothing to cut grains from and is
 * skipped. Muted tracks and silent envelope points are skipped too.
 */
export function scrubTargets(
  project: Project,
  timeSec: number,
  bufferFor: (clip: Clip, track: Track) => AudioBuffer | null
): GrainTarget[] {
  const trackById = new Map(project.tracks.map((t) => [t.id, t]))
  const out: GrainTarget[] = []
  for (const clip of Object.values(project.clips)) {
    if (!clip.mediaId) continue
    if (timeSec < clip.startSec || timeSec >= clip.startSec + clip.durationSec) continue
    const track = trackById.get(clip.trackId)
    if (!track || track.muted) continue
    const e = timeSec - clip.startSec
    const gain = fadeGainAt(e, {
      volume: clip.volume ?? 1,
      fadeInSec: clip.fadeInSec ?? 0,
      fadeOutSec: clip.fadeOutSec ?? 0,
      durationSec: clip.durationSec
    })
    if (!(gain > 0)) continue
    const buffer = bufferFor(clip, track)
    if (!buffer) continue
    out.push({ clip, track, buffer, srcOffset: clip.inSec + e * (clip.speed ?? 1), gain })
  }
  return out
}

/**
 * The source span (seconds into the buffer) a grain reads: forward = the
 * audio starting AT the playhead, reverse = the audio ending at it (played
 * backwards). A grain covers GRAIN_SEC of wall time at the clip's speed, and
 * never reads outside the clip's trimmed source range or the buffer. Null when
 * too little is left (right at a clip edge).
 */
export function grainSpan(
  srcOffset: number,
  clip: Pick<Clip, 'inSec' | 'durationSec' | 'speed'>,
  direction: 1 | -1,
  bufferDuration: number
): { start: number; dur: number } | null {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
  const len = GRAIN_SEC * speed
  const lo = Math.max(0, clip.inSec)
  const hi = Math.min(bufferDuration, clip.inSec + clip.durationSec * speed)
  const start = direction > 0 ? Math.max(lo, srcOffset) : Math.max(lo, srcOffset - len)
  const end = direction > 0 ? Math.min(hi, srcOffset + len) : Math.min(hi, srcOffset)
  const dur = end - start
  return dur >= MIN_GRAIN_SRC_SEC * speed ? { start, dur } : null
}

/**
 * Gain automation for one grain lasting `durSec` of wall time at peak `gain`:
 * linear fade in, hold, linear fade out to exactly 0 at the end. Offsets are
 * seconds after the grain's start; the fades shrink for a very short grain.
 */
export function grainEnvelope(gain: number, durSec: number): { kind: 'set' | 'ramp'; value: number; atOffset: number }[] {
  const fade = Math.min(GRAIN_FADE_SEC, durSec / 3)
  return [
    { kind: 'set', value: 0, atOffset: 0 },
    { kind: 'ramp', value: gain, atOffset: fade },
    { kind: 'set', value: gain, atOffset: durSec - fade },
    { kind: 'ramp', value: 0, atOffset: durSec }
  ]
}

/** Copy `n` samples of `src` starting at `s0` into `dst`, reversed (a reverse grain). */
export function reverseInto(src: Float32Array, s0: number, n: number, dst: Float32Array): void {
  for (let i = 0; i < n; i++) dst[i] = src[s0 + n - 1 - i] ?? 0
}

/** Scrub direction from two successive playhead positions (ties count as forward). */
export function scrubDirection(prevSec: number, nextSec: number): 1 | -1 {
  return nextSec < prevSec ? -1 : 1
}
