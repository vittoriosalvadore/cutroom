import { mediaUrl } from './media'
import { getAudioContext } from './audioContext'

// ---------------------------------------------------------------------------
// Decodes audio media to a shared AudioBuffer once per source, and derives a
// peak array for waveform drawing. One decode path feeds both playback and the
// timeline waveform. A version counter + subscribe() lets the timeline redraw
// when a decode finishes.
// ---------------------------------------------------------------------------

export const PEAKS_PER_SEC = 80
const MAX_DECODE_SEC = 900 // 15 min: skip full decode of very long files

export interface AudioEntry {
  status: 'loading' | 'ready' | 'error' | 'skipped'
  buffer?: AudioBuffer
  peaks?: Float32Array
}

const cache = new Map<string, AudioEntry>()
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const l of listeners) l()
}

export function subscribeAudioCache(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function audioCacheVersion(): number {
  return version
}

export function getAudioEntry(mediaId: string): AudioEntry | undefined {
  return cache.get(mediaId)
}

/** Downsample channel 0 to PEAKS_PER_SEC absolute-max buckets per second. */
function computePeaks(buffer: AudioBuffer): Float32Array {
  const data = buffer.getChannelData(0)
  const total = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SEC))
  const peaks = new Float32Array(total)
  const per = Math.max(1, Math.floor(buffer.length / total))
  for (let i = 0; i < total; i++) {
    const start = i * per
    const end = Math.min(buffer.length, start + per)
    let peak = 0
    for (let j = start; j < end; j++) {
      const a = Math.abs(data[j])
      if (a > peak) peak = a
    }
    peaks[i] = peak
  }
  return peaks
}

/**
 * The cached buffer for a media item, waiting for the app's own background
 * decode (ensureAudioDecoded, started on import) when it is still in flight
 * instead of starting a redundant parallel one — transcribing right after
 * importing a long file used to decode it twice. Resolves null when the cache
 * won't provide one (never requested, skipped as too long, or failed), so the
 * caller decodes on demand.
 */
export function waitForDecoded(mediaId: string): Promise<AudioBuffer | null> {
  // undefined = still loading.
  const settled = (): AudioBuffer | null | undefined => {
    const e = getAudioEntry(mediaId)
    if (e?.status === 'loading') return undefined
    return e?.status === 'ready' && e.buffer ? e.buffer : null
  }
  const now = settled()
  if (now !== undefined) return Promise.resolve(now)
  return new Promise((resolve) => {
    const unsub = subscribeAudioCache(() => {
      const r = settled()
      if (r === undefined) return
      unsub()
      resolve(r)
    })
  })
}

/** Get a media item's decoded AudioBuffer directly — reuses the cache if
 *  ready (or about to be), else decodes on demand. For features needing
 *  synchronous buffer access outside the normal ensureAudioDecoded
 *  cache-and-notify flow (e.g. transcription, silence detection). */
export async function getOrDecodeBuffer(mediaId: string, path: string): Promise<AudioBuffer> {
  const cached = await waitForDecoded(mediaId)
  if (cached) return cached
  const arr = await fetch(mediaUrl(path)).then((r) => r.arrayBuffer())
  return getAudioContext().decodeAudioData(arr)
}

/** Decode a media file's audio once. Safe to call repeatedly (idempotent).
 *  Pass durationSec=0 when the probe failed or returned an unknown duration —
 *  the post-decode buffer.duration check still guards against long files. */
export function ensureAudioDecoded(mediaId: string, path: string, durationSec: number): void {
  if (!path || cache.has(mediaId)) return
  // Skip before fetching only when we know the file is too long.
  // durationSec=0 means "unknown" — we let it through and check after decode.
  if (durationSec > 0 && durationSec > MAX_DECODE_SEC) {
    cache.set(mediaId, { status: 'skipped' })
    notify()
    return
  }
  cache.set(mediaId, { status: 'loading' })
  notify()
  fetch(mediaUrl(path))
    .then((r) => r.arrayBuffer())
    .then((buf) => getAudioContext().decodeAudioData(buf))
    .then((buffer) => {
      // Defensive: if the probed duration under-reported, don't keep a giant buffer.
      if (buffer.duration > MAX_DECODE_SEC) {
        cache.set(mediaId, { status: 'skipped' })
        notify()
        return
      }
      cache.set(mediaId, { status: 'ready', buffer, peaks: computePeaks(buffer) })
      notify()
    })
    .catch(() => {
      cache.set(mediaId, { status: 'error' })
      notify()
    })
}
