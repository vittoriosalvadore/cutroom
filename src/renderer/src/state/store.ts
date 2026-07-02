import { create } from 'zustand'
import type {
  AnimProp,
  Clip,
  ClipTransform,
  Keyframe,
  Effects,
  ChromaKey,
  ColorCorrection,
  MediaItem,
  MediaKind,
  Project,
  TextProps,
  Track,
  TrackGate,
  TrackDuck,
  TrackEQ,
  TrackComp
} from '../types'
import {
  clampSpeed,
  MIN_SPEED,
  defaultColor,
  defaultMarkerColor,
  defaultEffects,
  defaultSubtitleText,
  defaultTitleText,
  defaultTransform,
  defaultTrackGate,
  defaultTrackDuck,
  defaultTrackEQ,
  defaultTrackComp
} from '../types'
import { computeCrossfade, MIN_CLIP_SEC, rippleShift, rippleShiftMarkers, splitClipAt } from '../lib/editing'
import { clampFades } from '../lib/fades'
import { clampProp, keyIndexAt, KEY_EPS, rebaseTracks, sortKeys, splitTracksAt, withTransformProp } from '../lib/keyframes'
import { useSettings } from './settings'

/** One imported subtitle cue (used by SRT/VTT import). */
export interface SubtitleCue {
  startSec: number
  endSec: number
  text: string
}

// ---------------------------------------------------------------------------
// Single source of truth for the editor. Components subscribe to the slices
// they need; actions are the ONLY way to mutate. This keeps the timeline,
// preview, and transport perfectly in sync and makes undo/redo (a later phase)
// a matter of snapshotting `project`.
// ---------------------------------------------------------------------------

let counter = 0
function uid(prefix: string): string {
  counter += 1
  return `${prefix}_${counter.toString(36)}_${Date.now().toString(36)}`
}

function kindFromPath(path: string): MediaKind {
  const ext = (path.toLowerCase().split('.').pop() || '').trim()
  if (['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'].includes(ext)) return 'audio'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image'
  return 'video'
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** First video track (where new titles land), creating one if none exists. */
function topVideoTrack(tracks: Track[]): { tracks: Track[]; trackId: string } {
  const existing = tracks.find((t) => t.kind === 'video')
  if (existing) return { tracks, trackId: existing.id }
  const track: Track = {
    id: uid('t'),
    kind: 'video',
    name: 'V1',
    height: 68,
    muted: false,
    hidden: false
  }
  return { tracks: [track, ...tracks], trackId: track.id }
}

/** The dedicated subtitle lane, created at the top of the stack if missing. */
function subtitleTrack(tracks: Track[]): { tracks: Track[]; trackId: string } {
  const existing = tracks.find((t) => t.role === 'subtitle')
  if (existing) return { tracks, trackId: existing.id }
  const track: Track = {
    id: uid('t'),
    kind: 'video',
    name: 'Subtitles',
    height: 54,
    muted: false,
    hidden: false,
    role: 'subtitle'
  }
  // Top of the array = topmost layer, so subtitles composite above everything.
  return { tracks: [track, ...tracks], trackId: track.id }
}

// A first-run project so the timeline isn't empty: one video + one audio lane
// and a sample block on V1. The sample has no real file (path: '') — it renders
// as a colored clip; real decode arrives in Phase 3.
const SAMPLE_MEDIA_ID = 'm_sample'
function defaultProject(): Project {
  return {
    id: 'proj_default',
    name: 'Untitled Project',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    media: {
      [SAMPLE_MEDIA_ID]: {
        id: SAMPLE_MEDIA_ID,
        name: 'Sample Clip',
        path: '',
        kind: 'video',
        durationSec: 8,
        width: 1920,
        height: 1080,
        fps: 30
      }
    },
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', height: 68, muted: false, hidden: false },
      { id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false }
    ],
    clips: {
      c_sample: {
        id: 'c_sample',
        trackId: 'v1',
        mediaId: SAMPLE_MEDIA_ID,
        startSec: 1,
        durationSec: 6,
        inSec: 0
      }
    }
  }
}

interface EditorState {
  project: Project
  playheadSec: number
  isPlaying: boolean
  /** Timeline zoom: horizontal pixels per second. */
  pxPerSec: number
  /** The PRIMARY selected clip (Inspector target). Always a member of selectedClipIds, null iff empty. */
  selectedClipId: string | null
  /** The full clip selection set (multi-select). */
  selectedClipIds: Set<string>
  selectedTrackId: string | null
  selectedMarkerId: string | null

  // --- media ---
  importMedia: (paths: string[]) => void
  setMediaInfo: (
    mediaId: string,
    info: { durationSec?: number; width?: number; height?: number; fps?: number }
  ) => void

  // --- clips ---
  addClipFromMedia: (mediaId: string, trackId: string, startSec: number) => void
  moveClip: (clipId: string, startSec: number, trackId?: string) => void
  applyTrim: (clipId: string, bounds: { startSec: number; durationSec: number; inSec: number }) => void
  splitAtPlayhead: () => void
  removeClip: (clipId: string) => void
  rippleDelete: (clipId: string) => void
  /** Split a clip at both ends of [startSec, endSec) and ripple-delete the
   *  middle piece, shifting later same-track clips and markers left to close
   *  the gap. One recorded history step. */
  cutSilenceRange: (clipId: string, range: { startSec: number; endSec: number }) => void
  /** Apply every detected silence range to a clip in one recorded history
   *  step (a single undo for the whole auto-cut, not one per range). Ranges
   *  are given in ORIGINAL (pre-cut) timeline positions; later ranges are
   *  re-targeted internally as earlier cuts ripple-shift the timeline. */
  applySilenceCuts: (clipId: string, ranges: Array<{ startSec: number; endSec: number }>) => void
  /** Crossfade a clip with its nearest adjacent/overlapping same-track neighbor. */
  crossfadeWithNeighbor: (clipId: string) => void
  selectClip: (clipId: string | null) => void

  // --- multi-select ---
  /** Add/remove a clip from the selection (shift/ctrl-click); recomputes primary. */
  toggleClipSelection: (clipId: string) => void
  /** Replace the whole selection (rubber-band); primary = last id. */
  setClipSelection: (clipIds: string[]) => void
  selectAllClips: () => void
  clearSelection: () => void
  /** Move every selected clip by the same delta (group drag); one undo step (caller snapshots). */
  moveSelectedBy: (deltaSec: number) => void
  /** Delete every selected clip. */
  removeSelectedClips: () => void
  /** Ripple-delete every selected clip, closing gaps per track. */
  rippleDeleteSelected: () => void
  /** Copy the selection to the in-memory clipboard. */
  copySelectedClips: () => void
  /** Paste the clipboard at `atSec`, with fresh ids; selects the pasted clips. */
  pasteClips: (atSec: number) => void

  // --- markers ---
  addMarker: (timeSec?: number) => void
  removeMarker: (markerId: string) => void
  updateMarker: (markerId: string, patch: { label?: string; color?: string; timeSec?: number }) => void
  selectMarker: (markerId: string | null) => void
  /** Move the playhead to the previous/next marker (no wrap). */
  jumpMarker: (dir: -1 | 1) => void

  // --- titles / text / effects ---
  addTitle: (startSec: number) => void
  updateText: (clipId: string, patch: Partial<TextProps>) => void
  updateEffects: (clipId: string, patch: Partial<Effects>) => void
  updateChroma: (clipId: string, patch: Partial<ChromaKey>) => void
  updateColor: (clipId: string, patch: Partial<ColorCorrection>) => void
  resetColor: (clipId: string) => void

  // --- subtitles ---
  importSubtitles: (cues: SubtitleCue[]) => void

  // --- audio ---
  updateAudio: (
    clipId: string,
    patch: { volume?: number; fadeInSec?: number; fadeOutSec?: number }
  ) => void
  toggleTrackMute: (trackId: string, muted: boolean) => void
  addAudioTrack: (name?: string) => void
  selectTrack: (trackId: string | null) => void
  updateTrack: (trackId: string, patch: { audioGain?: number; pan?: number; name?: string }) => void
  updateTrackGate: (trackId: string, patch: Partial<TrackGate>) => void
  updateTrackDuck: (trackId: string, patch: Partial<TrackDuck>) => void
  updateTrackEQ: (trackId: string, patch: Partial<TrackEQ>) => void
  updateTrackComp: (trackId: string, patch: Partial<TrackComp>) => void

  // --- transform / keyframes ---
  /** Set the STATIC value of an animatable property (when its track is disarmed). */
  setStaticProp: (clipId: string, prop: AnimProp, v: number) => void
  /** Insert or replace a keyframe at clip-relative time `t`. */
  setKeyframe: (clipId: string, prop: AnimProp, t: number, v: number) => void
  /** Remove the keyframe at `t` (within epsilon); drops empty tracks/maps. */
  removeKeyframe: (clipId: string, prop: AnimProp, t: number) => void
  /** Arm (one key at `t`) or disarm (write `sampled` back to the static value). */
  toggleKeyframeTrack: (clipId: string, prop: AnimProp, t: number, sampled: number) => void
  /** Clear all transform + keyframes for a clip. */
  resetTransform: (clipId: string) => void
  /** Add a slow Ken Burns zoom + pan as scale/posX keyframes spanning the clip. */
  applyKenBurns: (clipId: string) => void
  /** Scale a letterboxed clip up so it fills the frame (static). */
  fillFrame: (clipId: string) => void
  /** Set playback speed; clamps duration so it never reads past the source. */
  setSpeed: (clipId: string, speed: number) => void

  // --- transport / view ---
  setPlayhead: (sec: number) => void
  setPlaying: (playing: boolean) => void
  setZoom: (pxPerSec: number) => void

  // --- history (undo/redo) ---
  past: Project[]
  future: Project[]
  /** Snapshot the current project before a discrete interaction (drag/slider). */
  snapshot: () => void
  undo: () => void
  redo: () => void

  // --- in-memory rollback ring (mid-session catastrophe net) ---
  /** Last few project states kept independent of the undo stack, so a bug that
   *  corrupts past[] can't also lose everything. Fed on the autosave tick. */
  rollback: Project[]
  /** Push the current project onto the rollback ring (capped at 4 entries). */
  pushRollback: () => void
  /** Roll back to the newest rollback entry (or no-op if empty). */
  rollbackOnce: () => void

  // --- project file ---
  /** Path of the saved project file, or null if never saved. */
  projectFilePath: string | null
  /** The project as of the last save/load — used to derive "dirty". */
  savedProject: Project
  loadProject: (project: Project, filePath: string | null) => void
  newProject: () => void
  markSaved: (filePath: string) => void

  // --- export ---
  exportOpen: boolean
  setExportOpen: (open: boolean) => void

  // --- AI subtitles ---
  transcribeOpen: boolean
  setTranscribeOpen: (open: boolean) => void

  // --- settings / options ---
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  // --- AI auto-reframe ---
  reframeOpen: boolean
  setReframeOpen: (open: boolean) => void
  /** Apply auto-reframe output: posX/posY keyframes + a static zoom. */
  applyReframe: (clipId: string, r: { posX: Keyframe[]; posY: Keyframe[]; scale: number }) => void

  // --- auto-cut silence ---
  autoCutSilenceOpen: boolean
  setAutoCutSilenceOpen: (open: boolean) => void
}

const HISTORY_LIMIT = 100

// In-memory clip clipboard (not part of undo history or the saved project). Each
// entry's startSec is relative to the copied group's leftmost clip.
let clipboard: Clip[] = []

/** History fields for a discrete, undoable mutation (always records). */
function recordHistory(s: EditorState): { past: Project[]; future: Project[] } {
  return { past: [...s.past, s.project].slice(-HISTORY_LIMIT), future: [] }
}

/**
 * Core mutation for cutting one silence range out of a clip: split at both
 * ends, ripple-delete the middle, ripple-shift markers. Operates on plain
 * clips/markers maps (no zustand `set`/history) so both the single-range
 * `cutSilenceRange` action and the bulk `applySilenceCuts` action can share
 * it without duplicating the split/ripple math or each other's undo-step
 * semantics — the former wraps one call in one recordHistory, the latter
 * wraps a whole loop of calls in ONE recordHistory for a single undo step.
 */
function applyOneSilenceCut(
  clips: EditorState['project']['clips'],
  markers: NonNullable<EditorState['project']['markers']>,
  clipId: string,
  range: { startSec: number; endSec: number }
): { clips: EditorState['project']['clips']; markers: NonNullable<EditorState['project']['markers']> } | null {
  const clip = clips[clipId]
  if (!clip) return null
  const durationSec = range.endSec - range.startSec
  if (durationSec <= 1e-4) return null

  // Split at the range end first, then the range start, so the second split's
  // offset (against the still-unsplit clip) doesn't need adjusting for the first.
  const next = { ...clips }
  let middleId = clipId
  let middleStart = range.startSec
  let middleDur = durationSec

  const atEnd = splitClipAt(clip, range.endSec)
  if (atEnd) {
    const afterId = uid('c')
    next[clipId] = atEnd.left
    next[afterId] = { ...atEnd.right, id: afterId, trackId: clip.trackId }
  }
  const beforeSplitTarget = next[clipId]
  const atStart = splitClipAt(beforeSplitTarget, range.startSec)
  if (atStart) {
    middleId = uid('c')
    next[clipId] = atStart.left
    next[middleId] = { ...atStart.right, id: middleId, trackId: clip.trackId }
    middleStart = atStart.right.startSec
    middleDur = atStart.right.durationSec
  } else {
    // The range start coincides with the clip start (no left remainder) —
    // the whole (possibly already end-split) clip IS the silent piece.
    middleStart = next[clipId].startSec
    middleDur = next[clipId].durationSec
  }

  delete next[middleId]
  const shifted = rippleShift(Object.values(next), clip.trackId, middleStart, middleDur)
  const nextClips: EditorState['project']['clips'] = {}
  for (const c of shifted) nextClips[c.id] = c
  const nextMarkers = rippleShiftMarkers(markers, middleStart, middleDur)

  return { clips: nextClips, markers: nextMarkers }
}

/** Selection after some clips are removed: drop them from the set, fix the primary. */
function pruneSelection(
  s: EditorState,
  removed: Set<string>
): { selectedClipId: string | null; selectedClipIds: Set<string> } {
  const ids = new Set([...s.selectedClipIds].filter((id) => !removed.has(id)))
  const primary =
    s.selectedClipId && !removed.has(s.selectedClipId)
      ? s.selectedClipId
      : ids.size > 0
        ? [...ids][0]
        : null
  return { selectedClipId: primary, selectedClipIds: ids }
}

/** After undo/redo swaps the project, keep only selections that still exist. */
function pruneToProject(
  s: EditorState,
  project: Project
): { selectedClipId: string | null; selectedClipIds: Set<string>; selectedMarkerId: string | null } {
  const ids = new Set([...s.selectedClipIds].filter((id) => project.clips[id]))
  const primary =
    s.selectedClipId && project.clips[s.selectedClipId] ? s.selectedClipId : ids.size > 0 ? [...ids][0] : null
  const markerOk = !!s.selectedMarkerId && (project.markers ?? []).some((m) => m.id === s.selectedMarkerId)
  return { selectedClipId: primary, selectedClipIds: ids, selectedMarkerId: markerOk ? s.selectedMarkerId : null }
}

/** A single-clip selection set + that clip as primary (the common case). */
function selectOne(clipId: string | null): {
  selectedClipId: string | null
  selectedClipIds: Set<string>
  selectedTrackId: null
  selectedMarkerId: null
} {
  return {
    selectedClipId: clipId,
    selectedClipIds: clipId ? new Set([clipId]) : new Set(),
    selectedTrackId: null,
    selectedMarkerId: null
  }
}

/** Immutably replace one clip with a shallow-merged patch. */
function patchClip(project: Project, clipId: string, patch: Partial<Clip>): Project {
  const clip = project.clips[clipId]
  if (!clip) return project
  return { ...project, clips: { ...project.clips, [clipId]: { ...clip, ...patch } } }
}

/** Drop empty tracks, and return undefined when the whole map is empty (fast path). */
function tidyKeyframes(
  kf: Partial<Record<AnimProp, Keyframe[]>>
): Partial<Record<AnimProp, Keyframe[]>> | undefined {
  const out: Partial<Record<AnimProp, Keyframe[]>> = {}
  for (const key of Object.keys(kf) as AnimProp[]) {
    const track = kf[key]
    if (track && track.length > 0) out[key] = track
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export const useEditor = create<EditorState>((set) => {
  const initialProject = defaultProject()
  return {
  project: initialProject,
  savedProject: initialProject,
  projectFilePath: null,
  playheadSec: 0,
  isPlaying: false,
  pxPerSec: 80,
  selectedClipId: null,
  selectedClipIds: new Set<string>(),
  selectedTrackId: null,
  selectedMarkerId: null,
  past: [],
  future: [],
  rollback: [],

  importMedia: (paths) =>
    set((s) => {
      const media = { ...s.project.media }
      for (const p of paths) {
        const id = uid('m')
        media[id] = {
          id,
          name: baseName(p),
          path: p,
          kind: kindFromPath(p),
          durationSec: 0 // unknown until probed (Phase 2)
        }
      }
      return { project: { ...s.project, media } }
    }),

  setMediaInfo: (mediaId, info) =>
    set((s) => {
      const m = s.project.media[mediaId]
      if (!m) return {}
      const media = { ...s.project.media, [mediaId]: { ...m, ...info } }

      // When audio gets its first real duration (was 0 before probe), extend any
      // clips that were placed with the 5 s pre-probe fallback duration and have
      // not been trimmed yet (inSec===0). Clips the user already trimmed are left
      // alone since durationSec would differ from the 5 s sentinel.
      let clips = s.project.clips
      if (m.durationSec === 0 && info.durationSec && info.durationSec > 0) {
        const next: typeof clips = {}
        for (const [id, c] of Object.entries(clips)) {
          next[id] =
            c.mediaId === mediaId && c.durationSec === 5 && c.inSec === 0
              ? { ...c, durationSec: info.durationSec }
              : c
        }
        clips = next
      }

      return { project: { ...s.project, media, clips } }
    }),

  addClipFromMedia: (mediaId, trackId, startSec) =>
    set((s) => {
      const m = s.project.media[mediaId]
      if (!m) return {}
      const duration = m.durationSec > 0 ? m.durationSec : 5 // sane default pre-probe
      const id = uid('c')
      const clip: Clip = {
        id,
        trackId,
        mediaId,
        startSec: Math.max(0, startSec),
        durationSec: duration,
        inSec: 0
      }
      return {
        ...recordHistory(s),
        project: { ...s.project, clips: { ...s.project.clips, [id]: clip } },
        ...selectOne(id)
      }
    }),

  moveClip: (clipId, startSec, trackId) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const next: Clip = {
        ...clip,
        startSec: Math.max(0, startSec),
        trackId: trackId ?? clip.trackId
      }
      return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } }
    }),

  applyTrim: (clipId, bounds) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      // A head (left-edge) trim moves the clip-relative origin, so keyframe times
      // must rebase by the same delta or the animation drifts (mirrors the split).
      const delta = bounds.startSec - clip.startSec
      const keyframes = clip.keyframes ? rebaseTracks(clip.keyframes, delta) : clip.keyframes
      // Trimming can shorten the clip below its current fade lengths. Playback/
      // export already rescale via clampFades at read time, but the STORED value
      // should match reality too (e.g. the Inspector fade slider shouldn't show
      // an 8s fade-out on a clip that's now only 3s long).
      const { fadeInSec, fadeOutSec } = clampFades(clip.fadeInSec ?? 0, clip.fadeOutSec ?? 0, bounds.durationSec)
      const next: Clip = {
        ...clip,
        startSec: bounds.startSec,
        durationSec: bounds.durationSec,
        inSec: bounds.inSec,
        fadeInSec,
        fadeOutSec,
        keyframes
      }
      return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } }
    }),

  splitAtPlayhead: () =>
    set((s) => {
      const t = s.playheadSec
      const clips = { ...s.project.clips }
      let changed = false
      for (const c of Object.values(s.project.clips)) {
        // Only split clips the playhead actually crosses (not at the very edges).
        if (t > c.startSec + 1e-4 && t < c.startSec + c.durationSec - 1e-4) {
          const offset = t - c.startSec
          const rightDur = c.durationSec - offset
          // Rebase keyframe tracks across the cut so the animation doesn't pop.
          const kf = c.keyframes ? splitTracksAt(c.keyframes, offset) : undefined
          // Split fades across the cut so the envelope isn't duplicated: the left
          // half keeps the fade-in, the right half keeps the fade-out.
          clips[c.id] = {
            ...c,
            durationSec: offset,
            fadeInSec: Math.min(c.fadeInSec ?? 0, offset),
            fadeOutSec: 0,
            keyframes: kf?.left
          }
          const rid = uid('c')
          clips[rid] = {
            ...c,
            id: rid,
            startSec: t,
            durationSec: rightDur,
            inSec: c.inSec + offset * (c.speed ?? 1), // right part reads later (scaled by speed)
            fadeInSec: 0,
            fadeOutSec: Math.min(c.fadeOutSec ?? 0, rightDur),
            keyframes: kf?.right
          }
          changed = true
        }
      }
      return changed ? { ...recordHistory(s), project: { ...s.project, clips } } : {}
    }),

  removeClip: (clipId) =>
    set((s) => {
      if (!s.project.clips[clipId]) return {}
      const clips = { ...s.project.clips }
      delete clips[clipId]
      return {
        ...recordHistory(s),
        project: { ...s.project, clips },
        ...pruneSelection(s, new Set([clipId]))
      }
    }),

  rippleDelete: (clipId) =>
    set((s) => {
      const target = s.project.clips[clipId]
      if (!target) return {}
      const clips = { ...s.project.clips }
      delete clips[clipId]
      // Pull later clips on the same track left to close the gap the clip left.
      for (const c of Object.values(clips)) {
        if (c.trackId === target.trackId && c.startSec >= target.startSec - 1e-6) {
          clips[c.id] = { ...c, startSec: Math.max(0, c.startSec - target.durationSec) }
        }
      }
      // Markers must ripple too, or they silently drift out of sync with the footage.
      const markers = rippleShiftMarkers(s.project.markers ?? [], target.startSec, target.durationSec)
      return {
        ...recordHistory(s),
        project: { ...s.project, clips, markers },
        ...pruneSelection(s, new Set([clipId]))
      }
    }),

  cutSilenceRange: (clipId, range) =>
    set((s) => {
      const cut = applyOneSilenceCut(s.project.clips, s.project.markers ?? [], clipId, range)
      if (!cut) return {}
      return { ...recordHistory(s), project: { ...s.project, clips: cut.clips, markers: cut.markers } }
    }),

  applySilenceCuts: (clipId, ranges) =>
    set((s) => {
      const trackId = s.project.clips[clipId]?.trackId
      if (!trackId) return {}
      // Ranges are detected up front, in ORIGINAL (pre-cut) timeline positions.
      // Each cut ripple-shifts everything after it, so later ranges must be
      // re-targeted against the running total already removed, and against
      // whichever clip currently spans that (shifted) position — the earlier
      // cut's "after" piece gets a fresh id that can't be predicted ahead of
      // time. One recordHistory for the WHOLE batch (not per-range) so the
      // entire auto-cut is a single undo step, matching rippleDeleteSelected's
      // convention for other multi-clip operations.
      let clips = s.project.clips
      let markers = s.project.markers ?? []
      let removed = 0
      for (const r of [...ranges].sort((a, b) => a.startSec - b.startSec)) {
        const startSec = r.startSec - removed
        const endSec = r.endSec - removed
        const target = Object.values(clips).find(
          (c) => c.trackId === trackId && startSec >= c.startSec - 1e-6 && startSec < c.startSec + c.durationSec - 1e-6
        )
        if (!target) continue // a prior cut already consumed this span; skip rather than crash
        const cut = applyOneSilenceCut(clips, markers, target.id, { startSec, endSec })
        if (!cut) continue
        clips = cut.clips
        markers = cut.markers
        removed += r.endSec - r.startSec
      }
      if (clips === s.project.clips) return {} // nothing was actually cut
      return { ...recordHistory(s), project: { ...s.project, clips, markers } }
    }),

  crossfadeWithNeighbor: (clipId) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const cEnd = clip.startSec + clip.durationSec
      // Signed distance to another clip: negative = overlapping, 0 = touching.
      const gapTo = (o: Clip): number => {
        const oEnd = o.startSec + o.durationSec
        if (oEnd <= clip.startSec) return clip.startSec - oEnd // o is to the left
        if (o.startSec >= cEnd) return o.startSec - cEnd // o is to the right
        return -1 // overlapping
      }
      let neighbor: Clip | null = null
      let best = Infinity
      for (const o of Object.values(s.project.clips)) {
        if (o.id === clipId || o.trackId !== clip.trackId) continue
        const g = gapTo(o)
        if (g < best) {
          best = g
          neighbor = o
        }
      }
      if (!neighbor || best > 0.1) return {} // nothing adjacent to crossfade with
      const [E, L] = clip.startSec <= neighbor.startSec ? [clip, neighbor] : [neighbor, clip]
      const { overlap, lStart } = computeCrossfade(E, L, useSettings.getState().defaultFadeSec)
      if (overlap <= 1e-4) return {}
      const clips = { ...s.project.clips }
      clips[E.id] = { ...E, fadeOutSec: overlap }
      clips[L.id] = { ...L, startSec: lStart, fadeInSec: overlap }
      return { ...recordHistory(s), project: { ...s.project, clips } }
    }),

  selectClip: (clipId) => set(selectOne(clipId)),

  // --- multi-select ---
  toggleClipSelection: (clipId) =>
    set((s) => {
      const ids = new Set(s.selectedClipIds)
      let primary: string | null
      if (ids.has(clipId)) {
        ids.delete(clipId)
        // Removing the primary picks another remaining member (or null).
        primary = s.selectedClipId === clipId ? (ids.size > 0 ? [...ids][ids.size - 1] : null) : s.selectedClipId
      } else {
        ids.add(clipId)
        primary = clipId // the newly added clip becomes the active/primary
      }
      return { selectedClipIds: ids, selectedClipId: primary, selectedTrackId: null, selectedMarkerId: null }
    }),

  setClipSelection: (clipIds) =>
    set(() => ({
      selectedClipIds: new Set(clipIds),
      selectedClipId: clipIds.length > 0 ? clipIds[clipIds.length - 1] : null,
      selectedTrackId: null,
      selectedMarkerId: null
    })),

  selectAllClips: () =>
    set((s) => {
      const all = Object.keys(s.project.clips)
      return {
        selectedClipIds: new Set(all),
        selectedClipId: s.selectedClipId && s.project.clips[s.selectedClipId] ? s.selectedClipId : all[0] ?? null,
        selectedTrackId: null,
        selectedMarkerId: null
      }
    }),

  clearSelection: () => set({ selectedClipId: null, selectedClipIds: new Set(), selectedMarkerId: null }),

  moveSelectedBy: (deltaSec) =>
    set((s) => {
      const ids = [...s.selectedClipIds]
      if (ids.length === 0) return {}
      let minStart = Infinity
      for (const id of ids) {
        const c = s.project.clips[id]
        if (c) minStart = Math.min(minStart, c.startSec)
      }
      const d = Math.max(deltaSec, -minStart) // leftmost clip can't cross 0
      const clips = { ...s.project.clips }
      for (const id of ids) {
        const c = clips[id]
        if (c) clips[id] = { ...c, startSec: Math.max(0, c.startSec + d) }
      }
      return { project: { ...s.project, clips } }
    }),

  removeSelectedClips: () =>
    set((s) => {
      if (s.selectedClipIds.size === 0) return {}
      const clips = { ...s.project.clips }
      for (const id of s.selectedClipIds) delete clips[id]
      return { ...recordHistory(s), project: { ...s.project, clips }, selectedClipId: null, selectedClipIds: new Set() }
    }),

  rippleDeleteSelected: () =>
    set((s) => {
      const removed = s.selectedClipIds
      if (removed.size === 0) return {}
      const clips = { ...s.project.clips }
      // Per track: total deleted duration that STARTS at or before each survivor.
      const delByTrack = new Map<string, { startSec: number; durationSec: number }[]>()
      const delRanges: { startSec: number; durationSec: number }[] = []
      for (const id of removed) {
        const c = s.project.clips[id]
        if (!c) continue
        if (!delByTrack.has(c.trackId)) delByTrack.set(c.trackId, [])
        delByTrack.get(c.trackId)!.push({ startSec: c.startSec, durationSec: c.durationSec })
        delRanges.push({ startSec: c.startSec, durationSec: c.durationSec })
      }
      for (const id of removed) delete clips[id]
      for (const c of Object.values(clips)) {
        const dels = delByTrack.get(c.trackId)
        if (!dels) continue
        let shift = 0
        for (const d of dels) if (d.startSec <= c.startSec + 1e-6) shift += d.durationSec
        if (shift > 0) clips[c.id] = { ...c, startSec: Math.max(0, c.startSec - shift) }
      }
      // Markers must ripple too, or they silently drift out of sync with the footage.
      // Same one-pass "sum against the ORIGINAL position" pattern as the clip-shift
      // above — sequentially re-shifting per range would be order-dependent (an
      // earlier shift could move a marker below a later range's own start
      // threshold, silently skipping it depending on iteration order).
      const shiftFor = (t: number): number => {
        let total = 0
        for (const d of delRanges) if (d.startSec <= t + 1e-6) total += d.durationSec
        return total
      }
      const markers = (s.project.markers ?? []).map((m) => ({
        ...m,
        timeSec: Math.max(0, m.timeSec - shiftFor(m.timeSec)),
        endSec: m.endSec != null ? Math.max(0, m.endSec - shiftFor(m.endSec)) : m.endSec
      }))
      return {
        ...recordHistory(s),
        project: { ...s.project, clips, markers },
        selectedClipId: null,
        selectedClipIds: new Set()
      }
    }),

  copySelectedClips: () =>
    set((s) => {
      const sel = [...s.selectedClipIds].map((id) => s.project.clips[id]).filter(Boolean) as Clip[]
      if (sel.length === 0) return {}
      const minStart = Math.min(...sel.map((c) => c.startSec))
      clipboard = sel.map((c) => structuredClone({ ...c, startSec: c.startSec - minStart }))
      return {}
    }),

  pasteClips: (atSec) =>
    set((s) => {
      if (clipboard.length === 0) return {}
      const clips = { ...s.project.clips }
      const newIds: string[] = []
      for (const c of clipboard) {
        if (!s.project.tracks.some((t) => t.id === c.trackId)) continue // track gone
        if (c.mediaId && !s.project.media[c.mediaId]) continue // media not in this project
        const id = uid('c')
        clips[id] = { ...structuredClone(c), id, startSec: Math.max(0, atSec + c.startSec) }
        newIds.push(id)
      }
      if (newIds.length === 0) return {}
      return {
        ...recordHistory(s),
        project: { ...s.project, clips },
        selectedClipIds: new Set(newIds),
        selectedClipId: newIds[newIds.length - 1],
        selectedTrackId: null,
        selectedMarkerId: null
      }
    }),

  // --- markers ---
  addMarker: (timeSec) =>
    set((s) => {
      const t = Math.max(0, timeSec ?? s.playheadSec)
      const markers = [...(s.project.markers ?? [])]
      if (markers.some((m) => Math.abs(m.timeSec - t) < 0.02)) return {} // dedupe (incl. region starts)
      const id = uid('mk')
      markers.push({ id, timeSec: t, color: defaultMarkerColor() })
      markers.sort((a, b) => a.timeSec - b.timeSec)
      // Establish a clean marker selection (mutual exclusion with clips/track).
      return {
        ...recordHistory(s),
        project: { ...s.project, markers },
        selectedMarkerId: id,
        selectedClipId: null,
        selectedClipIds: new Set(),
        selectedTrackId: null
      }
    }),

  removeMarker: (markerId) =>
    set((s) => {
      const markers = (s.project.markers ?? []).filter((m) => m.id !== markerId)
      return {
        ...recordHistory(s),
        project: { ...s.project, markers },
        selectedMarkerId: s.selectedMarkerId === markerId ? null : s.selectedMarkerId
      }
    }),

  updateMarker: (markerId, patch) =>
    set((s) => {
      const markers = (s.project.markers ?? []).map((m) => (m.id === markerId ? { ...m, ...patch } : m))
      if (patch.timeSec !== undefined) markers.sort((a, b) => a.timeSec - b.timeSec)
      return { project: { ...s.project, markers } }
    }),

  selectMarker: (markerId) =>
    set({ selectedMarkerId: markerId, selectedClipId: null, selectedClipIds: new Set(), selectedTrackId: null }),

  jumpMarker: (dir) =>
    set((s) => {
      // Both a marker's time and a region's end are jump stops.
      const times = (s.project.markers ?? [])
        .flatMap((m) => (m.endSec !== undefined ? [m.timeSec, m.endSec] : [m.timeSec]))
        .sort((a, b) => a - b)
      const t = s.playheadSec
      const target = dir < 0 ? [...times].reverse().find((x) => x < t - 1e-4) : times.find((x) => x > t + 1e-4)
      return target === undefined ? {} : { playheadSec: target }
    }),

  addTitle: (startSec) =>
    set((s) => {
      const { tracks, trackId } = topVideoTrack(s.project.tracks)
      const id = uid('c')
      const clip: Clip = {
        id,
        trackId,
        mediaId: null,
        startSec: Math.max(0, startSec),
        durationSec: 4,
        inSec: 0,
        role: 'title',
        text: defaultTitleText('Title'),
        effects: defaultEffects()
      }
      return {
        ...recordHistory(s),
        project: { ...s.project, tracks, clips: { ...s.project.clips, [id]: clip } },
        ...selectOne(id)
      }
    }),

  updateText: (clipId, patch) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c || !c.text) return {}
      const next: Clip = { ...c, text: { ...c.text, ...patch } }
      return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: next } } }
    }),

  updateEffects: (clipId, patch) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c) return {}
      const effects: Effects = { ...(c.effects ?? defaultEffects()), ...patch }
      return {
        project: { ...s.project, clips: { ...s.project.clips, [clipId]: { ...c, effects } } }
      }
    }),

  updateChroma: (clipId, patch) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c) return {}
      const base = c.effects ?? defaultEffects()
      const effects: Effects = { ...base, chroma: { ...base.chroma, ...patch } }
      return {
        project: { ...s.project, clips: { ...s.project.clips, [clipId]: { ...c, effects } } }
      }
    }),

  updateColor: (clipId, patch) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c) return {}
      const base = c.effects ?? defaultEffects()
      const effects: Effects = { ...base, color: { ...defaultColor(), ...base.color, ...patch } }
      return { project: patchClip(s.project, clipId, { effects }) }
    }),

  resetColor: (clipId) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c?.effects) return {}
      const effects: Effects = { ...c.effects, color: undefined }
      return { project: patchClip(s.project, clipId, { effects }) }
    }),

  importSubtitles: (cues) =>
    set((s) => {
      if (cues.length === 0) return {}
      const { tracks, trackId } = subtitleTrack(s.project.tracks)
      const clips = { ...s.project.clips }
      for (const cue of cues) {
        const id = uid('c')
        clips[id] = {
          id,
          trackId,
          mediaId: null,
          startSec: Math.max(0, cue.startSec),
          durationSec: Math.max(0.1, cue.endSec - cue.startSec),
          inSec: 0,
          role: 'subtitle',
          text: defaultSubtitleText(cue.text),
          effects: defaultEffects()
        }
      }
      return { ...recordHistory(s), project: { ...s.project, tracks, clips } }
    }),

  updateAudio: (clipId, patch) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c) return {}
      return { project: { ...s.project, clips: { ...s.project.clips, [clipId]: { ...c, ...patch } } } }
    }),

  toggleTrackMute: (trackId, muted) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) => (t.id === trackId ? { ...t, muted } : t))
      return { ...recordHistory(s), project: { ...s.project, tracks } }
    }),

  addAudioTrack: (name) =>
    set((s) => {
      const count = s.project.tracks.filter((t) => t.kind === 'audio').length
      const track: Track = {
        id: uid('t'),
        kind: 'audio',
        name: name ?? `A${count + 1}`,
        height: 52,
        muted: false,
        hidden: false
      }
      return { ...recordHistory(s), project: { ...s.project, tracks: [...s.project.tracks, track] } }
    }),

  selectTrack: (trackId) =>
    set({ selectedTrackId: trackId, selectedClipId: null, selectedClipIds: new Set(), selectedMarkerId: null }),

  updateTrack: (trackId, patch) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t))
      return { project: { ...s.project, tracks } }
    }),

  updateTrackGate: (trackId, patch) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) =>
        t.id === trackId ? { ...t, gate: { ...(t.gate ?? defaultTrackGate()), ...patch } } : t
      )
      return { project: { ...s.project, tracks } }
    }),

  updateTrackDuck: (trackId, patch) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) =>
        t.id === trackId ? { ...t, duck: { ...(t.duck ?? defaultTrackDuck()), ...patch } } : t
      )
      return { project: { ...s.project, tracks } }
    }),

  updateTrackEQ: (trackId, patch) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) =>
        t.id === trackId ? { ...t, eq: { ...(t.eq ?? defaultTrackEQ()), ...patch } } : t
      )
      return { project: { ...s.project, tracks } }
    }),

  updateTrackComp: (trackId, patch) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) =>
        t.id === trackId ? { ...t, comp: { ...(t.comp ?? defaultTrackComp()), ...patch } } : t
      )
      return { project: { ...s.project, tracks } }
    }),

  // --- transform / keyframes (no internal history; the Inspector snapshots) ---
  setStaticProp: (clipId, prop, v) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const cv = clampProp(prop, v)
      if (prop === 'opacity') {
        const effects = { ...(clip.effects ?? defaultEffects()), opacity: cv }
        return { project: patchClip(s.project, clipId, { effects }) }
      }
      const transform = withTransformProp(clip.transform ?? defaultTransform(), prop, cv)
      return { project: patchClip(s.project, clipId, { transform }) }
    }),

  setKeyframe: (clipId, prop, t, v) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const cv = clampProp(prop, v)
      const track = clip.keyframes?.[prop] ? [...clip.keyframes[prop]!] : []
      const idx = keyIndexAt(track, t)
      if (idx >= 0) track[idx] = { ...track[idx], v: cv }
      else track.push({ t, v: cv, ease: 'smooth' })
      const keyframes = { ...clip.keyframes, [prop]: sortKeys(track) }
      return { project: patchClip(s.project, clipId, { keyframes }) }
    }),

  removeKeyframe: (clipId, prop, t) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      const track = clip?.keyframes?.[prop]
      if (!clip || !track) return {}
      const kept = track.filter((kf) => Math.abs(kf.t - t) > KEY_EPS)
      const keyframes = tidyKeyframes({ ...clip.keyframes, [prop]: kept })
      return { project: patchClip(s.project, clipId, { keyframes }) }
    }),

  toggleKeyframeTrack: (clipId, prop, t, sampled) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const armed = !!clip.keyframes?.[prop]?.length
      if (armed) {
        // Disarm: bake the sampled value into the static value so nothing jumps.
        const keyframes = tidyKeyframes({ ...clip.keyframes, [prop]: [] })
        const patch: Partial<Clip> = { keyframes }
        if (prop === 'opacity') {
          patch.effects = { ...(clip.effects ?? defaultEffects()), opacity: clampProp(prop, sampled) }
        } else {
          patch.transform = withTransformProp(clip.transform ?? defaultTransform(), prop, clampProp(prop, sampled))
        }
        return { project: patchClip(s.project, clipId, patch) }
      }
      // Arm: a single key at the playhead holding the current value.
      const keyframes = { ...clip.keyframes, [prop]: [{ t, v: clampProp(prop, sampled), ease: 'smooth' as const }] }
      return { project: patchClip(s.project, clipId, { keyframes }) }
    }),

  resetTransform: (clipId) =>
    set((s) => {
      if (!s.project.clips[clipId]) return {}
      return { project: patchClip(s.project, clipId, { transform: undefined, keyframes: undefined }) }
    }),

  applyKenBurns: (clipId) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const d = clip.durationSec
      const keyframes: Partial<Record<AnimProp, Keyframe[]>> = {
        ...clip.keyframes,
        scale: [
          { t: 0, v: 1, ease: 'smooth' },
          { t: d, v: 1.18, ease: 'smooth' }
        ],
        posX: [
          { t: 0, v: -0.04, ease: 'smooth' },
          { t: d, v: 0.04, ease: 'smooth' }
        ]
      }
      return { project: patchClip(s.project, clipId, { keyframes }) }
    }),

  fillFrame: (clipId) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      const media = clip.mediaId ? s.project.media[clip.mediaId] : undefined
      const iw = media?.width ?? 0
      const ih = media?.height ?? 0
      let scale = 1
      if (iw > 0 && ih > 0) {
        const W = s.project.width
        const H = s.project.height
        scale = Math.max(W / iw, H / ih) / Math.min(W / iw, H / ih) // cover / contain
      }
      const transform = withTransformProp(clip.transform ?? defaultTransform(), 'scale', scale)
      return { project: patchClip(s.project, clipId, { transform }) }
    }),

  setSpeed: (clipId, speed) =>
    set((s) => {
      const c = s.project.clips[clipId]
      if (!c) return {}
      let sp = clampSpeed(speed)
      const media = c.mediaId ? s.project.media[c.mediaId] : null
      let durationSec = c.durationSec
      if (media && media.durationSec > 0) {
        const avail = Math.max(0, media.durationSec - c.inSec)
        // Don't let the requested speed force the clip's source span past the
        // remaining source below the minimum length (which would over-read).
        if (avail > 0) sp = Math.min(sp, Math.max(MIN_SPEED, avail / MIN_CLIP_SEC))
        // Source consumed = durationSec * speed; keep it within the media length.
        durationSec = Math.max(MIN_CLIP_SEC, Math.min(c.durationSec, avail / sp))
      }
      return { project: patchClip(s.project, clipId, { speed: sp, durationSec }) }
    }),

  setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(600, Math.max(10, pxPerSec)) }),

  snapshot: () =>
    set((s) => {
      // Dedupe: if the latest snapshot is already this exact project, do nothing.
      if (s.past.length > 0 && s.past[s.past.length - 1] === s.project) return {}
      return { past: [...s.past, s.project].slice(-HISTORY_LIMIT), future: [] }
    }),

  // Rollback ring is independent of the undo stack (a bug that corrupts past[]
  // shouldn't also lose the net). Capped at 4 references — cheap, and deep
  // enough to step out of a recent degenerate state.
  pushRollback: () =>
    set((s) => ({
      rollback: [...s.rollback, s.project].slice(-4)
    })),

  rollbackOnce: () =>
    set((s) => {
      if (s.rollback.length === 0) return {}
      const prev = s.rollback[s.rollback.length - 1]
      // Keep media (probes aren't part of rollback), like undo does.
      return {
        project: { ...prev, media: s.project.media },
        rollback: s.rollback.slice(0, -1)
      }
    }),

  undo: () =>
    set((s) => {
      if (s.past.length === 0) return {}
      const prev = s.past[s.past.length - 1]
      // Keep the current media bin (probes/imports are not part of undo history).
      const project: Project = { ...prev, media: s.project.media }
      return {
        project,
        past: s.past.slice(0, -1),
        future: [s.project, ...s.future].slice(0, HISTORY_LIMIT),
        ...pruneToProject(s, project)
      }
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return {}
      const next = s.future[0]
      const project: Project = { ...next, media: s.project.media }
      return {
        project,
        past: [...s.past, s.project].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        ...pruneToProject(s, project)
      }
    }),

  loadProject: (project, filePath) => {
    clipboard = [] // don't leak clips across documents
    set({
      project,
      savedProject: project,
      projectFilePath: filePath,
      past: [],
      future: [],
      rollback: [],
      selectedClipId: null,
      selectedClipIds: new Set(),
      selectedMarkerId: null,
      selectedTrackId: null,
      playheadSec: 0,
      isPlaying: false
    })
  },

  newProject: () => {
    clipboard = [] // don't leak clips across documents
    const fresh = defaultProject()
    set({
      project: fresh,
      savedProject: fresh,
      projectFilePath: null,
      past: [],
      future: [],
      rollback: [],
      selectedClipId: null,
      selectedClipIds: new Set(),
      selectedMarkerId: null,
      selectedTrackId: null,
      playheadSec: 0,
      isPlaying: false
    })
  },

  markSaved: (filePath) =>
    set((s) => {
      void window.cutroom?.clearRecoveryRing()
      return { savedProject: s.project, projectFilePath: filePath }
    }),

  exportOpen: false,
  setExportOpen: (open) => set({ exportOpen: open }),

  transcribeOpen: false,
  setTranscribeOpen: (open) => set({ transcribeOpen: open }),

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  reframeOpen: false,
  setReframeOpen: (open) => set({ reframeOpen: open }),
  applyReframe: (clipId, r) =>
    set((s) => {
      const clip = s.project.clips[clipId]
      if (!clip) return {}
      // Drop any existing scale TRACK, else it would override the static zoom we
      // write below (the sampler prefers a keyframe track over the static value).
      const restKf = { ...clip.keyframes }
      delete restKf.scale
      const keyframes = tidyKeyframes({ ...restKf, posX: r.posX, posY: r.posY })
      const transform = withTransformProp(clip.transform ?? defaultTransform(), 'scale', r.scale)
      return { ...recordHistory(s), project: patchClip(s.project, clipId, { transform, keyframes }) }
    }),

  autoCutSilenceOpen: false,
  setAutoCutSilenceOpen: (open) => set({ autoCutSilenceOpen: open })
  }
})
