// ---------------------------------------------------------------------------
// Which decode tier a media file should use. The EXTENSION check is pure and
// synchronous (the common fast path); the codec-probe wrapper is async (it
// must ask VideoDecoder.isConfigSupported before committing, since an MP4 may
// hold H.265/HEVC the build can't decode).
// ---------------------------------------------------------------------------

import type { MediaItem } from '../types'

export type DecodeTier = 'webcodecs' | 'video-element'

const WEBCODECS_EXT = new Set(['mp4', 'm4v', 'mov'])

/** The fast, synchronous tier guess from the file extension. */
export function extensionTier(path: string): DecodeTier {
  const ext = (path.toLowerCase().split('.').pop() || '').trim()
  return WEBCODECS_EXT.has(ext) ? 'webcodecs' : 'video-element'
}

/**
 * The real tier decision: the extension AND a VideoDecoder capability probe.
 * Falls back to video-element whenever WebCodecs is unavailable or the codec
 * isn't supported. `probeCodec` is injected so this stays pure-testable (the
 * real probe hits mp4box.js + the network).
 */
export async function resolveTier(
  media: MediaItem,
  probeCodec: (path: string) => Promise<string | null>
): Promise<DecodeTier> {
  if (typeof VideoDecoder === 'undefined') return 'video-element'
  if (extensionTier(media.path) !== 'webcodecs') return 'video-element'
  const codec = await probeCodec(media.path).catch(() => null)
  if (!codec) return 'video-element'
  try {
    const supported = await VideoDecoder.isConfigSupported({ codec })
    return supported.supported ? 'webcodecs' : 'video-element'
  } catch {
    return 'video-element'
  }
}

/**
 * True when an MP4 track's display matrix (tkhd, 3x3 with 16.16 fixed-point
 * a/b/c/d) rotates or mirrors the picture — e.g. portrait phone footage stored
 * landscape with a 90° matrix. The <video> element applies it; decoded
 * VideoFrames do NOT, so the WebCodecs tier must decline such tracks (report
 * unsupported) and leave them on the element tier. Scale/translation alone is
 * ignored, like Chromium does. A missing matrix counts as identity.
 */
export function hasDisplayRotation(matrix: ArrayLike<number> | null | undefined): boolean {
  if (!matrix || matrix.length < 5) return false
  const a = matrix[0]
  const b = matrix[1]
  const c = matrix[3]
  const d = matrix[4]
  return b !== 0 || c !== 0 || a < 0 || d < 0
}
