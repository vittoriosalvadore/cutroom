// ---------------------------------------------------------------------------
// Pure keyframe/sample-index math over a parsed mp4box file. Extracted from
// the demuxer so the "which sample do I start decoding from for time T"
// decision is unit-testable without a real video file.
//
// A "sample" here is mp4box terminology for one encoded frame: its byte range
// (offset+size), its timestamp, and whether it's a sync/sample (keyframe).
// ---------------------------------------------------------------------------

/** One decoded sample (frame) from mp4box's sample tables. */
export interface SampleEntry {
  /** True for keyframes (sync samples) — decode can (re)start here. */
  isSync: boolean
  /** Byte offset of the sample's data in the file. */
  offset: number
  /** Size in bytes of the sample's data. */
  size: number
  /** Presentation timestamp, in seconds. */
  time: number
  /** Duration of this frame, in seconds. */
  duration: number
}

/**
 * Index of the keyframe at or before `timeSec` — the sample decode must
 * (re)start from to reach the frame at `timeSec`. Returns the last keyframe's
 * index if `timeSec` is past the end, and the first index if before the start.
 */
export function findKeyframeBefore(samples: SampleEntry[], timeSec: number): number {
  if (samples.length === 0) return 0
  // Find the last sample whose time is <= timeSec.
  let lastAtOrBefore = 0
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].time <= timeSec) lastAtOrBefore = i
    else break
  }
  // Walk back to the nearest sync sample at or before it.
  for (let i = lastAtOrBefore; i >= 0; i--) {
    if (samples[i].isSync) return i
  }
  return 0
}
