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
// Noise removal: FFmpeg's afftdn (FFT denoiser), run ONCE per source media to
// a temp WAV that both the preview (decoded to an AudioBuffer) and the export
// mux (fed straight in as a clip's input path) reuse — no drift between what
// you hear and what exports.
//
// NOT arnndn (RNNoise): confirmed directly, by hand, across many repeated
// runs of the identical command/input, that this ffmpeg-static build's arnndn
// is non-deterministic — the SAME input produces a different amount of
// suppression from run to run (sometimes barely any), with no error or
// warning printed. Reproduces even on a pure mono input, so it isn't a
// stereo/channel-handling bug (ruling out threads=1 and per-channel
// splitting, both tried first) — it's the filter itself, in this build.
// afftdn is deterministic (byte-identical output across repeated runs,
// verified) and needs no external model file, at the cost of being a
// classical spectral-subtraction filter rather than a neural one.
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

function runDenoise(sourcePath: string): Promise<DenoiseResult> {
  if (!ffmpegPath) return Promise.resolve({ ok: false, error: 'Bundled FFmpeg binary not found for this platform.' })
  const tempPath = tempDenoisePath()
  const args = [
    '-y',
    '-i', sourcePath,
    '-vn',
    '-af', 'aresample=48000,afftdn',
    '-c:a', 'pcm_s16le',
    tempPath
  ]

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
