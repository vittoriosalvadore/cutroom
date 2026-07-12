// ---------------------------------------------------------------------------
// Core data model. The whole editor state is plain, serializable data so a
// project can be saved to / loaded from JSON without any custom logic.
//
// Two ideas worth internalizing early:
//  1. State is NORMALIZED: media and clips live in id->object maps, not nested
//     arrays. Moving/splitting a clip is then a single map update.
//  2. A clip references its source media; it does NOT own pixels. The clip says
//     "play seconds [inSec .. inSec+durationSec] of media X at timeline position
//     startSec". Trimming changes numbers, never the underlying file.
// ---------------------------------------------------------------------------

export type MediaKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio'
/** What a clip represents. 'media' references a file; 'title'/'subtitle' own text. */
export type ClipRole = 'media' | 'title' | 'subtitle'

/** An imported source file. Immutable once probed. */
export interface MediaItem {
  id: string
  name: string
  /** Absolute path on disk. Empty for built-in placeholders. */
  path: string
  kind: MediaKind
  /** Source length in seconds. 0 = not yet probed (Phase 2 fills this in). */
  durationSec: number
  width?: number
  height?: number
  fps?: number
}

/** A timeline lane. Order in Project.tracks defines vertical stacking. */
export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** Lane height in px, used by the timeline renderer. */
  height: number
  muted: boolean
  hidden: boolean
  /** Marks a lane that holds subtitle clips, so SRT export knows where to look. */
  role?: 'subtitle'
  /** Audio: per-track gain in dB (default 0). */
  audioGain?: number
  /** Audio: stereo pan, -1 (left) .. 1 (right), default 0. Audio tracks only. */
  pan?: number
  /** Audio: per-track noise gate. Absent = disabled. Audio tracks only. */
  gate?: TrackGate
  /** Audio: per-track sidechain ducker. Absent = disabled. Audio tracks only. */
  duck?: TrackDuck
  /** Audio: per-track 3-band EQ. Absent = flat. Audio tracks only. */
  eq?: TrackEQ
  /** Audio: per-track compressor. Absent = disabled. Audio tracks only. */
  comp?: TrackComp
}

/** Per-track 3-band EQ (low shelf 120Hz, mid peak 1kHz, high shelf 8kHz), in dB. */
export interface TrackEQ {
  enabled: boolean
  lowDb: number
  midDb: number
  highDb: number
}

/** Per-track compressor, modeled on FFmpeg `acompressor`. */
export interface TrackComp {
  enabled: boolean
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}

export function defaultTrackEQ(): TrackEQ {
  return { enabled: false, lowDb: 0, midDb: 0, highDb: 0 }
}

export function defaultTrackComp(): TrackComp {
  return { enabled: false, thresholdDb: -18, ratio: 3, attackMs: 20, releaseMs: 200, makeupDb: 0 }
}

/** Per-track noise gate, modeled on FFmpeg `agate`. Times in ms; levels in dB. */
export interface TrackGate {
  enabled: boolean
  /** Open above this input level (dB). agate threshold = dbToLinear(thresholdDb). */
  thresholdDb: number
  /** Attenuation floor when closed (<= 0 dB). agate range = dbToLinear(rangeDb). */
  rangeDb: number
  /** Gate ratio, >= 1. */
  ratio: number
  attackMs: number
  releaseMs: number
}

/** Per-track sidechain ducker, modeled on FFmpeg `sidechaincompress`. */
export interface TrackDuck {
  enabled: boolean
  /** The audio track whose level ducks THIS track (e.g. a voiceover track). */
  triggerTrackId: string | null
  /** sidechaincompress threshold = dbToLinear(thresholdDb). */
  thresholdDb: number
  /** Compression ratio. Clamped to 1..20 (FFmpeg hard cap) on export. */
  ratio: number
  attackMs: number
  releaseMs: number
}

/** A placed segment on a Track. References a MediaItem, OR carries its own text. */
export interface Clip {
  id: string
  trackId: string
  /** Source file reference. Null for generated title/subtitle clips (no file). */
  mediaId: string | null
  /** Where the clip starts on the timeline, in seconds. */
  startSec: number
  /** How long the clip occupies the timeline, in seconds. */
  durationSec: number
  /** Source in-point: the first second of the media this clip shows. */
  inSec: number
  // The source out-point is derived (inSec + durationSec); MVP has no speed change.
  /** Defaults to 'media' when omitted. */
  role?: ClipRole
  /** Text payload + styling for 'title' / 'subtitle' clips. */
  text?: TextProps
  /** Per-clip compositing effects (opacity, chroma key). Omitted = defaults. */
  effects?: Effects
  /** Audio: linear gain 0..1 (default 1). */
  volume?: number
  /** Audio: fade-in length in seconds from the clip's start (default 0). */
  fadeInSec?: number
  /** Audio: fade-out length in seconds to the clip's end (default 0). */
  fadeOutSec?: number
  /** AI noise removal (FFmpeg arnndn), applied to the source media once and
   *  reused for both preview and export. Default false = original audio. */
  denoiseEnabled?: boolean
  /** Per-clip 2D transform (static values; keyframes override per property). */
  transform?: ClipTransform
  /** Keyframe tracks per animatable property, in clip-relative seconds. */
  keyframes?: Partial<Record<AnimProp, Keyframe[]>>
  /** Playback speed (1 = normal, <1 slow-mo, >1 fast). Pitches audio like tape. */
  speed?: number
}

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4

export function clampSpeed(s: number): number {
  return Number.isFinite(s) ? Math.max(MIN_SPEED, Math.min(MAX_SPEED, s)) : 1
}

export type Easing = 'linear' | 'hold' | 'smooth'

/** One keyframe: a value at a clip-relative time, easing into the NEXT key. */
export interface Keyframe {
  /** Seconds from the clip start. */
  t: number
  v: number
  ease: Easing
}

/** Properties that can be animated with keyframes. */
export type AnimProp =
  | 'opacity'
  | 'scale'
  | 'posX'
  | 'posY'
  | 'rotationDeg'
  | 'cropTop'
  | 'cropRight'
  | 'cropBottom'
  | 'cropLeft'

/**
 * Per-clip 2D transform. Positions are FRACTIONS of the frame (0 = centered,
 * matching the % convention used elsewhere); crop insets are fractions of the
 * clip's own content rect; rotation is clockwise degrees.
 */
export interface ClipTransform {
  scale: number
  posX: number
  posY: number
  rotationDeg: number
  crop: { top: number; right: number; bottom: number; left: number }
}

export const IDENTITY_TRANSFORM: ClipTransform = {
  scale: 1,
  posX: 0,
  posY: 0,
  rotationDeg: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 }
}

export function defaultTransform(): ClipTransform {
  return { scale: 1, posX: 0, posY: 0, rotationDeg: 0, crop: { top: 0, right: 0, bottom: 0, left: 0 } }
}

/** A timeline marker (a point) or region (a labelled span when endSec is set). */
export interface Marker {
  id: string
  /** Marker time, or region start, in seconds. */
  timeSec: number
  /** Region end (> timeSec). Absent = a point marker. */
  endSec?: number
  label?: string
  /** Hex flag/band colour. */
  color?: string
}

export function defaultMarkerColor(): string {
  return '#ffcf4d'
}

/** The full editable document. Serialize this to save a project. */
export interface Project {
  id: string
  name: string
  /** Sequence settings the preview/export render to. */
  fps: number
  width: number
  height: number
  sampleRate: number
  media: Record<string, MediaItem>
  tracks: Track[]
  clips: Record<string, Clip>
  /** Timeline markers / regions (editing aids; do not affect render). */
  markers?: Marker[]
}

// ---------------------------------------------------------------------------
// Text & effects. All sizes/positions are stored RESOLUTION-INDEPENDENT (as a
// percentage of the frame), so a project authored at 1080p still looks right if
// the sequence is later set to 4K. The compositor converts % -> pixels.
// ---------------------------------------------------------------------------

export type TextAlign = 'left' | 'center' | 'right'

/** A title or subtitle's content and look. */
export interface TextProps {
  content: string
  fontFamily: string
  /** Font size as a percentage of frame HEIGHT (e.g. 9 = 9% of 1080 ≈ 97px). */
  fontSizePct: number
  color: string
  bold: boolean
  italic: boolean
  align: TextAlign
  /** Anchor of the text block, as a percentage of frame width/height (0..100). */
  xPct: number
  yPct: number
  /** Outline drawn behind the fill so text stays legible over busy footage. */
  strokeColor: string
  /** Outline width as a percentage of the font size. */
  strokeWidthPct: number
  /** Optional solid box behind the text (great for subtitles). */
  boxColor: string
  /** Box alpha 0..1. 0 = no box. */
  boxOpacity: number
}

/** Green/blue-screen key. Removes pixels near `color`. */
export interface ChromaKey {
  enabled: boolean
  /** The screen color to remove (hex), e.g. '#00d000' green or '#0047bb' blue. */
  color: string
  /** How aggressively near-key colors are removed (0..1). */
  similarity: number
  /** Softness of the cutout edge (0..1). */
  smoothness: number
  /** Suppresses leftover green/blue fringing on kept edges (0..1). */
  spill: number
}

/** Per-clip primary colour correction, applied in the fragment shader. */
export interface ColorCorrection {
  /** Exposure in stops (0 = neutral). */
  exposure: number
  /** Contrast about mid-grey (1 = neutral). */
  contrast: number
  /** Saturation (1 = neutral, 0 = greyscale). */
  saturation: number
  /** White balance: -1 cool .. +1 warm (0 = neutral). */
  temperature: number
  /** White balance: -1 green .. +1 magenta (0 = neutral). */
  tint: number
}

/** Per-clip compositing controls applied by the preview/export pipeline. */
export interface Effects {
  /** Layer opacity, 0..1. */
  opacity: number
  chroma: ChromaKey
  /** Primary colour correction. Omitted / neutral = no grade. */
  color?: ColorCorrection
}

export function defaultChroma(): ChromaKey {
  return { enabled: false, color: '#00d000', similarity: 0.4, smoothness: 0.1, spill: 0.25 }
}

export function defaultColor(): ColorCorrection {
  return { exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0 }
}

/** True when a grade is the identity (so the shader can skip it for a byte-identical result). */
export function isNeutralColor(c: ColorCorrection | undefined): boolean {
  return (
    !c ||
    (c.exposure === 0 && c.contrast === 1 && c.saturation === 1 && c.temperature === 0 && c.tint === 0)
  )
}

export function defaultEffects(): Effects {
  return { opacity: 1, chroma: defaultChroma() }
}

/** Convert decibels to a linear amplitude multiplier. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/** Default per-clip audio properties, used to seed Inspector controls. */
export function defaultAudio(): { volume: number; fadeInSec: number; fadeOutSec: number } {
  return { volume: 1, fadeInSec: 0, fadeOutSec: 0 }
}

export function defaultTrackGate(): TrackGate {
  return { enabled: false, thresholdDb: -45, rangeDb: -60, ratio: 2, attackMs: 5, releaseMs: 120 }
}

export function defaultTrackDuck(): TrackDuck {
  return { enabled: false, triggerTrackId: null, thresholdDb: -30, ratio: 8, attackMs: 15, releaseMs: 250 }
}

const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

export function defaultTitleText(content = 'Title'): TextProps {
  return {
    content,
    fontFamily: TEXT_FONT,
    fontSizePct: 9,
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    xPct: 50,
    yPct: 50,
    strokeColor: '#000000',
    strokeWidthPct: 6,
    boxColor: '#000000',
    boxOpacity: 0
  }
}

export function defaultSubtitleText(content = ''): TextProps {
  return {
    content,
    fontFamily: TEXT_FONT,
    fontSizePct: 5.2,
    color: '#ffffff',
    bold: false,
    italic: false,
    align: 'center',
    xPct: 50,
    yPct: 88,
    strokeColor: '#000000',
    strokeWidthPct: 8,
    boxColor: '#000000',
    boxOpacity: 0.35
  }
}
