import type { VideoSource, FrameSource } from './videoSource'
import { findKeyframeBefore, findSampleAtOrBefore, sampleByteSpan, type SampleEntry } from './sampleTable'
import { mediaUrl } from './media'

// ---------------------------------------------------------------------------
// The WebCodecs decode tier: frame-precise, stutter-free decode for MP4/MOV.
//
// Pipeline:
//   mp4box.js demux (moov only, for metadata) -> per-sample Range fetches ->
//   EncodedVideoChunk -> VideoDecoder -> VideoFrame -> compositor texture.
//
// mp4box is used ONLY to parse the moov (sample table + codec + avcC/hvcC
// decoder description) and is released right after init. Sample BYTES are
// fetched on demand with HTTP Range requests against the cutroom:// protocol
// (which serves 206 partial content from local disk) — mp4box has no network
// access of its own, so routing sample data through it would only work for
// bytes that happened to be prefetched.
//
// Decode strategy (set by the `playing` flag in requestTime()):
//   scrub  -> reset the decoder, feed keyframe..target, flush() so the tail
//             (including the target) is guaranteed to be emitted.
//   play   -> feed forward continuously, keeping up to LOOKAHEAD_FRAMES
//             decoded frames ahead of the playhead in `ahead`; frames are
//             promoted to `current` as the playhead reaches them.
//
// Eviction: a decoded VideoFrame holds GPU/memory until .close(). We hold the
// current frame + the bounded ahead ring; everything superseded is closed the
// moment it's replaced. Scrub/seek/dispose close the whole ring.
// ---------------------------------------------------------------------------

const LOOKAHEAD_FRAMES = 6
/** Fetch chunk size while progressively feeding mp4box until the moov is found. */
const DEMUX_CHUNK = 1024 * 1024
/** SeekTo gives up after this (a stuck decoder shouldn't hang export). */
const SEEK_TIMEOUT_MS = 4000
/** Presentation-time slack when matching a frame to the requested time. */
const FRAME_SLACK_SEC = 1 / 60

/** The mp4box.js file object. Typed loosely — only what init() touches. */
interface Mp4BoxFile {
  appendBuffer(buf: ArrayBuffer): number
  getInfo(): { tracks: Mp4Track[] }
  getTrackSamplesInfo(trackId: number): Mp4SampleInfo[]
  getTrackById(trackId: number): Mp4Trak
  onready?: () => void
}
interface Mp4Track {
  id: number
  codec: string
  track_width: number
  track_height: number
  timescale: number
  type?: string
}
interface Mp4SampleInfo {
  size: number
  offset: number
  cts: number
  duration: number
  is_sync: boolean
}
/** The raw trak box tree, walked only to find the codec-description box. */
interface Mp4Trak {
  mdia?: {
    minf?: {
      stbl?: {
        stsd?: {
          entries?: Array<Record<string, { write(stream: unknown): void } | undefined>>
        }
      }
    }
  }
}
interface Mp4BoxModule {
  createFile: () => Mp4BoxFile
  DataStream: {
    new (buf?: unknown, byteOffset?: number, endianness?: boolean): { buffer: ArrayBuffer }
    BIG_ENDIAN: boolean
  }
}

/** Augment ArrayBuffer for mp4box's required fileStart field. */
interface Mp4Buffer extends ArrayBuffer {
  fileStart: number
}

export class WebCodecsSource implements VideoSource {
  private decoder: VideoDecoder | null = null
  private decoderConfig: VideoDecoderConfig | null = null
  private codec = ''
  private samples: SampleEntry[] = []
  /** The frame the compositor is currently showing. */
  private current: VideoFrame | null = null
  /** Decoded frames whose presentation time is still ahead of the playhead,
   *  sorted by timestamp ascending. Bounded; promoted into `current` as the
   *  requested time reaches them. */
  private ahead: VideoFrame[] = []
  /** Source time (seconds) of the most recent requestTime/seekTo. */
  private requestedTime = 0
  private playing = false
  private w = 0
  private h = 0
  private initError: Error | null = null
  private initDone = false
  private initPromise: Promise<void> | null = null
  /** The last decode-order sample index fed to the decoder in play mode. */
  private decodeCursor = -1
  /** Bumped by scrub/seek to invalidate any in-flight feed. */
  private feedGen = 0
  /** True while a play-mode feed batch is in flight (don't start another). */
  private playFeedInFlight = false

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
   *  (the dispatcher keeps the video-element tier on rejection). */
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
      // Dynamic import: clips on the video-element tier never load mp4box.
      const MP4Box = (await import('mp4box')) as unknown as Mp4BoxModule
      const file = MP4Box.createFile()

      await this.feedUntilMoov(file)

      const info = file.getInfo()
      const track = info.tracks.find((t) => t.type === 'video') ?? info.tracks.find((t) => t.type !== 'audio')
      if (!track) throw new Error('no video track in MP4')
      this.codec = track.codec
      this.w = track.track_width
      this.h = track.track_height
      const timescale = track.timescale || 1

      // Sample table with REAL byte offsets — sample data is Range-fetched
      // directly from disk, never routed through mp4box's buffers.
      const infos = file.getTrackSamplesInfo(track.id) ?? []
      this.samples = infos.map((s) => ({
        isSync: !!s.is_sync,
        offset: s.offset,
        size: s.size,
        time: s.cts / timescale,
        duration: (s.duration || 0) / timescale
      }))
      if (this.samples.length === 0) throw new Error('MP4 has no video samples')

      // AVC/HEVC in MP4 store length-prefixed NALs; VideoDecoder REQUIRES the
      // avcC/hvcC extradata as `description` to decode them. Without it the
      // decoder expects Annex-B and errors on the first chunk.
      const description = extractDescription(MP4Box, file, track.id)
      const needsDescription = /^(avc|hvc|hev)/i.test(this.codec)
      if (needsDescription && !description) {
        throw new Error(`could not extract decoder description for ${this.codec}`)
      }

      if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder unavailable')
      const config: VideoDecoderConfig = description ? { codec: this.codec, description } : { codec: this.codec }
      const supported = await VideoDecoder.isConfigSupported(config)
      if (!supported.supported) throw new Error(`codec ${this.codec} not supported by VideoDecoder`)
      this.decoderConfig = config

      this.decoder = new VideoDecoder({
        output: (frame: VideoFrame) => this.onDecodedFrame(frame),
        error: (e: DOMException) => {
          this.initError = new Error(`VideoDecoder error: ${e.message}`)
        }
      })
      this.decoder.configure(config)
      this.initDone = true
    } catch (e) {
      this.initError = e instanceof Error ? e : new Error('WebCodecsSource init failed')
      this.initDone = true
      throw this.initError
    }
  }

  /** Fetch the file in ranges, feeding mp4box until the moov is parsed. */
  private async feedUntilMoov(file: Mp4BoxFile): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let nextOffset = 0
      let resolved = false
      file.onready = () => {
        if (resolved) return
        resolved = true
        resolve()
      }

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
  // Decoded-frame bookkeeping: current + a bounded lookahead ring.
  // -------------------------------------------------------------------------

  private onDecodedFrame(frame: VideoFrame): void {
    const t = frame.timestamp / 1_000_000
    if (t <= this.requestedTime + FRAME_SLACK_SEC) {
      // At or before the playhead: keep the LATEST such frame as current.
      if (!this.current || frame.timestamp >= this.current.timestamp) {
        this.current?.close()
        this.current = frame
        this.onFrameReady()
      } else {
        frame.close()
      }
    } else if (this.playing) {
      // Ahead of the playhead while playing: buffer it (sorted, bounded).
      let at = this.ahead.length
      while (at > 0 && this.ahead[at - 1].timestamp > frame.timestamp) at--
      this.ahead.splice(at, 0, frame)
      while (this.ahead.length > LOOKAHEAD_FRAMES * 2) {
        this.ahead.pop()?.close() // drop the farthest-future frame
      }
      // A first frame is better than nothing while waiting to reach it.
      if (!this.current) this.onFrameReady()
    } else {
      frame.close() // scrub overshoot (a B-frame past the target) — not needed
    }
  }

  /** Move buffered ahead-frames into `current` as the playhead reaches them. */
  private promote(): void {
    let changed = false
    while (this.ahead.length > 0 && this.ahead[0].timestamp / 1_000_000 <= this.requestedTime + FRAME_SLACK_SEC) {
      const f = this.ahead.shift() as VideoFrame
      if (!this.current || f.timestamp >= this.current.timestamp) {
        this.current?.close()
        this.current = f
        changed = true
      } else {
        f.close()
      }
    }
    if (changed) this.onFrameReady()
  }

  private closeAhead(): void {
    for (const f of this.ahead) f.close()
    this.ahead = []
  }

  // -------------------------------------------------------------------------
  // Feeding: Range-fetch sample bytes, decode, flush when a batch must finish.
  // -------------------------------------------------------------------------

  /** Fetch the raw bytes for decode-order samples [from, to] in ONE Range
   *  request, sliced per sample. Falls back correctly if the server ignores
   *  Range and returns the whole file (status 200). */
  private async fetchSampleBytes(from: number, to: number): Promise<Uint8Array[] | null> {
    const span = sampleByteSpan(this.samples, from, to)
    if (!span) return null
    const res = await fetch(mediaUrl(this.path), {
      headers: { Range: `bytes=${span.start}-${span.end - 1}` }
    })
    if (!res.ok) throw new Error(`sample fetch failed: ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const base = res.status === 206 ? span.start : 0 // 200 = whole file came back
    const out: Uint8Array[] = []
    for (let i = from; i <= to; i++) {
      const s = this.samples[i]
      const lo = s.offset - base
      if (lo < 0 || lo + s.size > buf.byteLength) throw new Error('sample bytes out of fetched range')
      out.push(buf.subarray(lo, lo + s.size))
    }
    return out
  }

  /** Feed decode-order samples [from, to]; `flushAfter` forces the decoder to
   *  emit every pending frame (required for scrub/seek so the target frame is
   *  guaranteed to come out — decoders hold tail frames until more input or a
   *  flush arrives). Aborts silently if a newer scrub/seek superseded us. */
  private async feedRange(from: number, to: number, gen: number, flushAfter: boolean): Promise<void> {
    if (!this.decoder) return
    const bytes = await this.fetchSampleBytes(from, to)
    if (!bytes || gen !== this.feedGen || !this.decoder) return
    for (let i = from; i <= to; i++) {
      const info = this.samples[i]
      this.decoder.decode(
        new EncodedVideoChunk({
          type: info.isSync ? 'key' : 'delta',
          timestamp: Math.round(info.time * 1_000_000),
          duration: Math.round(info.duration * 1_000_000),
          data: bytes[i - from]
        })
      )
    }
    this.decodeCursor = to
    if (flushAfter) {
      // flush() rejects if reset() lands first (a newer scrub) — that's fine.
      await this.decoder.flush().catch(() => undefined)
    }
  }

  // -------------------------------------------------------------------------
  // VideoSource interface.
  // -------------------------------------------------------------------------

  requestTime(srcTime: number, playing: boolean, _speed = 1): void {
    const wasPlaying = this.playing
    this.requestedTime = srcTime
    this.playing = playing
    this.promote()
    void this.ensureInit()
      .then(() => {
        if (playing) this.topUpPlayback(srcTime, !wasPlaying)
        else this.scrubTo(srcTime)
      })
      .catch(() => {
        /* init failed; the dispatcher never upgraded us. Nothing to do. */
      })
  }

  /** Play mode: keep the decode cursor LOOKAHEAD_FRAMES ahead of the playhead,
   *  restarting from a keyframe only when the playhead jumped. */
  private topUpPlayback(srcTime: number, justStarted: boolean): void {
    if (!this.decoder || this.samples.length === 0 || this.playFeedInFlight) return
    const targetIdx = findSampleAtOrBefore(this.samples, srcTime)
    const behind = this.decodeCursor < 0 || this.decodeCursor < targetIdx - LOOKAHEAD_FRAMES * 2
    const needsRestart = justStarted || behind
    let from: number
    if (needsRestart) {
      const gen = ++this.feedGen
      this.decoder.reset()
      if (this.decoderConfig) this.decoder.configure(this.decoderConfig)
      this.closeAhead()
      from = findKeyframeBefore(this.samples, srcTime)
      this.startPlayFeed(from, Math.min(this.samples.length - 1, targetIdx + LOOKAHEAD_FRAMES), gen)
      return
    }
    const wantThrough = Math.min(this.samples.length - 1, targetIdx + LOOKAHEAD_FRAMES)
    if (this.decodeCursor >= wantThrough) return // buffer already full enough
    this.startPlayFeed(this.decodeCursor + 1, wantThrough, this.feedGen)
  }

  private startPlayFeed(from: number, to: number, gen: number): void {
    if (from > to) return
    this.playFeedInFlight = true
    void this.feedRange(from, to, gen, false)
      .catch(() => undefined)
      .finally(() => {
        this.playFeedInFlight = false
      })
  }

  /** Scrub: decode exactly keyframe..target and flush so the target emits. */
  private scrubTo(srcTime: number): void {
    if (!this.decoder || this.samples.length === 0) return
    const gen = ++this.feedGen
    this.decoder.reset()
    if (this.decoderConfig) this.decoder.configure(this.decoderConfig)
    this.closeAhead()
    this.decodeCursor = -1
    const keyIdx = findKeyframeBefore(this.samples, srcTime)
    const targetIdx = findSampleAtOrBefore(this.samples, srcTime)
    if (targetIdx < keyIdx) return
    void this.feedRange(keyIdx, targetIdx, gen, true).catch(() => undefined)
  }

  async seekTo(srcTime: number): Promise<void> {
    await this.ensureInit().catch(() => undefined)
    if (!this.decoder || this.samples.length === 0) return
    const gen = ++this.feedGen
    this.requestedTime = srcTime
    this.playing = false
    this.decoder.reset()
    if (this.decoderConfig) this.decoder.configure(this.decoderConfig)
    this.closeAhead()
    this.current?.close()
    this.current = null
    this.decodeCursor = -1

    const keyIdx = findKeyframeBefore(this.samples, srcTime)
    const targetIdx = findSampleAtOrBefore(this.samples, srcTime)
    const deadline = Date.now() + SEEK_TIMEOUT_MS
    if (targetIdx >= keyIdx) {
      // feedRange flushes, so by the time it resolves every decodable frame
      // (including the target) has been through onDecodedFrame.
      await this.feedRange(keyIdx, targetIdx, gen, true).catch(() => undefined)
    }
    // Backstop only — flush() above makes this resolve immediately in practice.
    while (!this.current && Date.now() < deadline && !this.initError && gen === this.feedGen) {
      await new Promise((r) => setTimeout(r, 16))
    }
  }

  getElement(): HTMLVideoElement | null {
    return null // WebCodecs path has no <video> element (audio uses a companion)
  }

  endFrame(): void {
    /* nothing to pause — decode only runs when requested */
  }

  dispose(): void {
    this.feedGen++
    this.closeAhead()
    this.current?.close()
    this.current = null
    try {
      this.decoder?.close()
    } catch {
      /* already closed */
    }
    this.decoder = null
    this.samples = []
  }
}

/** Extract the codec description (avcC/hvcC/vpcC/av1C extradata) from the
 *  track's sample-description box — VideoDecoder needs it for AVC/HEVC MP4s.
 *  Returns undefined when the entry has none (VP9/AV1 usually work without). */
function extractDescription(MP4Box: Mp4BoxModule, file: Mp4BoxFile, trackId: number): Uint8Array | undefined {
  try {
    const trak = file.getTrackById(trackId)
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
    for (const entry of entries) {
      const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
      if (box) {
        const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
        box.write(stream)
        return new Uint8Array(stream.buffer, 8) // strip the 8-byte box header
      }
    }
  } catch {
    /* fall through — caller decides whether a missing description is fatal */
  }
  return undefined
}
