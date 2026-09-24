import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath, releaseTemp, trackProcess, trackTemp } from './ffmpeg'
import { isLocalFilePath } from './paths'

// ---------------------------------------------------------------------------
// Scrub audio for video files. A video clip's preview audio normally comes
// from its <video> element, which can't play the short grains audio scrubbing
// needs. So each video source gets a light 16 kHz mono PCM copy of its audio
// (≈ 2 MB per minute) that the renderer decodes once and uses ONLY for scrub
// grains — playback and export never read it. Jobs run one at a time.
// ---------------------------------------------------------------------------

interface ScrubAudioResult {
  ok: boolean
  tempPath?: string
  error?: string
}

/** Sources longer than this are skipped (the decoded buffer would be large). */
export const SCRUB_AUDIO_MAX_SEC = 3 * 60 * 60
export const SCRUB_AUDIO_RATE = 16000

let counter = 0
let queue: Promise<unknown> = Promise.resolve()

/** Pure FFmpeg args (exported for tests). */
export function scrubAudioArgs(sourcePath: string, outPath: string): string[] {
  return [
    '-y',
    '-i', sourcePath,
    '-map', '0:a:0', // no audio stream -> FFmpeg fails -> the clip just stays silent while scrubbing
    '-vn',
    '-ac', '1',
    '-ar', String(SCRUB_AUDIO_RATE),
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    outPath
  ]
}

function run(sourcePath: string): Promise<ScrubAudioResult> {
  const bin = ffmpegPath
  if (!bin) return Promise.resolve({ ok: false, error: 'Bundled FFmpeg binary not found for this platform.' })
  counter += 1
  const tempPath = join(tmpdir(), `cutroom-${process.pid}-${Date.now()}-${counter}-scrub.wav`)
  trackTemp(tempPath) // lives for the session; deleted on quit
  return new Promise((resolve) => {
    const proc = trackProcess(spawn(bin, scrubAudioArgs(sourcePath, tempPath), { stdio: ['ignore', 'ignore', 'pipe'] }))
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    const fail = (error: string): void => {
      void unlink(tempPath).catch(() => undefined)
      releaseTemp(tempPath)
      resolve({ ok: false, error })
    }
    proc.on('error', (err) => fail(err.message))
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, tempPath })
      else fail(`FFmpeg scrub-audio exited with code ${code}.\n${stderr.slice(-500)}`)
    })
  })
}

export function registerScrubAudioIpc(): void {
  ipcMain.handle('scrubAudio:start', (_event, sourcePath: unknown) => {
    if (!isLocalFilePath(sourcePath)) return Promise.resolve({ ok: false, error: 'Invalid source path.' })
    const job = queue.then(() => run(sourcePath))
    queue = job.catch(() => undefined)
    return job
  })
}
