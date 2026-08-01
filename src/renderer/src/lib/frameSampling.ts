import type { Clip } from '../types'
import { mediaUrl } from './media'
import { JobCancelled } from './workerJob'

// ---------------------------------------------------------------------------
// Shared "decode a hidden <video>, grab downscaled frames via canvas" sampler,
// used by autoReframe.ts (subject tracking) and sceneDetect.ts (histogram-diff
// cut detection) — same technique, extracted so a third feature doesn't
// copy-paste it again.
// ---------------------------------------------------------------------------

export interface SampledFrame {
  /** Clip-relative seconds. */
  t: number
  image: ImageData
}

/**
 * Seek a video element and resolve once the new frame is ready. A seek to
 * (essentially) the current time fires no 'seeked' event, so early-resolve
 * when already there; back off 0.05s from the exact end (seeking to duration
 * stalls / yields a black frame); and a timeout fallback so a stuck decoder
 * can never hang the whole analysis.
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
 * Grab `count` downscaled frames evenly spread across a window of the clip's
 * used span (clip-relative seconds; defaults to the whole clip). Passing a
 * narrow `window` re-samples just that slice more densely — e.g. to refine a
 * coarse candidate without re-analysing the whole clip.
 */
export async function sampleFrames(
  clip: Clip,
  path: string,
  count: number,
  onProgress: (fraction: number) => void,
  shouldCancel: () => boolean,
  window?: { fromRelSec: number; toRelSec: number }
): Promise<SampledFrame[]> {
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

    const fromRel = window?.fromRelSec ?? 0
    const toRel = window?.toRelSec ?? clip.durationSec

    const frames: SampledFrame[] = []
    for (let i = 0; i < count; i++) {
      if (shouldCancel()) throw new JobCancelled()
      const tRel = count <= 1 ? fromRel : fromRel + ((toRel - fromRel) * i) / (count - 1)
      await seekTo(video, clip.inSec + tRel)
      ctx.drawImage(video, 0, 0, W, H)
      frames.push({ t: tRel, image: ctx.getImageData(0, 0, W, H) })
      onProgress((i + 1) / count)
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}
