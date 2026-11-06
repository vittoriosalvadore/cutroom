import type { Clip, Track, TrackKind } from '../types'

// ---------------------------------------------------------------------------
// Pure track-management + marquee math, shared by the store and the timeline.
// Lane geometry here is in CONTENT pixels: y = 0 is the top of the first lane
// (i.e. below the ruler, before vertical scroll), so results don't depend on
// the current scroll position.
// ---------------------------------------------------------------------------

/** Lane height bounds (px) for the drag-to-resize edge and loaded projects. */
export const MIN_TRACK_HEIGHT = 36
export const MAX_TRACK_HEIGHT = 200

export function clampTrackHeight(h: number): number {
  if (!Number.isFinite(h)) return MIN_TRACK_HEIGHT
  return Math.round(Math.min(MAX_TRACK_HEIGHT, Math.max(MIN_TRACK_HEIGHT, h)))
}

/** First free "V<n>" / "A<n>" name (fills gaps left by removed tracks). */
export function nextTrackName(tracks: Track[], kind: TrackKind): string {
  const prefix = kind === 'audio' ? 'A' : 'V'
  const used = new Set(tracks.map((t) => t.name))
  let n = 1
  while (used.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

/** Tracks that hold ordinary footage (the subtitle lane is a video track too,
 *  but titles/media never land on it, so it doesn't count as "a video track"). */
function isPlainVideo(t: Track): boolean {
  return t.kind === 'video' && t.role !== 'subtitle'
}

/**
 * Whether a track may be deleted: the last plain video track and the last audio
 * track are kept, so media added from the bin (and new titles) always have a
 * lane to land on. The subtitle lane can always go.
 */
export function canRemoveTrack(tracks: Track[], trackId: string): boolean {
  const track = tracks.find((t) => t.id === trackId)
  if (!track) return false
  if (track.role === 'subtitle') return true
  const sameKind = tracks.filter((t) => (track.kind === 'audio' ? t.kind === 'audio' : isPlainVideo(t)))
  return sameKind.length > 1
}

/**
 * Where a new video track goes: directly above the topmost plain video track,
 * so it composites on top of the footage (overlay / B-roll) but stays under
 * the subtitle lane. With no video track at all, just below the subtitle lane.
 */
export function newVideoTrackIndex(tracks: Track[]): number {
  const firstVideo = tracks.findIndex(isPlainVideo)
  if (firstVideo >= 0) return firstVideo
  const sub = tracks.findIndex((t) => t.role === 'subtitle')
  return sub >= 0 ? sub + 1 : 0
}

/**
 * Move `trackId` so it ends up at `toIndex` in the result (clamped). Returns
 * the SAME array when nothing moves, so callers can skip a history step.
 */
export function moveTrackTo(tracks: Track[], trackId: string, toIndex: number): Track[] {
  const from = tracks.findIndex((t) => t.id === trackId)
  if (from < 0) return tracks
  const to = Math.max(0, Math.min(tracks.length - 1, Math.round(toIndex)))
  if (to === from) return tracks
  const next = tracks.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Drop target while dragging a track header to content-y `y`. `gap` is the
 * boundary the insertion line is drawn at (0 = above the first lane, n = below
 * the last); `index` is the dragged track's final index for moveTrackTo.
 */
export function trackDropTarget(tracks: Track[], draggedId: string, y: number): { gap: number; index: number } {
  let gap = tracks.length
  let top = 0
  for (let i = 0; i < tracks.length; i++) {
    if (y < top + tracks[i].height / 2) {
      gap = i
      break
    }
    top += tracks[i].height
  }
  const from = tracks.findIndex((t) => t.id === draggedId)
  const index = from >= 0 && gap > from ? gap - 1 : gap
  return { gap, index }
}

/** A rubber-band rectangle: timeline seconds x content pixels (any corner order). */
export interface MarqueeRect {
  t0: number
  t1: number
  y0: number
  y1: number
}

/**
 * Ids of clips whose drawn box intersects the marquee. A clip's box spans its
 * time range and its lane inset by `pad` px top/bottom (as the timeline draws
 * it). Touching counts, so a thin sweep across a lane still catches clips.
 */
export function clipsInMarquee(
  tracks: Track[],
  clips: Record<string, Clip>,
  rect: MarqueeRect,
  pad = 0
): string[] {
  const tA = Math.min(rect.t0, rect.t1)
  const tB = Math.max(rect.t0, rect.t1)
  const yA = Math.min(rect.y0, rect.y1)
  const yB = Math.max(rect.y0, rect.y1)
  const laneSpan = new Map<string, { top: number; bottom: number }>()
  let y = 0
  for (const t of tracks) {
    laneSpan.set(t.id, { top: y + pad, bottom: y + t.height - pad })
    y += t.height
  }
  const out: string[] = []
  for (const c of Object.values(clips)) {
    const lane = laneSpan.get(c.trackId)
    if (!lane) continue
    if (c.startSec > tB || c.startSec + c.durationSec < tA) continue
    if (lane.top > yB || lane.bottom < yA) continue
    out.push(c.id)
  }
  return out
}
