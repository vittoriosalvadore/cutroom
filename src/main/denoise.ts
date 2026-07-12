import { ipcMain, app } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import ffmpegPathRaw from 'ffmpeg-static'

// ffmpeg-static returns a path inside app.asar, which can't be executed.
// asarUnpack extracts the binary to app.asar.unpacked — fix the path there.
const ffmpegPath: string | null = ffmpegPathRaw && app.isPackaged
  ? ffmpegPathRaw.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
  : ffmpegPathRaw

// ---------------------------------------------------------------------------
// AI noise removal: FFmpeg's arnndn (RNNoise) filter, run ONCE per source media
// to a temp WAV that both the preview (decoded to an AudioBuffer) and the
// export mux (fed straight in as a clip's input path) reuse — no separate
// in-browser model, no drift between what you hear and what exports.
// ---------------------------------------------------------------------------

interface DenoiseResult {
  ok: boolean
  tempPath?: string
  error?: string
}

let counter = 0

function tempDenoisePath(): string {
  counter += 1
  return join(tmpdir(), `cutroom-${process.pid}-${Date.now()}-${counter}-denoised.wav`)
}

/** arnndn expects 48kHz; resample first so any source rate works. PCM output
 *  (not AAC) avoids stacking a second lossy encode on top of export's own. */
function runDenoise(sourcePath: string): Promise<DenoiseResult> {
  if (!ffmpegPath) return Promise.resolve({ ok: false, error: 'Bundled FFmpeg binary not found for this platform.' })
  const tempPath = tempDenoisePath()
  const args = ['-y', '-i', sourcePath, '-vn', '-af', 'aresample=48000,arnndn', '-c:a', 'pcm_s16le', tempPath]

  return new Promise<DenoiseResult>((resolve) => {
    const proc = spawn(ffmpegPath as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 16000) stderr = stderr.slice(-16000)
    })
    proc.on('error', (err) => resolve({ ok: false, error: err.message }))
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, tempPath })
      else resolve({ ok: false, error: `FFmpeg denoise exited with code ${code}.\n${stderr.slice(-700)}` })
    })
  })
}

export function registerDenoiseIpc(): void {
  ipcMain.handle('denoise:start', (_event, sourcePath: string) => runDenoise(sourcePath))
}
