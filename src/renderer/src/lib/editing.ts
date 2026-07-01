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
  const thresholdSec = thresholdPx / pxPerSec
  let best = value
  let bestDist = thresholdSec
  let found = false
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d <= bestDist) {
      bestDist = d
      best = c
      found = true
    }
  }
  return found ? best : value
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
  const snapStart = snapTime(rawStart, candidates, pxPerSec, thresholdPx)
  const snapByEnd = snapTime(rawStart + durationSec, candidates, pxPerSec, thresholdPx) - durationSec
  const startMoved = snapStart !== rawStart
  const endMoved = snapByEnd !== rawStart
  if (startMoved && endMoved) {
    return Math.abs(snapStart - rawStart) <= Math.abs(snapByEnd - rawStart) ? snapStart : snapByEnd
  }
  if (startMoved) return snapStart
  if (endMoved) return snapByEnd
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
