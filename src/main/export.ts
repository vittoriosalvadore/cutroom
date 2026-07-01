import { ipcMain, dialog, app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import ffmpegPathRaw from 'ffmpeg-static'

// ffmpeg-static returns a path inside app.asar, which can't be executed.
// asarUnpack extracts the binary to app.asar.unpacked — fix the path there.
const ffmpegPath: string | null = ffmpegPathRaw && app.isPackaged
  ? ffmpegPathRaw.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
  : ffmpegPathRaw

// ---------------------------------------------------------------------------
// Export sink. The renderer composites each frame with the SAME WebGL pipeline
// used for preview, encodes it to PNG, and streams the PNGs here. We feed them
// straight into one long-lived FFmpeg process via image2pipe, so there are no
// temp files and the output matches the preview exactly. Audio is out of scope
// for this step (silent video).
// ---------------------------------------------------------------------------

interface ExportResult {
  ok: boolean
  error?: string
}

interface Session {
  proc: ChildProcess
  stderr: string
  failed: boolean
  failError: string
  done: Promise<ExportResult>
}

let session: Session | null = null

interface StartOptions {
  width: number
  height: number
  fps: number
  outputPath: string
  preset?: string
  crf?: number
}

const X264_PRESETS = new Set([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'
])

function startSession(opts: StartOptions): ExportResult {
  if (!ffmpegPath) return { ok: false, error: 'Bundled FFmpeg binary not found for this platform.' }
  if (session) return { ok: false, error: 'An export is already in progress.' }

  // PNG frames in on stdin -> H.264/yuv420p MP4 out. yuv420p + faststart make
  // the result broadly playable (browsers, QuickTime, mobile). Preset/CRF come
  // from settings; both are validated/clamped so a bad value can't break ffmpeg.
  const preset = opts.preset && X264_PRESETS.has(opts.preset) ? opts.preset : 'medium'
  const crf = Number.isFinite(opts.crf) ? Math.max(0, Math.min(51, Math.round(opts.crf as number))) : 20
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg',       // renderer sends JPEG frames (faster to encode than PNG)
    '-framerate', String(opts.fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', preset,
    '-crf', String(crf),
    '-movflags', '+faststart',
    opts.outputPath
  ]

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })
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
      else resolve({ ok: false, error: `FFmpeg exited with code ${code}.\n${s.stderr.slice(-700)}` })
    })
  })

  // A broken pipe (FFmpeg died) must not crash the main process.
  proc.stdin?.on('error', () => {
    s.failed = true
    if (!s.failError) s.failError = s.stderr.slice(-400) || 'Broken pipe.'
  })

  session = s
  return { ok: true }
}

/** Write one PNG frame, applying stream backpressure so memory stays bounded. */
function writeFrame(data: ArrayBuffer): Promise<ExportResult> {
  const s = session
  if (!s) return Promise.resolve({ ok: false, error: 'No active export session.' })
  if (s.failed || !s.proc.stdin) {
    const detail = s.failError || s.stderr.slice(-400)
    return Promise.resolve({ ok: false, error: detail ? `FFmpeg failed: ${detail}` : 'FFmpeg process is not accepting input.' })
  }

  const buf = Buffer.from(data)
  return new Promise<ExportResult>((resolve) => {
    const flushed = s.proc.stdin!.write(buf)
    if (flushed) resolve({ ok: !s.failed })
    else s.proc.stdin!.once('drain', () => resolve({ ok: !s.failed }))
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

function cancelSession(): ExportResult {
  const s = session
  if (!s) return { ok: true }
  try {
    s.proc.stdin?.destroy()
    s.proc.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  session = null
  return { ok: true }
}

export function registerExportIpc(): void {
  ipcMain.handle('dialog:saveVideo', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Export video',
      defaultPath: 'cutroom-export.mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    return result.canceled || !result.filePath ? null : result.filePath
  })

  ipcMain.handle('export:start', (_event, opts: StartOptions) => startSession(opts))
  ipcMain.handle('export:frame', (_event, data: ArrayBuffer) => writeFrame(data))
  ipcMain.handle('export:finish', () => finishSession())
  ipcMain.handle('export:cancel', () => cancelSession())
}
