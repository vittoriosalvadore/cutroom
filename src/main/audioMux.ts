import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { copyFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath, releaseTemp, trackProcess, trackTemp } from './ffmpeg'
import { isLocalFilePath, isOwnTempFile } from './paths'
import { buildMuxArgs, buildMuxGraph, type MuxClip } from './muxArgs'

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

const PROBE_TIMEOUT_MS = 15000

let counter = 0
let busy = false

function tempPath(suffix: string): string {
  counter += 1
  return join(tmpdir(), `cutroom-${process.pid}-${Date.now()}-${counter}-${suffix}`)
}

/**
 * Probe a file for an audio stream using the bundled ffmpeg (ffprobe-free).
 * Async with a timeout so a slow or hung network mount can't freeze the main
 * process (and with it every window and dialog).
 */
function hasAudioStream(path: string): Promise<boolean> {
  const bin = ffmpegPath
  if (!bin) return Promise.resolve(false)
  return new Promise((resolve) => {
    const proc = trackProcess(spawn(bin, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] }))
    let stderr = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 64000) stderr += d.toString()
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    proc.on('close', () => {
      clearTimeout(timer)
      resolve(/Stream #\d+:\d+.*: Audio:/.test(stderr))
    })
  })
}

function runFfmpeg(args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = trackProcess(spawn(ffmpegPath as string, args, { stdio: ['ignore', 'ignore', 'pipe'] }))
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
}

async function runMux(opts: MuxOptions): Promise<{ ok: boolean; error?: string }> {
  if (!ffmpegPath) return { ok: false, error: 'Bundled FFmpeg binary not found.' }
  if (busy) return { ok: false, error: 'An audio mux is already running.' }
  if (!isOwnTempFile(opts.silentPath, tmpdir())) return { ok: false, error: 'Invalid export temp path.' }
  if (!isLocalFilePath(opts.outputPath)) return { ok: false, error: 'Invalid export output path.' }
  if (!Array.isArray(opts.clips)) return { ok: false, error: 'Invalid audio plan.' }
  busy = true

  // Write to a sibling temp name and rename on success, so a failed mux never
  // destroys an existing file the user chose to replace or leaves a corrupt one.
  const partPath = `${opts.outputPath}.part`
  const scriptPath = tempPath('graph.txt')
  trackTemp(partPath)
  trackTemp(opts.silentPath)
  try {
    // Only local files may reach an FFmpeg `-i` (never URLs/protocols from an
    // untrusted project file), and only clips whose source has an audio stream.
    const paths = [...new Set(opts.clips.map((c) => c.path))].filter(isLocalFilePath)
    const probed = await Promise.all(paths.map(async (p) => [p, await hasAudioStream(p)] as const))
    const hasAudio = new Map(probed)
    const audible = opts.clips.filter((c) => hasAudio.get(c.path) === true)

    let result: { ok: boolean; error?: string }
    if (audible.length === 0) {
      // Nothing audible: the silent video is the final output.
      await copyFile(opts.silentPath, partPath)
      result = { ok: true }
    } else {
      // The graph goes in a script file: a long timeline's graph blows past the
      // Windows 32K command-line limit when passed inline.
      trackTemp(scriptPath)
      await writeFile(scriptPath, buildMuxGraph(audible, opts.sampleRate), 'utf-8')
      result = await runFfmpeg(
        buildMuxArgs({
          silentPath: opts.silentPath,
          outputPath: partPath,
          sampleRate: opts.sampleRate,
          clips: audible,
          filterScriptPath: scriptPath
        })
      )
    }
    if (result.ok) await rename(partPath, opts.outputPath)
    return result
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Audio mux failed.' }
  } finally {
    for (const p of [partPath, scriptPath, opts.silentPath]) {
      await unlink(p).catch(() => undefined)
      releaseTemp(p)
    }
    busy = false
  }
}

export function registerAudioMuxIpc(): void {
  ipcMain.handle('export:tempVideoPath', () => tempPath('silent.mp4'))
  ipcMain.handle('export:muxAudio', (_event, opts: MuxOptions) => runMux(opts))
  // Remove a leftover temp silent video (cancelled / failed export). Only our
  // own temp files — never an arbitrary path the renderer passes in.
  ipcMain.handle('export:discardTemp', async (_event, path: string) => {
    if (isOwnTempFile(path, tmpdir())) await unlink(path).catch(() => undefined)
    return true
  })
}
