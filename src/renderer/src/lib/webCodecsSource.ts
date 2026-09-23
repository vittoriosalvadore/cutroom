import type { VideoSource, FrameSource } from './videoSource'
import {
  findKeyframeBefore,
  findSampleAtOrBefore,
  parseContentRangeTotal,
  presentationOffsetSec,
  sampleByteSpan,
  TIME_EPSILON_SEC,
  type EditListEntry,
  type SampleEntry
} from './sampleTable'
import { hasDisplayRotation } from './videoTier'
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
//             (including the target) is guaranteed to be emitted. Skipped
//             when that exact frame is already shown or being decoded.
//   play   -> feed forward continuously, keeping up to LOOKAHEAD_FRAMES
//             decoded frames ahead of the playhead in `ahead`; frames are
//             promoted to `current` as the playhead reaches them. A backward
//             jump restarts from the target's keyframe; the last sample is
//             followed by a flush() so the reorder tail comes out.
// Every reset starts a new decode pass (feedGen). `current` normally only
// moves forward; it moves BACK only when it is past the requested time (see
// offerCurrent), so a backward scrub/jump can't freeze on a stale later frame.
//
// Eviction: a decoded VideoFrame holds GPU/memory until .close(). We hold the
// current frame + the bounded ahead ring; everything superseded is closed the
// moment it's replaced. Scrub/seek/dispose close the whole ring.
//
// Sample times are on the PRESENTATION timeline (edit list applied, see
// presentationOffsetSec), so t=0 is the first frame the <video> element shows.
// ---------------------------------------------------------------------------

const LOOKAHEAD_FRAMES = 6
/** Fetch chunk size while progressively feeding mp4box until the moov is found. */
const DEMUX_CHUNK = 1024 * 1024
/** SeekTo gives up after this (a stuck decoder shouldn't hang export). */
const SEEK_TIMEOUT_MS = 4000
/** Presentation-time slack when matching a frame to the playhead while
 *  PLAYING (rAF jitter). Paused/export matching is exact (TIME_EPSILON_SEC). */
const FRAME_SLACK_SEC = 1 / 60
/** Decoder errors we recover from (recreate + reconfigure) before giving up
 *  and reporting decodeFailed, which makes the pool demote to the element tier. */
const MAX_DECODE_ERRORS = 3

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
  movie_timescale?: number
  type?: string
  /** tkhd display matrix (rotation/mirroring for phone footage). */
  matrix?: ArrayLike<number>
  /** elst entries, when the track has an edit list. */
  edits?: EditListEntry[]
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
  /** feedGen of the decode pass that produced `current`. */
  private currentGen = -1
  /** Backward scrub: the best frame (<= target) of the new pass, held back
   *  until that pass's flush completes so the GOP's leading frames don't flash
   *  on screen. Committed to `current` by commitPending(). */
  private pendingBack: VideoFrame | null = null
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
  /** Earliest presentation time in the table; requests before it show it. */
  private firstTime = 0
  /** The last decode-order sample index fed to the decoder in play mode. */
  private decodeCursor = -1
  /** Bumped whenever the decoder is reset (scrub/seek/play restart/error) to
   *  invalidate any in-flight feed. Doubles as the decode-pass generation. */
  private feedGen = 0
  /** feedGen of the play-mode feed batch in flight, or -1 (don't start another). */
  private playFeedGen = -1
  /** True while the decoder holds a continuous play-mode feed that can be
   *  extended from decodeCursor (false after any reset or scrub/seek flush —
   *  the decoder then needs a keyframe first). */
  private playPrimed = false
  /** Keyframe index the current play pass started from. */
  private playOriginKey = 0
  /** Target sample + generation of the last scrub/seek, so repeated paused
   *  requests for the same frame don't reset and re-decode the GOP. */
  private scrubIdx = -1
  private scrubGen = -1
  private decodeErrors = 0
  private failed = false

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

  /** True once the decoder failed past MAX_DECODE_ERRORS; the pool then
   *  demotes this clip to the video-element tier. */
  get decodeFailed(): boolean {
    return this.failed
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
      // VideoFrames come out un-rotated; the element tier honors the matrix.
      if (hasDisplayRotation(track.matrix)) throw new Error('rotated/mirrored track: keeping the video-element tier')
      this.codec = track.codec
      this.w = track.track_width
      this.h = track.track_height
      const timescale = track.timescale || 1

      // Sample table with REAL byte offsets — sample data is Range-fetched
      // directly from disk, never routed through mp4box's buffers. Times are
      // shifted onto the presentation timeline (edit list / composition
      // offset), matching what the <video> element and the audio play.
      const infos = file.getTrackSamplesInfo(track.id) ?? []
      let minCts = Infinity
      for (const s of infos) minCts = Math.min(minCts, s.cts)
      const offset = presentationOffsetSec(track.edits, minCts, timescale, track.movie_timescale ?? timescale)
      this.samples = infos.map((s) => ({
        isSync: !!s.is_sync,
        offset: s.offset,
        size: s.size,
        time: s.cts / timescale - offset,
        duration: (s.duration || 0) / timescale
      }))
      if (this.samples.length === 0) throw new Error('MP4 has no video samples')
      this.firstTime = Infinity
      for (const s of this.samples) this.firstTime = Math.min(this.firstTime, s.time)

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

      this.decoder = this.makeDecoder(config)
      this.initDone = true
    } catch (e) {
      this.initError = e instanceof Error ? e : new Error('WebCodecsSource init failed')
      this.initDone = true
      throw this.initError
    }
  }

  /** A configured decoder whose callbacks ignore it once it's been replaced
   *  (error recovery) — stale outputs are closed, stale errors dropped. */
  private makeDecoder(config: VideoDecoderConfig): VideoDecoder {
    const dec: VideoDecoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (dec === this.decoder) this.onDecodedFrame(frame)
        else frame.close()
      },
      error: (e: DOMException) => {
        if (dec === this.decoder) this.onDecoderError(e)
      }
    })
    dec.configure(config)
    return dec
  }

  /** The decoder closes itself on error; every later call would throw and the
   *  clip would freeze. Recreate it (bounded) and re-drive the last request —
   *  nothing else will while paused. Past the cap, report decodeFailed and
   *  signal so the pool demotes this clip to the element tier. */
  private onDecoderError(e: DOMException): void {
    console.warn('[cutroom] VideoDecoder error:', e.message)
    this.feedGen++ // abort in-flight feeds of the dead decoder
    this.closeAhead()
    this.dropPending()
    this.decodeCursor = -1
    this.playPrimed = false
    this.playFeedGen = -1
    this.decodeErrors++
    if (this.decodeErrors <= MAX_DECODE_ERRORS && this.decoderConfig) {
      try {
        this.decoder = this.makeDecoder(this.decoderConfig)
        if (this.playing) this.topUpPlayback(this.requestedTime, true)
        else this.scrubTo(this.requestedTime)
        return
      } catch {
        /* fall through to failed */
      }
    }
    this.failed = true
    this.decoder = null
    this.onFrameReady()
  }

  /** Fetch the file in ranges, feeding mp4box until the moov is parsed. Stops
   *  at EOF: a truncated file (no moov) makes mp4box ask for offsets past the
   *  end forever otherwise. */
  private async feedUntilMoov(file: Mp4BoxFile): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let nextOffset = 0
      /** File size once known: from Content-Range, or from a short read. */
      let knownSize = Infinity
      let resolved = false
      file.onready = () => {
        if (resolved) return
        resolved = true
        resolve()
      }

      const fetchNext = async (): Promise<void> => {
        if (resolved) return
        if (nextOffset >= knownSize) {
          reject(new Error('mp4 ended before moov parsed'))
          return
        }
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
        const total = parseContentRangeTotal(res.headers.get('Content-Range'))
        if (total !== null) knownSize = total
        const buf = (await res.arrayBuffer()) as Mp4Buffer
        if (buf.byteLength === 0) {
          if (!resolved) reject(new Error('mp4 ended before moov parsed'))
          return
        }
        // A short read means EOF (the header may not be exposed to fetch); a
        // 200 means the server ignored Range and sent the whole file.
        if (res.status === 200) knownSize = Math.min(knownSize, buf.byteLength)
        else if (buf.byteLength < DEMUX_CHUNK) knownSize = Math.min(knownSize, nextOffset + buf.byteLength)
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

  /** Latest presentation time (s) a frame may have to be shown for the current
   *  request. A request before the first frame shows the first frame. */
  private showLimit(): number {
    return Math.max(this.requestedTime, this.firstTime) + (this.playing ? FRAME_SLACK_SEC : TIME_EPSILON_SEC)
  }

  /** Chunk/frame timestamp (µs) of a decode-order sample. */
  private sampleTs(idx: number): number {
    return Math.round(this.samples[idx].time * 1_000_000)
  }

  /** True when `current` is exactly the frame of decode-order sample `idx`. */
  private holds(idx: number): boolean {
    return !!this.current && idx >= 0 && idx < this.samples.length && this.current.timestamp === this.sampleTs(idx)
  }

  /** Replace `current`. Returns true only when the DISPLAYED frame changed (a
   *  re-decode of the same timestamp must not trigger another render, or a
   *  paused render -> requestTime -> decode cycle would never settle). */
  private setCurrent(frame: VideoFrame, gen: number): boolean {
    const changed = !this.current || this.current.timestamp !== frame.timestamp
    this.current?.close()
    this.current = frame
    this.currentGen = gen
    return changed
  }

  /** Offer a frame (<= showLimit) for `current`. Normally only forward
   *  progress is accepted (the latest frame at/before the playhead wins). A
   *  frame BEHIND current is wanted only when current is itself past the
   *  playhead (backward scrub/jump): shown at once while playing, else held in
   *  pendingBack until the scrub's flush finishes. Returns "display changed". */
  private offerCurrent(frame: VideoFrame, gen: number): boolean {
    const cur = this.current
    if (cur && frame.timestamp < cur.timestamp) {
      if (cur.timestamp / 1_000_000 <= this.showLimit()) {
        frame.close() // current is already a valid, later frame
        return false
      }
      if (this.playing) return this.setCurrent(frame, gen)
      if (!this.pendingBack || frame.timestamp >= this.pendingBack.timestamp) {
        this.pendingBack?.close()
        this.pendingBack = frame
      } else {
        frame.close()
      }
      return false
    }
    this.dropPending() // superseded by forward progress
    return this.setCurrent(frame, gen)
  }

  /** A scrub's flush finished: show its held-back target frame. */
  private commitPending(gen: number): void {
    if (gen !== this.feedGen || !this.pendingBack) return
    const f = this.pendingBack
    this.pendingBack = null
    if (this.setCurrent(f, gen)) this.onFrameReady()
  }

  private dropPending(): void {
    this.pendingBack?.close()
    this.pendingBack = null
  }

  private onDecodedFrame(frame: VideoFrame): void {
    const t = frame.timestamp / 1_000_000
    if (t <= this.showLimit()) {
      if (this.offerCurrent(frame, this.feedGen)) this.onFrameReady()
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

  /** Move buffered ahead-frames into `current` as the playhead reaches them.
   *  Deliberately does NOT call onFrameReady: it runs inside requestTime(),
   *  i.e. inside the compositor's render pass, which reads `frame` right after
   *  — signalling here would start a nested render (double-drawn layers). */
  private promote(): void {
    const limit = this.showLimit()
    while (this.ahead.length > 0 && this.ahead[0].timestamp / 1_000_000 <= limit) {
      this.offerCurrent(this.ahead.shift() as VideoFrame, this.feedGen)
    }
  }

  private closeAhead(): void {
    for (const f of this.ahead) f.close()
    this.ahead = []
  }

  /** Reset + reconfigure the decoder for a new decode pass and drop every
   *  buffered frame of the old one. Returns the new generation. */
  private restartDecoder(): number {
    const gen = ++this.feedGen
    this.closeAhead()
    this.dropPending()
    this.decodeCursor = -1
    this.playPrimed = false
    const dec = this.decoder
    if (dec && dec.state !== 'closed') {
      dec.reset()
      if (this.decoderConfig) dec.configure(this.decoderConfig)
    }
    return gen
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
    if (this.failed) return
    void this.ensureInit()
      .then(() => {
        // Skip requests superseded before init/microtask resolution.
        if (playing && this.playing) this.topUpPlayback(srcTime, !wasPlaying)
        else if (!playing && !this.playing && srcTime === this.requestedTime) this.scrubTo(srcTime)
      })
      .catch(() => {
        /* init failed; the dispatcher never upgraded us. Nothing to do. */
      })
  }

  /** Play mode: keep the decode cursor LOOKAHEAD_FRAMES ahead of the playhead,
   *  restarting from a keyframe when playback (re)starts, the decoder isn't
   *  primed for continuation, or the playhead jumped (forward past the
   *  lookahead, or BACKWARD — frames already passed are never re-emitted). */
  private topUpPlayback(srcTime: number, justStarted: boolean): void {
    if (!this.decoder || this.samples.length === 0 || this.failed) return
    const targetIdx = findSampleAtOrBefore(this.samples, srcTime)
    const keyIdx = findKeyframeBefore(this.samples, srcTime)
    const inFlight = this.playFeedGen === this.feedGen
    const backward =
      keyIdx < this.playOriginKey ||
      (!!this.current && this.currentGen === this.feedGen && this.current.timestamp / 1_000_000 > this.showLimit())
    const behind = !inFlight && (this.decodeCursor < 0 || this.decodeCursor < targetIdx - LOOKAHEAD_FRAMES * 2)
    if (justStarted || !this.playPrimed || backward || behind) {
      // An in-flight feed of the old pass aborts on its generation check.
      const gen = this.restartDecoder()
      this.playPrimed = true
      this.playOriginKey = keyIdx
      this.startPlayFeed(keyIdx, Math.min(this.samples.length - 1, targetIdx + LOOKAHEAD_FRAMES), gen)
      return
    }
    if (inFlight) return
    const wantThrough = Math.min(this.samples.length - 1, targetIdx + LOOKAHEAD_FRAMES)
    if (this.decodeCursor >= wantThrough) return // buffer already full enough
    this.startPlayFeed(this.decodeCursor + 1, wantThrough, this.feedGen)
  }

  private startPlayFeed(from: number, to: number, gen: number): void {
    if (from > to) return
    this.playFeedGen = gen
    // Flush once the LAST sample is fed: the decoder holds its reorder tail
    // until more input or a flush, so the final frames would never appear.
    const atEnd = to >= this.samples.length - 1
    void this.feedRange(from, to, gen, atEnd)
      .catch(() => undefined)
      .finally(() => {
        if (this.playFeedGen === gen) this.playFeedGen = -1
      })
  }

  /** Scrub: decode exactly keyframe..target and flush so the target emits.
   *  A no-op when that exact frame is already shown or already being decoded
   *  (paused re-renders call this every time). */
  private scrubTo(srcTime: number): void {
    if (!this.decoder || this.samples.length === 0 || this.failed) return
    const targetIdx = findSampleAtOrBefore(this.samples, srcTime)
    if (targetIdx === this.scrubIdx && this.scrubGen === this.feedGen) return
    if (this.holds(targetIdx)) {
      // Already showing it (e.g. paused on a frame play just promoted, or
      // renderExact right after seekTo). Only reset if another pass is in
      // flight, so it can't land a different frame afterwards.
      if (this.playFeedGen === this.feedGen || this.scrubGen === this.feedGen) this.restartDecoder()
      this.scrubIdx = targetIdx
      this.scrubGen = this.feedGen
      return
    }
    const gen = this.restartDecoder()
    this.scrubIdx = targetIdx
    this.scrubGen = gen
    const keyIdx = findKeyframeBefore(this.samples, srcTime)
    if (targetIdx < keyIdx) return
    void this.feedRange(keyIdx, targetIdx, gen, true)
      .then(() => this.commitPending(gen))
      .catch(() => undefined)
  }

  async seekTo(srcTime: number): Promise<void> {
    await this.ensureInit().catch(() => undefined)
    if (!this.decoder || this.samples.length === 0 || this.failed) return
    this.requestedTime = srcTime
    this.playing = false
    const targetIdx = findSampleAtOrBefore(this.samples, srcTime)
    // Same frame as last time (e.g. 60fps export of a 30fps clip): done.
    if (this.holds(targetIdx) && this.playFeedGen !== this.feedGen) {
      this.scrubIdx = targetIdx
      this.scrubGen = this.feedGen
      return
    }
    const gen = this.restartDecoder()
    this.current?.close()
    this.current = null
    this.scrubIdx = targetIdx
    this.scrubGen = gen

    const keyIdx = findKeyframeBefore(this.samples, srcTime)
    const deadline = Date.now() + SEEK_TIMEOUT_MS
    if (targetIdx >= keyIdx) {
      // feedRange flushes, so by the time it resolves every decodable frame
      // (including the target) has been through onDecodedFrame.
      await this.feedRange(keyIdx, targetIdx, gen, true).catch(() => undefined)
    }
    // Backstop only — flush() above makes this resolve immediately in practice.
    // (Also covers decoder-error recovery, which re-drives the same request.)
    while (!this.current && Date.now() < deadline && !this.failed && this.requestedTime === srcTime) {
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
    this.dropPending()
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
