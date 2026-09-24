import type { MediaItem } from '../types'

// ---------------------------------------------------------------------------
// Pure proxy (optimized preview media) decisions, shared by the proxy cache,
// the preview compositor and the UI. No window/IPC access, so unit-testable.
// ---------------------------------------------------------------------------

export type ProxyStatus = 'queued' | 'processing' | 'ready' | 'error'

export interface ProxyEntry {
  status: ProxyStatus
  /** 0..1 while processing. */
  progress: number
  /** The cached proxy file, present only when ready. */
  proxyPath?: string
  error?: string
}

/** "Larger than 1080p": the SHORTER side exceeds 1080 px, so portrait 1080×1920
 *  phone footage doesn't count but 1440p and 4K (either orientation) do. */
export const AUTO_PROXY_MIN_SHORT_SIDE = 1080

/** Should the auto option create a proxy for this media (once it's probed)? */
export function shouldAutoProxy(media: MediaItem): boolean {
  if (media.kind !== 'video' || !media.path) return false
  const w = media.width ?? 0
  const h = media.height ?? 0
  if (w <= 0 || h <= 0) return false
  return Math.min(w, h) > AUTO_PROXY_MIN_SHORT_SIDE
}

/**
 * The file the PREVIEW decodes for a media item: its ready proxy when proxies
 * are enabled, otherwise the original. `exact` (the export render) always
 * returns the original — export must never read a proxy.
 */
export function previewSourcePath(
  media: MediaItem,
  entry: ProxyEntry | undefined,
  opts: { useProxies: boolean; exact?: boolean }
): string {
  if (opts.exact || !opts.useProxies) return media.path
  if (entry?.status === 'ready' && entry.proxyPath) return entry.proxyPath
  return media.path
}

/**
 * The size used to lay a video frame out in the program frame ("contain").
 * A proxy's pixel size is smaller and its aspect can differ by a rounding
 * pixel (even dims), so a proxied frame is laid out by the ORIGINAL's probed
 * size — preview geometry is then identical with or without the proxy. The
 * probe reports the upright (rotation-applied) size, matching a proxy whose
 * rotation is baked in.
 */
export function frameLayoutSize(
  media: MediaItem,
  frame: { width: number; height: number },
  proxied: boolean
): { width: number; height: number } {
  if (proxied && (media.width ?? 0) > 0 && (media.height ?? 0) > 0) {
    return { width: media.width as number, height: media.height as number }
  }
  return { width: frame.width, height: frame.height }
}

/** Human-readable byte size (for the cache size readout). */
export function formatBytes(n: number): string {
  if (!(n > 0)) return '0 MB'
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  const mb = n / 1024 ** 2
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}
