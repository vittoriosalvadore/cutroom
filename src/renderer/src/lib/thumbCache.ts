import { mediaUrl } from './media'
import type { MediaItem } from '../types'

// ---------------------------------------------------------------------------
// Thumbnails for the timeline and the Media Bin. Video sources get a filmstrip
// (one JPEG row of evenly spaced frames, rendered once by main and cached on
// disk); images use the picture itself as a single tile. Keyed by media id,
// like the other per-source caches. Purely cosmetic: a missing or failed strip
// just leaves the plain clip colour.
// ---------------------------------------------------------------------------

export interface ThumbStrip {
  img: HTMLImageElement
  /** Number of equal-width tiles laid out left to right. */
  count: number
  tileW: number
  tileH: number
  /** cutroom:// URL of the strip (for CSS backgrounds). */
  url: string
}

type Entry = { status: 'loading' } | { status: 'ready'; strip: ThumbStrip } | { status: 'error' }

const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version += 1
  for (const l of listeners) l()
}

export function subscribeThumbs(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function thumbsVersion(): number {
  return version
}

export function getThumbStrip(mediaId: string): ThumbStrip | null {
  const e = cache.get(mediaId)
  return e?.status === 'ready' ? e.strip : null
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous' // cutroom:// is another origin; keep canvases untainted
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('thumbnail failed to load'))
    img.src = url
  })
}

/** Start (once) producing the thumbnails for a media item. */
export function ensureThumbs(media: MediaItem): void {
  if (cache.has(media.id) || !media.path) return
  if (media.kind !== 'video' && media.kind !== 'image') return
  if (media.kind === 'video' && !(media.durationSec > 0)) return // wait for the probe
  cache.set(media.id, { status: 'loading' })
  void (async (): Promise<void> => {
    try {
      let url: string
      let count = 1
      if (media.kind === 'image') {
        url = mediaUrl(media.path)
      } else {
        if (!window.cutroom?.thumbStrip) throw new Error('no thumbnail bridge')
        const r = await window.cutroom.thumbStrip(media.path, media.durationSec)
        if (!r.ok || !r.path || !r.count) throw new Error(r.error ?? 'no strip')
        url = mediaUrl(r.path)
        count = r.count
      }
      const img = await loadImage(url)
      const tileW = img.naturalWidth / count
      cache.set(media.id, { status: 'ready', strip: { img, count, tileW, tileH: img.naturalHeight, url } })
    } catch {
      cache.set(media.id, { status: 'error' })
    }
    notify()
  })()
}

/** Tile index showing source time `srcSec` of a `durationSec`-long source. */
export function tileIndexAt(srcSec: number, durationSec: number, count: number): number {
  if (count <= 1 || !(durationSec > 0)) return 0
  return Math.min(count - 1, Math.max(0, Math.floor((srcSec / durationSec) * count)))
}
