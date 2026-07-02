import { pipeline, env, RawImage } from '@xenova/transformers'

// ---------------------------------------------------------------------------
// Local object detection in a Web Worker (for AI auto-reframe). The main thread
// sends downscaled RGBA frames; we run a small DETR-family model and post back
// bounding boxes. Off-thread so analysis never freezes the editor. First run
// downloads the model from the hub (cached afterwards); ONNX WASM from a CDN.
// ---------------------------------------------------------------------------

env.allowLocalModels = false

// See transcribe.worker.ts for why: onnxruntime-web 1.14's multi-threading
// auto-detection is buggy outside a crossOriginIsolated page, leaving the WASM
// backend half-initialized ("Cannot read properties of undefined (reading
// 'registerBackend')") instead of falling back cleanly. Force single-threaded.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1
  env.backends.onnx.wasm.proxy = false
}

const MODEL = 'Xenova/yolos-tiny'

interface Box {
  score: number
  label: string
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
}
type Detector = (image: RawImage, opts: Record<string, unknown>) => Promise<Box[]>

let detector: Detector | null = null

async function getDetector(): Promise<Detector> {
  if (detector) return detector
  detector = (await pipeline('object-detection', MODEL, {
    progress_callback: (p: unknown) => self.postMessage({ type: 'progress', data: p })
  })) as unknown as Detector
  return detector
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const data = e.data as {
    type: string
    id?: number
    image?: { data: Uint8ClampedArray; width: number; height: number }
    threshold?: number
  }
  if (data.type !== 'detect' || !data.image) return
  try {
    const d = await getDetector()
    // Build an RGB image from the RGBA pixels; the model's processor resizes it.
    const img = new RawImage(new Uint8ClampedArray(data.image.data), data.image.width, data.image.height, 4).rgb()
    const boxes = await d(img, { threshold: data.threshold ?? 0.4, percentage: true })
    self.postMessage({ type: 'result', id: data.id, boxes })
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: err instanceof Error ? err.message : String(err) })
  }
}
