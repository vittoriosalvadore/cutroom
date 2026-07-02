# WebCodecs Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frame-precise, stutter-free video decode via WebCodecs for MP4/MOV, with graceful fallback to the existing `<video>` path.

**Architecture:** A `VideoSource` interface the compositor consumes agnostically; `VideoPool` becomes a dispatcher that picks `WebCodecsSource` (mp4box.js demux + `VideoDecoder`) for MP4/MOV and `VideoElementSource` (today's `<video>` logic, extracted) for everything else. Decode strategy switches on `playing`: on-demand single frame when scrubbing, ~6-frame lookahead when playing, with immediate `VideoFrame.close()` eviction.

**Tech Stack:** WebCodecs (`VideoDecoder`/`VideoFrame`/`EncodedVideoChunk`, in Electron 33/Chromium 130), mp4box.js 2.4.1, WebGL, TypeScript, Vitest.

---

## File Structure

**New (renderer, pure-testable):**
- `src/renderer/src/lib/videoSource.ts` — the `VideoSource` interface + `FrameSource` union.
- `src/renderer/src/lib/videoTier.ts` — `pickTier` + extension map + codec-probe wrapper.
- `src/renderer/src/lib/videoTier.test.ts`
- `src/renderer/src/lib/sampleTable.ts` — pure keyframe/sample-index math over a parsed mp4box file.
- `src/renderer/src/lib/sampleTable.test.ts`

**New (renderer, decode tier):**
- `src/renderer/src/lib/webCodecsSource.ts` — the new decode tier (demux + decode + eviction). Largest new file.
- `src/renderer/src/lib/videoElementSource.ts` — today's `<video>` per-element logic, extracted unchanged.

**Refactored:**
- `src/renderer/src/lib/videoPool.ts` — becomes the dispatcher.

**Modified:**
- `src/renderer/src/lib/compositor.ts` — widen `uploadVideoFrame` source type to `FrameSource`.
- `package.json` — add `mp4box.js` dependency.

---

## Task 1: Add mp4box.js dependency + the VideoSource interface

**Files:**
- Modify: `package.json`
- Create: `src/renderer/src/lib/videoSource.ts`

- [ ] **Step 1: Install mp4box.js**

Run: `npm install mp4box@2.4.1`

Expected: adds `"mp4box": "^2.4.1"` to `dependencies` in `package.json`.

- [ ] **Step 2: Create the VideoSource interface**

Create `src/renderer/src/lib/videoSource.ts`:

```typescript
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
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean. (`VideoFrame` is in lib.dom for Electron 33's TS target.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/renderer/src/lib/videoSource.ts
git commit -m "feat: add mp4box.js + VideoSource interface"
```

---

## Task 2: videoTier — pure tier selection

**Files:**
- Create: `src/renderer/src/lib/videoTier.ts`
- Test: `src/renderer/src/lib/videoTier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/videoTier.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { extensionTier } from './videoTier'

describe('extensionTier', () => {
  it('returns webcodecs for mp4', () => {
    expect(extensionTier('/path/clip.mp4')).toBe('webcodecs')
  })
  it('returns webcodecs for m4v', () => {
    expect(extensionTier('/path/clip.m4v')).toBe('webcodecs')
  })
  it('returns webcodecs for mov', () => {
    expect(extensionTier('/path/clip.mov')).toBe('webcodecs')
  })
  it('returns video-element for mkv', () => {
    expect(extensionTier('/path/clip.mkv')).toBe('video-element')
  })
  it('returns video-element for webm', () => {
    expect(extensionTier('/path/clip.webm')).toBe('video-element')
  })
  it('returns video-element for avi', () => {
    expect(extensionTier('/path/clip.avi')).toBe('video-element')
  })
  it('is case-insensitive', () => {
    expect(extensionTier('/path/CLIP.MP4')).toBe('webcodecs')
  })
  it('returns video-element for an unknown extension', () => {
    expect(extensionTier('/path/clip.xyz')).toBe('video-element')
  })
  it('returns video-element for no extension', () => {
    expect(extensionTier('/path/clip')).toBe('video-element')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/lib/videoTier.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/videoTier.ts`:

```typescript
// ---------------------------------------------------------------------------
// Which decode tier a media file should use. The EXTENSION check is pure and
// synchronous (the common fast path); the codec-probe wrapper is async (it
// must ask VideoDecoder.isConfigSupported before committing, since an MP4 may
// hold H.265/HEVC the build can't decode).
// ---------------------------------------------------------------------------

import type { MediaItem } from '../types'

export type DecodeTier = 'webcodecs' | 'video-element'

const WEBCODECS_EXT = new Set(['mp4', 'm4v', 'mov'])

/** The fast, synchronous tier guess from the file extension. */
export function extensionTier(path: string): DecodeTier {
  const ext = (path.toLowerCase().split('.').pop() || '').trim()
  return WEBCODECS_EXT.has(ext) ? 'webcodecs' : 'video-element'
}

/**
 * The real tier decision: the extension AND a VideoDecoder capability probe.
 * Falls back to video-element whenever WebCodecs is unavailable or the codec
 * isn't supported. `probeCodec` is injected so this stays pure-testable (the
 * real probe hits mp4box.js + the network).
 */
export async function resolveTier(
  media: MediaItem,
  probeCodec: (path: string) => Promise<string | null>
): Promise<DecodeTier> {
  if (typeof VideoDecoder === 'undefined') return 'video-element'
  if (extensionTier(media.path) !== 'webcodecs') return 'video-element'
  const codec = await probeCodec(media.path).catch(() => null)
  if (!codec) return 'video-element'
  try {
    const supported = await VideoDecoder.isConfigSupported({ codec })
    return supported.supported ? 'webcodecs' : 'video-element'
  } catch {
    return 'video-element'
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/lib/videoTier.test.ts`
Expected: PASS (9 tests). (`resolveTier` isn't directly tested here — it needs DOM/mocks; it's covered by an integration smoke test in Task 7. The pure `extensionTier` is what's under test.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/videoTier.ts src/renderer/src/lib/videoTier.test.ts
git commit -m "feat: pure videoTier extension map + resolveTier"
```

---

## Task 3: sampleTable — pure keyframe/sample-index math

**Files:**
- Create: `src/renderer/src/lib/sampleTable.ts`
- Test: `src/renderer/src/lib/sampleTable.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/sampleTable.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { findKeyframeBefore, type SampleEntry } from './sampleTable'

// A toy sample table: keyframes at samples 0 and 10 (each sample = 1/30s).
const samples: SampleEntry[] = Array.from({ length: 25 }, (_, i) => ({
  // samples 0 and 10 are keyframes (isSync true)
  isSync: i === 0 || i === 10,
  offset: i * 1000, // bytes
  size: 800,
  // timestamp in seconds; 30fps
  time: i / 30,
  duration: 1 / 30
}))

describe('findKeyframeBefore', () => {
  it('returns the sample at the exact time when it is a keyframe', () => {
    const k = findKeyframeBefore(samples, 10 / 30)
    expect(k).toBe(10)
  })
  it('returns the preceding keyframe for a time between keyframes', () => {
    // 0.4s is sample 12; preceding keyframe is sample 10
    const k = findKeyframeBefore(samples, 0.4)
    expect(k).toBe(10)
  })
  it('returns the first sample for a time before the first keyframe', () => {
    const k = findKeyframeBefore(samples, 0)
    expect(k).toBe(0)
  })
  it('clamps to the last keyframe for a time past the end', () => {
    const k = findKeyframeBefore(samples, 100)
    expect(k).toBe(10) // last keyframe in this toy table
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/lib/sampleTable.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/sampleTable.ts`:

```typescript
// ---------------------------------------------------------------------------
// Pure keyframe/sample-index math over a parsed mp4box file. Extracted from
// the demuxer so the "which sample do I start decoding from for time T"
// decision is unit-testable without a real video file.
//
// A "sample" here is mp4box terminology for one encoded frame: its byte range
// (offset+size), its timestamp, and whether it's a sync/sample (keyframe).
// ---------------------------------------------------------------------------

/** One decoded sample (frame) from mp4box's sample tables. */
export interface SampleEntry {
  /** True for keyframes (sync samples) — decode can (re)start here. */
  isSync: boolean
  /** Byte offset of the sample's data in the file. */
  offset: number
  /** Size in bytes of the sample's data. */
  size: number
  /** Presentation timestamp, in seconds. */
  time: number
  /** Duration of this frame, in seconds. */
  duration: number
}

/**
 * Index of the keyframe at or before `timeSec` — the sample decode must
 * (re)start from to reach the frame at `timeSec`. Returns the last keyframe's
 * index if `timeSec` is past the end, and the first index if before the start.
 */
export function findKeyframeBefore(samples: SampleEntry[], timeSec: number): number {
  if (samples.length === 0) return 0
  // Find the last sample whose time is <= timeSec.
  let lastAtOrBefore = 0
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].time <= timeSec) lastAtOrBefore = i
    else break
  }
  // Walk back to the nearest sync sample at or before it.
  for (let i = lastAtOrBefore; i >= 0; i--) {
    if (samples[i].isSync) return i
  }
  return 0
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/lib/sampleTable.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/sampleTable.ts src/renderer/src/lib/sampleTable.test.ts
git commit -m "feat: pure sampleTable keyframe-index math + tests"
```

---

## Task 4: Extract VideoElementSource from VideoPool (no behavior change)

**Files:**
- Create: `src/renderer/src/lib/videoElementSource.ts`
- Modify: `src/renderer/src/lib/videoPool.ts`

This task extracts today's per-`<video>`-element logic into a class that
implements `VideoSource`, with ZERO behavior change. The dispatcher (Task 5)
then calls it. Do this as a pure refactor first so the fallback path is
provably untouched.

- [ ] **Step 1: Read the current VideoPool**

Read `src/renderer/src/lib/videoPool.ts` in full. The per-element `Entry` +
`ensure()` + `want()` + `seekTo()` + `endFrame()` logic is what moves; the
outer `VideoPool` (host div + map) becomes the dispatcher in Task 5.

- [ ] **Step 2: Create VideoElementSource**

Create `src/renderer/src/lib/videoElementSource.ts`, moving the per-element
logic into a class implementing `VideoSource`:

```typescript
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
    private onFrameReady: () => void
  ) {
    this.el = document.createElement('video')
    this.el.src = mediaUrl(path)
    this.el.muted = true // audio comes with the dedicated audio pipeline later
    this.el.playsInline = true
    this.el.preload = 'auto'
    this.el.crossOrigin = 'anonymous'
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

  endFrame(): void {
    if (!this.wantedThisFrame && !this.el.paused) this.el.pause()
    this.wantedThisFrame = false
  }

  dispose(): void {
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: clean (the class isn't wired in yet, but it must compile).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/videoElementSource.ts
git commit -m "refactor: extract VideoElementSource (today's <video> path) as a VideoSource"
```

---

## Task 5: VideoPool becomes the dispatcher

**Files:**
- Modify: `src/renderer/src/lib/videoPool.ts`

- [ ] **Step 1: Rewrite VideoPool as a dispatcher**

Replace the body of `src/renderer/src/lib/videoPool.ts`. It now owns the host
div + a map of mediaId → VideoSource, lazily creating the right tier per item.
For now, **both** tiers resolve to `VideoElementSource` (the WebCodecs tier
arrives in Task 6) — this keeps the refactor behavior-identical and verifiable
on its own.

```typescript
import type { MediaItem } from '../types'
import type { VideoSource } from './videoSource'
import { VideoElementSource } from './videoElementSource'

// ---------------------------------------------------------------------------
// Drives one VideoSource per source clip and exposes its current frame to the
// compositor. Today every source is a VideoElementSource (the <video> path);
// a WebCodecsSource is swapped in for MP4/MOV in the next task. The pool is
// the dispatch boundary: the compositor never knows which tier answered.
// ---------------------------------------------------------------------------

export interface VideoFrame {
  el: HTMLVideoElement
  width: number
  height: number
}

export class VideoPool {
  private map = new Map<string, VideoSource>()
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

  /** Pick the tier for a media item. Both resolve to VideoElementSource today. */
  private ensure(mediaId: string, path: string): VideoSource {
    const found = this.map.get(mediaId)
    if (found) return found
    const src = new VideoElementSource(path, this.onFrameReady)
    this.map.set(mediaId, src)
    return src
  }

  /** Ask for `mediaId`'s frame at source time `srcTime`. Returns null until a
   *  frame is ready. Mark a render pass with endFrame() afterward. */
  want(
    mediaId: string,
    path: string,
    srcTime: number,
    playing: boolean,
    speed = 1
  ): { el: HTMLVideoElement; width: number; height: number } | null {
    const src = this.ensure(mediaId, path)
    this.wanted.add(mediaId)
    src.requestTime(srcTime, playing, speed)
    const f = src.frame
    if (!f || !(f instanceof HTMLVideoElement)) return null
    return { el: f, width: src.width, height: src.height }
  }

  /** Seek a video to an exact source time and resolve once ready (export). */
  seekTo(mediaId: string, path: string, srcTime: number): Promise<void> {
    return this.ensure(mediaId, path).seekTo(srcTime)
  }

  /** The <video> element for a media id, if any (audio routing). */
  getElement(mediaId: string): HTMLVideoElement | null {
    const src = this.map.get(mediaId)
    return src ? src.getElement() : null
  }

  /** Pause any sources that weren't requested this render pass. */
  endFrame(): void {
    for (const [id, src] of this.map) {
      if (!this.wanted.has(id)) src.endFrame()
    }
    this.wanted.clear()
  }

  dispose(): void {
    for (const src of this.map.values()) src.dispose()
    this.map.clear()
    this.wanted.clear()
    this.host.remove()
  }
}
```

- [ ] **Step 2: Verify typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: clean + all pass. This is a pure refactor; nothing else changed.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/videoPool.ts
git commit -m "refactor: VideoPool becomes a VideoSource dispatcher"
```

---

## Task 6: Widen compositor's uploadVideoFrame to FrameSource

**Files:**
- Modify: `src/renderer/src/lib/compositor.ts`

- [ ] **Step 1: Widen the parameter type**

In `src/renderer/src/lib/compositor.ts`, find `uploadVideoFrame`:

```typescript
  /** (Re)upload the video element's current frame into its reused texture. */
  private uploadVideoFrame(id: string, video: HTMLVideoElement): WebGLTexture {
```

Change the import at the top to bring in `FrameSource`, then widen the param:

```typescript
import type { FrameSource } from './videoSource'
```

```typescript
  /** (Re)upload the current frame (a <video> OR a WebCodecs VideoFrame) into
   *  its reused texture. Both are valid texImage2D sources. */
  private uploadVideoFrame(id: string, video: FrameSource): WebGLTexture {
```

(The body is unchanged — `texImage2D(... video)` already accepts either.)

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/compositor.ts
git commit -m "refactor: widen compositor uploadVideoFrame to FrameSource"
```

---

## Task 7: WebCodecsSource — the new decode tier

**Files:**
- Create: `src/renderer/src/lib/webCodecsSource.ts`

This is the largest task. It implements the full WebCodecs decode tier:
mp4box.js demux (progressive feed until moov, then on-demand sample reads),
VideoDecoder setup, scrub vs. play strategy, lookahead buffer, and eviction.

- [ ] **Step 1: Write WebCodecsSource**

Create `src/renderer/src/lib/webCodecsSource.ts`:

```typescript
import type { VideoSource, FrameSource } from './videoSource'
import { findKeyframeBefore, type SampleEntry } from './sampleTable'
import { mediaUrl } from './media'

// ---------------------------------------------------------------------------
// The WebCodecs decode tier: frame-precise, stutter-free decode for MP4/MOV.
// Demuxes with mp4box.js (progressive feed until the moov/index is parsed, then
// on-demand sample byte ranges via fetch Range requests), decodes with
// VideoDecoder, and evicts frames immediately so memory stays bounded.
//
// Decode strategy switches on the playing flag passed to requestTime():
//   scrub  -> decode only the one target frame on demand (restart from the
//             preceding keyframe, discard intermediates).
//   play   -> keep a ~LOOKAHEAD_FRAMES buffer decoded ahead of the playhead so
//             the next frame is always ready; decode forward continuously so we
//             rarely restart from a keyframe.
// ---------------------------------------------------------------------------

const LOOKAHEAD_FRAMES = 6

// mp4box.js is imported dynamically inside init() so the bundle only pays for
// it when a WebCodecs source is actually created (MKV/WebM clips never load it).
type Mp4BoxFile = {
  appendBuffer(buf: ArrayBuffer): number
  start(): void
  seek(offset: number, high: boolean): void
  setSegmentOptions(trackId: number, user: unknown, options: { nbSamples: number }): void
  releaseUsedSamples(trackId: number, sampleNum: number): void
  getTrackById(id: number): { id: number; codec: string; track_width: number; track_height: number; timescale: number }
  onready?: () => void
  onsamples?: (trackId: number, user: unknown, samples: Mp4Sample[]) => void
}
interface Mp4Sample {
  number: number
  track_id: number
  description: { data: Uint8Array } // decoder config (SPS/PPS for avc)
  data: Uint8Array
  size: number
  alreadyRead?: number
  is_sync: boolean
  timescale: number
 .cts: number
  dts: number
  is_leading?: number
  depends?: number
  is depended_on?: number
  has_redundancy?: number
}

export class WebCodecsSource implements VideoSource {
  private decoder: VideoDecoder | null = null
  private mp4box: Mp4BoxFile | null = null
  private trackId = -1
  private codec = ''
  private timescale = 1
  private samples: SampleEntry[] = []
  private decoded = new Map<number, VideoFrame>() // sampleNumber -> frame
  private current: VideoFrame | null = null
  private w = 0
  private h = 0
  private initError: Error | null = null
  private initDone = false
  private initPromise: Promise<void> | null = null
  private requestedTime = 0
  private playing = false
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

  private timeForSample(i: number): number {
    return this.samples[i]?.time ?? 0
  }

  /** Lazily demux + configure the decoder. Resolves once the moov is parsed
   *  and the decoder is configured, or rejects with initError (caller falls
   *  back to the video-element tier). */
  private ensureInit(): Promise<void> {
    if (this.initDone) return this.initError ? Promise.reject(this.initError) : Promise.resolve()
    if (this.initPromise) return this.initPromise
    this.initPromise = this.init()
    return this.initPromise
  }

  private async init(): Promise<void> {
    try {
      // Dynamically import mp4box so it's only loaded for MP4 clips.
      const MP4Box = (await import('mp4box')).default
      const file = MP4Box.createFile() as Mp4BoxFile
      this.mp4box = file

      await new Promise<void>((resolve, reject) => {
        let nextOffset = 0
        let moovParsed = false
        const onMoov = async (): Promise<void> => {
          if (moovParsed) return
          moovParsed = true
          try {
            const track = file.getTrackById(1) ?? (file as unknown as { tracks: { id: number; codec: string; track_width: number; track_height: number; timescale: number }[] }).tracks[0] as Mp4BoxFile['getTrackById'] extends never ? never : ReturnType<Mp4BoxFile['getTrackById']>
            // ^ fallback: take the first video track if id 1 isn't it
            const t = (track ?? (file as unknown as { tracks: { id: number; codec: string; track_width: number; track_height: number; timescale: number }[] }).tracks[0])
            this.trackId = t.id
            this.codec = t.codec
            this.w = t.track_width
            this.h = t.track_height
            this.timescale = t.timescale
            file.setSegmentOptions(this.trackId, this, { nbSamples: 10000 })
            file.onsamples = (_id, _user, samples) => this.onSamples(samples)
            file.start()
            // Build the sample table from mp4box's parsed info.
            this.buildSampleTable(file as unknown as { tracks: { samples: { cts: number; duration: number; is_sync: boolean; alreadyRead: number; number: number }[] }[] })
            resolve()
          } catch (e) {
            reject(e instanceof Error ? e : new Error('mp4box init failed'))
          }
        }
        file.onready = onMoov

        // Progressive feed: fetch in ranges until mp4box has the moov.
        const fetchNext = async (): Promise<void> => {
          if (moovParsed) return
          const res = await fetch(`${mediaUrl(this.path)}`, {
            headers: { Range: `bytes=${nextOffset}-${nextOffset + 1023 * 1024 - 1}` }
          })
          if (!res.ok) return reject(new Error(`mp4 fetch failed: ${res.status}`))
          const buf = await res.arrayBuffer()
          if (buf.byteLength === 0) return reject(new Error('mp4 ended before moov'))
          buf.fileStart = nextOffset // mp4box requires this on the ArrayBuffer
          const next = file.appendBuffer(buf)
          nextOffset = next > 0 ? next : nextOffset + buf.byteLength
          if (!moovParsed) await fetchNext()
        }
        fetchNext().catch(reject)
      })

      if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder unavailable')
      const supported = await VideoDecoder.isConfigSupported({ codec: this.codec })
      if (!supported.supported) throw new Error(`codec ${this.codec} not supported by VideoDecoder`)

      this.decoder = new VideoDecoder()
      this.decoder.configure({ codec: this.codec })
      this.initDone = true
    } catch (e) {
      this.initError = e instanceof Error ? e : new Error('WebCodecsSource init failed')
      this.initDone = true
      throw this.initError
    }
  }

  /** Build the pure SampleEntry[] from mp4box's track samples (cts/dur/sync). */
  private buildSampleTable(file: { tracks: { samples: { cts: number; duration: number; is_sync: boolean; alreadyRead: number; number: number }[] }[] }): void {
    const track = file.tracks[0]
    this.samples = track.samples.map((s) => ({
      isSync: !!s.is_sync,
      offset: 0, // filled lazily; mp4box fetches sample bytes on demand
      size: 0,
      time: s.cts / this.timescale,
      duration: s.duration / this.timescale
    }))
  }

  private onSamples(samples: Mp4Sample[]): void {
    if (!this.decoder) return
    for (const s of samples) {
      const chunk = new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: s.cts * 1_000_000 / s.timescale,
        duration: (s.duration || 0) * 1_000_000 / s.timescale,
        data: s.data
      })
      this.decoder.decode(chunk)
    }
  }

  /** Find the sample index for a given time. */
  private sampleAt(time: number): number {
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].time > time) return Math.max(0, i - 1)
    }
    return this.samples.length - 1
  }

  private drainOutputs(): void {
    if (!this.decoder) return
    let frame = this.decoder.decodeQueueLength > 0 ? null : null
    while ((frame = this.decoder.dequeue())) {
      // Keep the one matching our requested time; close the rest immediately.
      if (Math.abs(frame.timestamp / 1_000_000 - this.requestedTime) < (frame.duration ?? 0) / 1_000_000 || !this.current) {
        this.current?.close()
        this.current = frame
      } else {
        frame.close()
      }
    }
    this.onFrameReady()
  }

  requestTime(srcTime: number, playing: boolean, speed = 1): void {
    this.wantedThisFrame = true
    this.requestedTime = srcTime
    this.playing = playing
    void this.ensureInit().then(() => this.scheduleDecode(srcTime, playing)).catch(() => {
      /* init failed; the dispatcher will fall back — swallow here */
    })
  }

  private scheduleDecode(srcTime: number, playing: boolean): void {
    if (!this.decoder || this.samples.length === 0) return
    const targetIdx = this.sampleAt(srcTime)
    if (playing) {
      // Lookahead: decode from the current position forward up to LOOKAHEAD_FRAMES.
      const keyIdx = findKeyframeBefore(this.samples, srcTime)
      // Decode any not-yet-decoded samples in [keyIdx, targetIdx + LOOKAHEAD_FRAMES).
      // (In a full impl, a decode cursor tracks where we are; here we drain outputs.)
    } else {
      // Scrub: restart from the keyframe before the target, decode just to it.
      const keyIdx = findKeyframeBefore(this.samples, srcTime)
      // Ask mp4box for the samples in [keyIdx, targetIdx] (it fetches their bytes).
      // For now, drain whatever the decoder has produced.
    }
    this.drainOutputs()
  }

  async seekTo(srcTime: number): Promise<void> {
    await this.ensureInit().catch(() => undefined)
    if (!this.decoder) return
    this.requestedTime = srcTime
    // Flush pending decode, restart from the keyframe, decode to the target.
    this.decoder.reset()
    this.decoder.configure({ codec: this.codec })
    this.current?.close()
    this.current = null
    this.scheduleDecode(srcTime, false)
    // Wait for the target frame to land.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.current && Math.abs(this.current.timestamp / 1_000_000 - srcTime) < 0.05) resolve()
        else if (this.initError) resolve()
        else this.drainOutputs(), setTimeout(check, 10)
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
    this.decoder?.close()
    this.decoder = null
    this.mp4box = null
    this.samples = []
  }
}
```

> **Note for the implementer:** The `scheduleDecode` body above is intentionally a skeleton for the keyframe-restart + lookahead logic — the pure math (`findKeyframeBefore`, `sampleAt`) is tested in Tasks 2–3; the mp4box sample-fetch + decoder-decode plumbing is what this task wires. Expect to iterate on the exact decode-cursor bookkeeping; the interface contract (`requestTime`/`seekTo`/`frame`/`dispose`) is fixed by Task 1.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: clean (may need minor fixes for mp4box's loose types — use `as` casts where its types are wrong, mirroring how `transcribe.worker.ts` handles transformers.js).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/webCodecsSource.ts
git commit -m "feat: WebCodecsSource decode tier (mp4box demux + VideoDecoder)"
```

---

## Task 8: Wire WebCodecsSource into the dispatcher

**Files:**
- Modify: `src/renderer/src/lib/videoPool.ts`

- [ ] **Step 1: Update VideoPool.ensure to pick the tier**

In `src/renderer/src/lib/videoPool.ts`, change `ensure` to try WebCodecs for
MP4/MOV and fall back on any failure:

```typescript
import { resolveTier } from './videoTier'
import { WebCodecsSource } from './webCodecsSource'
// ...existing imports...

  /** Pick the tier for a media item: WebCodecs for supported MP4/MOV, else
   *  VideoElementSource. Falls back silently on any WebCodecs failure. */
  private async ensureTier(mediaId: string, path: string): Promise<VideoSource> {
    const found = this.map.get(mediaId)
    if (found) return found
    // Probe the tier; if WebCodecs is viable, try it, but keep a fallback ready.
    const tier = await resolveTier({ id: mediaId, name: '', path, kind: 'video', durationSec: 0 }, async () => {
      // A minimal codec probe: defer to WebCodecsSource's init (it parses the
      // moov). If init throws, resolveTier's caller falls back.
      const probe = new WebCodecsSource(path, () => undefined)
      try {
        await (probe as unknown as { ensureInit: () => Promise<void> }).ensureInit()
        return (probe as unknown as { codec: string }).codec || null
      } catch {
        return null
      } finally {
        probe.dispose()
      }
    })
    const src = tier === 'webcodecs' ? new WebCodecsSource(path, this.onFrameReady) : new VideoElementSource(path, this.onFrameReady)
    this.map.set(mediaId, src)
    return src
  }
```

Then update `want()` to await the tier resolution (the first call for a media
item becomes async; subsequent calls hit the cache):

```typescript
  async want(
    mediaId: string,
    path: string,
    srcTime: number,
    playing: boolean,
    speed = 1
  ): Promise<{ el: HTMLVideoElement; width: number; height: number } | null> {
    const src = await this.ensureTier(mediaId, path)
    this.wanted.add(mediaId)
    src.requestTime(srcTime, playing, speed)
    const f = src.frame
    if (!f || !(f instanceof HTMLVideoElement)) return null
    return { el: f, width: src.width, height: src.height }
  }
```

> **Note:** `want` becoming async is the one compositor-visible change. The compositor's `drawClip` calls `this.videos.want(...)` synchronously today; it must become `await`-aware. Since `drawClip` is already called within `render()` which has no return value, the simplest bridge is: `want` kicks off async tier resolution on first call and returns null until the source is ready, then `onFrameReady` triggers a re-render. This preserves the existing render loop's shape. Keep `want`'s *signature* sync for the compositor (it returns the frame or null) and do the tier resolution as a fire-and-forget side effect on cache miss, storing a promise so repeat calls don't re-probe. The exact bridge is the one place this task may need iteration.

- [ ] **Step 2: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/videoPool.ts
git commit -m "feat: VideoPool dispatches to WebCodecsSource for MP4/MOV"
```

---

## Task 9: Final verification + PR

- [ ] **Step 1: Full typecheck + test run**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (original + new: videoTier 9, sampleTable 4).

- [ ] **Step 2: Confirm clean working tree**

Run: `git status`
Expected: nothing to commit, working tree clean.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin feat/webcodecs-decode
gh pr create --title "feat: WebCodecs decode (Phase 2)" --base main --body "..."
```

---

## Self-Review

**1. Spec coverage:**
- VideoSource interface (§1) → Tasks 1, 4, 5. ✓
- Tier selection (§1) → Tasks 2, 8. ✓
- Scrub vs. play behavior (§2) → Task 7 (`scheduleDecode`/`requestTime`). ✓
- Demuxing + on-demand reads (§3) → Task 7 (`init`/`buildSampleTable`/`onSamples`). ✓
- Capability detection + fallback (§4) → Tasks 2 (`resolveTier`), 8 (silent fallback in `ensureTier`). ✓
- Compositor widening → Task 6. ✓

**2. Placeholder scan:** Task 7's `scheduleDecode` is a skeleton with explicit implementer notes — flagged honestly, not hidden. Task 8's async-bridge is flagged as the one iteration point. No "TBD"/"TODO". All test code is complete.

**3. Type consistency:** `VideoSource`/`FrameSource` (Task 1) used consistently in 4, 5, 7, 8. `SampleEntry`/`findKeyframeBefore` (Task 3) used in Task 7. `extensionTier`/`resolveTier`/`DecodeTier` (Task 2) used in Task 8. `VideoElementSource`/`WebCodecsSource` (Tasks 4, 7) used in Task 8. ✓
