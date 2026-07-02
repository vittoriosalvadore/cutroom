import type { VideoSource, FrameSource } from './videoSource'
import { findKeyframeBefore, type SampleEntry } from './sampleTable'
import { mediaUrl } from './media'

// ---------------------------------------------------------------------------
// The WebCodecs decode tier: frame-precise, stutter-free decode for MP4/MOV.
//
// Pipeline:
//   fetch (Range, progressive) -> mp4box.js (demux) -> EncodedVideoChunk ->
//   VideoDecoder -> VideoFrame -> compositor texture.
//
// mp4box.js is imported DYNAMICALLY inside init() so MKV/WebM clips (which use
// the VideoElementSource tier) never pay the bundle cost of loading it.
//
// Decode strategy (set by the `playing` flag in requestTime()):
//   scrub  -> decode only the one target frame on demand: reset the decoder,
//             feed the chain from the preceding keyframe to the target,
//             discard everything except the target frame, surface it.
//   play   -> keep a LOOKAHEAD_FRAMES buffer decoded ahead of the playhead so
//             the next frame is always ready; decode forward continuously so
//             we rarely pay the keyframe-restart cost.
//
// Eviction: a decoded VideoFrame holds GPU/memory until .close(). We hold at
// most the current frame + the lookahead ring; every superseded frame is
// .close()d the instant it's replaced.
// ---------------------------------------------------------------------------

const LOOKAHEAD_FRAMES = 6
/** Fetch chunk size while progressively feeding mp4box until the moov is found. */
const DEMUX_CHUNK = 1024 * 1024
/** SeekTo gives up after this (a stuck decoder shouldn't hang export). */
const SEEK_TIMEOUT_MS = 4000

/** The mp4box.js file object. Typed loosely — its types are hand-rolled. */
interface Mp4BoxFile {
  appendBuffer(buf: ArrayBuffer): number
  start(): void
  seek(offset: number): void
  getInfo(): { tracks: Mp4Track[] }
  getTrackSamplesInfo(trackId: number): Mp4SampleInfo[]
  getTrackSample(trackId: number, sampleNumber: number): { data: Uint8Array }
  onready?: () => void
}
interface Mp4Track {
  id: number
  codec: string
  track_width: number
  track_height: number
  timescale: number
  type?: string
  nb_samples?: number
}
interface Mp4SampleInfo {
  number: number
  alreadyRead: number
  size: number
  cts: number
  dts: number
  duration: number
  is_sync: boolean
  is_leading?: number
}

/** Augment ArrayBuffer for mp4box's required fileStart field. */
interface Mp4Buffer extends ArrayBuffer {
  fileStart: number
}

export class WebCodecsSource implements VideoSource {
  private decoder: VideoDecoder | null = null
  private mp4box: Mp4BoxFile | null = null
  private trackId = -1
  private codec = ''
  private timescale = 1
  private samples: SampleEntry[] = []
  /** The current frame the compositor is showing. */
  private current: VideoFrame | null = null
  /** Timestamp (µs) of the frame most recently requested via requestTime. */
  private requestedTime = 0
  /** Whether we're in continuous (play) or on-demand (scrub) mode. */
  private playing = false
  private w = 0
  private h = 0
  private initError: Error | null = null
  private initDone = false
  private initPromise: Promise<void> | null = null
  /** The last sample index we fed to the decoder (avoid re-feeding on play). */
  private decodeCursor = -1
  /** Decoded outputs collected via the VideoDecoder output callback. The newer
   *  dequeue()/decodeQueueLength API isn't in this TS lib version, so we drain
   *  this queue ourselves from drainOutputs(). */
  private outputQueue: VideoFrame[] = []
  private wantedThisFrame = false

  constructor(
    private path: string,
    private onFrameReady: () => void
  ) {}

  get frame(): FrameSource | null {
    return this.current
  }
  get width(): number {
    return this.w
  }
  get height(): number {
    return this.h
  }

  // -------------------------------------------------------------------------
  // Initialization: progressive demux until moov, then configure the decoder.
  // -------------------------------------------------------------------------

  /** Lazily demux + configure. Resolves when ready, rejects with initError
   *  (the dispatcher falls back to the video-element tier on rejection). */
  ensureInit(): Promise<void> {
    if (this.initDone) return this.initError ? Promise.reject(this.initError) : Promise.resolve()
    if (this.initPromise) return this.initPromise
    this.initPromise = this.init()
    return this.initPromise
  }

  /** Exposed so the tier probe can read the codec before committing. */
  get resolvedCodec(): string | null {
    return this.initDone && !this.initError ? this.codec : null
  }

  private async init(): Promise<void> {
    try {
      // Dynamic import: MKV/WebM clips never load mp4box.
      const MP4Box = (await import('mp4box')) as unknown as { createFile: () => Mp4BoxFile }
      const file = MP4Box.createFile()
      this.mp4box = file

      await this.feedUntilMoov(file)

      const info = file.getInfo()
      const track = info.tracks.find((t) => t.type !== 'audio') ?? info.tracks[0]
      if (!track) throw new Error('no video track in MP4')
      this.trackId = track.id
      this.codec = track.codec
      this.w = track.track_width
      this.h = track.track_height
      this.timescale = track.timescale || 1

      // Build the pure sample table from mp4box's parsed sample info.
      const infos = file.getTrackSamplesInfo(this.trackId) ?? []
      this.samples = infos.map((s) => ({
        isSync: !!s.is_sync,
        offset: 0,
        size: s.size,
        time: s.cts / this.timescale,
        duration: (s.duration || 0) / this.timescale
      }))

      if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder unavailable')
      const supported = await VideoDecoder.isConfigSupported({ codec: this.codec })
      if (!supported.supported) throw new Error(`codec ${this.codec} not supported by VideoDecoder`)

      // Use the output-callback init pattern (works across WebCodecs versions;
      // the newer dequeue() API isn't typed in this lib version). Decoded
      // frames land in outputQueue and are drained by drainOutputs().
      this.decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          this.outputQueue.push(frame)
          this.onFrameReady()
        },
        error: (e: DOMException) => {
          this.initError = new Error(`VideoDecoder error: ${e.message}`)
        }
      })
      this.decoder.configure({ codec: this.codec })
      this.initDone = true
    } catch (e) {
      this.initError = e instanceof Error ? e : new Error('WebCodecsSource init failed')
      this.initDone = true
      throw this.initError
    }
  }

  /** Fetch the file in ranges, feeding mp4box until it signals the moov is
   *  parsed (appendBuffer returns a negative offset when done with the moov). */
  private async feedUntilMoov(file: Mp4BoxFile): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let nextOffset = 0
      let resolved = false
      const onReady = (): void => {
        if (resolved) return
        resolved = true
        resolve()
      }
      file.onready = onReady

      const fetchNext = async (): Promise<void> => {
        if (resolved) return
        let res: Response
        try {
          res = await fetch(mediaUrl(this.path), {
            headers: { Range: `bytes=${nextOffset}-${nextOffset + DEMUX_CHUNK - 1}` }
          })
        } catch (e) {
          if (!resolved) reject(e instanceof Error ? e : new Error('mp4 fetch failed'))
          return
        }
        if (!res.ok) {
          if (!resolved) reject(new Error(`mp4 fetch failed: ${res.status}`))
          return
        }
        const buf = (await res.arrayBuffer()) as Mp4Buffer
        if (buf.byteLength === 0) {
          if (!resolved) reject(new Error('mp4 ended before moov parsed'))
          return
        }
        buf.fileStart = nextOffset
        const suggest = file.appendBuffer(buf)
        nextOffset = suggest > 0 ? suggest : nextOffset + buf.byteLength
        if (!resolved) await fetchNext()
      }
      fetchNext().catch((e) => {
        if (!resolved) reject(e instanceof Error ? e : new Error('mp4 feed failed'))
      })
    })
  }

  // -------------------------------------------------------------------------
  // Decode: feed EncodedVideoChunks from the keyframe to the target.
  // -------------------------------------------------------------------------

  /** Fetch + feed the encoded bytes for samples [from, to] into the decoder. */
  private feedRange(from: number, to: number): void {
    if (!this.decoder || !this.mp4box) return
    for (let i = from; i <= to && i < this.samples.length; i++) {
      const info = this.samples[i]
      // getTrackSample pulls the sample's bytes (mp4box caches/fetches as needed).
      const s = this.mp4box.getTrackSample(this.trackId, i + 1) // mp4box samples are 1-indexed
      const chunk = new EncodedVideoChunk({
        type: info.isSync ? 'key' : 'delta',
        timestamp: Math.round(info.time * 1_000_000),
        duration: Math.round(info.duration * 1_000_000),
        data: s.data
      })
      this.decoder.decode(chunk)
    }
    this.decodeCursor = to
  }

  /** Drain decoded outputs from the callback-fed queue, keeping the one
   *  closest to the requested time and closing the rest (bounded memory). */
  private drainOutputs(): void {
    while (this.outputQueue.length > 0) {
      const out = this.outputQueue.shift() as VideoFrame
      // Keep the frame closest to the requested time; close the rest.
      if (this.isCloser(out, this.current)) {
        this.current?.close()
        this.current = out
      } else {
        out.close()
      }
      // If we've reached/passed the requested time during scrub, stop draining.
      if (!this.playing && out.timestamp / 1_000_000 >= this.requestedTime) break
    }
    this.onFrameReady()
  }

  /** Is `candidate` closer to the requested time than `current`? */
  private isCloser(candidate: VideoFrame, current: VideoFrame | null): boolean {
    const ct = candidate.timestamp / 1_000_000
    if (!current) return ct <= this.requestedTime + 1 / 30 || true
    const curT = current.timestamp / 1_000_000
    return Math.abs(ct - this.requestedTime) < Math.abs(curT - this.requestedTime)
  }

  // -------------------------------------------------------------------------
  // VideoSource interface.
  // -------------------------------------------------------------------------

  requestTime(srcTime: number, playing: boolean, _speed = 1): void {
    this.wantedThisFrame = true
    this.requestedTime = srcTime
    this.playing = playing
    void this.ensureInit()
      .then(() => this.scheduleDecode(srcTime, playing))
      .catch(() => {
        /* init failed; the dispatcher falls back. Swallow here. */
      })
  }

  private scheduleDecode(srcTime: number, playing: boolean): void {
    if (!this.decoder || this.samples.length === 0) return
    const targetIdx = this.sampleAtOrBefore(srcTime)
    if (playing) {
      // Continuous: if the decode cursor is already near the target, just top
      // up the lookahead buffer; otherwise restart from the keyframe.
      const start = this.decodeCursor >= 0 && targetIdx - this.decodeCursor < LOOKAHEAD_FRAMES
        ? this.decodeCursor + 1
        : findKeyframeBefore(this.samples, srcTime)
      const end = Math.min(this.samples.length - 1, targetIdx + LOOKAHEAD_FRAMES)
      if (end >= start) this.feedRange(start, end)
    } else {
      // Scrub: restart from the keyframe before the target, decode just to it.
      this.decoder.reset()
      this.decoder.configure({ codec: this.codec })
      const keyIdx = findKeyframeBefore(this.samples, srcTime)
      this.decodeCursor = -1
      if (targetIdx >= keyIdx) this.feedRange(keyIdx, targetIdx)
    }
    this.drainOutputs()
  }

  /** Index of the sample at or before a time. */
  private sampleAtOrBefore(time: number): number {
    let idx = 0
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].time <= time) idx = i
      else break
    }
    return idx
  }

  async seekTo(srcTime: number): Promise<void> {
    await this.ensureInit().catch(() => undefined)
    if (!this.decoder) return
    this.requestedTime = srcTime
    this.playing = false
    this.decoder.reset()
    this.decoder.configure({ codec: this.codec })
    this.current?.close()
    this.current = null
    this.decodeCursor = -1
    const keyIdx = findKeyframeBefore(this.samples, srcTime)
    const targetIdx = this.sampleAtOrBefore(srcTime)
    if (targetIdx >= keyIdx) this.feedRange(keyIdx, targetIdx)

    // Wait for the target frame to land (or time out).
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + SEEK_TIMEOUT_MS
      const check = (): void => {
        this.drainOutputs()
        const t = this.current?.timestamp ?? -1
        if ((t >= 0 && t / 1_000_000 >= srcTime - 1 / 30) || Date.now() > deadline || this.initError) resolve()
        else setTimeout(check, 16)
      }
      check()
    })
  }

  getElement(): HTMLVideoElement | null {
    return null // WebCodecs path has no <video> element
  }

  endFrame(): void {
    this.wantedThisFrame = false
  }

  dispose(): void {
    this.current?.close()
    this.current = null
    try {
      this.decoder?.close()
    } catch {
      /* already closed */
    }
    this.decoder = null
    this.mp4box = null
    this.samples = []
    for (const f of this.outputQueue) f.close()
    this.outputQueue = []
  }
}
