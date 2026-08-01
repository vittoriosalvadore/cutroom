import type { Clip, Project } from '../types'
import { JobCancelled } from './workerJob'
import { sampleFrames, type SampledFrame } from './frameSampling'

// ---------------------------------------------------------------------------
// Algorithmic (non-ML) hard-cut detection: sample frames at a fixed interval,
// compare consecutive frames' coarse color histograms, and flag jumps above a
// threshold as candidate cuts. Deterministic and fast — the standard classical
// technique for hard-cut detection (soft dissolves are a separate, harder
// problem, out of scope here). Candidates are then refined by re-sampling
// their narrow window more densely, to pin the cut time tighter than the
// coarse interval would allow on its own.
// ---------------------------------------------------------------------------

export interface SceneDetectOptions {
  /** Seconds between coarse samples. Smaller = more precise but slower. */
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
  /** Clip-relative seconds. */
  atSec: number
}

const HIST_BINS = 16
// Dense re-sample of a candidate's narrow coarse window, to pin the cut closer
// than the coarse interval alone would allow.
const REFINE_SAMPLES = 8
// Two refined candidates closer than this are the same cut (coarse windows
// can overlap when the interval is small relative to true cut spacing).
const MIN_CUT_GAP_SEC = 0.2
// Guards a very long clip + very small interval from an unbounded seek count.
const MAX_COARSE_SAMPLES = 600

/** Per-channel (R,G,B) normalized 16-bin histogram of a downscaled frame. */
export function computeHistogram(image: ImageData): Float32Array {
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
 *  at 2; averaged over 3 channels and halved). */
export function histogramDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / (2 * 3)
}

/** Index (within `frames`) of the biggest jump, or -1 if fewer than 2 frames. */
function biggestJump(frames: SampledFrame[]): { index: number; dist: number } {
  let best = -1
  let bestDist = -1
  for (let i = 1; i < frames.length; i++) {
    const dist = histogramDistance(computeHistogram(frames[i - 1].image), computeHistogram(frames[i].image))
    if (dist > bestDist) {
      bestDist = dist
      best = i
    }
  }
  return { index: best, dist: bestDist }
}

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

  const interval = Math.max(0.05, opts.intervalSec)
  const count = Math.max(2, Math.min(MAX_COARSE_SAMPLES, Math.round(clip.durationSec / interval) + 1))
  const frames = await sampleFrames(
    clip,
    media.path,
    count,
    (fraction) => onProgress({ stage: 'sampling', progress: fraction }),
    shouldCancel
  )

  const hists = frames.map((f) => computeHistogram(f.image))
  const candidateIdx: number[] = []
  for (let i = 1; i < hists.length; i++) {
    if (histogramDistance(hists[i - 1], hists[i]) >= opts.threshold) candidateIdx.push(i)
  }

  const cuts: SceneCut[] = []
  for (let ci = 0; ci < candidateIdx.length; ci++) {
    if (shouldCancel()) throw new JobCancelled()
    onProgress({ stage: 'refining', progress: (ci + 1) / candidateIdx.length })
    const i = candidateIdx[ci]
    const refined = await sampleFrames(clip, media.path, REFINE_SAMPLES, () => undefined, shouldCancel, {
      fromRelSec: frames[i - 1].t,
      toRelSec: frames[i].t
    })
    const { index } = biggestJump(refined)
    cuts.push({ atSec: index > 0 ? refined[index].t : frames[i].t })
  }

  cuts.sort((a, b) => a.atSec - b.atSec)
  const deduped: SceneCut[] = []
  for (const cut of cuts) {
    if (deduped.length === 0 || cut.atSec - deduped[deduped.length - 1].atSec > MIN_CUT_GAP_SEC) {
      deduped.push(cut)
    }
  }

  onProgress({ stage: 'done' })
  return deduped
}
