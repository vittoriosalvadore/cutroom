import { app, ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, readdirSync, unlinkSync } from 'fs'
import { access, readdir, rename, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { setPriority } from 'os'
import { ffmpegPath, releaseTemp, trackProcess, trackTemp } from './ffmpeg'
import { isLocalFilePath } from './paths'
import {
  buildProxyArgs,
  durationsMatch,
  isProxyFileName,
  parseDurationLine,
  parseProgressTime,
  partialName,
  progressFraction,
  proxyFileName
} from './proxyArgs'

// ---------------------------------------------------------------------------
// Proxy / optimized media. For heavy video (4K, long-GOP camera codecs) main
// transcodes a lightweight 720p short-GOP H.264 copy that the PREVIEW decodes
// instead of the original. Export never sees a proxy: the renderer only swaps
// paths inside the preview compositor, and everything export builds (frames,
// audio plan) reads MediaItem.path.
//
// Proxies live in userData/proxies/<hash(path, size, mtime)>.mp4, so they
// survive restarts and are found again by recomputing the name — the project
// file never stores a proxy path. One job runs at a time (a transcode already
// saturates the CPU); the rest wait in a FIFO queue. Output is written to a
// `.partial` file that is renamed into place only after a duration check, and
// partials are deleted on cancel, failure, quit and (for a crashed session)
// at the next launch.
// ---------------------------------------------------------------------------

export interface ProxyResult {
  ok: boolean
  proxyPath?: string
  cancelled?: boolean
  error?: string
}

/** Pushed to the renderer on 'proxy:progress' while a job is queued/running. */
interface ProxyProgress {
  sourcePath: string
  state: 'queued' | 'running'
  /** 0..1 */
  progress: number
}

interface Job {
  sourcePath: string
  /** Renderer-probed duration, the progress denominator (0 = unknown). */
  durationSec: number
  waiters: ((r: ProxyResult) => void)[]
  senders: Set<WebContents>
  proc: ChildProcess | null
  cancelled: boolean
}

const PROBE_TIMEOUT_MS = 15000

const queue: Job[] = []
let running: Job | null = null

function proxyDir(): string {
  return join(app.getPath('userData'), 'proxies')
}

function ensureDir(): string {
  const dir = proxyDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Where the proxy for `sourcePath` lives (whether or not it exists yet). */
async function proxyPathFor(sourcePath: string): Promise<string> {
  const info = await stat(sourcePath)
  return join(proxyDir(), proxyFileName(sourcePath, info.size, info.mtimeMs))
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function send(job: Job, state: ProxyProgress['state'], progress: number): void {
  const msg: ProxyProgress = { sourcePath: job.sourcePath, state, progress }
  for (const wc of job.senders) if (!wc.isDestroyed()) wc.send('proxy:progress', msg)
}

function settle(job: Job, result: ProxyResult): void {
  for (const w of job.waiters) w(result)
  job.waiters = []
}

/** Container duration of a file via `ffmpeg -i` (no ffprobe bundled). */
function probeDuration(path: string): Promise<number> {
  const bin = ffmpegPath
  if (!bin) return Promise.resolve(0)
  return new Promise((resolve) => {
    const proc = trackProcess(spawn(bin, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] }))
    let stderr = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 64000) stderr += d.toString()
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(0)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      resolve(parseDurationLine(stderr))
    })
  })
}

async function runJob(job: Job): Promise<ProxyResult> {
  if (!ffmpegPath) return { ok: false, error: 'Bundled FFmpeg binary not found for this platform.' }
  let finalPath: string
  try {
    finalPath = await proxyPathFor(job.sourcePath)
  } catch {
    return { ok: false, error: 'Source file not found.' }
  }
  if (await exists(finalPath)) return { ok: true, proxyPath: finalPath }
  if (job.cancelled) return { ok: false, cancelled: true }

  const dir = ensureDir()
  const partial = join(dir, partialName(basename(finalPath)))
  trackTemp(partial) // deleted on quit if we're killed mid-encode
  const cleanup = async (): Promise<void> => {
    await unlink(partial).catch(() => undefined)
    releaseTemp(partial)
  }

  send(job, 'running', 0)
  const code = await new Promise<number | string>((resolve) => {
    const proc = trackProcess(
      spawn(ffmpegPath as string, buildProxyArgs(job.sourcePath, partial), { stdio: ['ignore', 'pipe', 'pipe'] })
    )
    job.proc = proc
    // A background transcode must not starve the editor (preview decode, UI):
    // run it at below-normal priority. Best effort — may be refused.
    try {
      if (proc.pid) setPriority(proc.pid, 10)
    } catch {
      /* keep normal priority */
    }
    let stderr = ''
    let sourceSec = job.durationSec
    let lastSent = -1
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 32000) stderr = stderr.slice(-16000)
      // Fall back to FFmpeg's own view of the input when the renderer had none.
      if (!(sourceSec > 0)) sourceSec = parseDurationLine(stderr)
    })
    let pending = ''
    proc.stdout?.on('data', (d: Buffer) => {
      // Parse whole lines only: a chunk can end mid-number.
      pending += d.toString()
      const cut = pending.lastIndexOf('\n')
      if (cut < 0) return
      const lines = pending.slice(0, cut + 1)
      pending = pending.slice(cut + 1)
      const t = parseProgressTime(lines)
      if (t === null) return
      const p = progressFraction(t, sourceSec)
      // Throttle IPC to whole-percent steps.
      if (Math.floor(p * 100) !== Math.floor(lastSent * 100)) {
        lastSent = p
        send(job, 'running', p)
      }
    })
    proc.on('error', (err) => resolve(err.message))
    proc.on('close', (c) => resolve(c === 0 ? 0 : `FFmpeg proxy exited with code ${c}.\n${stderr.slice(-700)}`))
  })
  job.proc = null

  if (job.cancelled) {
    await cleanup()
    return { ok: false, cancelled: true }
  }
  if (code !== 0) {
    await cleanup()
    return { ok: false, error: String(code) }
  }

  // Source times must map 1:1 onto the proxy — refuse one that doesn't match.
  const [srcSec, proxySec] = await Promise.all([probeDuration(job.sourcePath), probeDuration(partial)])
  if (job.cancelled) {
    await cleanup()
    return { ok: false, cancelled: true }
  }
  if (!durationsMatch(srcSec, proxySec)) {
    await cleanup()
    return { ok: false, error: `Proxy duration ${proxySec.toFixed(2)}s does not match the source (${srcSec.toFixed(2)}s).` }
  }
  try {
    await rename(partial, finalPath)
  } catch (e) {
    await cleanup()
    return { ok: false, error: e instanceof Error ? e.message : 'Could not store the proxy.' }
  }
  releaseTemp(partial)
  return { ok: true, proxyPath: finalPath }
}

/** Start the next queued job if nothing is running (concurrency = 1). */
function pump(): void {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = job
  for (const q of queue) send(q, 'queued', 0)
  void runJob(job)
    .catch((e): ProxyResult => ({ ok: false, error: e instanceof Error ? e.message : 'Proxy failed.' }))
    .then((result) => {
      running = null
      settle(job, result)
      pump()
    })
}

function findJob(sourcePath: string): Job | undefined {
  if (running?.sourcePath === sourcePath) return running
  return queue.find((j) => j.sourcePath === sourcePath)
}

async function createProxy(sender: WebContents, sourcePath: unknown, durationSec: unknown): Promise<ProxyResult> {
  if (!isLocalFilePath(sourcePath)) return { ok: false, error: 'Invalid source path.' }
  try {
    const ready = await proxyPathFor(sourcePath)
    if (await exists(ready)) return { ok: true, proxyPath: ready }
  } catch {
    return { ok: false, error: 'Source file not found.' }
  }
  return new Promise<ProxyResult>((resolve) => {
    const existing = findJob(sourcePath)
    if (existing) {
      // Same source asked twice (bin click + auto): join the job in flight.
      existing.waiters.push(resolve)
      existing.senders.add(sender)
      return
    }
    const job: Job = {
      sourcePath,
      durationSec: typeof durationSec === 'number' && Number.isFinite(durationSec) ? durationSec : 0,
      waiters: [resolve],
      senders: new Set([sender]),
      proc: null,
      cancelled: false
    }
    queue.push(job)
    send(job, 'queued', 0)
    pump()
  })
}

function cancelJob(job: Job): void {
  job.cancelled = true
  const i = queue.indexOf(job)
  if (i >= 0) {
    queue.splice(i, 1)
    settle(job, { ok: false, cancelled: true })
  } else {
    // Running: kill; runJob sees `cancelled`, deletes the partial and settles.
    job.proc?.kill('SIGKILL')
  }
}

/** Finished + partial proxy files in the cache dir. */
async function cacheFiles(): Promise<string[]> {
  try {
    return (await readdir(proxyDir())).filter(isProxyFileName).map((n) => join(proxyDir(), n))
  } catch {
    return []
  }
}

async function cacheInfo(): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  for (const p of await cacheFiles()) {
    try {
      bytes += (await stat(p)).size
      if (p.endsWith('.mp4')) files += 1
    } catch {
      /* vanished */
    }
  }
  return { bytes, files }
}

async function clearCache(): Promise<{ ok: boolean; failed: number }> {
  for (const job of [...queue]) cancelJob(job)
  if (running) {
    const job = running
    cancelJob(job)
    // Wait for the kill to land so its partial isn't recreated after we sweep.
    await new Promise<void>((resolve) => job.waiters.push(() => resolve()))
  }
  let failed = 0
  for (const p of await cacheFiles()) {
    try {
      await unlink(p)
    } catch {
      failed += 1 // e.g. still open for preview playback on Windows
    }
  }
  return { ok: failed === 0, failed }
}

/**
 * Delete partial proxies a crashed/killed session left behind. Safe at launch:
 * the single-instance lock means no other Cutroom is writing into the dir.
 */
export function sweepStaleProxyPartials(): void {
  const dir = proxyDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.partial') || !isProxyFileName(name)) continue
    try {
      unlinkSync(join(dir, name))
    } catch {
      /* in use or already gone */
    }
  }
}

export function registerProxyIpc(): void {
  // Existing proxies for a batch of sources (null = none yet). Nothing is
  // created here; the renderer derives its proxy state from this on import
  // and project open.
  ipcMain.handle('proxy:lookup', async (_e, paths: unknown) => {
    const out: Record<string, string | null> = {}
    if (!Array.isArray(paths)) return out
    for (const p of paths.slice(0, 2000)) {
      if (!isLocalFilePath(p)) continue
      try {
        const candidate = await proxyPathFor(p)
        out[p] = (await exists(candidate)) ? candidate : null
      } catch {
        out[p] = null
      }
    }
    return out
  })
  ipcMain.handle('proxy:create', (e, sourcePath: unknown, durationSec: unknown) =>
    createProxy(e.sender, sourcePath, durationSec)
  )
  ipcMain.handle('proxy:cancel', (_e, sourcePath: unknown) => {
    if (!isLocalFilePath(sourcePath)) return false
    const job = findJob(sourcePath)
    if (job) cancelJob(job)
    return !!job
  })
  ipcMain.handle('proxy:cacheInfo', () => cacheInfo())
  ipcMain.handle('proxy:clearCache', () => clearCache())
}
