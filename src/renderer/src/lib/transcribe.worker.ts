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

// onnxruntime-web 1.14's auto-detection of WebAssembly multi-threading is
// buggy when the page isn't crossOriginIsolated (no COOP/COEP headers, which
// this app doesn't set) — it can leave the WASM backend half-initialized
// instead of cleanly falling back, surfacing later as a "Cannot read
// properties of undefined (reading 'registerBackend')" crash. Forcing
// single-threaded WASM sidesteps the detection bug entirely.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = false
}

// transformers.js types are loose; the transcriber is an async-callable.
type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>
) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> }>

// One loaded model at a time (switching models frees the previous one).
let loaded: { model: string; transcriber: Transcriber } | null = null

async function getTranscriber(model: string): Promise<Transcriber> {
  if (loaded?.model === model) return loaded.transcriber
  loaded = null
  const transcriber = (await pipeline('automatic-speech-recognition', model, {
    progress_callback: (p: unknown) => self.postMessage({ type: 'progress', data: p })
  })) as unknown as Transcriber
  loaded = { model, transcriber }
  return transcriber
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const data = e.data as { type: string; id?: number; pcm?: Float32Array; model?: string; language?: string }
  if (data.type !== 'transcribe' || !data.pcm || !data.model) return
  try {
    const t = await getTranscriber(data.model)
    self.postMessage({ type: 'status', id: data.id, status: 'transcribing' })
    const output = await t(data.pcm, {
      return_timestamps: true,
      // The pipeline overlaps its own 30 s chunks (5 s stride) and merges them,
      // so a window longer than 30 s is transcribed without seams.
      chunk_length_s: 30,
      stride_length_s: 5,
      // Always transcribe (never translate to English). A null language lets
      // the multilingual model detect it.
      task: 'transcribe',
      language: data.language && data.language !== 'auto' ? data.language : null
    })
    self.postMessage({ type: 'result', id: data.id, chunks: output.chunks ?? [], text: output.text })
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: err instanceof Error ? err.message : String(err) })
  }
}
