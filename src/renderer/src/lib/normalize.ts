import type { Project } from '../types'
import { getAudioEntry } from './audioCache'

// ---------------------------------------------------------------------------
// Peak normalization helper. Finds the loudest sample across a track's audible
// clips (from the decoded buffers) so a one-click "Normalize" can set the track
// gain to bring that peak to a target headroom. Because it only changes the
// track gain, preview and export stay identical (no new filter, perfect parity).
// ---------------------------------------------------------------------------

/** Max absolute sample over all audible clips on a track, or null if none decoded. */
export function trackPeak(project: Project, trackId: string): number | null {
  let peak = 0
  let analyzed = false
  for (const clip of Object.values(project.clips)) {
    if (clip.trackId !== trackId || !clip.mediaId) continue
    const media = project.media[clip.mediaId]
    if (!media || media.kind === 'image') continue
    const entry = getAudioEntry(clip.mediaId)
    if (!entry || entry.status !== 'ready' || !entry.buffer) continue
    const buf = entry.buffer
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
    const sr = buf.sampleRate
    const i0 = Math.max(0, Math.floor(clip.inSec * sr))
    const i1 = Math.min(buf.length, Math.ceil((clip.inSec + clip.durationSec * speed) * sr))
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch)
      for (let i = i0; i < i1; i++) {
        const a = Math.abs(data[i])
        if (a > peak) peak = a
      }
    }
    analyzed = true
  }
  return analyzed && peak > 0 ? peak : null
}

/**
 * Track gain (dB, clamped to the mixer range) that brings the track's peak to
 * -1 dBFS, or null if it can't be measured yet (audio still decoding).
 */
export function normalizeGainDb(project: Project, trackId: string): number | null {
  const peak = trackPeak(project, trackId)
  if (peak === null) return null
  const gain = -1 - 20 * Math.log10(peak) // bring peak to -1 dBFS
  return Math.max(-40, Math.min(6, gain))
}
