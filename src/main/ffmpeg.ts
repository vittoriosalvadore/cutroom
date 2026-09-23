import { app } from 'electron'
import type { ChildProcess } from 'child_process'
import { unlinkSync } from 'fs'
import ffmpegPathRaw from 'ffmpeg-static'

// ffmpeg-static returns a path inside app.asar, which can't be executed.
// asarUnpack extracts the binary to app.asar.unpacked — fix the path there.
export const ffmpegPath: string | null = ffmpegPathRaw && app.isPackaged
  ? ffmpegPathRaw.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
  : ffmpegPathRaw

// ---------------------------------------------------------------------------
// Lifetime tracking for every FFmpeg child and temp file main creates, so a
// quit never leaves an encoder running in the background or gigabytes of
// temp media behind.
// ---------------------------------------------------------------------------

const live = new Set<ChildProcess>()
const temps = new Set<string>()

/** Register a spawned FFmpeg so it is killed on quit. */
export function trackProcess(proc: ChildProcess): ChildProcess {
  live.add(proc)
  const forget = (): void => {
    live.delete(proc)
  }
  proc.once('close', forget)
  proc.once('error', forget)
  return proc
}

/** Register a temp file to delete on quit (unless released first). */
export function trackTemp(path: string): void {
  temps.add(path)
}

export function releaseTemp(path: string): void {
  temps.delete(path)
}

/** Kill every live FFmpeg and remove tracked temp files. Call on will-quit. */
export function shutdownFfmpeg(): void {
  for (const proc of live) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  live.clear()
  for (const p of temps) {
    try {
      unlinkSync(p)
    } catch {
      /* missing or still locked — nothing more we can do at quit */
    }
  }
  temps.clear()
}
