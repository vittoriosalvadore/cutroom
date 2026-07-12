import type { Project } from '../types'
import { mediaUrl } from './media'
import { getAudioContext } from './audioContext'

// ---------------------------------------------------------------------------
// AI noise removal cache. Keyed by mediaId (decode-once-reuse-everywhere, same
// convention as audioCache.ts) rather than stored in project JSON — the
// denoised audio is a derived artifact, not project state. The main process
// runs FFmpeg's arnndn filter to a temp WAV once; this cache decodes that WAV
// into an AudioBuffer for realtime preview playback and keeps the temp path
// around for export to feed straight into the mux pass.
// ---------------------------------------------------------------------------

export interface DenoiseEntry {
  status: 'processing' | 'ready' | 'error'
  tempPath?: string
  buffer?: AudioBuffer
  error?: string
}

const cache = new Map<string, DenoiseEntry>()
const inflight = new Map<string, Promise<DenoiseEntry>>()
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const l of listeners) l()
}

export function subscribeDenoiseCache(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function denoiseCacheVersion(): number {
  return version
}

export function getDenoiseEntry(mediaId: string): DenoiseEntry | undefined {
  return cache.get(mediaId)
}

/** Drop a cached result so the next ensureDenoised() call re-runs the filter
 *  (e.g. the user turned denoise off then on again after an error). */
export function clearDenoiseEntry(mediaId: string): void {
  cache.delete(mediaId)
  notify()
}

/** Kick off (or reuse an in-flight/ready) denoise job for a media source.
 *  Idempotent — safe to call every time the Inspector renders a denoise-
 *  enabled clip, or from the export preflight. */
export function ensureDenoised(mediaId: string, path: string): Promise<DenoiseEntry> {
  const existing = cache.get(mediaId)
  if (existing?.status === 'ready') return Promise.resolve(existing)
  const already = inflight.get(mediaId)
  if (already) return already

  const job = (async (): Promise<DenoiseEntry> => {
    cache.set(mediaId, { status: 'processing' })
    notify()
    try {
      const result = await window.cutroom.denoiseStart(path)
      if (!result.ok || !result.tempPath) throw new Error(result.error ?? 'Denoise failed.')
      const arr = await fetch(mediaUrl(result.tempPath)).then((r) => r.arrayBuffer())
      const buffer = await getAudioContext().decodeAudioData(arr)
      const entry: DenoiseEntry = { status: 'ready', tempPath: result.tempPath, buffer }
      cache.set(mediaId, entry)
      notify()
      return entry
    } catch (e) {
      const entry: DenoiseEntry = { status: 'error', error: e instanceof Error ? e.message : 'Denoise failed.' }
      cache.set(mediaId, entry)
      notify()
      return entry
    } finally {
      inflight.delete(mediaId)
    }
  })()
  inflight.set(mediaId, job)
  return job
}

/** Ensure every denoise-enabled clip's source has a ready cache entry before
 *  export reads it — export must never silently fall back to the original
 *  audio just because the job hadn't finished (or hadn't been started, e.g.
 *  the user enabled it and immediately hit Export). */
export async function ensureDenoisedForExport(project: Project): Promise<void> {
  const seen = new Set<string>()
  const waits: Promise<DenoiseEntry>[] = []
  for (const clip of Object.values(project.clips)) {
    if (!clip.denoiseEnabled || !clip.mediaId || seen.has(clip.mediaId)) continue
    const media = project.media[clip.mediaId]
    if (!media || !media.path) continue
    seen.add(clip.mediaId)
    waits.push(ensureDenoised(clip.mediaId, media.path))
  }
  await Promise.all(waits)
}
