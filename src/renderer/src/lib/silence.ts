// ---------------------------------------------------------------------------
// RMS-based silence detection over a decoded AudioBuffer. Adapts audioCache.ts's
// computePeaks() windowing (same getChannelData walk) but computes RMS
// (sqrt(mean(x^2))) per window instead of abs-max peak, since RMS reflects
// perceived loudness — what "silence" means to a human ear — whereas peak only
// reflects transient spikes. Kept as a separate pure file (no cache/state) so
// it stays trivially unit-testable with a synthetic AudioBuffer.
// ---------------------------------------------------------------------------

export interface SilenceRange {
  startSec: number
  endSec: number
}

export interface FindSilencesOptions {
  /** RMS level below which a window counts as silent, in dBFS (e.g. -40). */
  thresholdDb: number
  /** A silent run must span at least this long to count as a cut candidate
   *  (avoids chopping natural breath pauses). */
  minSilenceSec: number
  /** After merging, any two silences separated by less than this much speech
   *  are merged into one (avoids leaving unusably tiny slivers of "clip"
   *  between two near-adjacent silences). */
  minClipSec: number
}

const ANALYSIS_WINDOWS_PER_SEC = 50

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * Detect silent ranges in `buffer` (channel 0, matching computePeaks' single-
 * channel convention) using windowed RMS against `thresholdDb`. Returns ranges
 * sorted by startSec, each satisfying minSilenceSec, with adjacent silences
 * closer than minClipSec merged together.
 */
export function findSilences(buffer: AudioBuffer, opts: FindSilencesOptions): SilenceRange[] {
  const data = buffer.getChannelData(0)
  const total = Math.max(1, Math.ceil(buffer.duration * ANALYSIS_WINDOWS_PER_SEC))
  const per = Math.max(1, Math.floor(buffer.length / total))
  const thresholdLinear = dbToLinear(opts.thresholdDb)

  const silentWindow: boolean[] = new Array(total)
  for (let i = 0; i < total; i++) {
    const start = i * per
    const end = Math.min(buffer.length, start + per)
    let sumSq = 0
    for (let j = start; j < end; j++) sumSq += data[j] * data[j]
    const rms = Math.sqrt(sumSq / Math.max(1, end - start))
    silentWindow[i] = rms < thresholdLinear
  }

  const secPerWindow = 1 / ANALYSIS_WINDOWS_PER_SEC
  const ranges: SilenceRange[] = []
  let runStart = -1
  for (let i = 0; i <= total; i++) {
    const silent = i < total && silentWindow[i]
    if (silent && runStart < 0) runStart = i
    else if (!silent && runStart >= 0) {
      const startSec = runStart * secPerWindow
      const endSec = i * secPerWindow
      if (endSec - startSec >= opts.minSilenceSec) ranges.push({ startSec, endSec })
      runStart = -1
    }
  }

  const merged: SilenceRange[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.startSec - last.endSec < opts.minClipSec) last.endSec = r.endSec
    else merged.push({ ...r })
  }
  return merged
}
