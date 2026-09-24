import type { VideoSource, FrameSource } from './videoSource'
import { VideoElementSource } from './videoElementSource'
import { WebCodecsSource } from './webCodecsSource'
import { resolveTier } from './videoTier'

// ---------------------------------------------------------------------------
// Drives one VideoSource per timeline CLIP (keyed by clip id, not media id)
// and exposes its current frame to the compositor. Two clips of the same file
// visible at once (split + overlap for PiP/crossfade) therefore get their own
// decoder, frame and audio element instead of thrashing one between two times. This is the dispatch boundary: the compositor asks for a frame
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
// element source doing both jobs — a silent fallback, not a crash; a WebCodecs
// source whose decoder keeps failing is demoted back to the element source.
//
// A clip on a HIDDEN track isn't drawn but must stay audible (export mixes
// hidden tracks' audio too): wantAudio() drives only its audio element.
//
// Entries not wanted for IDLE_EVICT_MS are disposed (element, decoder, held
// VideoFrame) and the owner is told via onEvict so it can free the GL texture.
// Eviction only runs from endFrame() and skips everything wanted (drawn or
// audio-only) this frame.
// ---------------------------------------------------------------------------

/** Dispose a source that hasn't been wanted for this long (wall clock). */
const IDLE_EVICT_MS = 10_000

/** A decodable frame ready to upload as a texture. `source` is the actual
 *  texImage2D source — an HTMLVideoElement (legacy path) or a WebCodecs
 *  VideoFrame (frame-precise path); the compositor uploads either unchanged. */
export interface VideoFrame {
  source: FrameSource
  width: number
  height: number
}

interface PoolEntry {
  /** The file this entry decodes; a different path for the same key (media
   *  relinked) recreates the entry. */
  path: string
  /** The source rendering video frames. */
  active: VideoSource
  /** The <video>-element source kept alive for audio after a WebCodecs
   *  upgrade. Null while the element source IS the active one. */
  audioCompanion: VideoElementSource | null
  /** Resolves once the tier probe settled (upgraded or not). Never rejects. */
  tierReady: Promise<void>
  /** performance.now() of the last want()/wantAudio()/seekTo(), for idle eviction. */
  lastUsed: number
}

export class VideoPool {
  /** Keyed by clip id. */
  private map = new Map<string, PoolEntry>()
  /** Keys whose tier probe is already in flight (don't re-probe). */
  private probing = new Set<string>()
  private host: HTMLDivElement
  private onFrameReady: () => void
  private onEvict: (key: string) => void
  /** Keys drawn this frame (want). */
  private wanted = new Set<string>()
  /** Keys only heard this frame (wantAudio, hidden tracks). */
  private audible = new Set<string>()

  constructor(onFrameReady: () => void, onEvict: (key: string) => void = () => undefined) {
    this.onFrameReady = onFrameReady
    this.onEvict = onEvict
    // Off-screen (not display:none, which can pause decoding) so frames decode.
    this.host = document.createElement('div')
    this.host.style.cssText =
      'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
    document.body.appendChild(this.host)
  }

  /** Get (or lazily create) the entry for a clip id. Creates a
   *  VideoElementSource immediately and asynchronously probes for an upgrade
   *  to WebCodecsSource (MP4/MOV only). The probe runs once per entry. */
  private ensure(key: string, path: string): PoolEntry {
    const found = this.map.get(key)
    if (found && found.path === path) return found
    if (found) this.evict(key, found)
    // Start with the fallback so the clip shows immediately while probing.
    const entry: PoolEntry = {
      path,
      active: new VideoElementSource(path, this.onFrameReady, this.host),
      audioCompanion: null,
      tierReady: Promise.resolve(),
      lastUsed: performance.now()
    }
    this.map.set(key, entry)
    entry.tierReady = this.maybeUpgradeToWebCodecs(key, path, entry)
    return entry
  }

  /** A WebCodecs source whose decoder failed for good hands rendering back to
   *  its audio companion (the element source), so the clip keeps playing. */
  private demoteIfFailed(entry: PoolEntry): void {
    if (entry.active instanceof WebCodecsSource && entry.active.decodeFailed && entry.audioCompanion) {
      entry.active.dispose()
      entry.active = entry.audioCompanion
      entry.audioCompanion = null
    }
  }

  /** Async probe: if the file is MP4/MOV and WebCodecs can decode it, promote
   *  a WebCodecsSource to render and keep the element for audio. The probe
   *  source IS the promoted source (init is the expensive part — demux +
   *  decoder config — so it's done exactly once). Any failure is swallowed
   *  and disposes the probe — the element source keeps doing both jobs. */
  private maybeUpgradeToWebCodecs(key: string, path: string, entry: PoolEntry): Promise<void> {
    if (this.probing.has(key)) return Promise.resolve()
    this.probing.add(key)
    const candidate = new WebCodecsSource(path, this.onFrameReady)
    return resolveTier({ id: key, name: '', path, kind: 'video', durationSec: 0 }, async () => {
      try {
        await candidate.ensureInit()
        return candidate.resolvedCodec
      } catch {
        return null
      }
    })
      .then((tier) => {
        const live = this.map.get(key)
        // Only upgrade if this key is still mapped AND still on the fallback.
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
   * Ask for clip `key`'s frame at source time `srcTime` of the file at `path`.
   * Returns null until a frame is ready. Mark a render pass with endFrame()
   * afterward.
   */
  want(key: string, path: string, srcTime: number, playing: boolean, speed = 1): VideoFrame | null {
    const entry = this.ensure(key, path)
    this.demoteIfFailed(entry)
    entry.lastUsed = performance.now()
    this.wanted.add(key)
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

  /** Drive ONLY the audio side of clip `key` (a clip on a hidden track: not
   *  drawn, still heard). Keeps the entry alive like want() but never decodes
   *  a picture: the element source is the audio element when no WebCodecs
   *  upgrade happened, else the audio companion is. Paused -> hard pause. */
  wantAudio(key: string, path: string, srcTime: number, playing: boolean, speed = 1): void {
    const entry = this.ensure(key, path)
    this.demoteIfFailed(entry)
    entry.lastUsed = performance.now()
    this.audible.add(key)
    const el = entry.audioCompanion ?? (entry.active instanceof VideoElementSource ? entry.active : null)
    if (!el) return
    if (playing) el.requestTime(srcTime, playing, speed)
    else el.pause()
  }

  /** Seek a video to an exact source time and resolve once the frame is ready.
   *  (Export path.) Waits for the tier probe first, so an export never starts
   *  on the element tier and switches decoders mid-file. */
  async seekTo(key: string, path: string, srcTime: number): Promise<void> {
    const entry = this.ensure(key, path)
    entry.lastUsed = performance.now()
    await entry.tierReady
    this.demoteIfFailed(entry)
    entry.lastUsed = performance.now()
    return entry.active.seekTo(srcTime)
  }

  /** The <video> element for a clip id, if one exists (for audio routing). */
  getElement(key: string): HTMLVideoElement | null {
    const entry = this.map.get(key)
    if (!entry) return null
    return entry.audioCompanion?.getElement() ?? entry.active.getElement()
  }

  /** Pause any sources no longer under the playhead; dispose long-idle ones. */
  endFrame(): void {
    const now = performance.now()
    for (const [id, entry] of this.map) {
      if (this.wanted.has(id)) continue
      if (this.audible.has(id)) {
        // Audio-only: leave the audio element alone, idle the picture side.
        if (entry.audioCompanion) entry.active.endFrame()
        continue
      }
      entry.active.endFrame()
      entry.audioCompanion?.endFrame()
      if (now - entry.lastUsed > IDLE_EVICT_MS) this.evict(id, entry)
    }
    this.wanted.clear()
    this.audible.clear()
  }

  /** Release an idle entry. A later want()/seekTo() simply recreates it (and
   *  re-probes); an in-flight probe for it sees a stale entry and disposes
   *  its candidate. */
  private evict(key: string, entry: PoolEntry): void {
    entry.active.dispose()
    entry.audioCompanion?.dispose()
    this.map.delete(key)
    this.probing.delete(key)
    this.onEvict(key)
  }

  dispose(): void {
    for (const entry of this.map.values()) {
      entry.active.dispose()
      entry.audioCompanion?.dispose()
    }
    this.map.clear()
    this.probing.clear()
    this.wanted.clear()
    this.audible.clear()
    this.host.remove()
  }
}
