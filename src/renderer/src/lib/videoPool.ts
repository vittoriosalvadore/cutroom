import { mediaUrl } from './media'

// ---------------------------------------------------------------------------
// Drives a hidden <video> element per source clip and exposes its current frame
// as a texture source for the compositor. Using the platform decoder gets real,
// keyable video into the preview across every format the runtime supports.
//
// It is NOT frame-accurate: seeking snaps to the decoder's nearest decodable
// frame and resolves asynchronously. Good enough for a draft preview; a
// WebCodecs path can replace this later for exact stepping.
// ---------------------------------------------------------------------------

/** A decodable frame ready to upload as a texture. */
export interface VideoFrame {
  el: HTMLVideoElement
  width: number
  height: number
}

interface Entry {
  el: HTMLVideoElement
  wantedThisFrame: boolean
  lastSeek: number
}

// While paused, ignore seek requests within this many seconds of the current
// position so scrubbing doesn't fire a storm of redundant seeks.
const SEEK_EPSILON = 0.04
// While playing, only hard-correct the element if it drifts past this.
const DRIFT_TOLERANCE = 0.3

export class VideoPool {
  private map = new Map<string, Entry>()
  private host: HTMLDivElement
  private onFrameReady: () => void

  constructor(onFrameReady: () => void) {
    this.onFrameReady = onFrameReady
    // Off-screen (not display:none, which can pause decoding) so frames decode.
    this.host = document.createElement('div')
    this.host.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
    document.body.appendChild(this.host)
  }

  private ensure(mediaId: string, path: string): Entry {
    const found = this.map.get(mediaId)
    if (found) return found

    const el = document.createElement('video')
    el.src = mediaUrl(path)
    el.muted = true // audio comes with the dedicated audio pipeline later
    el.playsInline = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    const entry: Entry = { el, wantedThisFrame: false, lastSeek: -1 }

    const ready = (): void => this.onFrameReady()
    el.addEventListener('loadeddata', ready)
    el.addEventListener('seeked', ready)
    el.addEventListener('canplay', ready)

    this.host.appendChild(el)
    this.map.set(mediaId, entry)
    return entry
  }

  /**
   * Ask for `mediaId`'s frame at source time `srcTime`. Returns null until the
   * element can produce a frame. Mark a render pass with endFrame() afterward.
   */
  want(mediaId: string, path: string, srcTime: number, playing: boolean, speed = 1): VideoFrame | null {
    const entry = this.ensure(mediaId, path)
    entry.wantedThisFrame = true
    const el = entry.el

    if (el.readyState < 1) return null // no metadata/dimensions yet

    // Play the element at the clip's speed so its currentTime tracks srcTime
    // (which advances at `speed`); preservesPitch:false makes the audio pitch
    // with speed, matching the BufferSource audio path.
    if (el.playbackRate !== speed) el.playbackRate = speed
    el.preservesPitch = false

    const dur = el.duration || 0
    const target = dur > 0 ? Math.min(Math.max(0, srcTime), Math.max(0, dur - 0.05)) : Math.max(0, srcTime)

    if (playing) {
      if (el.paused) {
        el.currentTime = target
        void el.play().catch(() => undefined)
      } else if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE) {
        el.currentTime = target
      }
    } else {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - target) > SEEK_EPSILON && Math.abs(entry.lastSeek - target) > 0.001) {
        entry.lastSeek = target
        el.currentTime = target
      }
    }

    if (el.readyState < 2) return null // not enough data for a current frame
    return { el, width: el.videoWidth, height: el.videoHeight }
  }

  /**
   * Seek a video to an exact source time and resolve once the frame is ready.
   * Used by export, which must capture the correct frame before moving on. Falls
   * back to a timeout so a stuck decoder can't hang the whole render.
   */
  seekTo(mediaId: string, path: string, srcTime: number): Promise<void> {
    const entry = this.ensure(mediaId, path)
    entry.wantedThisFrame = true
    const el = entry.el

    return new Promise<void>((resolve) => {
      let settled = false
      let timer = 0

      const finish = (): void => {
        if (settled) return
        settled = true
        el.removeEventListener('seeked', onSeeked)
        el.removeEventListener('loadedmetadata', onMeta)
        if (timer) window.clearTimeout(timer)
        resolve()
      }
      const onSeeked = (): void => finish()
      const seek = (): void => {
        if (!el.paused) el.pause()
        const dur = el.duration || 0
        const target = dur > 0 ? Math.min(Math.max(0, srcTime), Math.max(0, dur - 0.05)) : Math.max(0, srcTime)
        entry.lastSeek = target
        if (Math.abs(el.currentTime - target) < 0.001 && el.readyState >= 2) {
          finish()
          return
        }
        el.addEventListener('seeked', onSeeked)
        el.currentTime = target
      }
      const onMeta = (): void => seek()

      timer = window.setTimeout(finish, 4000)
      if (el.readyState < 1) el.addEventListener('loadedmetadata', onMeta, { once: true })
      else seek()
    })
  }

  /** The <video> element for a media id, if it exists (for audio routing). */
  getElement(mediaId: string): HTMLVideoElement | null {
    return this.map.get(mediaId)?.el ?? null
  }

  /** Pause any videos that weren't requested this render pass. */
  endFrame(): void {
    for (const entry of this.map.values()) {
      if (!entry.wantedThisFrame && !entry.el.paused) entry.el.pause()
      entry.wantedThisFrame = false
    }
  }

  dispose(): void {
    for (const entry of this.map.values()) {
      entry.el.pause()
      entry.el.removeAttribute('src')
      entry.el.load()
    }
    this.map.clear()
    this.host.remove()
  }
}
