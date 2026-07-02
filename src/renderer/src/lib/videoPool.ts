import type { VideoSource, FrameSource } from './videoSource'
import { VideoElementSource } from './videoElementSource'
import { WebCodecsSource } from './webCodecsSource'
import { resolveTier } from './videoTier'

// ---------------------------------------------------------------------------
// Drives one VideoSource per source clip and exposes its current frame to the
// compositor. This is the dispatch boundary: the compositor asks for a frame
// and never knows whether it came from a <video> element (the fallback) or a
// WebCodecs VideoDecoder (the frame-precise MP4 path).
//
// Tier resolution is async but want() stays SYNCHRONOUS (the compositor calls
// it every frame; an async return would force the whole render loop async).
// On cache miss we create a VideoElementSource immediately so the clip shows
// up right now, then asynchronously probe whether WebCodecs can handle it; if
// so, we swap in a WebCodecsSource and trigger a re-render. A failed probe
// leaves the VideoElementSource in place — a silent fallback, not a crash.
// ---------------------------------------------------------------------------

/** A decodable frame ready to upload as a texture. `source` is the actual
 *  texImage2D source — an HTMLVideoElement (legacy path) or a WebCodecs
 *  VideoFrame (frame-precise path); the compositor uploads either unchanged. */
export interface VideoFrame {
  source: FrameSource
  width: number
  height: number
}

export class VideoPool {
  private map = new Map<string, VideoSource>()
  /** Media ids whose tier probe is already in flight (don't re-probe). */
  private probing = new Set<string>()
  private host: HTMLDivElement
  private onFrameReady: () => void
  private wanted = new Set<string>()

  constructor(onFrameReady: () => void) {
    this.onFrameReady = onFrameReady
    // Off-screen (not display:none, which can pause decoding) so frames decode.
    this.host = document.createElement('div')
    this.host.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
    document.body.appendChild(this.host)
  }

  /** Get (or lazily create) the source for a media id. Creates a
   *  VideoElementSource immediately and asynchronously probes for an upgrade
   *  to WebCodecsSource (MP4/MOV only). The probe runs once per id. */
  private ensure(mediaId: string, path: string): VideoSource {
    const found = this.map.get(mediaId)
    if (found) return found
    // Start with the fallback so the clip shows immediately while probing.
    const fallback = new VideoElementSource(path, this.onFrameReady)
    this.map.set(mediaId, fallback)
    this.maybeUpgradeToWebCodecs(mediaId, path, fallback)
    return fallback
  }

  /** Async probe: if the file is MP4/MOV and WebCodecs can decode it, swap in
   *  a WebCodecsSource. Any failure is swallowed — the fallback stays. */
  private maybeUpgradeToWebCodecs(mediaId: string, path: string, fallback: VideoSource): void {
    if (this.probing.has(mediaId)) return
    this.probing.add(mediaId)
    // A throwaway source parses the moov just to read the codec for resolveTier.
    const probe = new WebCodecsSource(path, () => undefined)
    resolveTier(
      { id: mediaId, name: '', path, kind: 'video', durationSec: 0 },
      async () => {
        try {
          await probe.ensureInit()
          return probe.resolvedCodec
        } catch {
          return null
        } finally {
          probe.dispose()
        }
      }
    )
      .then((tier) => {
        // Only upgrade if this id is still mapped AND still on the fallback
        // (dispose may have removed it; a later source may have replaced it).
        if (tier === 'webcodecs' && this.map.get(mediaId) === fallback) {
          const wc = new WebCodecsSource(path, this.onFrameReady)
          this.map.set(mediaId, wc)
          fallback.dispose()
          this.onFrameReady()
        }
      })
      .catch(() => {
        /* stay on the fallback */
      })
  }

  /**
   * Ask for `mediaId`'s frame at source time `srcTime`. Returns null until a
   * frame is ready. Mark a render pass with endFrame() afterward.
   */
  want(
    mediaId: string,
    path: string,
    srcTime: number,
    playing: boolean,
    speed = 1
  ): VideoFrame | null {
    const src = this.ensure(mediaId, path)
    this.wanted.add(mediaId)
    src.requestTime(srcTime, playing, speed)
    const f = src.frame
    if (!f || src.width === 0 || src.height === 0) return null
    return { source: f, width: src.width, height: src.height }
  }

  /** Seek a video to an exact source time and resolve once the frame is ready. */
  seekTo(mediaId: string, path: string, srcTime: number): Promise<void> {
    return this.ensure(mediaId, path).seekTo(srcTime)
  }

  /** The <video> element for a media id, if it exists (for audio routing). */
  getElement(mediaId: string): HTMLVideoElement | null {
    const src = this.map.get(mediaId)
    return src ? src.getElement() : null
  }

  /** Pause any video elements no longer under the playhead. */
  endFrame(): void {
    for (const [id, src] of this.map) {
      if (!this.wanted.has(id)) src.endFrame()
    }
    this.wanted.clear()
  }

  dispose(): void {
    for (const src of this.map.values()) src.dispose()
    this.map.clear()
    this.probing.clear()
    this.wanted.clear()
    this.host.remove()
  }
}

