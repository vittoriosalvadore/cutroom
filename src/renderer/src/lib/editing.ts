import type { AnimProp, Keyframe } from '../types'
import { splitTracksAt } from './keyframes'

// ---------------------------------------------------------------------------
// Pure timeline-editing math: snapping and clip trimming. No DOM/state deps, so
// it is unit-tested directly. The Timeline component owns hit-testing and calls
// these to compute new clip bounds.
// ---------------------------------------------------------------------------

export interface ClipBounds {
  startSec: number
  durationSec: number
  inSec: number
}

/** A clip can never be trimmed shorter than this. */
export const MIN_CLIP_SEC = 0.1

/** Nearest candidate within `thresholdSec`, or null when nothing is close enough. */
function nearestCandidate(value: number, candidates: number[], thresholdSec: number): number | null {
  let best: number | null = null
  let bestDist = thresholdSec
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d <= bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/**
 * Snap a time to the nearest candidate within `thresholdPx` (converted to
 * seconds via the zoom). Returns the snapped time, or the input if nothing is
 * close enough.
 */
export function snapTime(
  value: number,
  candidates: number[],
  pxPerSec: number,
  thresholdPx = 8
): number {
  return nearestCandidate(value, candidates, thresholdPx / pxPerSec) ?? value
}

/**
 * Snap a moving clip by its closest edge: try snapping the leading edge (start)
 * and the trailing edge (start+duration); whichever lands closer wins. Returns
 * the new start time.
 */
export function snapMove(
  rawStart: number,
  durationSec: number,
  candidates: number[],
  pxPerSec: number,
  thresholdPx = 8
): number {
  const thresholdSec = thresholdPx / pxPerSec
  // Track whether each edge actually snapped explicitly: comparing the result
  // against rawStart would misfire on float noise ((a + d) - d !== a).
  const startHit = nearestCandidate(rawStart, candidates, thresholdSec)
  const endHit = nearestCandidate(rawStart + durationSec, candidates, thresholdSec)
  const snapStart = startHit ?? rawStart
  const snapByEnd = endHit != null ? endHit - durationSec : rawStart
  if (startHit != null && endHit != null) {
    return Math.abs(snapStart - rawStart) <= Math.abs(snapByEnd - rawStart) ? snapStart : snapByEnd
  }
  if (startHit != null) return snapStart
  if (endHit != null) return snapByEnd
  return rawStart
}

/**
 * Compute new clip bounds when dragging the left or right edge by `deltaSec`,
 * with all clamping applied:
 *  - never shorter than MIN_CLIP_SEC
 *  - start never < 0
 *  - for media clips with a known source length, never read outside the source
 *    (inSec >= 0 and inSec + duration <= srcDuration)
 * Non-media clips (titles/subtitles) keep inSec and are bounded only by length.
 */
export function computeTrim(
  orig: ClipBounds,
  edge: 'left' | 'right',
  deltaSec: number,
  opts: { isMedia: boolean; srcDuration: number | null; speed?: number }
): ClipBounds {
  const bounded = opts.isMedia && opts.srcDuration != null
  // A clip consumes durationSec * speed of SOURCE, so source limits scale by 1/speed.
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1

  if (edge === 'right') {
    let dur = Math.max(MIN_CLIP_SEC, orig.durationSec + deltaSec)
    if (bounded) {
      dur = Math.min(dur, Math.max(MIN_CLIP_SEC, ((opts.srcDuration as number) - orig.inSec) / speed))
    }
    return { startSec: orig.startSec, durationSec: dur, inSec: orig.inSec }
  }

  // Left edge: positive delta shortens from the head, negative extends it. Each
  // timeline second of trim moves the in-point by `speed` source seconds.
  const maxD = orig.durationSec - MIN_CLIP_SEC // keep duration >= MIN
  let minD = -orig.startSec // keep start >= 0
  if (bounded) minD = Math.max(minD, -orig.inSec / speed) // keep inSec >= 0
  const d = Math.max(minD, Math.min(maxD, deltaSec))

  return {
    startSec: orig.startSec + d,
    durationSec: orig.durationSec - d,
    inSec: bounded ? orig.inSec + d * speed : orig.inSec
  }
}

/**
 * Compute a crossfade between an earlier clip `e` and a later clip `l` (ordered
 * by start time). If they already overlap, that overlap IS the crossfade length;
 * otherwise the later clip is pulled left to create a `defaultDur` overlap. The
 * caller then sets e.fadeOut = l.fadeIn = overlap. Returns the overlap length and
 * the later clip's (possibly new) start.
 */
export function computeCrossfade(
  e: { startSec: number; durationSec: number },
  l: { startSec: number; durationSec: number },
  defaultDur = 0.5
): { overlap: number; lStart: number } {
  const eEnd = e.startSec + e.durationSec
  let lStart = l.startSec
  let overlap = eEnd - lStart
  if (overlap <= 1e-4) {
    const d = Math.min(defaultDur, e.durationSec, l.durationSec)
    lStart = Math.max(0, eEnd - d)
    overlap = eEnd - lStart
  }
  overlap = Math.max(0, Math.min(overlap, e.durationSec, l.durationSec))
  return { overlap, lStart }
}

/** Minimal split input: whatever a split needs to touch, decoupled from the
 *  full Clip type (same minimalism as ClipBounds) so this stays testable
 *  without constructing a full Project. */
export interface SplittableClip {
  startSec: number
  durationSec: number
  inSec: number
  speed?: number
  fadeInSec?: number
  fadeOutSec?: number
  keyframes?: Partial<Record<AnimProp, Keyframe[]>>
}

export interface SplitResult<T> {
  left: T
  right: T
}

/**
 * Split one clip at absolute timeline time `atSec`. Returns undefined if atSec
 * doesn't actually fall strictly inside the clip. Mirrors the inline split
 * logic `splitAtPlayhead` (store.ts) already applies at the playhead, factored
 * out so auto-cut-silence can call it many times per job. The two returned
 * pieces carry no id/trackId — the caller assigns those (existing id for
 * `left`, a fresh id for `right`), matching how splitAtPlayhead does it today.
 */
export function splitClipAt<T extends SplittableClip>(clip: T, atSec: number): SplitResult<T> | undefined {
  if (atSec <= clip.startSec + 1e-4 || atSec >= clip.startSec + clip.durationSec - 1e-4) return undefined
  const offset = atSec - clip.startSec
  const rightDur = clip.durationSec - offset
  const kf = clip.keyframes ? splitTracksAt(clip.keyframes, offset) : undefined
  return {
    left: {
      ...clip,
      durationSec: offset,
      fadeInSec: Math.min(clip.fadeInSec ?? 0, offset),
      fadeOutSec: 0,
      keyframes: kf?.left
    },
    right: {
      ...clip,
      startSec: atSec,
      durationSec: rightDur,
      inSec: clip.inSec + offset * (clip.speed ?? 1),
      fadeInSec: 0,
      fadeOutSec: Math.min(clip.fadeOutSec ?? 0, rightDur),
      keyframes: kf?.right
    }
  }
}

/** Minimal ripple-delete input. */
export interface RippleClip {
  trackId: string
  startSec: number
}

/**
 * Ripple-shift: every clip on `trackId` whose start is at/after the removed
 * range's start moves left by `removedDurationSec`, closing the gap. Clips on
 * OTHER tracks are untouched — ripple is per-lane, matching the existing
 * product decision in rippleDelete/rippleDeleteSelected (store.ts).
 */
export function rippleShift<T extends RippleClip>(
  clips: T[],
  trackId: string,
  removedStartSec: number,
  removedDurationSec: number
): T[] {
  return clips.map((c) =>
    c.trackId === trackId && c.startSec >= removedStartSec - 1e-6
      ? { ...c, startSec: Math.max(0, c.startSec - removedDurationSec) }
      : c
  )
}

/** Minimal marker/region input: a point (timeSec) or a region (+ endSec). */
export interface RippleMarker {
  timeSec: number
  endSec?: number
}

/**
 * Shift markers/regions the same way rippleShift shifts clips: any time at/
 * after the removed range's END moves left by removedDurationSec; a time
 * INSIDE the removed range collapses to its start (the footage it pointed at is
 * gone, so the nearest surviving spot is the cut point). Ripple-delete today
 * (store.ts) only shifts clips, never markers — silently desyncing marker
 * positions whenever something is ripple-deleted. Auto-cut-silence calls
 * ripple-delete far more densely than today's manual usage, so this fixes it.
 */
export function rippleShiftMarkers<T extends RippleMarker>(
  markers: T[],
  removedStartSec: number,
  removedDurationSec: number
): T[] {
  const shift = (t: number): number => shiftTimeForRanges(t, [{ startSec: removedStartSec, durationSec: removedDurationSec }])
  return markers.map((m) => ({ ...m, timeSec: shift(m.timeSec), endSec: m.endSec != null ? shift(m.endSec) : m.endSec }))
}

/** A removed span of timeline: [startSec, startSec + durationSec). */
export interface RemovedRange {
  startSec: number
  durationSec: number
}

/**
 * Union possibly-overlapping removed ranges (e.g. clips deleted from several
 * tracks at once) into sorted, non-overlapping spans. Markers live on the
 * shared timeline, not a lane, so two clips deleted in parallel on V1 and A1
 * remove that time ONCE, not twice.
 */
export function mergeRemovedRanges(ranges: RemovedRange[]): RemovedRange[] {
  const sorted = ranges.filter((r) => r.durationSec > 0).sort((a, b) => a.startSec - b.startSec)
  const out: RemovedRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    const end = r.startSec + r.durationSec
    if (last && r.startSec <= last.startSec + last.durationSec + 1e-6) {
      last.durationSec = Math.max(last.durationSec, end - last.startSec)
    } else {
      out.push({ startSec: r.startSec, durationSec: r.durationSec })
    }
  }
  return out
}

/**
 * Where time `t` lands after removing every range in `ranges` (which must be
 * non-overlapping — see mergeRemovedRanges). Evaluated against the ORIGINAL
 * positions in one pass, so the result is independent of range order: each
 * range wholly before `t` pulls it left by its duration; a range containing `t`
 * collapses it onto that range's start.
 */
export function shiftTimeForRanges(t: number, ranges: RemovedRange[]): number {
  let shift = 0
  for (const r of ranges) {
    const end = r.startSec + r.durationSec
    if (t >= end - 1e-6) shift += r.durationSec
    else if (t > r.startSec) shift += t - r.startSec
  }
  return Math.max(0, t - shift)
}
