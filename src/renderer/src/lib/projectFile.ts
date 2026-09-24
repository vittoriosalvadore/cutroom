import type { AnimProp, Clip, Easing, Keyframe, MediaItem, Marker, Project, Track } from '../types'
import { defaultTrackComp, defaultTrackDuck, defaultTrackEQ, defaultTrackGate } from '../types'
import { clampReverb } from '../../../shared/reverb'
import { clampTrackHeight } from './tracks'

// ---------------------------------------------------------------------------
// Pure project (de)serialization. Defensive on the way IN so a corrupt or
// hand-edited file can never crash the app: structurally-invalid data is
// rejected, individually-bad clips/media entries are dropped, and missing
// scalar settings are filled with sane defaults. Pure, so it is unit-tested
// directly.
// ---------------------------------------------------------------------------

export const FILE_VERSION = 1

export interface ProjectFileMeta {
  savedPath?: string | null
  timestamp?: number
}

export function serializeProject(project: Project, meta: ProjectFileMeta = {}): string {
  return JSON.stringify({ app: 'cutroom', version: FILE_VERSION, ...meta, project }, null, 2)
}

export type DeserializeResult = { ok: true; project: Project } | { ok: false; error: string }

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Drop malformed marker entries; never throw (old files have no markers key). */
function sanitizeMarkers(raw: unknown): Marker[] {
  if (!Array.isArray(raw)) return []
  const out: Marker[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const t = Number(o.timeSec)
    if (!Number.isFinite(t)) continue
    const end = Number(o.endSec)
    out.push({
      id: typeof o.id === 'string' ? o.id : `mk_${out.length}`,
      timeSec: Math.max(0, t),
      endSec: Number.isFinite(end) && end > t ? end : undefined,
      label: typeof o.label === 'string' ? o.label : undefined,
      color: typeof o.color === 'string' ? o.color : undefined
    })
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const TRACK_KINDS = new Set(['video', 'audio'])
const MEDIA_KINDS = new Set(['video', 'audio', 'image'])
const EASINGS = new Set<Easing>(['linear', 'hold', 'smooth'])

/**
 * Overlay a stored effect block onto its defaults, keeping only well-typed
 * fields: `enabled` must be a boolean, numbers must be finite. A garbage block
 * (a hand-edited file) degrades to the defaults instead of crashing the
 * Inspector's number formatting later. Absent stays absent (= effect off).
 */
function sanitizeFx<T extends { enabled: boolean }>(raw: unknown, defaults: T): T | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return undefined
  const out = { ...defaults }
  for (const k of Object.keys(defaults) as (keyof T)[]) {
    const v = raw[k as string]
    const d = defaults[k]
    if (typeof d === 'number' && Number.isFinite(v)) out[k] = v as T[keyof T]
    else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v as T[keyof T]
  }
  return out
}

/** Per-track mixer/effect fields, validated (see sanitizeFx). */
function sanitizeTrackAudio(t: Record<string, unknown>): Partial<Track> {
  const out: Partial<Track> = {
    audioGain: Number.isFinite(t.audioGain) ? (t.audioGain as number) : undefined,
    pan: Number.isFinite(t.pan) ? Math.max(-1, Math.min(1, t.pan as number)) : undefined,
    gate: sanitizeFx(t.gate, defaultTrackGate()),
    eq: sanitizeFx(t.eq, defaultTrackEQ()),
    comp: sanitizeFx(t.comp, defaultTrackComp())
  }
  const duck = sanitizeFx(t.duck, defaultTrackDuck())
  if (duck) {
    const trig = isRecord(t.duck) ? t.duck.triggerTrackId : null
    duck.triggerTrackId = typeof trig === 'string' ? trig : null
  }
  out.duck = duck
  if (isRecord(t.reverb)) {
    out.reverb = { enabled: t.reverb.enabled === true, ...clampReverb(t.reverb) }
  } else {
    out.reverb = undefined
  }
  return out
}

/** Tracks are structural: a malformed one fails the whole file (its clips would
 *  be orphaned). Cosmetic fields get defaults. Returns an error string on failure. */
function sanitizeTracks(raw: unknown[]): Track[] | string {
  const out: Track[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    if (!isRecord(t)) return 'Project has a malformed track.'
    if (typeof t.id !== 'string' || !t.id) return 'Project has a track without an id.'
    if (typeof t.kind !== 'string' || !TRACK_KINDS.has(t.kind)) return `Track "${t.id}" has an unknown kind.`
    if (seen.has(t.id)) return `Project has two tracks with the id "${t.id}".`
    seen.add(t.id)
    out.push({
      ...(t as unknown as Track),
      name: typeof t.name === 'string' ? t.name : t.id,
      ...sanitizeTrackAudio(t),
      height: clampTrackHeight(num(t.height, t.kind === 'audio' ? 52 : 68)),
      muted: t.muted === true,
      hidden: t.hidden === true
    })
  }
  return out
}

/** Drop media entries that aren't usable objects; a missing/garbage duration
 *  becomes 0 ("not yet probed") so the app re-probes it. */
function sanitizeMedia(raw: Record<string, unknown>): Project['media'] {
  const out: Project['media'] = {}
  for (const [id, m] of Object.entries(raw)) {
    if (!isRecord(m)) continue
    if (typeof m.kind !== 'string' || !MEDIA_KINDS.has(m.kind)) continue
    const dur = Number(m.durationSec)
    out[id] = {
      ...(m as unknown as MediaItem),
      id,
      name: typeof m.name === 'string' ? m.name : id,
      path: typeof m.path === 'string' ? m.path : '',
      durationSec: Number.isFinite(dur) && dur >= 0 ? dur : 0
    }
  }
  return out
}

/** Keep only well-formed keys, sorted by time (the evaluator assumes sorted). */
function sanitizeKeyframes(raw: unknown): Clip['keyframes'] | undefined {
  if (!isRecord(raw)) return undefined
  const out: Partial<Record<AnimProp, Keyframe[]>> = {}
  for (const [prop, track] of Object.entries(raw)) {
    if (!Array.isArray(track)) continue
    const keys: Keyframe[] = []
    for (const k of track) {
      if (!isRecord(k) || !Number.isFinite(k.t) || !Number.isFinite(k.v)) continue
      const ease = EASINGS.has(k.ease as Easing) ? (k.ease as Easing) : 'smooth'
      keys.push({ ...(k as unknown as Keyframe), ease })
    }
    if (keys.length > 0) out[prop as AnimProp] = keys.sort((a, b) => a.t - b.t)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A clip survives only if it can be placed and rendered: finite timing, a
 *  positive length, a real track, and a media reference that is null or
 *  resolvable. Anything else is dropped (not the whole file). */
function sanitizeClips(raw: Record<string, unknown>, trackIds: Set<string>, media: Project['media']): Project['clips'] {
  const out: Project['clips'] = {}
  for (const [id, c] of Object.entries(raw)) {
    if (!isRecord(c)) continue
    const { startSec, durationSec, inSec } = c
    if (!Number.isFinite(startSec) || !Number.isFinite(durationSec) || !Number.isFinite(inSec)) continue
    if ((durationSec as number) <= 0) continue
    if (typeof c.trackId !== 'string' || !trackIds.has(c.trackId)) continue
    if (c.mediaId !== null && (typeof c.mediaId !== 'string' || !media[c.mediaId])) continue
    const clip: Clip = { ...(c as unknown as Clip), id, startSec: Math.max(0, startSec as number) }
    if (c.speed !== undefined && !Number.isFinite(c.speed)) delete clip.speed
    if (c.keyframes !== undefined) {
      const kf = sanitizeKeyframes(c.keyframes)
      if (kf) clip.keyframes = kf
      else delete clip.keyframes
    }
    out[id] = clip
  }
  return out
}

/** Validate + normalize an untrusted object into a Project. */
function validateProject(p: unknown): DeserializeResult {
  if (!p || typeof p !== 'object') return { ok: false, error: 'No project data found.' }
  const o = p as Record<string, unknown>
  if (!Array.isArray(o.tracks)) return { ok: false, error: 'Project is missing its track list.' }
  if (!isRecord(o.clips)) return { ok: false, error: 'Project is missing its clips.' }
  if (!isRecord(o.media)) return { ok: false, error: 'Project is missing its media list.' }

  const tracks = sanitizeTracks(o.tracks)
  if (typeof tracks === 'string') return { ok: false, error: tracks }
  const media = sanitizeMedia(o.media)
  const clips = sanitizeClips(o.clips, new Set(tracks.map((t) => t.id)), media)

  const project: Project = {
    id: typeof o.id === 'string' ? o.id : 'proj',
    name: typeof o.name === 'string' ? o.name : 'Untitled Project',
    fps: num(o.fps, 30),
    width: num(o.width, 1920),
    height: num(o.height, 1080),
    sampleRate: num(o.sampleRate, 48000),
    media,
    tracks,
    clips,
    markers: sanitizeMarkers(o.markers)
  }
  return { ok: true, project }
}

/** Parse a saved/recovery file (wrapped or a bare project) into a Project. */
export function deserializeProject(json: string): DeserializeResult {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { ok: false, error: 'File is not valid JSON.' }
  }
  const wrapped = isRecord(data) && 'project' in data
  if (wrapped) {
    // A newer app may have changed the format in ways this build can't read;
    // refuse rather than silently dropping (and later overwriting) its data.
    const version = Number((data as Record<string, unknown>).version)
    if (Number.isFinite(version) && version > FILE_VERSION) {
      return {
        ok: false,
        error: `This project was saved by a newer version of Cutroom (file format ${version}; this version reads up to ${FILE_VERSION}). Please update Cutroom to open it.`
      }
    }
  }
  const raw = wrapped ? (data as Record<string, unknown>).project : data
  return validateProject(raw)
}
