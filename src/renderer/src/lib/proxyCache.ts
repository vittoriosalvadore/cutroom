import type { MediaItem } from '../types'
import { previewSourcePath, type ProxyEntry } from './proxy'

// ---------------------------------------------------------------------------
// Proxy (optimized preview media) state, renderer side. Keyed by SOURCE PATH
// — not media id, not project JSON: a proxy is a derived cache artifact that
// main finds again from the file itself (userData/proxies/<hash(path, size,
// mtime)>.mp4), so the same file shares one proxy across media items and
// projects, and a saved project never carries a proxy path. Same
// subscribe/version shape as denoiseCache.ts.
//
// Only the PREVIEW compositor reads this (via proxyPreviewPath); export
// renders and mixes from MediaItem.path.
// ---------------------------------------------------------------------------

const cache = new Map<string, ProxyEntry>()
const inflight = new Map<string, Promise<ProxyEntry | undefined>>()
/** Paths already asked about (proxy:lookup), so re-renders don't re-stat. */
const looked = new Set<string>()
let version = 0
const listeners = new Set<() => void>()
let progressHooked = false

function notify(): void {
  version += 1
  for (const l of listeners) l()
}

/** Route main's queued/running progress pushes into the entries once. */
function hookProgress(): void {
  if (progressHooked || !window.cutroom?.onProxyProgress) return
  progressHooked = true
  window.cutroom.onProxyProgress((p) => {
    const e = cache.get(p.sourcePath)
    // Only jobs we're waiting on; a late push must not un-ready an entry.
    if (!e || (e.status !== 'queued' && e.status !== 'processing')) return
    cache.set(p.sourcePath, { status: p.state === 'queued' ? 'queued' : 'processing', progress: p.progress })
    notify()
  })
}

export function subscribeProxyCache(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function proxyCacheVersion(): number {
  return version
}

export function getProxyEntry(sourcePath: string): ProxyEntry | undefined {
  return cache.get(sourcePath)
}

/** What the preview should decode for `media` (proxy when ready + enabled). */
export function proxyPreviewPath(media: MediaItem, useProxies: boolean): string {
  return previewSourcePath(media, cache.get(media.path), { useProxies })
}

/** Pick up proxies that already exist on disk (earlier session / project).
 *  Each path is asked once; never starts a transcode. */
export async function lookupProxies(paths: string[]): Promise<void> {
  const fresh = paths.filter((p) => p && !looked.has(p))
  if (!fresh.length || !window.cutroom?.proxyLookup) return
  for (const p of fresh) looked.add(p)
  let found: Record<string, string | null>
  try {
    found = await window.cutroom.proxyLookup(fresh)
  } catch {
    return
  }
  let changed = false
  for (const [path, proxyPath] of Object.entries(found)) {
    if (proxyPath && !cache.has(path)) {
      cache.set(path, { status: 'ready', progress: 1, proxyPath })
      changed = true
    }
  }
  if (changed) notify()
}

/** Queue (or join / reuse) a proxy for a source. Resolves with the final
 *  entry, or undefined when the job was cancelled. */
export function ensureProxy(sourcePath: string, durationSec: number): Promise<ProxyEntry | undefined> {
  const existing = cache.get(sourcePath)
  if (existing?.status === 'ready') return Promise.resolve(existing)
  const already = inflight.get(sourcePath)
  if (already) return already
  hookProgress()

  const job = (async (): Promise<ProxyEntry | undefined> => {
    cache.set(sourcePath, { status: 'queued', progress: 0 })
    notify()
    try {
      const r = await window.cutroom.proxyCreate(sourcePath, durationSec)
      if (r.cancelled) {
        cache.delete(sourcePath)
        notify()
        return undefined
      }
      const entry: ProxyEntry =
        r.ok && r.proxyPath
          ? { status: 'ready', progress: 1, proxyPath: r.proxyPath }
          : { status: 'error', progress: 0, error: r.error ?? 'Proxy failed.' }
      cache.set(sourcePath, entry)
      notify()
      return entry
    } catch (e) {
      const entry: ProxyEntry = { status: 'error', progress: 0, error: e instanceof Error ? e.message : 'Proxy failed.' }
      cache.set(sourcePath, entry)
      notify()
      return entry
    } finally {
      inflight.delete(sourcePath)
    }
  })()
  inflight.set(sourcePath, job)
  return job
}

/** Cancel a queued/running job; its promise resolves undefined. */
export function cancelProxy(sourcePath: string): void {
  void window.cutroom?.proxyCancel(sourcePath).catch(() => undefined)
}

/**
 * Delete every cached proxy. Entries are dropped FIRST so the preview swaps
 * back to the originals (releasing the proxy files it has open), then main
 * cancels any job and deletes the files. `failed` counts files still locked.
 */
export async function clearProxyCache(): Promise<{ failed: number }> {
  cache.clear()
  looked.clear()
  notify()
  // One or two preview frames to recreate the decoders on the originals.
  await new Promise((r) => window.setTimeout(r, 300))
  try {
    const r = await window.cutroom.proxyClearCache()
    return { failed: r.failed }
  } catch {
    return { failed: -1 }
  }
}
