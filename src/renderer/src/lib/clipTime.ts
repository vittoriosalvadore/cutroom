import type { Clip } from '../types'

// ---------------------------------------------------------------------------
// Clip time mapping with playback speed. A clip plays `durationSec` of TIMELINE
// time but consumes `durationSec * speed` of SOURCE, starting at `inSec` — the
// same mapping the compositor (srcTime = inSec + (t - startSec) * speed) and
// editing.computeTrim use. Helpers here keep analysis passes consistent with it.
// ---------------------------------------------------------------------------

type TimedClip = Pick<Clip, 'startSec' | 'durationSec' | 'inSec' | 'speed'>

/** The clip's effective speed (missing / non-positive = 1). */
export function clipSpeed(clip: Pick<Clip, 'speed'>): number {
  return clip.speed && clip.speed > 0 ? clip.speed : 1
}

/** Seconds of SOURCE media the clip consumes. */
export function clipSourceSpan(clip: TimedClip): number {
  return clip.durationSec * clipSpeed(clip)
}

/** Source time for a clip-relative timeline offset `tRel`. */
export function clipRelToSource(clip: TimedClip, tRel: number): number {
  return clip.inSec + tRel * clipSpeed(clip)
}

/** Timeline-absolute time for a source time `srcSec` within the clip. */
export function sourceToTimeline(clip: TimedClip, srcSec: number): number {
  return clip.startSec + (srcSec - clip.inSec) / clipSpeed(clip)
}
