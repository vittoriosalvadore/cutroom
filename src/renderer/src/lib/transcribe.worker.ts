import { pipeline, env } from '@xenova/transformers'

// ---------------------------------------------------------------------------
// Whisper speech-to-text in a Web Worker. The main thread sends 16 kHz mono PCM;
// we run it through a small Whisper model and post back timestamped segments.
// Runs off the UI thread so transcription never freezes the editor.
//
// First run downloads the model from the Hugging Face hub (cached afterwards, so
// later runs are fully offline). The ONNX WASM runtime is fetched from a CDN.
// ---------------------------------------------------------------------------

// Fetch models from the hub rather than expecting them bundled locally.
env.allowLocalModels = false

const MODEL = 'Xenova/whisper-tiny.en'

// transformers.js types are loose; the transcriber is an async-callable.
type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>
) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>

let transcriber: Transcriber | null = null

async function getTranscriber(): Promise<Transcriber> {
  if (transcriber) return transcriber
  transcriber = (await pipeline('automatic-speech-recognition', MODEL, {
    progress_callback: (p: unknown) => self.postMessage({ type: 'progress', data: p })
  })) as unknown as Transcriber
  return transcriber
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const data = e.data as { type: string; pcm?: Float32Array }
  if (data.type !== 'transcribe' || !data.pcm) return
  try {
    const t = await getTranscriber()
    self.postMessage({ type: 'status', status: 'transcribing' })
    const output = await t(data.pcm, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5
    })
    self.postMessage({ type: 'result', chunks: output.chunks ?? [], text: output.text })
  } catch (err) {
    self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}
