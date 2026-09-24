import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { copyFile, rename, unlink, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath, releaseTemp, trackProcess, trackTemp } from './ffmpeg'
import { isLocalFilePath, isOwnTempFile } from './paths'
import { buildMuxArgs, buildMuxGraph, planReverbs, type MuxClip } from './muxArgs'
import { encodeWavFloat32, generateReverbIR } from '../shared/reverb'

// ---------------------------------------------------------------------------
// Export audio mux (main process). Pass 2 of export: take the silent video the
// frame-server produced and add a mixed soundtrack built from source files on
// disk (no PCM crosses IPC). Sources without an audio stream are dropped so a
// video with no audio can never abort the mux. Reverb tracks get their impulse
// response written here as temp WAVs, generated from the renderer's (clamped)
// settings by the same pure code the preview's ConvolverNode uses.
// ---------------------------------------------------------------------------

interface MuxOptions {
  silentPath: string
  outputPath: string
  sampleRate: number
  clips: MuxClip[]
  /** Length of the exported video in seconds. */
  durationSec?: number
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
  // The rate sizes the reverb IR buffers too, so a garbage value must not reach them.
  if (!Number.isInteger(opts.sampleRate) || opts.sampleRate < 8000 || opts.sampleRate > 192000) {
    return { ok: false, error: 'Invalid sample rate.' }
  }
  busy = true

  // Write to a sibling temp name and rename on success, so a failed mux never
  // destroys an existing file the user chose to replace or leaves a corrupt one.
  const partPath = `${opts.outputPath}.part`
  const scriptPath = tempPath('graph.txt')
  const irPaths: string[] = []
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
      // One IR per reverb track, in planReverbs order (the graph's input order).
      for (const { reverb } of planReverbs(audible)) {
        const irPath = tempPath('reverb.wav')
        trackTemp(irPath)
        irPaths.push(irPath)
        await writeFile(irPath, encodeWavFloat32(generateReverbIR(reverb, opts.sampleRate), opts.sampleRate))
      }
      result = await runFfmpeg(
        buildMuxArgs({
          silentPath: opts.silentPath,
          outputPath: partPath,
          sampleRate: opts.sampleRate,
          clips: audible,
          filterScriptPath: scriptPath,
          durationSec: opts.durationSec,
          irPaths,
          // The container follows the temp file main itself named (see export:tempVideoPath).
          container: extname(opts.silentPath).toLowerCase() === '.webm' ? 'webm' : 'mp4'
        })
      )
    }
    if (result.ok) await rename(partPath, opts.outputPath)
    return result
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Audio mux failed.' }
  } finally {
    for (const p of [partPath, scriptPath, opts.silentPath, ...irPaths]) {
      await unlink(p).catch(() => undefined)
      releaseTemp(p)
    }
    busy = false
  }
}

export function registerAudioMuxIpc(): void {
  // The pass-1 temp's extension carries the container (mp4 / webm): pass 1
  // forces it, and the no-audio path copies this file verbatim to the user's
  // output, so the two must agree.
  ipcMain.handle('export:tempVideoPath', (_event, ext?: unknown) =>
    tempPath(ext === 'webm' ? 'silent.webm' : 'silent.mp4')
  )
  ipcMain.handle('export:muxAudio', (_event, opts: MuxOptions) => runMux(opts))
  // Remove a leftover temp silent video (cancelled / failed export). Only our
  // own temp files — never an arbitrary path the renderer passes in.
  ipcMain.handle('export:discardTemp', async (_event, path: string) => {
    if (isOwnTempFile(path, tmpdir())) await unlink(path).catch(() => undefined)
    return true
  })
}
