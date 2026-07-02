import type { Clip, Project } from '../types'
import { getOrDecodeBuffer } from './audioCache'
import { findSilences, type SilenceRange } from './silence'

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
