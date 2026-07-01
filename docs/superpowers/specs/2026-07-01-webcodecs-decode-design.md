# WebCodecs Decode — Phase 2 Design

**Status:** Approved (Approach C — WebCodecs for MP4/MOV, `<video>` fallback)
**Date:** 2026-07-01
**Branch:** `feat/webcodecs-decode`

## North star

Cutroom must run smooth — the anti-Adobe / anti-Vegas. This phase targets the
"smoothness" half of the north star: frame-precise, stutter-free video decode.

## Problem statement

Today every active video clip gets a hidden `<video>` element (`VideoPool.ts`).
Each render frame copies the element's current frame to the canvas via
`texImage2D`. This works but has three ceilings — the same three that make
Premiere/Vegas feel sluggish:

1. **No decode control.** The `<video>` element is a black box that decodes on
   its own schedule. Under load (multi-cam, 4K) it stalls and the "buffering…"
   placeholder shows. The editor *waits* on the element.
2. **Seeking is fuzzy.** `<video>` snaps to the nearest decodable keyframe, so
   scrubbing jumps instead of being frame-precise. Documented in-code as
   "NOT frame-accurate."
3. **Memory is unmanaged.** Each `<video>` element hoards its decode buffers;
   we can't evict strategically. Heavy timelines choke.

## Chosen approach: WebCodecs for MP4/MOV, `<video>` fallback (Approach C)

WebCodecs (`VideoDecoder`) hands us direct control: we feed `EncodedVideoChunk`s
and get `VideoFrame`s back, one at a time, on demand. `VideoFrame` is a valid
`texImage2D` source, so it slots into the existing compositor without rewriting
it.

Phase 2 ships this for **MP4/MOV only** (~90% of real footage: phones, cameras,
screen recordings, exports). MKV/WebM/AVI stay on the `<video>` path — no worse
than today. The decode-tier abstraction is designed so an FFmpeg-WASM demuxer
can slot in later (Phase 2.5) for the remaining formats without rework.

## Design

### 1. The decode-tier abstraction (`VideoSource` interface)

The compositor today calls `VideoPool.want(mediaId, path, srcTime, playing,
speed)` and gets `{ el: HTMLVideoElement, width, height }`. We introduce a
unified `VideoSource` interface so the compositor doesn't care *how* a frame was
produced, and a new tier can slot in later without touching the compositor.

```ts
// Both HTMLVideoElement and VideoFrame are valid texImage2D sources, so the
// compositor's uploadVideoFrame() already accepts either — we widen the field
// type from HTMLVideoElement to this union.
type FrameSource = HTMLVideoElement | VideoFrame

interface VideoSource {
  /** The current decoded frame, or null while the first frame is decoding. */
  readonly frame: FrameSource | null
  readonly width: number
  readonly height: number
  /** Advance to / seek to this source time. Drives decode for the next frame. */
  requestTime(srcTime: number, playing: boolean, speed: number): void
  /** Seek to an exact time and resolve when the frame is ready (export path). */
  seekTo(srcTime: number): Promise<void>
  /** The <video> element, if this source is the legacy path (audio routing). */
  getElement(): HTMLVideoElement | null
  /** Called after every render pass so the source can pause unused decoders. */
  endFrame(): void
  dispose(): void
}
```

**Tier selection** (per media item, checked at first decode so a late failure
can still fall back):

```ts
async function pickTier(media: MediaItem): Promise<'webcodecs' | 'video-element'> {
  if (typeof VideoDecoder === 'undefined') return 'video-element'
  const ext = extname(media.path) // mp4, m4v, mov -> webcodecs; else legacy
  if (ext !== 'mp4' && ext !== 'm4v' && ext !== 'mov') return 'video-element'
  // Probe the codec; isConfigSupported gates H.265/odd profiles we can't decode.
  const probe = await probeMp4Codec(media.path)
  const ok = await VideoDecoder.isConfigSupported({ codec: probe.codec, ... })
  return ok ? 'webcodecs' : 'video-element'
}
```

`VideoPool` becomes a thin dispatcher: `want(mediaId, …)` looks up (or lazily
creates) the right `VideoSource` per media item and forwards the call.

- **`VideoElementSource`** — today's `VideoPool` per-element logic, extracted
  unchanged. Handles the fallback. Still owns a `<video>` element (audio routing
  for video clips still taps it).
- **`WebCodecsSource`** — new. Demuxes via mp4box.js, decodes via
  `VideoDecoder`, evicts frames.

### 2. Decode behavior — scrub vs. play

The two modes have opposite needs; the source switches strategy on the
`playing` flag the compositor already passes.

**Scrub (paused, dragging the playhead):**
- Jumps unpredictably. Decode **only the one target frame** on demand.
- Throw away any in-flight decode, restart from the keyframe before the target,
  decode the chain keyframe → target, discard intermediates, show the frame.
- No lookahead — the user may scrub away in 50ms.

**Play (real-time playback):**
- Steady forward motion. Keep a small **lookahead buffer** (~6 frames) decoded
  ahead of the playhead so the next frame is always ready.
- Decode forward continuously so we rarely restart from a keyframe (the cheap
  path: each frame predicts from the previous).
- Cap the buffer so memory stays bounded; the `<video>` element's hoarding is
  exactly the pathology this avoids.

**Eviction:** a decoded `VideoFrame` stays in GPU memory until `.close()` is
called. The source holds exactly one "current" frame plus its lookahead buffer
when playing. Every displayed-and-superseded frame is `.close()`d immediately.

### 3. Demuxing (mp4box.js) + on-demand chunk reads

`mp4box.js` is the W3C reference demuxer for WebCodecs (pure JS, MP4/MOV only).
On first frame request for a media item:

1. **Fetch the file** in chunks via the existing `cutroom://` protocol (no new
   security surface; `serveMedia` in `index.ts` already honors Range requests —
   that's why scrubbing works at all today).
2. **Feed bytes to mp4box.js**, which parses the container and gives us:
   - The codec string (`avc1.42E01E` etc.) for `VideoDecoder.configure()`.
   - The sample tables (where the keyframes are) — so we know "to decode the
     frame at 3.5s, start from the keyframe at 3.0s."
   - The encoded samples (compressed bytes per frame), wrapped into
     `EncodedVideoChunk`s and handed to `VideoDecoder.decode()`.
3. **Cache the parsed structure per media item** so we don't re-parse on every
   scrub. Compressed byte ranges are read on-demand via Range requests.

**Incremental feed contract (mp4box.js specifics):** mp4box.js is fed file data
progressively via `mp4boxfile.appendBuffer(buf)` until it returns a negative
offset (meaning "I have the moov box / index"), NOT by fetching the whole file.
We fetch in fixed-size ranges until the moov (index) is parsed, then read
individual sample byte ranges on demand via further Range requests. Opening a
2-hour video parses the index (small, at the front of the file), then pulls
just the bytes for the frame in view — never the whole file.

### 4. Capability detection + graceful fallback

WebCodecs is an optimization, not a requirement. The new source checks at
runtime and **falls back silently** to the `<video>` path if any check fails:

| Check | If it fails |
|---|---|
| `typeof VideoDecoder !== 'undefined'` | Old/locked-down Chromium → `<video>` |
| `VideoDecoder.isConfigSupported({ codec, ... })` | Unsupported codec (e.g. H.265 the build can't decode) → `<video>` |
| mp4box.js fails to parse | Corrupt/unusual container → `<video>` |
| First decode throws / errors | Decode failure mid-stream → `<video>` |

A user whose hardware or file doesn't cooperate gets exactly today's behavior:
no regression, no error surfacing, no "unsupported." `pickTier` re-checks at
first decode, so a late failure degrades to the fallback rather than crashing.

## Non-goals (deferred)

- **MKV/WebM/AVI WebCodecs decode** — Phase 2.5 (FFmpeg-WASM demuxer; additive
  behind the same `VideoSource` interface).
- **Audio via WebCodecs** — audio keeps its existing pipeline (`audioCache.ts`).
  mp4box can extract audio tracks but that's out of scope here.
- **Export pipeline changes** — export already works via `renderExact` → the
  compositor; it automatically benefits once the compositor consumes
  `VideoFrame`s, but the pipeline itself isn't redesigned.
- **New UI** — invisible to the user; they just feel smoother scrubbing. No
  settings toggle. (A diagnostics panel is a separate concern.)

## Verification

- `npm run typecheck` — clean.
- `npm test` — existing tests still pass; new unit tests for the pure seams
  (tier selection, keyframe lookup, frame-index math).
- Manual smoke matrix (documented in the implementation plan):
  - MP4 on timeline → scrub is frame-precise (compare to a known frame).
  - 4K MP4 playback → no "buffering…" placeholder under sustained play.
  - MKV clip → falls back to `<video>` path, behaves exactly as today.
  - Disable WebCodecs (devtools) → MP4 also falls back, no crash.

## Dependencies

- **`mp4box.js`** — new dev dependency. Pure JS, ~50KB, no native code. The W3C
  WebCodecs sample uses it; widely deployed.

## Files touched (summary)

**New (renderer, pure-testable):**
- `src/renderer/src/lib/videoSource.ts` — the `VideoSource` interface + `FrameSource`.
- `src/renderer/src/lib/videoTier.ts` — `pickTier` + codec probe + extension map.
- `src/renderer/src/lib/videoTier.test.ts`
- `src/renderer/src/lib/webCodecsSource.ts` — the new decode tier (demux +
  decode + eviction). The largest new file.
- `src/renderer/src/lib/sampleTable.ts` — pure keyframe/sample-index math over
  a parsed mp4box file (testable without a real file).
- `src/renderer/src/lib/sampleTable.test.ts`

**Refactored:**
- `src/renderer/src/lib/videoPool.ts` — becomes the dispatcher; extracts today's
  per-element logic into `VideoElementSource` (in `videoElementSource.ts`).
- `src/renderer/src/lib/videoElementSource.ts` — today's `<video>` logic, moved
  unchanged, now implementing `VideoSource`.

**Modified:**
- `src/renderer/src/lib/compositor.ts` — `uploadVideoFrame` widens its source
  type to `FrameSource`; `drawClip`/`getVideoPool` unchanged.
- `package.json` — add `mp4box.js` dev dependency.
