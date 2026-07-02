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
// so, the WebCodecs source takes over RENDERING while the element source is
// kept as the AUDIO COMPANION — the audio engine taps video-clip audio via
// getElement() (audioPool.sync), and a VideoFrame has no audio to give it.
// The companion is driven only while playing (audio is silent when paused),
// so export scrubbing never pays for element seeks. A failed probe leaves the
// element source doing both jobs — a silent fallback, not a crash.
// ---------------------------------------------------------------------------

/** A decodable frame ready to upload as a texture. `source` is the actual
 *  texImage2D source — an HTMLVideoElement (legacy path) or a WebCodecs
 *  VideoFrame (frame-precise path); the compositor uploads either unchanged. */
export interface VideoFrame {
  source: FrameSource
  width: number
  height: number
}

interface PoolEntry {
  /** The source rendering video frames. */
  active: VideoSource
  /** The <video>-element source kept alive for audio after a WebCodecs
   *  upgrade. Null while the element source IS the active one. */
  audioCompanion: VideoElementSource | null
}

export class VideoPool {
  private map = new Map<string, PoolEntry>()
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

  /** Get (or lazily create) the entry for a media id. Creates a
   *  VideoElementSource immediately and asynchronously probes for an upgrade
   *  to WebCodecsSource (MP4/MOV only). The probe runs once per id. */
  private ensure(mediaId: string, path: string): PoolEntry {
    const found = this.map.get(mediaId)
    if (found) return found
    // Start with the fallback so the clip shows immediately while probing.
    const entry: PoolEntry = {
      active: new VideoElementSource(path, this.onFrameReady, this.host),
      audioCompanion: null
    }
    this.map.set(mediaId, entry)
    this.maybeUpgradeToWebCodecs(mediaId, path, entry)
    return entry
  }

  /** Async probe: if the file is MP4/MOV and WebCodecs can decode it, promote
   *  a WebCodecsSource to render and keep the element for audio. The probe
   *  source IS the promoted source (init is the expensive part — demux +
   *  decoder config — so it's done exactly once). Any failure is swallowed
   *  and disposes the probe — the element source keeps doing both jobs. */
  private maybeUpgradeToWebCodecs(mediaId: string, path: string, entry: PoolEntry): void {
    if (this.probing.has(mediaId)) return
    this.probing.add(mediaId)
    const candidate = new WebCodecsSource(path, this.onFrameReady)
    resolveTier({ id: mediaId, name: '', path, kind: 'video', durationSec: 0 }, async () => {
      try {
        await candidate.ensureInit()
        return candidate.resolvedCodec
      } catch {
        return null
      }
    })
      .then((tier) => {
        const live = this.map.get(mediaId)
        // Only upgrade if this id is still mapped AND still on the fallback.
        if (tier === 'webcodecs' && live === entry && entry.active instanceof VideoElementSource) {
          entry.audioCompanion = entry.active
          entry.active = candidate
          this.onFrameReady()
        } else {
          candidate.dispose()
        }
      })
      .catch(() => {
        candidate.dispose()
      })
  }

  /**
   * Ask for `mediaId`'s frame at source time `srcTime`. Returns null until a
   * frame is ready. Mark a render pass with endFrame() afterward.
   */
  want(mediaId: string, path: string, srcTime: number, playing: boolean, speed = 1): VideoFrame | null {
    const entry = this.ensure(mediaId, path)
    this.wanted.add(mediaId)
    entry.active.requestTime(srcTime, playing, speed)
    // Keep the audio companion's element rolling in sync while playing (the
    // audio engine taps it). While paused just hard-pause it — no per-frame
    // seeks (export scrubs every output frame; paused audio is silent anyway).
    if (playing) entry.audioCompanion?.requestTime(srcTime, playing, speed)
    else entry.audioCompanion?.pause()
    const f = entry.active.frame
    if (!f || entry.active.width === 0 || entry.active.height === 0) return null
    return { source: f, width: entry.active.width, height: entry.active.height }
  }

  /** Seek a video to an exact source time and resolve once the frame is ready. */
  seekTo(mediaId: string, path: string, srcTime: number): Promise<void> {
    return this.ensure(mediaId, path).active.seekTo(srcTime)
  }

  /** The <video> element for a media id, if one exists (for audio routing). */
  getElement(mediaId: string): HTMLVideoElement | null {
    const entry = this.map.get(mediaId)
    if (!entry) return null
    return entry.audioCompanion?.getElement() ?? entry.active.getElement()
  }

  /** Pause any sources no longer under the playhead. */
  endFrame(): void {
    for (const [id, entry] of this.map) {
      if (!this.wanted.has(id)) {
        entry.active.endFrame()
        entry.audioCompanion?.endFrame()
      }
    }
    this.wanted.clear()
  }

  dispose(): void {
    for (const entry of this.map.values()) {
      entry.active.dispose()
      entry.audioCompanion?.dispose()
    }
    this.map.clear()
    this.probing.clear()
    this.wanted.clear()
    this.host.remove()
  }
}
