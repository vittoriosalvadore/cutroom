import type { Clip, Project, WordTiming } from '../types'
import type { SubtitleCue } from '../state/store'
import { ensureAudioDecoded, waitForDecoded } from './audioCache'
import { WorkerJob, JobCancelled } from './workerJob'

// ---------------------------------------------------------------------------
// Drives the Whisper worker: extract a clip's audio to 16 kHz mono PCM (Whisper's
// required format), transcribe it off-thread, and map the timestamped segments to
// subtitle cues positioned on the timeline.
// ---------------------------------------------------------------------------

// An extraction step (decode + offline render) that never resolves would
// otherwise hang the whole transcription with no way out — Stop only takes
// effect at a checkpoint, and there was none during extraction. Mirrors
// WorkerJob's 60s "presume it's dead" convention.
const EXTRACT_TIMEOUT_MS = 60_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export interface TranscribeProgress {
  stage: 'extracting' | 'loading' | 'transcribing'
  /** Model-download progress, 0..1 (loading stage only). */
  progress?: number
  file?: string
}

interface WhisperChunk {
  timestamp: [number, number | null]
  text: string
}

async function getSourceBuffer(project: Project, clip: Clip): Promise<AudioBuffer> {
  const media = clip.mediaId ? project.media[clip.mediaId] : null
  if (!media || !media.path) throw new Error('This clip has no audio to transcribe.')
  // Reuse the app's own background decode (kicked off on import) instead of
  // starting a redundant parallel one if it's still in flight — transcribing
  // right after importing a long file used to double the decode work.
  ensureAudioDecoded(media.id, media.path, media.durationSec)
  return waitForDecoded(media.id)
}

/** Render the clip's used span to 16 kHz mono PCM. */
async function getClipPcm16k(project: Project, clip: Clip, shouldCancel: () => boolean): Promise<Float32Array> {
  if (shouldCancel()) throw new JobCancelled()
  const buffer = await withTimeout(
    getSourceBuffer(project, clip),
    EXTRACT_TIMEOUT_MS,
    'Decoding this audio took too long — the file may be too large or corrupt.'
  )
  if (shouldCancel()) throw new JobCancelled()
  const length = Math.max(1, Math.ceil(clip.durationSec * 16000))
  const offline = new OfflineAudioContext(1, length, 16000)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  const offset = Math.max(0, Math.min(clip.inSec, buffer.duration))
  const dur = Math.max(0, Math.min(clip.durationSec, buffer.duration - offset))
  src.start(0, offset, dur)
  const rendered = await withTimeout(
    offline.startRendering(),
    EXTRACT_TIMEOUT_MS,
    "Rendering this clip's audio took too long."
  )
  return rendered.getChannelData(0).slice()
}

function chunksToCues(chunks: WhisperChunk[], clipStartSec: number): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (let i = 0; i < chunks.length; i++) {
    const text = (chunks[i].text ?? '').trim()
    if (!text) continue
    const start = chunks[i].timestamp?.[0] ?? 0
    let end = chunks[i].timestamp?.[1]
    if (end == null) end = chunks[i + 1]?.timestamp?.[0] ?? start + 2
    cues.push({
      startSec: clipStartSec + start,
      endSec: clipStartSec + Math.max(start + 0.2, end),
      text
    })
  }
  return cues
}

// Word-level (karaoke) caption-card grouping: consecutive words are packed into
// a card up to MAX_WORDS_PER_CARD or MAX_CARD_DURATION_SEC (whichever comes
// first), or fewer if a word ends in sentence punctuation.
const MAX_WORDS_PER_CARD = 6
const MAX_CARD_DURATION_SEC = 3

/** Group per-word Whisper chunks into subtitle cues, keeping each word's own
 *  timing (relative to its OWN card's start) for karaoke highlight rendering. */
export function wordsToCues(chunks: WhisperChunk[], clipStartSec: number): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let group: { text: string; start: number; end: number }[] = []

  const flush = (): void => {
    if (group.length === 0) return
    const first = group[0]
    const last = group[group.length - 1]
    const cardStart = clipStartSec + first.start
    const cardEnd = clipStartSec + last.end
    const words: WordTiming[] = group.map((w) => ({
      text: w.text,
      startSec: w.start - first.start,
      endSec: w.end - first.start
    }))
    cues.push({
      startSec: cardStart,
      endSec: Math.max(cardStart + 0.2, cardEnd),
      text: group.map((w) => w.text).join(' ').trim(),
      words
    })
    group = []
  }

  for (let i = 0; i < chunks.length; i++) {
    const text = (chunks[i].text ?? '').trim()
    if (!text) continue
    const start = chunks[i].timestamp?.[0] ?? 0
    let end = chunks[i].timestamp?.[1]
    if (end == null) end = chunks[i + 1]?.timestamp?.[0] ?? start + 0.2

    const wouldSpan = group.length > 0 ? end - group[0].start : 0
    if (group.length >= MAX_WORDS_PER_CARD || wouldSpan > MAX_CARD_DURATION_SEC) flush()

    group.push({ text, start, end })
    if (/[.!?]$/.test(text)) flush()
  }
  flush()
  return cues
}

interface TranscribeIn {
  type: 'transcribe'
  pcm: Float32Array
  wordLevel?: boolean
}
interface TranscribeOut {
  chunks: WhisperChunk[]
  text: string
}

const job = new WorkerJob<TranscribeIn, TranscribeOut>(
  () => new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
)

/**
 * Force-abandon the transcribe worker (if one exists). A call already posted
 * to it can't be cancelled in place, only left to finish or hit WorkerJob's
 * own dead-worker timeout — but if the CALLER has already given up on it
 * (e.g. the user closed the modal after clicking Stop), leaving that stale
 * call occupying the shared worker is a trap: a follow-up Transcribe click
 * posts a NEW call to the SAME worker, and when the old, abandoned call's
 * timeout eventually fires, it terminates the worker and takes the new call
 * down with it too ("Worker was terminated before responding"). Terminating
 * here instead guarantees the next call starts against a fresh worker.
 */
export function abandonTranscription(): void {
  job.terminate()
}

const SAMPLE_RATE = 16000
// 30s per call so a crash mid-transcription only loses the current window's
// cues, not the whole clip — each window's cues are surfaced via onCue as
// soon as they resolve, so the caller can commit them into the project
// immediately (see TranscribeModal.tsx) rather than batching until the end.
const CHUNK_SEC = 30

/**
 * Transcribe a clip window by window. Resolves with every cue once done (for
 * convenience), but callers should treat `onCue` as the source of truth for
 * incremental, crash-safe commits.
 */
export async function transcribeClip(
  project: Project,
  clip: Clip,
  onProgress: (p: TranscribeProgress) => void,
  onCue: (cue: SubtitleCue) => void,
  shouldCancel: () => boolean = () => false,
  wordLevel = false
): Promise<SubtitleCue[]> {
  onProgress({ stage: 'extracting' })
  const pcm = await getClipPcm16k(project, clip, shouldCancel)
  const chunkLen = CHUNK_SEC * SAMPLE_RATE
  const chunkCount = Math.max(1, Math.ceil(pcm.length / chunkLen))
  const allCues: SubtitleCue[] = []

  for (let i = 0; i < chunkCount; i++) {
    if (shouldCancel()) throw new JobCancelled()
    const start = i * chunkLen
    // .slice() (not .subarray()) copies into a fresh buffer per chunk, so it's
    // safe to transfer to the worker without affecting the other chunks.
    const chunkPcm = pcm.slice(start, Math.min(pcm.length, start + chunkLen))
    const chunkStartSec = clip.startSec + start / SAMPLE_RATE

    const { chunks } = await job.call(
      { type: 'transcribe', pcm: chunkPcm, wordLevel },
      {
        onProgress: (p) => onProgress({ stage: 'loading', progress: p.progress, file: p.file }),
        onStatus: (msg) => {
          if ((msg as { status?: string }).status === 'transcribing') onProgress({ stage: 'transcribing' })
        },
        shouldCancel,
        transfer: [chunkPcm.buffer],
        // WorkerJob's 60s default assumes silence means a dead worker, but a
        // single chunk posts no progress between 'transcribing' and the
        // result — with a heavier model (medium/large), CPU-only inference
        // for one 30s window can legitimately take longer than that. A
        // generous ceiling still catches an actually-dead worker; Stop
        // (abandonTranscription) is there for "I don't want to wait."
        timeoutMs: 5 * 60_000
      }
    )
    const cues = wordLevel ? wordsToCues(chunks, chunkStartSec) : chunksToCues(chunks, chunkStartSec)
    for (const cue of cues) {
      allCues.push(cue)
      onCue(cue)
    }
  }
  return allCues
}
