// ---------------------------------------------------------------------------
// The decode-tier abstraction. The compositor asks a VideoSource for "the
// current frame at this source time" and does not care whether it came from a
// <video> element (the legacy/fallback path) or a WebCodecs VideoDecoder (the
// frame-precise path). Both HTMLVideoElement and VideoFrame are valid
// texImage2D sources, so the compositor's existing texture upload already
// accepts either — this interface just formalizes the union.
// ---------------------------------------------------------------------------

/** Anything texImage2D can sample as a video source. */
export type FrameSource = HTMLVideoElement | VideoFrame

export interface VideoSource {
  /** The current decoded frame, or null while the first frame is still decoding. */
  readonly frame: FrameSource | null
  readonly width: number
  readonly height: number
  /** Advance to / seek to this source time. Drives decode for the next frame.
   *  `playing` switches strategy: on-demand single frame when scrubbing, a
   *  lookahead buffer when playing. */
  requestTime(srcTime: number, playing: boolean, speed: number): void
  /** Seek to an exact time and resolve once the frame is ready (export path). */
  seekTo(srcTime: number): Promise<void>
  /** The underlying <video> element, if this source is the legacy path (the
   *  audio engine taps it for video-clip audio). Null for the WebCodecs path. */
  getElement(): HTMLVideoElement | null
  /** Called after every render pass so the source can pause unused decoders. */
  endFrame(): void
  dispose(): void
}
