import type { Clip } from '../types'
import { mediaUrl } from './media'
import { clipRelToSource } from './clipTime'
import { JobCancelled } from './workerJob'

// ---------------------------------------------------------------------------
// Shared "decode a hidden <video>, grab downscaled frames via a canvas" sampler,
// used by autoReframe.ts (subject tracking) and sceneDetect.ts (histogram-diff
// cut detection). Frames are always addressed by SOURCE time: callers map
// timeline time through the clip's speed (lib/clipTime) first.
// ---------------------------------------------------------------------------

export interface SampledFrame {
  /** Clip-relative TIMELINE seconds. */
  t: number
  image: ImageData
}

/** Seek the shared hidden <video> to a SOURCE time and return that frame, downscaled. */
export type GrabFrame = (srcSec: number) => Promise<ImageData>

/**
 * Seek a video element and resolve once the new frame is ready. Mirrors
 * VideoElementSource.seekTo's defenses: a seek to (essentially) the current time fires no
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

/**
 * Open `path` in a hidden <video>, hand `use` a grabber for frames `width` px
 * wide, and always release the decoder afterwards — one element for the whole
 * job, however many (random-access) seeks it makes.
 */
export async function withFrameGrabber<T>(
  path: string,
  use: (grab: GrabFrame) => Promise<T>,
  width = 320
): Promise<T> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  // Match the video pool: CORS-anonymous (set BEFORE src) so the canvas stays
  // untainted and getImageData() works (cutroom:// sends Access-Control-Allow-Origin).
  video.crossOrigin = 'anonymous'
  video.src = mediaUrl(path)
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Could not load the video for analysis.'))
    })
    const W = width
    const H = Math.max(1, Math.round((W * video.videoHeight) / Math.max(1, video.videoWidth)))
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not create an analysis canvas.')
    return await use(async (srcSec) => {
      await seekTo(video, srcSec)
      ctx.drawImage(video, 0, 0, W, H)
      return ctx.getImageData(0, 0, W, H)
    })
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

/** Grab `count` downscaled frames evenly spread across the clip's timeline span. */
export function sampleFrames(
  clip: Clip,
  path: string,
  count: number,
  onProgress: (fraction: number) => void,
  shouldCancel: () => boolean
): Promise<SampledFrame[]> {
  return withFrameGrabber(path, async (grab) => {
    const frames: SampledFrame[] = []
    for (let i = 0; i < count; i++) {
      if (shouldCancel()) throw new JobCancelled()
      // tRel is clip-relative TIMELINE time (what keyframes use); the source
      // frame shown there is speed-scaled.
      const tRel = count <= 1 ? 0 : (clip.durationSec * i) / (count - 1)
      frames.push({ t: tRel, image: await grab(clipRelToSource(clip, tRel)) })
      onProgress((i + 1) / count)
    }
    return frames
  })
}
