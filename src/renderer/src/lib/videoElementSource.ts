import type { VideoSource, FrameSource } from './videoSource'
import { mediaUrl } from './media'

// ---------------------------------------------------------------------------
// The legacy/fallback decode tier: a hidden <video> element per source clip.
// This is today's VideoPool per-element logic, extracted unchanged into a
// VideoSource so the dispatcher (VideoPool) can swap in a WebCodecs tier for
// MP4 without touching this path. NOT frame-accurate; seek snaps to the
// decoder's nearest keyframe (documented limitation).
// ---------------------------------------------------------------------------

// While paused, ignore seek requests within this many seconds of the current
// position so scrubbing doesn't fire a storm of redundant seeks.
const SEEK_EPSILON = 0.04
// While playing, only hard-correct the element if it drifts past this.
const DRIFT_TOLERANCE = 0.3

export class VideoElementSource implements VideoSource {
  private el: HTMLVideoElement
  private wantedThisFrame = false
  private lastSeek = -1
  private _ready = false

  constructor(
    path: string,
    private onFrameReady: () => void,
    host?: HTMLElement
  ) {
    this.el = document.createElement('video')
    this.el.src = mediaUrl(path)
    this.el.muted = true // audible playback goes through the WebAudio graph, not the element
    this.el.playsInline = true
    this.el.preload = 'auto'
    this.el.crossOrigin = 'anonymous'
    // Attach to the pool's off-screen host: a detached element usually still
    // decodes in Chromium, but attached-off-screen is the battle-tested setup
    // the original pool used, so keep it.
    host?.appendChild(this.el)
    const ready = (): void => this.onFrameReady()
    this.el.addEventListener('loadeddata', ready)
    this.el.addEventListener('seeked', ready)
    this.el.addEventListener('canplay', () => {
      this._ready = true
      ready()
    })
  }

  get frame(): FrameSource | null {
    if (!this._ready || this.el.readyState < 2 || this.el.videoWidth === 0) return null
    return this.el
  }
  get width(): number {
    return this.el.videoWidth
  }
  get height(): number {
    return this.el.videoHeight
  }

  requestTime(srcTime: number, playing: boolean, speed = 1): void {
    this.wantedThisFrame = true
    const el = this.el
    if (el.readyState < 1) return // no metadata/dimensions yet

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
      if (Math.abs(el.currentTime - target) > SEEK_EPSILON && Math.abs(this.lastSeek - target) > 0.001) {
        this.lastSeek = target
        el.currentTime = target
      }
    }
  }

  seekTo(srcTime: number): Promise<void> {
    this.wantedThisFrame = true
    const el = this.el
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
        this.lastSeek = target
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

  getElement(): HTMLVideoElement | null {
    return this.el
  }

  /** Hard-pause without seeking. Used on the audio-companion path, where a
   *  paused timeline must not trigger per-frame element seeks (export scrubs
   *  every output frame; the companion's audio is silent while paused anyway). */
  pause(): void {
    if (!this.el.paused) this.el.pause()
  }

  endFrame(): void {
    if (!this.wantedThisFrame && !this.el.paused) this.el.pause()
    this.wantedThisFrame = false
  }

  dispose(): void {
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
    this.el.remove()
  }
}
