import type { Clip, Project } from '../types'
import { getOrDecodeBuffer } from './audioCache'
import { estimateThresholdDb, findSilences, type SilenceRange } from './silence'

// ---------------------------------------------------------------------------
// Auto-cut-silence: detect quiet ranges in a clip's audio and convert them to
// timeline-absolute cut ranges the store's applySilenceCuts action applies (in
// one recorded history step, re-targeting later ranges as earlier cuts ripple-
// shift the timeline — see store.ts). Detection is a pure, synchronous
// analysis over an already-decoded buffer (same cost class as audioCache's
// waveform peaks) — no worker needed. Kept separate from the modal so the
// detection math is independently testable, mirroring how autoReframe.ts/
// transcribe.ts are split from theirs.
// ---------------------------------------------------------------------------

export interface AutoCutSilenceOptions {
  /** RMS level below which audio counts as silent, in dBFS (e.g. -40). */
  thresholdDb: number
  /** A silent run must span at least this long to count as a cut candidate. */
  minSilenceSec: number
  /** Shrunk inward from each detected range before cutting, so word onsets/
   *  offsets never get clipped. */
  paddingSec: number
}

/** Merge silences separated by a shorter gap than this — avoids leaving
 *  unusably tiny slivers of "clip" between two near-adjacent pauses. Not
 *  user-facing; small enough to never swallow a real word gap. */
const MERGE_GAP_SEC = 0.2

export interface SilenceCutRange {
  startSec: number
  endSec: number
}

/**
 * Detect candidate cut ranges within `clip`'s visible span, in TIMELINE-
 * ABSOLUTE seconds. Non-destructive — only analyzes and returns candidates;
 * nothing is applied to the project. Throws if the clip has no audio.
 */
export async function detectSilenceRanges(
  project: Project,
  clip: Clip,
  opts: AutoCutSilenceOptions
): Promise<SilenceCutRange[]> {
  const media = clip.mediaId ? project.media[clip.mediaId] : null
  if (!media || !media.path) throw new Error('This clip has no audio to analyze.')
  const buffer = await getOrDecodeBuffer(media.id, media.path)

  const speed = clip.speed ?? 1
  const clipSrcStart = clip.inSec
  const clipSrcEnd = clip.inSec + clip.durationSec * speed

  const raw = findSilences(buffer, {
    thresholdDb: opts.thresholdDb,
    minSilenceSec: opts.minSilenceSec,
    minClipSec: MERGE_GAP_SEC
  })

  return rangesToTimeline(raw, clip, clipSrcStart, clipSrcEnd, opts.paddingSec)
}

/** Clip detected source-relative ranges to the clip's visible window, apply
 *  padding, and convert to timeline-absolute seconds. Exported for testing. */
export function rangesToTimeline(
  raw: SilenceRange[],
  clip: Pick<Clip, 'startSec' | 'inSec' | 'speed'>,
  clipSrcStart: number,
  clipSrcEnd: number,
  paddingSec: number
): SilenceCutRange[] {
  const speed = clip.speed ?? 1
  const toTimeline = (srcT: number): number => clip.startSec + (srcT - clip.inSec) / speed

  const out: SilenceCutRange[] = []
  for (const r of raw) {
    const start = Math.max(r.startSec, clipSrcStart)
    const end = Math.min(r.endSec, clipSrcEnd)
    if (end <= start) continue
    const paddedStart = start + paddingSec
    const paddedEnd = end - paddingSec
    if (paddedEnd <= paddedStart) continue
    out.push({ startSec: toTimeline(paddedStart), endSec: toTimeline(paddedEnd) })
  }
  return out
}

/** Total seconds that would be removed if every range were applied. */
export function totalRemovedSec(ranges: SilenceCutRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.endSec - r.startSec), 0)
}

// --- Recut-style options: automatic threshold + cutting every track ---------

export interface SilenceCutOptions extends AutoCutSilenceOptions {
  /** Pick the threshold from each clip's own noise floor (thresholdDb ignored). */
  autoThreshold: boolean
  /** Cut the span from every track (camera + separate mic stay in sync), and
   *  only where EVERY audible clip under it is silent (no one talking). */
  allTracks: boolean
}

export interface SilenceCutResult {
  ranges: SilenceCutRange[]
  /** Threshold used for the analysed clip (dBFS): the auto estimate or the slider. */
  thresholdDb: number
}

/** Timeline ranges of a clip's silences (padded), plus the threshold used. */
async function clipSilences(
  project: Project,
  clip: Clip,
  opts: SilenceCutOptions
): Promise<{ ranges: SilenceCutRange[]; thresholdDb: number }> {
  const media = clip.mediaId ? project.media[clip.mediaId] : null
  if (!media || !media.path) throw new Error('This clip has no audio to analyze.')
  const buffer = await getOrDecodeBuffer(media.id, media.path)
  const speed = clip.speed ?? 1
  const srcStart = clip.inSec
  const srcEnd = clip.inSec + clip.durationSec * speed
  const thresholdDb = opts.autoThreshold ? estimateThresholdDb(buffer, srcStart, srcEnd) : opts.thresholdDb
  const raw = findSilences(buffer, { thresholdDb, minSilenceSec: opts.minSilenceSec, minClipSec: MERGE_GAP_SEC })
  return { ranges: rangesToTimeline(raw, clip, srcStart, srcEnd, opts.paddingSec), thresholdDb }
}

/** `base` minus every span in `remove`; pieces shorter than `minSec` are dropped. Pure. */
export function subtractRanges(base: SilenceCutRange[], remove: SilenceCutRange[], minSec: number): SilenceCutRange[] {
  const cuts = [...remove].sort((a, b) => a.startSec - b.startSec)
  const out: SilenceCutRange[] = []
  for (const r of base) {
    let pieces: SilenceCutRange[] = [{ ...r }]
    for (const c of cuts) {
      if (c.endSec <= r.startSec || c.startSec >= r.endSec) continue
      const next: SilenceCutRange[] = []
      for (const p of pieces) {
        if (c.endSec <= p.startSec || c.startSec >= p.endSec) next.push(p)
        else {
          if (c.startSec > p.startSec) next.push({ startSec: p.startSec, endSec: c.startSec })
          if (c.endSec < p.endSec) next.push({ startSec: c.endSec, endSec: p.endSec })
        }
      }
      pieces = next
    }
    for (const p of pieces) if (p.endSec - p.startSec >= minSec - 1e-9) out.push(p)
  }
  return out
}

/** Speech spans of a clip on the timeline: its visible span minus its silences. */
export function speechSpans(clip: Pick<Clip, 'startSec' | 'durationSec'>, silences: SilenceCutRange[]): SilenceCutRange[] {
  return subtractRanges([{ startSec: clip.startSec, endSec: clip.startSec + clip.durationSec }], silences, 0)
}

/**
 * Detect the cuts for `clip`. With `allTracks`, every other audible clip that
 * overlaps it (unmuted track, an audio or video source with sound) is analysed
 * too, and a pause survives only where all of them are quiet — so a second
 * speaker on another mic is never cut mid-sentence. Sources without an audio
 * stream (stills, mute video) simply don't count.
 */
export async function detectSilenceCuts(project: Project, clip: Clip, opts: SilenceCutOptions): Promise<SilenceCutResult> {
  const own = await clipSilences(project, clip, opts)
  if (!opts.allTracks) return own
  const span = { startSec: clip.startSec, endSec: clip.startSec + clip.durationSec }
  const trackById = new Map(project.tracks.map((t) => [t.id, t]))
  const speech: SilenceCutRange[] = []
  for (const other of Object.values(project.clips)) {
    if (other.id === clip.id || !other.mediaId) continue
    if (other.startSec >= span.endSec || other.startSec + other.durationSec <= span.startSec) continue
    const track = trackById.get(other.trackId)
    const media = project.media[other.mediaId]
    if (!track || track.muted || !media || (media.kind !== 'audio' && media.kind !== 'video')) continue
    try {
      const { ranges } = await clipSilences(project, other, opts)
      speech.push(...speechSpans(other, ranges))
    } catch {
      /* no decodable audio (e.g. a mute video): it can't be talking */
    }
  }
  return { ranges: subtractRanges(own.ranges, speech, opts.minSilenceSec), thresholdDb: own.thresholdDb }
}
