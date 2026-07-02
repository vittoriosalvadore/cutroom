import type { Clip, Project } from '../types'
import type { SubtitleCue } from '../state/store'
import { getOrDecodeBuffer } from './audioCache'
import { WorkerJob, JobCancelled } from './workerJob'

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

/** Render the clip's used span to 16 kHz mono PCM. */
async function getClipPcm16k(project: Project, clip: Clip): Promise<Float32Array> {
  const buffer = await getSourceBuffer(project, clip)
  const length = Math.max(1, Math.ceil(clip.durationSec * 16000))
  const offline = new OfflineAudioContext(1, length, 16000)
  const src = offline.createBufferSource()
  src.buffer = buffer
  src.connect(offline.destination)
  const offset = Math.max(0, Math.min(clip.inSec, buffer.duration))
  const dur = Math.max(0, Math.min(clip.durationSec, buffer.duration - offset))
  src.start(0, offset, dur)
  const rendered = await offline.startRendering()
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

interface TranscribeIn {
  type: 'transcribe'
  pcm: Float32Array
}
interface TranscribeOut {
  chunks: WhisperChunk[]
  text: string
}

const job = new WorkerJob<TranscribeIn, TranscribeOut>(
  () => new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
)

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
  shouldCancel: () => boolean = () => false
): Promise<SubtitleCue[]> {
  onProgress({ stage: 'extracting' })
  const pcm = await getClipPcm16k(project, clip)
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
      { type: 'transcribe', pcm: chunkPcm },
      {
        onProgress: (p) => onProgress({ stage: 'loading', progress: p.progress, file: p.file }),
        onStatus: (msg) => {
          if ((msg as { status?: string }).status === 'transcribing') onProgress({ stage: 'transcribing' })
        },
        shouldCancel,
        transfer: [chunkPcm.buffer]
      }
    )
    for (const cue of chunksToCues(chunks, chunkStartSec)) {
      allCues.push(cue)
      onCue(cue)
    }
  }
  return allCues
}
