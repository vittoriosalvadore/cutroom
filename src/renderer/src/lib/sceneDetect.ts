import type { Clip, Project } from '../types'
import { clipRelToSource, clipSpeed } from './clipTime'
import { alignSplitTimes } from './editing'
import { withFrameGrabber } from './frameSampling'
import { TIME_EPSILON_SEC } from './sampleTable'
import { JobCancelled } from './workerJob'

// ---------------------------------------------------------------------------
// Algorithmic (non-ML) hard-cut detection. Deterministic and fast — the
// classical technique for hard cuts (soft dissolves are a separate, harder
// problem, out of scope here):
//  1. coarse pass: a coarse colour histogram every ~intervalSec of footage;
//     consecutive samples whose histograms jump past `threshold` flag a window;
//  2. refine: bisect each flagged window down to two ADJACENT frames, so the
//     cut lands exactly on the first frame of the new shot;
//  3. confirm: a hard cut still jumps between those two frames, whereas a pan,
//     fast motion or a fade that drifted past the threshold over a whole coarse
//     interval barely changes from one frame to the next — dropped.
// Frames are addressed by TIMELINE frame index on the project's frame grid,
// each read from the source frame the export renders there (speed-aware), so
// every cut lands on a frame boundary of the sequence.
// ---------------------------------------------------------------------------

export interface SceneDetectOptions {
  /** Seconds of FOOTAGE (source time) between coarse samples. Smaller = slower
   *  but fewer cuts hidden in one window. */
  intervalSec: number
  /** Normalized histogram-distance threshold (0..1) above which a jump between
   *  consecutive samples is flagged as a cut. Lower = more (and more false-
   *  positive-prone) candidates. */
  threshold: number
}

export interface SceneDetectProgress {
  stage: 'sampling' | 'refining' | 'done'
  /** 0..1 within the current stage. */
  progress?: number
}

export interface SceneCut {
  /** Absolute TIMELINE time of the new shot's first frame (a frame boundary). */
  atSec: number
  /** Histogram jump across the cut, 0..1 — how clear-cut it is. */
  score: number
}

/** A frame's colour signature: per-channel normalized bins (see computeHistogram). */
export type Histogram = Float32Array

const HIST_BINS = 16
// Guards a very long clip + small interval from an unbounded seek count: the
// coarse step widens instead (refinement still pins each cut to one frame).
const MAX_COARSE_SAMPLES = 600
// A flagged window survives refinement only if the jump between its two final
// adjacent frames is still at least this fraction of the threshold.
const CONFIRM_RATIO = 0.5

/** Per-channel (R,G,B) normalized 16-bin histogram of a downscaled frame. */
export function computeHistogram(image: { data: ArrayLike<number> }): Histogram {
  const hist = new Float32Array(HIST_BINS * 3)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    hist[Math.min(HIST_BINS - 1, (data[i] * HIST_BINS) >> 8)] += 1
    hist[HIST_BINS + Math.min(HIST_BINS - 1, (data[i + 1] * HIST_BINS) >> 8)] += 1
    hist[HIST_BINS * 2 + Math.min(HIST_BINS - 1, (data[i + 2] * HIST_BINS) >> 8)] += 1
  }
  // Normalize each channel's bins to sum to 1, so distance is frame-size-independent.
  for (let c = 0; c < 3; c++) {
    let sum = 0
    for (let i = 0; i < HIST_BINS; i++) sum += hist[c * HIST_BINS + i]
    if (sum > 0) for (let i = 0; i < HIST_BINS; i++) hist[c * HIST_BINS + i] /= sum
  }
  return hist
}

/** L1 distance between two normalized 3-channel histograms, scaled to 0..1
 *  (each channel's L1 distance between two probability distributions maxes
 *  at 2; summed over 3 channels and divided by 6). */
export function histogramDistance(a: Histogram, b: Histogram): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / (2 * 3)
}

/** First and last timeline frame (index on the `fps` grid) that show the clip —
 *  the compositor draws it for start <= t < end — or null under two frames. */
export function clipFrameSpan(
  clip: Pick<Clip, 'startSec' | 'durationSec'>,
  fps: number
): { first: number; last: number } | null {
  const first = Math.max(0, Math.ceil(clip.startSec * fps - 1e-6))
  const last = Math.ceil((clip.startSec + clip.durationSec) * fps - 1e-6) - 1
  return last > first ? { first, last } : null
}

/**
 * SOURCE time to read for timeline frame `frame`: where the export samples it
 * (inSec + (frame/fps - startSec) * speed), nudged past that point by the
 * export's own frame-lookup slack. When footage and sequence share a frame
 * rate the point sits exactly ON a source frame boundary, where a seek may
 * show either neighbour; nudged, it shows the frame the export renders.
 */
export function frameSourceTime(
  clip: Pick<Clip, 'startSec' | 'durationSec' | 'inSec' | 'speed'>,
  fps: number,
  frame: number
): number {
  return clipRelToSource(clip, frame / fps - clip.startSec) + TIME_EPSILON_SEC
}

/** Coarse sample frames: every `step` frames from `first`, always ending on
 *  `last`, with the step widened so there are at most `maxSamples` of them. */
export function coarseFrames(first: number, last: number, step: number, maxSamples: number): number[] {
  const s = Math.max(1, Math.round(step), Math.ceil((last - first) / Math.max(1, maxSamples - 1)))
  const frames: number[] = []
  for (let k = first; k < last; k += s) frames.push(k)
  frames.push(last)
  return frames
}

/**
 * Narrow a flagged window to the cut itself: frame `lo` shows the outgoing shot
 * (histogram `hLo`) and frame `hi` the incoming one (`hHi`). Each midpoint
 * replaces whichever end it resembles more — the nearer frames also absorb any
 * gradual motion — until the two are adjacent. `frame` is then the first frame
 * of the new shot and `score` the jump between the two.
 */
export async function bisectCut(
  lo: number,
  hLo: Histogram,
  hi: number,
  hHi: Histogram,
  histAt: (frame: number) => Promise<Histogram>,
  shouldCancel: () => boolean = () => false
): Promise<{ frame: number; score: number }> {
  while (hi - lo > 1) {
    if (shouldCancel()) throw new JobCancelled()
    const mid = Math.floor((lo + hi) / 2)
    const h = await histAt(mid)
    if (histogramDistance(h, hLo) <= histogramDistance(h, hHi)) {
      lo = mid
      hLo = h
    } else {
      hi = mid
      hHi = h
    }
  }
  return { frame: hi, score: histogramDistance(hLo, hHi) }
}

/**
 * The detector proper, decoupled from decoding so it is unit-testable: `histAt`
 * returns the histogram of a timeline frame. Samples the (sorted) coarse
 * `frames`, bisects every window whose ends differ by at least `threshold`, and
 * keeps the cuts that still jump frame-to-frame. Returns cut frames, ascending.
 */
export async function findCuts(
  frames: number[],
  threshold: number,
  histAt: (frame: number) => Promise<Histogram>,
  onProgress: (p: SceneDetectProgress) => void = () => undefined,
  shouldCancel: () => boolean = () => false
): Promise<{ frame: number; score: number }[]> {
  const hists: Histogram[] = []
  for (let i = 0; i < frames.length; i++) {
    if (shouldCancel()) throw new JobCancelled()
    hists.push(await histAt(frames[i]))
    onProgress({ stage: 'sampling', progress: (i + 1) / frames.length })
  }

  const flagged: number[] = []
  for (let i = 1; i < hists.length; i++) {
    if (histogramDistance(hists[i - 1], hists[i]) >= threshold) flagged.push(i)
  }

  const cuts: { frame: number; score: number }[] = []
  for (let f = 0; f < flagged.length; f++) {
    const i = flagged[f]
    const cut = await bisectCut(frames[i - 1], hists[i - 1], frames[i], hists[i], histAt, shouldCancel)
    if (cut.score >= threshold * CONFIRM_RATIO) cuts.push(cut)
    onProgress({ stage: 'refining', progress: (f + 1) / flagged.length })
  }
  // Stop pressed during the last refinement step: don't hand back cuts.
  if (shouldCancel()) throw new JobCancelled()
  return cuts
}

/**
 * Detect hard cuts in a video clip. Each cut's `atSec` is an absolute timeline
 * time on the project's frame grid, already cleaned by alignSplitTimes (no
 * sliver pieces at the clip edges or between cuts), so it can go straight to
 * splitClipAtTimes / addMarkers.
 */
export async function detectScenes(
  project: Project,
  clip: Clip,
  opts: SceneDetectOptions,
  onProgress: (p: SceneDetectProgress) => void,
  shouldCancel: () => boolean = () => false
): Promise<SceneCut[]> {
  const media = clip.mediaId ? project.media[clip.mediaId] : null
  if (!media || media.kind !== 'video' || !media.path) {
    throw new Error('Scene detection needs a video clip.')
  }
  const fps = project.fps > 0 ? project.fps : 30
  const span = clipFrameSpan(clip, fps)
  let found: { frame: number; score: number }[] = []
  if (span) {
    // The interval is footage time — how much the picture may change between
    // two samples is what the threshold is tuned against — so a sped-up clip
    // is sampled proportionally more densely on the timeline.
    const step = (Math.max(0.01, opts.intervalSec) / clipSpeed(clip)) * fps
    const frames = coarseFrames(span.first, span.last, step, MAX_COARSE_SAMPLES)
    found = await withFrameGrabber(media.path, (grab) =>
      findCuts(
        frames,
        opts.threshold,
        async (k) => computeHistogram(await grab(frameSourceTime(clip, fps, k))),
        onProgress,
        shouldCancel
      )
    )
  }

  const score = new Map(found.map((c) => [c.frame, c.score]))
  const cuts = alignSplitTimes(
    clip,
    found.map((c) => c.frame / fps),
    fps
  ).map((atSec) => ({ atSec, score: score.get(Math.round(atSec * fps)) ?? 0 }))
  onProgress({ stage: 'done' })
  return cuts
}
