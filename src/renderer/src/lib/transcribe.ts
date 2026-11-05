import type { Clip, Project } from '../types'
import type { SubtitleCue } from '../state/store'
import { getOrDecodeBuffer } from './audioCache'
import { WorkerJob, JobCancelled } from './workerJob'
import { clipSourceSpan, sourceToTimeline } from './clipTime'
import { t } from './i18n'
import { estimateWordChunks, wordsToCues, type WhisperChunk } from './karaoke'
import { isSilent, modelHub, splitAtQuiet, type TranscribeLanguage, type TranscribeModel } from './transcribeOptions'

// ---------------------------------------------------------------------------
// Drives the Whisper worker: extract a clip's audio to 16 kHz mono PCM (Whisper's
// required format), transcribe it off-thread, and map the timestamped segments to
// subtitle cues positioned on the timeline. In karaoke mode the cues also carry
// per-word timing (lib/karaoke.ts) for the compositor's word highlight.
// ---------------------------------------------------------------------------

export interface TranscribeProgress {
  stage: 'extracting' | 'loading' | 'transcribing'
  /** Model-download progress, 0..1 (loading stage only). */
  progress?: number
  file?: string
}

// Extraction (decode + offline render) has no checkpoint where Stop could land,
// so a decode that never settles would hang the modal for good. A generous
// limit that grows with the file still catches that without failing big files
// on slow machines.
function extractTimeoutMs(sourceSec: number): number {
  return 60_000 + Math.max(0, sourceSec) * 250
}

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

/** Render the clip's used SOURCE span (durationSec * speed) to 16 kHz mono PCM,
 *  at natural speed — Whisper needs un-stretched audio; cue times are mapped
 *  back through the clip's speed afterwards. */
async function getClipPcm16k(project: Project, clip: Clip, shouldCancel: () => boolean): Promise<Float32Array> {
  const media = clip.mediaId ? project.media[clip.mediaId] : null
  if (!media || !media.path) throw new Error(t('This clip has no audio to transcribe.'))
  const srcSpan = clipSourceSpan(clip)
  const limit = extractTimeoutMs(Math.max(media.durationSec, srcSpan))
  // Reuses the background decode started on import if it is still running.
  const buffer = await withTimeout(
    getOrDecodeBuffer(media.id, media.path),
    limit,
    t('Decoding this audio took too long. The file may be too large or damaged.')
  )
  if (shouldCancel()) throw new JobCancelled()
  const length = Math.max(1, Math.ceil(srcSpan * 16000))
  const offline = new OfflineAudioContext(1, length, 16000)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  const offset = Math.max(0, Math.min(clip.inSec, buffer.duration))
  const dur = Math.max(0, Math.min(srcSpan, buffer.duration - offset))
  src.start(0, offset, dur)
  const rendered = await withTimeout(offline.startRendering(), limit, t("Preparing this clip's audio took too long."))
  return rendered.getChannelData(0).slice()
}

/** Map Whisper chunks (seconds from the window start) to timeline cues;
 *  `toTimeline` converts window-relative source seconds to timeline seconds. */
function chunksToCues(chunks: WhisperChunk[], toTimeline: (winSec: number) => number): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (let i = 0; i < chunks.length; i++) {
    const text = (chunks[i].text ?? '').trim()
    if (!text) continue
    const start = chunks[i].timestamp?.[0] ?? 0
    let end = chunks[i].timestamp?.[1]
    if (end == null) end = chunks[i + 1]?.timestamp?.[0] ?? start + 2
    cues.push({
      startSec: toTimeline(start),
      endSec: toTimeline(Math.max(start + 0.2, end)),
      text
    })
  }
  return cues
}

interface TranscribeIn {
  type: 'transcribe'
  pcm: Float32Array
  /** Hugging Face model id. */
  model: string
  /** Whisper language name, or 'auto'. */
  language: string
  /** Ask for word-level timestamps (karaoke). */
  words: boolean
}

export interface TranscribeOptions {
  model: TranscribeModel
  language: TranscribeLanguage
  /** Word-timed cues for a karaoke highlight. */
  karaoke?: boolean
}
interface TranscribeOut {
  chunks: WhisperChunk[]
  text: string
  /** True when `chunks` are single words with their own timestamps. False
   *  means phrase segments — also what a word-level request falls back to
   *  when the model can't time words (see transcribe.worker.ts). */
  wordTimestamps?: boolean
}

export interface TranscribeResult {
  cues: SubtitleCue[]
  /** Karaoke only: the model couldn't time words, so some word timings were
   *  estimated from phrase timestamps (see karaoke.estimateWordChunks). */
  estimatedWords: boolean
}

const job = new WorkerJob<TranscribeIn, TranscribeOut>(
  () => new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
)

/**
 * Tear down the transcribe worker (if any) and every call posted to it. A
 * call already in the worker can't be cancelled in place, only waited out —
 * and once the caller has given up on it (the modal was closed while a Stop
 * was pending), leaving it to occupy the shared worker is a trap: the next
 * Transcribe queues behind it, and if the stale call later times out, that
 * teardown takes the new call down too. The next call starts a fresh worker.
 */
export function abandonTranscription(): void {
  job.terminate()
}

const SAMPLE_RATE = 16000
// Windows of up to 2 min, each ending at the quietest spot of its last 4 s so
// no word is sliced at a boundary (the pipeline itself overlaps its 30 s
// chunks inside a window). Each window's cues are surfaced via onCue as soon
// as it resolves, so the caller commits them immediately (see
// TranscribeModal.tsx) and a crash only loses the window in flight.
const WINDOW_SEC = 120
const QUIET_SEARCH_SEC = 4

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
  options: TranscribeOptions = { model: 'small', language: 'auto' }
): Promise<TranscribeResult> {
  onProgress({ stage: 'extracting' })
  const pcm = await getClipPcm16k(project, clip, shouldCancel)
  const allCues: SubtitleCue[] = []
  let estimatedWords = false

  for (const [start, end] of splitAtQuiet(pcm, SAMPLE_RATE, WINDOW_SEC, QUIET_SEARCH_SEC)) {
    if (shouldCancel()) throw new JobCancelled()
    // Whisper invents stock phrases on silence — don't feed it any.
    if (isSilent(pcm, start, end)) continue
    // .slice() (not .subarray()) copies into a fresh buffer per window, so it's
    // safe to transfer to the worker without affecting the others.
    const chunkPcm = pcm.slice(start, end)
    // PCM is SOURCE audio: window offsets map to the timeline through speed.
    const winSrcSec = clip.inSec + start / SAMPLE_RATE
    const toTimeline = (winSec: number): number => sourceToTimeline(clip, winSrcSec + winSec)

    const out = await job.call(
      {
        type: 'transcribe',
        pcm: chunkPcm,
        model: modelHub(options.model),
        language: options.language,
        words: !!options.karaoke
      },
      {
        onProgress: (p) => onProgress({ stage: 'loading', progress: p.progress, file: p.file }),
        onStatus: (msg) => {
          if ((msg as { status?: string }).status === 'transcribing') onProgress({ stage: 'transcribing' })
        },
        shouldCancel,
        // The worker reports after each 30 s chunk of a window, but one chunk on
        // the "Best" model can still run for minutes on CPU without a message;
        // only a truly hung worker should trip this.
        timeoutMs: 15 * 60_000,
        transfer: [chunkPcm.buffer]
      }
    )
    let cues: SubtitleCue[]
    if (options.karaoke) {
      // Word times are SOURCE seconds within the window; toTimeline maps them
      // through the clip's speed, exactly like the segment path.
      const words = out.wordTimestamps ? out.chunks : estimateWordChunks(out.chunks)
      if (!out.wordTimestamps && words.length > 0) estimatedWords = true
      cues = wordsToCues(words, toTimeline)
    } else {
      cues = chunksToCues(out.chunks, toTimeline)
    }
    for (const cue of cues) {
      allCues.push(cue)
      onCue(cue)
    }
  }
  return { cues: allCues, estimatedWords }
}
