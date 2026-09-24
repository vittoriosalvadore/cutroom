import type { Clip, Project } from '../types'
import type { SubtitleCue } from '../state/store'
import { getOrDecodeBuffer } from './audioCache'
import { WorkerJob, JobCancelled } from './workerJob'
import { clipSourceSpan, sourceToTimeline } from './clipTime'
import { isSilent, modelHub, splitAtQuiet, type TranscribeLanguage, type TranscribeModel } from './transcribeOptions'

// ---------------------------------------------------------------------------
// Drives the Whisper worker: extract a clip's audio to 16 kHz mono PCM (Whisper's
// required format), transcribe it off-thread, and map the timestamped segments to
// subtitle cues positioned on the timeline.
// ---------------------------------------------------------------------------

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
  return getOrDecodeBuffer(media.id, media.path)
}

/** Render the clip's used SOURCE span (durationSec * speed) to 16 kHz mono PCM,
 *  at natural speed — Whisper needs un-stretched audio; cue times are mapped
 *  back through the clip's speed afterwards. */
async function getClipPcm16k(project: Project, clip: Clip): Promise<Float32Array> {
  const buffer = await getSourceBuffer(project, clip)
  const srcSpan = clipSourceSpan(clip)
  const length = Math.max(1, Math.ceil(srcSpan * 16000))
  const offline = new OfflineAudioContext(1, length, 16000)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  const offset = Math.max(0, Math.min(clip.inSec, buffer.duration))
  const dur = Math.max(0, Math.min(srcSpan, buffer.duration - offset))
  src.start(0, offset, dur)
  const rendered = await offline.startRendering()
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
}

export interface TranscribeOptions {
  model: TranscribeModel
  language: TranscribeLanguage
}
interface TranscribeOut {
  chunks: WhisperChunk[]
  text: string
}

const job = new WorkerJob<TranscribeIn, TranscribeOut>(
  () => new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
)

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
): Promise<SubtitleCue[]> {
  onProgress({ stage: 'extracting' })
  const pcm = await getClipPcm16k(project, clip)
  const allCues: SubtitleCue[] = []

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

    const { chunks } = await job.call(
      { type: 'transcribe', pcm: chunkPcm, model: modelHub(options.model), language: options.language },
      {
        onProgress: (p) => onProgress({ stage: 'loading', progress: p.progress, file: p.file }),
        onStatus: (msg) => {
          if ((msg as { status?: string }).status === 'transcribing') onProgress({ stage: 'transcribing' })
        },
        shouldCancel,
        // A 2 min window on the "Accurate" model can run for minutes on CPU
        // without an intermediate message; only a truly hung worker should trip this.
        timeoutMs: 15 * 60_000,
        transfer: [chunkPcm.buffer]
      }
    )
    for (const cue of chunksToCues(chunks, toTimeline)) {
      allCues.push(cue)
      onCue(cue)
    }
  }
  return allCues
}
