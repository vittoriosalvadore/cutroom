import { ipcMain, app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { copyFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import ffmpegPathRaw from 'ffmpeg-static'

// ffmpeg-static returns a path inside app.asar, which can't be executed.
// asarUnpack extracts the binary to app.asar.unpacked — fix the path there.
const ffmpegPath: string | null = ffmpegPathRaw && app.isPackaged
  ? ffmpegPathRaw.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
  : ffmpegPathRaw
import { buildMuxArgs, type MuxClip } from './muxArgs'

// ---------------------------------------------------------------------------
// Export audio mux (main process). Pass 2 of export: take the silent video the
// frame-server produced and add a mixed soundtrack built from source files on
// disk (no PCM crosses IPC). Sources without an audio stream are dropped so a
// video with no audio can never abort the mux.
// ---------------------------------------------------------------------------

interface MuxOptions {
  silentPath: string
  outputPath: string
  sampleRate: number
  clips: MuxClip[]
}

let counter = 0
let busy = false

function tempVideoPath(): string {
  counter += 1
  return join(tmpdir(), `cutroom-${process.pid}-${Date.now()}-${counter}-silent.mp4`)
}

/** Probe a file for an audio stream using the bundled ffmpeg (ffprobe-free). */
function hasAudioStream(path: string): boolean {
  if (!ffmpegPath) return false
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', path], { encoding: 'utf8' })
  return /Stream #\d+:\d+.*: Audio:/.test(result.stderr || '')
}

async function runMux(opts: MuxOptions): Promise<{ ok: boolean; error?: string }> {
  if (!ffmpegPath) return { ok: false, error: 'Bundled FFmpeg binary not found.' }
  if (busy) return { ok: false, error: 'An audio mux is already running.' }
  busy = true
  try {
    // Keep only clips whose source actually has an audio stream.
    const probe = new Map<string, boolean>()
    const audible = opts.clips.filter((c) => {
      if (!probe.has(c.path)) probe.set(c.path, hasAudioStream(c.path))
      return probe.get(c.path) === true
    })

    if (audible.length === 0) {
      // Nothing audible: the silent video is the final output.
      await copyFile(opts.silentPath, opts.outputPath)
      await unlink(opts.silentPath).catch(() => undefined)
      return { ok: true }
    }

    const args = buildMuxArgs({
      silentPath: opts.silentPath,
      outputPath: opts.outputPath,
      sampleRate: opts.sampleRate,
      clips: audible
    })

    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const proc = spawn(ffmpegPath as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
        if (stderr.length > 16000) stderr = stderr.slice(-16000)
      })
      proc.on('error', (err) => resolve({ ok: false, error: err.message }))
      proc.on('close', (code) =>
        resolve(code === 0 ? { ok: true } : { ok: false, error: `FFmpeg audio mux exited ${code}.\n${stderr.slice(-700)}` })
      )
    })

    await unlink(opts.silentPath).catch(() => undefined)
    return result
  } catch (e) {
    await unlink(opts.silentPath).catch(() => undefined)
    return { ok: false, error: e instanceof Error ? e.message : 'Audio mux failed.' }
  } finally {
    busy = false
  }
}

export function registerAudioMuxIpc(): void {
  ipcMain.handle('export:tempVideoPath', () => tempVideoPath())
  ipcMain.handle('export:muxAudio', (_event, opts: MuxOptions) => runMux(opts))
  // Remove a leftover temp silent video (cancelled / failed export).
  ipcMain.handle('export:discardTemp', async (_event, path: string) => {
    if (path) await unlink(path).catch(() => undefined)
    return true
  })
}
