import type { Track, TrackDuck } from '../types'

/**
 * The effective ducking config for `track`, or null when ducking cannot apply:
 * the track isn't audio, ducking is disabled, there's no trigger, the trigger is
 * itself, or the trigger track is missing / muted / not an audio track.
 *
 * This is the ONE place duck validity is decided, shared by the preview audio
 * graph (audioPool) and the export plan (exporter) so they can never diverge.
 */
export function resolveDuck(track: Track, tracks: Track[]): TrackDuck | null {
  if (track.kind !== 'audio') return null
  const d = track.duck
  if (!d || !d.enabled || !d.triggerTrackId) return null
  if (d.triggerTrackId === track.id) return null // self-trigger
  const trig = tracks.find((t) => t.id === d.triggerTrackId)
  if (!trig || trig.muted || trig.kind !== 'audio') return null
  return d
}
