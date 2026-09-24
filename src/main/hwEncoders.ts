import { execFile } from 'child_process'
import { ffmpegPath, trackProcess } from './ffmpeg'
import { HW_ENCODERS } from '../shared/exportOptions'
import { buildProbeArgs, parseEncoderList } from './encodeArgs'

// ---------------------------------------------------------------------------
// Hardware export encoder probe (main process). Runs once per app session,
// asynchronously, and caches the result:
//   1. `ffmpeg -hide_banner -encoders` — which HW encoders this build has.
//   2. For each candidate listed, a tiny real test encode with a timeout —
//      a listed encoder without the GPU/driver fails here and is dropped.
// Any failure (no binary, timeout, no GPU) just yields fewer entries; an empty
// list means "software only" and the UI degrades to Auto/Software.
// ---------------------------------------------------------------------------

const LIST_TIMEOUT_MS = 5000
const TEST_TIMEOUT_MS = 8000

let cached: Promise<string[]> | null = null

function run(bin: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    // Tracked so a quit mid-probe never leaves an FFmpeg behind.
    trackProcess(
      execFile(bin, args, { timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        resolve({ ok: !err, stdout: String(stdout ?? '') })
      )
    )
  })
}

async function probe(bin: string): Promise<string[]> {
  const list = await run(bin, ['-hide_banner', '-encoders'], LIST_TIMEOUT_MS)
  if (!list.ok) return []
  const built = parseEncoderList(list.stdout)
  const working: string[] = []
  // Sequential on purpose: parallel GPU session opens can fail spuriously
  // (consumer NVENC caps concurrent sessions).
  for (const enc of HW_ENCODERS) {
    if (!built.has(enc)) continue
    const test = await run(bin, buildProbeArgs(enc), TEST_TIMEOUT_MS)
    if (test.ok) working.push(enc)
  }
  return working
}

/** Working hardware encoder names (cached; first call starts the probe). */
export function getWorkingHwEncoders(): Promise<string[]> {
  if (!ffmpegPath) return Promise.resolve([])
  if (!cached) cached = probe(ffmpegPath).catch(() => [])
  return cached
}
