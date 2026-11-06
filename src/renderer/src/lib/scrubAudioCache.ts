import { mediaUrl } from './media'
import { getAudioContext } from './audioContext'

// ---------------------------------------------------------------------------
// Scrub audio for video media (see src/main/scrubAudio.ts). A video clip's
// preview audio comes from its <video> element, which can't play scrub
// grains, so the main process extracts a light mono copy once per source and
// this cache decodes it. Used ONLY by audio scrubbing; playback and export
// never touch it. Keyed by mediaId, like audioCache/denoiseCache.
// ---------------------------------------------------------------------------

/** Longer sources are skipped (mirrors SCRUB_AUDIO_MAX_SEC in main). */
const MAX_SEC = 3 * 60 * 60

type Entry = { status: 'processing' } | { status: 'ready'; buffer: AudioBuffer } | { status: 'error' }

const cache = new Map<string, Entry>()

/** The decoded scrub buffer for a video source, once ready. */
export function getScrubAudio(mediaId: string): AudioBuffer | null {
  const e = cache.get(mediaId)
  return e?.status === 'ready' ? e.buffer : null
}

/** Start (once) extracting + decoding a video source's scrub audio. */
export function ensureScrubAudio(mediaId: string, path: string, durationSec: number): void {
  if (cache.has(mediaId) || !path || !(durationSec > 0) || durationSec > MAX_SEC) return
  if (!window.cutroom?.scrubAudioStart) return
  cache.set(mediaId, { status: 'processing' })
  void (async (): Promise<void> => {
    try {
      const r = await window.cutroom.scrubAudioStart(path)
      if (!r.ok || !r.tempPath) throw new Error(r.error ?? 'no audio')
      const arr = await fetch(mediaUrl(r.tempPath)).then((res) => res.arrayBuffer())
      const buffer = await getAudioContext().decodeAudioData(arr)
      cache.set(mediaId, { status: 'ready', buffer })
    } catch {
      // No audio stream / unreadable: the clip simply stays silent while scrubbing.
      cache.set(mediaId, { status: 'error' })
    }
  })()
}
