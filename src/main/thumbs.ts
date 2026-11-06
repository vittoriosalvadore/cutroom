import { app, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { mkdirSync, readdirSync, unlinkSync } from 'fs'
import { access, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { ffmpegPath, releaseTemp, trackProcess, trackTemp } from './ffmpeg'
import { isLocalFilePath } from './paths'
import { buildThumbStripArgs, isThumbFileName, thumbFileName, tileCount, tileTimes } from './thumbArgs'

// ---------------------------------------------------------------------------
// Timeline thumbnails. For each video source main renders one small JPEG
// "filmstrip" (a row of evenly spaced frames, see thumbArgs.ts) that the
// timeline paints inside video clips and the Media Bin uses as a poster.
// Strips live in userData/thumbs/<hash(path, size, mtime, count)>.jpg, so they
// survive restarts and are regenerated only when the file changes. Jobs run
// one at a time; output goes to a `.partial` file renamed into place on
// success, and stale partials are swept at launch.
// ---------------------------------------------------------------------------

export interface ThumbResult {
  ok: boolean
  /** The strip JPEG (present when ok). */
  path?: string
  /** Number of equal-width tiles in the strip. */
  count?: number
  error?: string
}

const JOB_TIMEOUT_MS = 60_000

let queue: Promise<unknown> = Promise.resolve()

function thumbDir(): string {
  return join(app.getPath('userData'), 'thumbs')
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function runStrip(sourcePath: string, outPath: string, times: number[]): Promise<{ ok: boolean; error?: string }> {
  const bin = ffmpegPath
  if (!bin) return Promise.resolve({ ok: false, error: 'Bundled FFmpeg binary not found for this platform.' })
  return new Promise((resolve) => {
    const proc = trackProcess(spawn(bin, buildThumbStripArgs(sourcePath, outPath, times), { stdio: ['ignore', 'ignore', 'pipe'] }))
    let stderr = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), JOB_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 8000) stderr += d.toString()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true } : { ok: false, error: `FFmpeg thumbnails exited with code ${code}.\n${stderr.slice(-400)}` })
    })
  })
}

async function makeStrip(sourcePath: string, durationSec: number): Promise<ThumbResult> {
  const count = tileCount(durationSec)
  let info
  try {
    info = await stat(sourcePath)
  } catch {
    return { ok: false, error: 'Source not found.' }
  }
  const dir = thumbDir()
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, thumbFileName(sourcePath, info.size, info.mtimeMs, count))
  if (await exists(finalPath)) return { ok: true, path: finalPath, count }

  const partial = finalPath.replace(/\.jpg$/, '.partial')
  trackTemp(partial)
  try {
    const r = await runStrip(sourcePath, partial, tileTimes(durationSec, count))
    if (!r.ok) return { ok: false, error: r.error }
    await rename(partial, finalPath)
    return { ok: true, path: finalPath, count }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Thumbnail generation failed.' }
  } finally {
    await unlink(partial).catch(() => undefined)
    releaseTemp(partial)
  }
}

/** Delete `.partial` strips a crashed session left behind. Call at launch. */
export function sweepStaleThumbPartials(): void {
  try {
    for (const name of readdirSync(thumbDir())) {
      if (isThumbFileName(name) && name.endsWith('.partial')) {
        try {
          unlinkSync(join(thumbDir(), name))
        } catch {
          /* in use or gone */
        }
      }
    }
  } catch {
    /* no cache dir yet */
  }
}

export function registerThumbIpc(): void {
  ipcMain.handle('thumbs:strip', (_event, sourcePath: unknown, durationSec: unknown): Promise<ThumbResult> => {
    if (!isLocalFilePath(sourcePath)) return Promise.resolve({ ok: false, error: 'Invalid source path.' })
    const dur = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
    if (dur === 0) return Promise.resolve({ ok: false, error: 'Unknown duration.' })
    const job = queue.then(() => makeStrip(sourcePath, dur))
    queue = job.catch(() => undefined)
    return job
  })
}
