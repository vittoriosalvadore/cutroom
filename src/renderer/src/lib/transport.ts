// ---------------------------------------------------------------------------
// Transport math (pure, unit-tested): J/K/L shuttle rates, the playback clock's
// per-tick advance with its start/end stops, and frame stepping. The store and
// the rAF clock in App.tsx are thin wrappers around these.
//
// A shuttle rate is SIGNED: +1 is normal playback, +2/+4 fast-forward, -1/-2/-4
// reverse. Only +1 is "real" playback (decoders rolling, audio audible); every
// other rate drives the preview down the paused/scrub path (seeked frames, see
// stepShuttleHold) with audio as short scrub grains (lib/scrub, when the Audio
// scrubbing setting is on) — reverse decode is too expensive to do properly,
// and pitch-following fast audio isn't worth it.
// ---------------------------------------------------------------------------

import type { Project } from '../types'

/** Fastest shuttle speed in either direction. */
export const MAX_SHUTTLE = 4

/**
 * The next shuttle rate after pressing L (`dir` = 1) or J (`dir` = -1).
 * Pressing the key for the direction already playing doubles the speed (capped
 * at 4×); from paused or the opposite direction it starts at 1× that way.
 */
export function nextShuttleRate(current: number, isPlaying: boolean, dir: 1 | -1): number {
  if (!isPlaying || Math.sign(current) !== dir) return dir
  return dir * Math.min(MAX_SHUTTLE, Math.abs(current) * 2)
}

/** True when the rate plays through the real (decoder + audio) path. */
export function isRealtimeRate(rate: number): boolean {
  return rate === 1
}

/**
 * Advance the playhead by `dtSec` wall-clock seconds at `rate`. Forward stops
 * (clamped) at `endSec`, the end of the timeline — re-read each tick since edits
 * during playback can move it; reverse stops at 0. `stop` ends playback.
 */
export function advancePlayhead(
  playheadSec: number,
  dtSec: number,
  rate: number,
  endSec: number
): { sec: number; stop: boolean } {
  const next = playheadSec + dtSec * rate
  if (rate < 0 && next <= 0) return { sec: 0, stop: true }
  if (rate > 0 && next >= endSec) return { sec: Math.max(0, endSec), stop: true }
  return { sec: Math.max(0, next), stop: false }
}

/**
 * Where playback should begin, or null when there's nothing to play (empty
 * timeline). Starting forward while parked at (or past) the end restarts from
 * 0; reverse starts where it is (and stops on the first tick if already at 0).
 */
export function playStartSec(playheadSec: number, rate: number, endSec: number): number | null {
  if (endSec <= 0) return null
  if (rate > 0 && playheadSec >= endSec - 1e-3) return 0
  return playheadSec
}

/**
 * Step the playhead by `frames` whole frames at `fps`, landing ON the frame
 * grid (so repeated steps never accumulate float drift). A playhead between
 * frames steps to the neighbouring grid line in that direction. Never below 0.
 */
export function stepFrames(playheadSec: number, fps: number, frames: number): number {
  const f = fps > 0 ? fps : 30
  // Tolerance so 1/30 * 30 style rounding doesn't read as "between frames".
  const cur = playheadSec * f
  const base = frames >= 0 ? Math.floor(cur + 1e-6) : Math.ceil(cur - 1e-6)
  return Math.max(0, (base + frames) / f)
}

/** Transport label for a shuttle rate: '' at 1×, else e.g. '▶▶ 2×' / '◀◀ 4×' / '◀ 1×'. */
export function formatShuttleRate(rate: number): string {
  if (rate === 1) return ''
  const mag = Math.abs(rate)
  const arrow = rate < 0 ? (mag > 1 ? '◀◀' : '◀') : '▶▶'
  return `${arrow} ${mag}×`
}

// ---------------------------------------------------------------------------
// Shuttle preview pacing. Off 1× the preview rides the scrub path, where every
// new time restarts a seek (<video>) or a keyframe..target decode (WebCodecs).
// Re-targeting on every rAF tick would abort each one before its frame lands —
// a frozen or "buffering" picture. So while shuttling the preview HOLDS its
// time until the requested frame has arrived (or SHUTTLE_MAX_HOLD_MS passes),
// then jumps to the live playhead: a stuttery-but-moving picture, like a deck.
// ---------------------------------------------------------------------------

/** Longest the shuttle preview waits on a frame before re-targeting anyway. */
export const SHUTTLE_MAX_HOLD_MS = 500

export interface ShuttleHold {
  /** The time the preview is showing / has requested. */
  time: number
  /** performance.now() of that request. */
  at: number
  /** True once a decoded frame has arrived since the request. */
  landed: boolean
}

/**
 * Advance the shuttle hold for this tick: the next hold, and whether to render
 * (at `hold.time`). Holds while the requested frame is in flight, and also
 * until the playhead has moved at least `minStepSec` (~2 frames) — a smaller
 * move may resolve to the frame already shown, which decodes nothing and so
 * would never "land". With no video at the held time there's nothing to wait
 * for (titles, images and gaps draw synchronously), so it follows live.
 */
export function stepShuttleHold(
  hold: ShuttleHold,
  playheadSec: number,
  nowMs: number,
  videoAtHold: boolean,
  minStepSec: number
): { hold: ShuttleHold; render: boolean } {
  const fresh = nowMs - hold.at < SHUTTLE_MAX_HOLD_MS
  const waiting = !hold.landed || Math.abs(playheadSec - hold.time) < minStepSec
  if (videoAtHold && fresh && waiting) return { hold, render: false }
  return { hold: { time: playheadSec, at: nowMs, landed: false }, render: true }
}

/** True when a visible video clip covers timeline time `t` (drawing it needs a decode). */
export function hasVideoAt(project: Project, t: number): boolean {
  const shown = new Set(project.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden).map((tr) => tr.id))
  for (const c of Object.values(project.clips)) {
    if (!c.mediaId || !shown.has(c.trackId)) continue
    if (t < c.startSec || t >= c.startSec + c.durationSec) continue
    if (project.media[c.mediaId]?.kind === 'video') return true
  }
  return false
}

/** Keys a focused range input (slider) handles itself — global shortcuts and
 *  the Inspector's undo snapshot both key off this list. */
export const SLIDER_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End'
])
