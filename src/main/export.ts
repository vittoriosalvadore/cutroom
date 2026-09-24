import { BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { tmpdir } from 'os'
import { basename, extname } from 'path'
import { existsSync } from 'fs'
import { ffmpegPath, trackProcess, trackTemp } from './ffmpeg'
import { isOwnTempFile } from './paths'
import { buildEncodeArgs, resolveEncodeConfig, type RawStartOptions } from './encodeArgs'
import { getWorkingHwEncoders } from './hwEncoders'
import { EXPORT_FORMATS, formatInfo, type ExportFormat } from '../shared/exportOptions'

// ---------------------------------------------------------------------------
// Export sink. The renderer composites each frame with the SAME WebGL pipeline
// used for preview, encodes it to JPEG, and streams the frames here. We feed
// them straight into one long-lived FFmpeg process via image2pipe, so there are
// no temp frame files and the output matches the preview exactly. Audio is
// added afterwards by the mux pass (audioMux.ts). The encoder (software
// x264/x265/VP9 or a probed hardware encoder) and the optional output scale
// come from the export preset.
// ---------------------------------------------------------------------------

interface ExportResult {
  ok: boolean
  error?: string
}

/** What export:start reports back: which encoder actually runs. */
interface StartResult extends ExportResult {
  encoder?: string
  hardware?: boolean
}

interface Session {
  proc: ChildProcess
  stderr: string
  failed: boolean
  failError: string
  done: Promise<ExportResult>
}

let session: Session | null = null
let starting = false

async function startSession(raw: RawStartOptions): Promise<StartResult> {
  if (!ffmpegPath) return { ok: false, error: 'Bundled FFmpeg binary not found for this platform.' }
  if (session || starting) return { ok: false, error: 'An export is already in progress.' }
  const opts = raw ?? {}
  // Pass 1 only ever writes to a temp path main handed out itself.
  if (!isOwnTempFile(opts.outputPath, tmpdir())) return { ok: false, error: 'Invalid export temp path.' }

  starting = true
  let working: string[]
  try {
    // Cached after the first call; only probe-verified encoders can be chosen.
    working = await getWorkingHwEncoders()
  } finally {
    starting = false
  }
  if (session) return { ok: false, error: 'An export is already in progress.' }

  // JPEG frames in on stdin -> H.264/HEVC/VP9 out (yuv420p, +faststart for
  // MP4), optionally Lanczos-scaled to the preset size. Every renderer value
  // (size, fps, format, resolution, preset, CRF, bitrate, encoder) is
  // validated/clamped in resolveEncodeConfig so a bad value can't break — or
  // inject into — the FFmpeg command line.
  const config = resolveEncodeConfig(opts, working)
  if (!config) return { ok: false, error: 'Invalid export options.' }
  // The temp file's extension (from export:tempVideoPath) must name the same
  // container: the no-audio path copies it verbatim as the final output.
  if (extname(config.outputPath).toLowerCase() !== `.${config.container}`) {
    return { ok: false, error: 'Export temp path does not match the output format.' }
  }
  const args = buildEncodeArgs(config)
  // Hardware encoders can pass the probe yet still fail on a real job (driver
  // limits, resolution caps) — say so, so the user knows what to switch.
  const hwHint = config.hardware
    ? `\n\nThe hardware encoder (${config.encoder}) failed. Set Encoder to "Software" and retry.`
    : ''

  trackTemp(config.outputPath) // deleted on quit if the export never completes
  const proc = trackProcess(spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] }))
  const s: Session = { proc, stderr: '', failed: false, failError: '', done: Promise.resolve({ ok: true }) }

  s.done = new Promise<ExportResult>((resolve) => {
    proc.stderr?.on('data', (chunk: Buffer) => {
      s.stderr += chunk.toString()
      if (s.stderr.length > 16000) s.stderr = s.stderr.slice(-16000)
    })
    proc.on('error', (err) => {
      s.failed = true
      s.failError = err.message
      resolve({ ok: false, error: err.message })
    })
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: `FFmpeg exited with code ${code}.\n${s.stderr.slice(-700)}${hwHint}` })
    })
  })

  // A broken pipe (FFmpeg died) must not crash the main process.
  proc.stdin?.on('error', () => {
    s.failed = true
    if (!s.failError) s.failError = (s.stderr.slice(-400) || 'Broken pipe.') + hwHint
  })

  session = s
  return { ok: true, encoder: config.encoder, hardware: config.hardware }
}

/** Write one JPEG frame, applying stream backpressure so memory stays bounded. */
function writeFrame(data: ArrayBuffer): Promise<ExportResult> {
  const s = session
  if (!s) return Promise.resolve({ ok: false, error: 'No active export session.' })
  if (s.failed || !s.proc.stdin) {
    const detail = s.failError || s.stderr.slice(-400)
    return Promise.resolve({ ok: false, error: detail ? `FFmpeg failed: ${detail}` : 'FFmpeg process is not accepting input.' })
  }

  const stdin = s.proc.stdin
  if (stdin.destroyed || !stdin.writable) {
    return Promise.resolve({ ok: false, error: 'FFmpeg stopped accepting input.' })
  }
  const buf = Buffer.from(data)
  return new Promise<ExportResult>((resolve) => {
    if (stdin.write(buf)) {
      resolve({ ok: !s.failed })
      return
    }
    // Wait for 'drain' — but if FFmpeg dies while the pipe is full, 'drain'
    // never fires (stdin gets EPIPE and is destroyed), so also settle on the
    // stream closing/erroring or the process exiting. Otherwise the export
    // (and every later one) hangs forever.
    const onExit = (): void => {
      s.failed = true
      if (!s.failError) s.failError = s.stderr.slice(-400) || 'FFmpeg exited.'
      settle()
    }
    const settle = (): void => {
      stdin.off('drain', settle)
      stdin.off('error', settle)
      stdin.off('close', settle)
      s.proc.off('close', onExit)
      if (s.failed) {
        const detail = s.failError || s.stderr.slice(-400)
        resolve({ ok: false, error: detail ? `FFmpeg failed: ${detail}` : 'FFmpeg stopped accepting input.' })
      } else {
        resolve({ ok: true })
      }
    }
    stdin.once('drain', settle)
    stdin.once('error', settle)
    stdin.once('close', settle)
    s.proc.once('close', onExit)
  })
}

async function finishSession(): Promise<ExportResult> {
  const s = session
  if (!s) return { ok: false, error: 'No active export session.' }
  s.proc.stdin?.end()
  const result = await s.done
  session = null
  return result
}

async function cancelSession(): Promise<ExportResult> {
  const s = session
  if (!s) return { ok: true }
  session = null
  try {
    s.proc.stdin?.destroy()
    s.proc.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  // Wait for the process to actually exit so the renderer's follow-up
  // discardTemp can delete the file (Windows keeps it locked until then).
  await s.done
  return { ok: true }
}

export function registerExportIpc(): void {
  // The filter + extension follow the chosen format, so the container FFmpeg
  // writes (-f mp4 / -f webm) always matches the file name.
  ipcMain.handle('dialog:saveVideo', async (_event, format?: unknown) => {
    const f: ExportFormat = EXPORT_FORMATS.includes(format as ExportFormat) ? (format as ExportFormat) : 'mp4-h264'
    const ext = formatInfo(f).ext
    const result = await dialog.showSaveDialog({
      title: 'Export video',
      defaultPath: `cutroom-export.${ext}`,
      filters: [ext === 'webm' ? { name: 'WebM Video', extensions: ['webm'] } : { name: 'MP4 Video', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    // Not every platform enforces the filter's extension — append it if missing.
    if (extname(result.filePath).toLowerCase() === `.${ext}`) return result.filePath
    const withExt = `${result.filePath}.${ext}`
    // The dialog only checked the name as typed, so it never asked about
    // replacing the file we are about to write — ask now.
    if (existsSync(withExt)) {
      const win = BrowserWindow.fromWebContents(_event.sender)
      const opts = {
        type: 'warning' as const,
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Replace file?',
        message: `"${basename(withExt)}" already exists.`,
        detail: 'Do you want to replace it?'
      }
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (response !== 0) return null
    }
    return withExt
  })

  // Working hardware encoders (probed once, cached). [] = software only.
  ipcMain.handle('export:hwEncoders', () => getWorkingHwEncoders())
  ipcMain.handle('export:start', (_event, opts: RawStartOptions) => startSession(opts))
  ipcMain.handle('export:frame', (_event, data: ArrayBuffer) => writeFrame(data))
  ipcMain.handle('export:finish', () => finishSession())
  ipcMain.handle('export:cancel', () => cancelSession())
}
