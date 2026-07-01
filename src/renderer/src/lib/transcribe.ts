import type { Clip, Project } from '../types'
import type { SubtitleCue } from '../state/store'
import { getAudioContext } from './audioContext'
import { getAudioEntry } from './audioCache'
import { mediaUrl } from './media'

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
  // Reuse the cached decode for audio clips; decode on demand otherwise.
  const entry = getAudioEntry(media.id)
  if (entry?.status === 'ready' && entry.buffer) return entry.buffer
  const arr = await fetch(mediaUrl(media.path)).then((r) => r.arrayBuffer())
  return getAudioContext().decodeAudioData(arr)
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

let worker: Worker | null = null
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

export async function transcribeClip(
  project: Project,
  clip: Clip,
  onProgress: (p: TranscribeProgress) => void
): Promise<SubtitleCue[]> {
  onProgress({ stage: 'extracting' })
  const pcm = await getClipPcm16k(project, clip)
  const w = getWorker()

  return new Promise<SubtitleCue[]>((resolve, reject) => {
    const handler = (e: MessageEvent): void => {
      const msg = e.data as { type: string; data?: { status?: string; file?: string; progress?: number }; chunks?: WhisperChunk[]; error?: string }
      if (msg.type === 'progress') {
        if (msg.data?.status === 'progress') {
          onProgress({ stage: 'loading', progress: (msg.data.progress ?? 0) / 100, file: msg.data.file })
        } else {
          onProgress({ stage: 'loading', file: msg.data?.file })
        }
      } else if (msg.type === 'status') {
        onProgress({ stage: 'transcribing' })
      } else if (msg.type === 'result') {
        w.removeEventListener('message', handler)
        resolve(chunksToCues(msg.chunks ?? [], clip.startSec))
      } else if (msg.type === 'error') {
        w.removeEventListener('message', handler)
        reject(new Error(msg.error || 'Transcription failed.'))
      }
    }
    w.addEventListener('message', handler)
    w.postMessage({ type: 'transcribe', pcm })
  })
}
