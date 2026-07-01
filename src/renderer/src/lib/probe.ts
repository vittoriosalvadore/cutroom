import { mediaUrl } from './media'

// Lightweight metadata probes using the platform decoders. Lets the media bin
// show real durations/resolutions and clips inherit the correct length on add,
// without pulling in ffprobe yet.

export interface ProbeResult {
  durationSec: number
  width: number
  height: number
}

/** Read duration + dimensions from a video file. */
export function probeVideo(path: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const cleanup = (): void => {
      v.removeAttribute('src')
      v.load()
    }
    v.onloadedmetadata = () => {
      const result: ProbeResult = {
        durationSec: Number.isFinite(v.duration) ? v.duration : 0,
        width: v.videoWidth,
        height: v.videoHeight
      }
      cleanup()
      resolve(result)
    }
    v.onerror = () => {
      cleanup()
      reject(new Error(`Could not probe video: ${path}`))
    }
    v.src = mediaUrl(path)
  })
}

/** Read dimensions from an image file (duration is conceptually 0 for a still). */
export function probeImage(path: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ durationSec: 0, width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error(`Could not probe image: ${path}`))
    img.src = mediaUrl(path)
  })
}

/** Read duration from an audio file (so audio clips get the right length). */
export function probeAudio(path: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    const cleanup = (): void => {
      a.removeAttribute('src')
      a.load()
    }
    a.onloadedmetadata = () => {
      const durationSec = Number.isFinite(a.duration) ? a.duration : 0
      cleanup()
      resolve({ durationSec, width: 0, height: 0 })
    }
    a.onerror = () => {
      cleanup()
      reject(new Error(`Could not probe audio: ${path}`))
    }
    a.src = mediaUrl(path)
  })
}
