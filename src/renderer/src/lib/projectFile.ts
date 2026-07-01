import type { Marker, Project } from '../types'

// ---------------------------------------------------------------------------
// Pure project (de)serialization. Defensive on the way IN so a corrupt or
// hand-edited file can never crash the app: structurally-invalid data is
// rejected, and missing scalar settings are filled with sane defaults. Pure, so
// it is unit-tested directly.
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

/** Validate + normalize an untrusted object into a Project. */
function validateProject(p: unknown): DeserializeResult {
  if (!p || typeof p !== 'object') return { ok: false, error: 'No project data found.' }
  const o = p as Record<string, unknown>
  if (!Array.isArray(o.tracks)) return { ok: false, error: 'Project is missing its track list.' }
  if (!o.clips || typeof o.clips !== 'object') return { ok: false, error: 'Project is missing its clips.' }
  if (!o.media || typeof o.media !== 'object') return { ok: false, error: 'Project is missing its media list.' }

  const project: Project = {
    id: typeof o.id === 'string' ? o.id : 'proj',
    name: typeof o.name === 'string' ? o.name : 'Untitled Project',
    fps: num(o.fps, 30),
    width: num(o.width, 1920),
    height: num(o.height, 1080),
    sampleRate: num(o.sampleRate, 48000),
    media: o.media as Project['media'],
    tracks: o.tracks as Project['tracks'],
    clips: o.clips as Project['clips'],
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
  const raw =
    data && typeof data === 'object' && 'project' in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).project
      : data
  return validateProject(raw)
}
