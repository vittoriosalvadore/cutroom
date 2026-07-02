// ---------------------------------------------------------------------------
// Pure keyframe/sample-index math over a parsed mp4box file. Extracted from
// the demuxer so the "which sample do I start decoding from for time T"
// decision is unit-testable without a real video file.
//
// A "sample" here is mp4box terminology for one encoded frame: its byte range
// (offset+size), its timestamp, and whether it's a sync sample (keyframe).
//
// IMPORTANT: samples are stored in DECODE order (dts order). With B-frames the
// presentation time (cts) is NOT monotonic across that array — a linear walk
// that breaks at the first time > target stops too early. Every search here
// scans the full array (a few thousand entries — microseconds) instead of
// assuming monotonic times.
// ---------------------------------------------------------------------------

/** One encoded sample (frame) from mp4box's sample tables, in decode order. */
export interface SampleEntry {
  /** True for keyframes (sync samples) — decode can (re)start here. */
  isSync: boolean
  /** Byte offset of the sample's data in the file. */
  offset: number
  /** Size in bytes of the sample's data. */
  size: number
  /** Presentation timestamp (cts), in seconds. NOT monotonic with B-frames. */
  time: number
  /** Duration of this frame, in seconds. */
  duration: number
}

/**
 * Decode-order index of the sample PRESENTED at `timeSec`: the one with the
 * largest presentation time <= timeSec. Falls back to the earliest-presented
 * sample when timeSec is before the first frame.
 */
export function findSampleAtOrBefore(samples: SampleEntry[], timeSec: number): number {
  let best = -1
  let bestTime = -Infinity
  let earliest = 0
  let earliestTime = Infinity
  for (let i = 0; i < samples.length; i++) {
    const t = samples[i].time
    if (t <= timeSec && t > bestTime) {
      bestTime = t
      best = i
    }
    if (t < earliestTime) {
      earliestTime = t
      earliest = i
    }
  }
  return best >= 0 ? best : earliest
}

/**
 * Index of the keyframe decode must (re)start from to reach the frame at
 * `timeSec`: the nearest sync sample at or before the target's DECODE index.
 * (Walking back in decode order is correct even with B-frames — a decoder can
 * always start at a sync sample and feed forward.)
 */
export function findKeyframeBefore(samples: SampleEntry[], timeSec: number): number {
  if (samples.length === 0) return 0
  const target = findSampleAtOrBefore(samples, timeSec)
  for (let i = target; i >= 0; i--) {
    if (samples[i].isSync) return i
  }
  return 0
}

/**
 * The contiguous byte span covering samples [from, to] (decode order), for one
 * Range request. Interleaved audio chunks sitting between video samples are
 * fetched too — wasteful but simple, and reads are from local disk.
 */
export function sampleByteSpan(
  samples: SampleEntry[],
  from: number,
  to: number
): { start: number; end: number } | null {
  if (from > to || from < 0 || to >= samples.length) return null
  let start = Infinity
  let end = -Infinity
  for (let i = from; i <= to; i++) {
    const s = samples[i]
    if (s.size <= 0) continue
    start = Math.min(start, s.offset)
    end = Math.max(end, s.offset + s.size)
  }
  if (!Number.isFinite(start) || end <= start) return null
  return { start, end }
}
