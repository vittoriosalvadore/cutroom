// ---------------------------------------------------------------------------
// Pure fade-envelope math. Kept free of WebAudio so it can be unit-tested and
// reused. Produces a schedule of gain operations relative to the moment a clip
// source starts (atOffset = seconds after start). The same linear envelope is
// mirrored by FFmpeg's afade on export.
//
// `e0` is how many seconds into the clip span playback begins (0 at the clip's
// head, >0 when the playhead enters mid-clip after a seek). The three exclusive
// regions are: inside fade-in, steady, inside fade-out.
// ---------------------------------------------------------------------------

export interface FadeParams {
  volume: number
  fadeInSec: number
  fadeOutSec: number
  durationSec: number
}

export interface FadeOp {
  kind: 'set' | 'ramp'
  value: number
  /** Seconds after the source start time. */
  atOffset: number
}

/** Clamp fades to >=0 and scale them down proportionally if they overlap. */
export function clampFades(
  fadeInSec: number,
  fadeOutSec: number,
  durationSec: number
): { fadeInSec: number; fadeOutSec: number } {
  let fi = Math.max(0, fadeInSec || 0)
  let fo = Math.max(0, fadeOutSec || 0)
  if (durationSec > 0 && fi + fo > durationSec) {
    const scale = durationSec / (fi + fo)
    fi *= scale
    fo *= scale
  }
  return { fadeInSec: fi, fadeOutSec: fo }
}

export function computeFadeSchedule(e0: number, params: FadeParams): FadeOp[] {
  const V = Math.max(0, params.volume)
  const D = params.durationSec
  const { fadeInSec: fi, fadeOutSec: fo } = clampFades(params.fadeInSec, params.fadeOutSec, D)
  const e = Math.max(0, Math.min(e0, D))
  const foStart = D - fo
  const ops: FadeOp[] = []

  const addFutureFadeOut = (): void => {
    if (fo > 0) {
      ops.push({ kind: 'set', value: V, atOffset: Math.max(0, foStart - e) })
      ops.push({ kind: 'ramp', value: 0, atOffset: Math.max(0, D - e) })
    }
  }

  if (fi > 0 && e < fi) {
    // Entered during the fade-in.
    ops.push({ kind: 'set', value: V * (e / fi), atOffset: 0 })
    ops.push({ kind: 'ramp', value: V, atOffset: fi - e })
    addFutureFadeOut()
  } else if (fo > 0 && e >= foStart) {
    // Entered during the fade-out.
    const remain = Math.max(0, D - e)
    ops.push({ kind: 'set', value: V * (remain / fo), atOffset: 0 })
    ops.push({ kind: 'ramp', value: 0, atOffset: remain })
  } else {
    // Steady region (with a fade-out still ahead, if any).
    ops.push({ kind: 'set', value: V, atOffset: 0 })
    addFutureFadeOut()
  }

  return ops
}

/**
 * The linear gain at a given clip-local time. Used to drive live (real-time
 * playing) sources like video elements, where we set the gain each frame rather
 * than schedule an envelope.
 */
export function fadeGainAt(clipTime: number, params: FadeParams): number {
  const V = Math.max(0, params.volume)
  const D = params.durationSec
  const { fadeInSec: fi, fadeOutSec: fo } = clampFades(params.fadeInSec, params.fadeOutSec, D)
  const t = Math.max(0, Math.min(clipTime, D))
  let g = V
  if (fi > 0 && t < fi) g = V * (t / fi)
  const foStart = D - fo
  if (fo > 0 && t > foStart) g = Math.min(g, V * ((D - t) / fo))
  return g
}
