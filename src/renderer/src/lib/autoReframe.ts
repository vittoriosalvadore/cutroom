import type { Clip, Keyframe, Project } from '../types'
import { mediaUrl } from './media'
import { WorkerJob, JobCancelled } from './workerJob'

/** Re-exported under this module's name so existing callers (AutoReframeModal)
 *  keep working unchanged — it's the same JobCancelled sentinel every worker
 *  job now throws, not a distinct reframe-specific error type. */
export { JobCancelled as ReframeCancelled }

// ---------------------------------------------------------------------------
// AI auto-reframe. Samples frames from a video clip, detects the subject in each
// (off-thread, detect.worker), tracks its centre over time, and emits smoothed
// position keyframes (+ a static zoom) that keep the subject framed. The output
// is just keyframes, so it rides the existing transform/keyframe system and
// renders identically in preview and export.
// ---------------------------------------------------------------------------

export interface ReframeOptions {
  /** Which subject to follow. */
  target: 'person' | 'auto'
  /** Punch-in zoom (>1). Bigger = tighter follow but more crop. */
  zoom: number
  /** Number of frames to analyse across the clip. */
  samples: number
}

export interface ReframeProgress {
  stage: 'loading' | 'sampling' | 'detecting' | 'done'
  /** 0..1 within the current stage. */
  progress?: number
  file?: string
}

export interface ReframeResult {
  posX: Keyframe[]
  posY: Keyframe[]
  scale: number
}

interface Box {
  score: number
  label: string
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
}

interface DetectIn {
  type: 'detect'
  image: { data: Uint8ClampedArray; width: number; height: number }
}
interface DetectOut {
  boxes: Box[]
}

const detectJob = new WorkerJob<DetectIn, DetectOut>(
  () => new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module' })
)

/**
 * Seek a video element and resolve once the new frame is ready. Mirrors
 * videoPool.seekTo's defenses: a seek to (essentially) the current time fires no
 * 'seeked' event, so early-resolve when already there; back off 0.05s from the
 * exact end (seeking to duration stalls / yields a black frame); and a timeout
 * fallback so a stuck decoder can never hang the whole analysis.
 */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  const dur = video.duration || t
  const target = Math.max(0, Math.min(t, dur - 0.05))
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) {
      resolve()
      return
    }
    let timer = 0
    const done = (): void => {
      window.clearTimeout(timer)
      video.removeEventListener('seeked', done)
      resolve()
    }
    timer = window.setTimeout(done, 3000)
    video.addEventListener('seeked', done)
    video.currentTime = target
  })
}

interface Frame {
  t: number // clip-relative seconds
  image: ImageData
}

/** Grab `count` downscaled frames spread across the clip's used span. */
async function sampleFrames(
  clip: Clip,
  path: string,
  count: number,
  onProgress: (p: ReframeProgress) => void,
  shouldCancel: () => boolean
): Promise<Frame[]> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  // Match the video pool: CORS-anonymous so the canvas stays untainted and
  // getImageData() works (the cutroom:// protocol sends Access-Control-Allow-Origin).
  video.crossOrigin = 'anonymous'
  video.src = mediaUrl(path)
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Could not load the video for analysis.'))
    })
    const W = 320
    const H = Math.max(1, Math.round((W * video.videoHeight) / Math.max(1, video.videoWidth)))
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not create an analysis canvas.')
    const frames: Frame[] = []
    for (let i = 0; i < count; i++) {
      if (shouldCancel()) throw new JobCancelled()
      const tRel = count <= 1 ? 0 : (clip.durationSec * i) / (count - 1)
      await seekTo(video, clip.inSec + tRel)
      ctx.drawImage(video, 0, 0, W, H)
      frames.push({ t: tRel, image: ctx.getImageData(0, 0, W, H) })
      onProgress({ stage: 'sampling', progress: (i + 1) / count })
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

/** Subject centre (0..1) for a frame, or null when nothing suitable was found. */
function pickCenter(boxes: Box[], target: ReframeOptions['target']): { cx: number; cy: number } | null {
  let pool = boxes
  if (target === 'person') {
    const people = boxes.filter((b) => b.label === 'person')
    if (people.length > 0) pool = people
  }
  if (pool.length === 0) return null
  // Highest-confidence box; ties broken toward the larger one.
  const best = pool.reduce((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? b : a
    const area = (x: Box): number => (x.box.xmax - x.box.xmin) * (x.box.ymax - x.box.ymin)
    return area(b) > area(a) ? b : a
  })
  return { cx: (best.box.xmin + best.box.xmax) / 2, cy: (best.box.ymin + best.box.ymax) / 2 }
}

/** Replace gaps (no detection) by carrying the nearest known centre forward/back. */
function fillCenters(centers: ({ cx: number; cy: number } | null)[]): { cx: number; cy: number }[] {
  const out: { cx: number; cy: number }[] = []
  let last: { cx: number; cy: number } | null = null
  for (const c of centers) {
    if (c) last = c
    out.push(last ?? { cx: 0.5, cy: 0.5 })
  }
  // Back-fill any leading gap with the first known value.
  const firstKnown = centers.find((c) => c) ?? { cx: 0.5, cy: 0.5 }
  for (let i = 0; i < out.length && !centers[i]; i++) out[i] = firstKnown
  return out
}

/** Moving-average smoothing over a +/- `r` window to kill detection jitter. */
function smooth(centers: { cx: number; cy: number }[], r: number): { cx: number; cy: number }[] {
  return centers.map((_, i) => {
    let cx = 0
    let cy = 0
    let n = 0
    for (let j = Math.max(0, i - r); j <= Math.min(centers.length - 1, i + r); j++) {
      cx += centers[j].cx
      cy += centers[j].cy
      n++
    }
    return { cx: cx / n, cy: cy / n }
  })
}

export async function autoReframe(
  project: Project,
  clip: Clip,
  opts: ReframeOptions,
  onProgress: (p: ReframeProgress) => void,
  shouldCancel: () => boolean = () => false
): Promise<ReframeResult> {
  const media = clip.mediaId ? project.media[clip.mediaId] : null
  if (!media || media.kind !== 'video' || !media.path) {
    throw new Error('Auto-reframe needs a video clip.')
  }
  const count = Math.max(2, Math.min(120, Math.round(opts.samples)))
  const frames = await sampleFrames(clip, media.path, count, onProgress, shouldCancel)

  const centers: ({ cx: number; cy: number } | null)[] = []
  for (let i = 0; i < frames.length; i++) {
    onProgress({ stage: 'detecting', progress: (i + 1) / frames.length })
    const image = frames[i].image
    const { boxes } = await detectJob.call(
      { type: 'detect', image: { data: image.data, width: image.width, height: image.height } },
      {
        onProgress: (p) => onProgress({ stage: 'loading', progress: p.progress, file: p.file }),
        shouldCancel,
        transfer: [image.data.buffer]
      }
    )
    centers.push(pickCenter(boxes, opts.target))
  }

  const tracked = smooth(fillCenters(centers), 2)
  const s = Math.max(1.05, opts.zoom)

  // Detected centres are fractions of the VIDEO content; the compositor fits that
  // content into the frame via contain (a pillar/letter-boxed rect when the clip
  // aspect differs from the project), so convert the centre offset into frame
  // space with that rect before computing the pan. The pan is then clamped to the
  // content's on-screen overhang so it never reveals more empty border.
  const iw = media.width ?? 0
  const ih = media.height ?? 0
  let bw = 1
  let bh = 1
  if (iw > 0 && ih > 0) {
    const fit = Math.min(project.width / iw, project.height / ih)
    bw = (iw * fit) / project.width
    bh = (ih * fit) / project.height
  }
  const axis = (c: number, frac: number): number => {
    const m = Math.max(0, (s * frac - 1) / 2)
    return Math.max(-m, Math.min(m, -(c - 0.5) * frac * s))
  }

  const posX: Keyframe[] = []
  const posY: Keyframe[] = []
  for (let i = 0; i < frames.length; i++) {
    posX.push({ t: frames[i].t, v: axis(tracked[i].cx, bw), ease: 'smooth' })
    posY.push({ t: frames[i].t, v: axis(tracked[i].cy, bh), ease: 'smooth' })
  }
  onProgress({ stage: 'done' })
  return { posX, posY, scale: s }
}
