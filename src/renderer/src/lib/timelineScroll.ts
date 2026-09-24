// ---------------------------------------------------------------------------
// Pure scroll math for the timeline canvas. Horizontal scroll is kept in
// SECONDS (the time at the left edge of the lane area) so it survives zoom
// changes; vertical scroll is in CSS pixels of lane content.
// ---------------------------------------------------------------------------

/**
 * Clamp a horizontal scroll (seconds) to [0, max]. `contentEndSec` is the end of
 * the material (timeline end, or the playhead if later); you can scroll until
 * that end sits mid-view, leaving room to drop clips after it.
 */
export function clampScrollSec(scrollSec: number, contentEndSec: number, visibleSec: number): number {
  const max = Math.max(0, contentEndSec - visibleSec / 2)
  if (!Number.isFinite(scrollSec)) return 0
  return Math.min(max, Math.max(0, scrollSec))
}

/** Clamp a vertical lane scroll (px) so the last lane can't leave the bottom. */
export function clampScrollY(scrollY: number, contentPx: number, viewportPx: number): number {
  const max = Math.max(0, contentPx - viewportPx)
  if (!Number.isFinite(scrollY)) return 0
  return Math.min(max, Math.max(0, scrollY))
}

/**
 * Scroll needed to keep the playhead in view. Returns `scrollSec` unchanged when
 * it is already visible; otherwise pages so the playhead lands a little in from
 * the left edge (the usual NLE "page follow" during playback).
 */
export function followPlayhead(scrollSec: number, playheadSec: number, visibleSec: number): number {
  if (visibleSec <= 0) return scrollSec
  const lead = visibleSec * 0.05 // how far in from the edge the playhead may get
  if (playheadSec >= scrollSec && playheadSec <= scrollSec + visibleSec - lead) return scrollSec
  return Math.max(0, playheadSec - visibleSec * 0.1)
}

/**
 * New scroll after zooming from `oldPx` to `newPx` px/sec so the time under the
 * cursor (`anchorPx` px into the lane area) stays put.
 */
export function zoomAnchoredScroll(scrollSec: number, anchorPx: number, oldPx: number, newPx: number): number {
  const anchorT = scrollSec + anchorPx / oldPx
  return Math.max(0, anchorT - anchorPx / newPx)
}

/**
 * Total scrollable length (seconds) matching clampScrollSec: you can scroll
 * until the content end sits mid-view, so the extent is end + half a view
 * (never less than one view).
 */
export function scrollExtentSec(contentEndSec: number, visibleSec: number): number {
  return Math.max(visibleSec, contentEndSec + visibleSec / 2)
}

/**
 * Scrollbar thumb for a scroll `pos` over `extent` with `visible` of it shown,
 * on a track `trackPx` long. The thumb never shrinks below `minPx` so it stays
 * grabbable on long timelines. Returns px offsets within the track.
 */
export function thumbGeometry(
  pos: number,
  visible: number,
  extent: number,
  trackPx: number,
  minPx = 28
): { offset: number; size: number } {
  if (!(extent > 0) || !(trackPx > 0) || visible >= extent) return { offset: 0, size: Math.max(0, trackPx) }
  const size = Math.min(trackPx, Math.max(minPx, (visible / extent) * trackPx))
  const maxPos = extent - visible
  const offset = maxPos > 0 ? (Math.min(Math.max(pos, 0), maxPos) / maxPos) * (trackPx - size) : 0
  return { offset, size }
}

/** Inverse of thumbGeometry: the scroll position for a thumb at `offsetPx`. */
export function posFromThumb(offsetPx: number, visible: number, extent: number, trackPx: number, minPx = 28): number {
  const { size } = thumbGeometry(0, visible, extent, trackPx, minPx)
  const room = trackPx - size
  const maxPos = Math.max(0, extent - visible)
  if (room <= 0) return 0
  return (Math.min(Math.max(offsetPx, 0), room) / room) * maxPos
}

/** Zoom (px per second) that fits `durationSec` into `lanePx`, with a small margin. */
export function fitZoom(durationSec: number, lanePx: number): number {
  if (!(durationSec > 0) || !(lanePx > 0)) return 100
  return lanePx / (durationSec * 1.04)
}
