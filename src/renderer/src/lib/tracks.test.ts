import { describe, it, expect } from 'vitest'
import {
  canRemoveTrack,
  clampTrackHeight,
  clipsInMarquee,
  moveTrackTo,
  newVideoTrackIndex,
  nextTrackName,
  trackDropTarget,
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT
} from './tracks'
import type { Clip, Track } from '../types'

function track(id: string, kind: Track['kind'], height = 50, role?: 'subtitle'): Track {
  return { id, kind, name: id.toUpperCase(), height, muted: false, hidden: false, role }
}

function clip(id: string, trackId: string, startSec: number, durationSec: number): Clip {
  return { id, trackId, mediaId: null, startSec, durationSec, inSec: 0 }
}

describe('clampTrackHeight', () => {
  it('clamps to the lane bounds and rounds', () => {
    expect(clampTrackHeight(10)).toBe(MIN_TRACK_HEIGHT)
    expect(clampTrackHeight(999)).toBe(MAX_TRACK_HEIGHT)
    expect(clampTrackHeight(80.4)).toBe(80)
    expect(clampTrackHeight(NaN)).toBe(MIN_TRACK_HEIGHT)
  })
})

describe('nextTrackName', () => {
  it('picks the first free number per kind', () => {
    const tracks = [track('v1', 'video'), track('v3', 'video'), track('a1', 'audio')]
    expect(nextTrackName(tracks, 'video')).toBe('V2')
    expect(nextTrackName(tracks, 'audio')).toBe('A2')
  })
})

describe('canRemoveTrack', () => {
  it('keeps the last plain video track and the last audio track', () => {
    const tracks = [track('s', 'video', 50, 'subtitle'), track('v1', 'video'), track('a1', 'audio')]
    expect(canRemoveTrack(tracks, 'v1')).toBe(false) // the subtitle lane doesn't count
    expect(canRemoveTrack(tracks, 'a1')).toBe(false)
    expect(canRemoveTrack(tracks, 's')).toBe(true)
    expect(canRemoveTrack([...tracks, track('v2', 'video')], 'v1')).toBe(true)
    expect(canRemoveTrack(tracks, 'nope')).toBe(false)
  })
})

describe('newVideoTrackIndex', () => {
  it('goes above the topmost video track but under the subtitle lane', () => {
    expect(newVideoTrackIndex([track('v1', 'video'), track('a1', 'audio')])).toBe(0)
    expect(newVideoTrackIndex([track('s', 'video', 50, 'subtitle'), track('v1', 'video')])).toBe(1)
    expect(newVideoTrackIndex([track('s', 'video', 50, 'subtitle'), track('a1', 'audio')])).toBe(1)
    expect(newVideoTrackIndex([track('a1', 'audio')])).toBe(0)
  })
})

describe('moveTrackTo', () => {
  const tracks = [track('a', 'video'), track('b', 'video'), track('c', 'audio')]
  it('moves a track to its final index', () => {
    expect(moveTrackTo(tracks, 'a', 2).map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(moveTrackTo(tracks, 'c', 0).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })
  it('returns the same array for a no-op or unknown id, and clamps', () => {
    expect(moveTrackTo(tracks, 'b', 1)).toBe(tracks)
    expect(moveTrackTo(tracks, 'zz', 0)).toBe(tracks)
    expect(moveTrackTo(tracks, 'a', 99).map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('trackDropTarget', () => {
  // Lanes at content y: a [0,50) b [50,100) c [100,150)
  const tracks = [track('a', 'video'), track('b', 'video'), track('c', 'audio')]
  it('maps a y to the nearest boundary and the final index', () => {
    expect(trackDropTarget(tracks, 'c', 10)).toEqual({ gap: 0, index: 0 })
    expect(trackDropTarget(tracks, 'a', 80)).toEqual({ gap: 2, index: 1 }) // below b
    expect(trackDropTarget(tracks, 'a', 500)).toEqual({ gap: 3, index: 2 })
    expect(trackDropTarget(tracks, 'b', 60)).toEqual({ gap: 1, index: 1 }) // stays put
  })
})

describe('clipsInMarquee', () => {
  // v1 [0,60) a1 [60,110)
  const tracks = [track('v1', 'video', 60), track('a1', 'audio', 50)]
  const clips = {
    c1: clip('c1', 'v1', 0, 5),
    c2: clip('c2', 'v1', 10, 5),
    c3: clip('c3', 'a1', 3, 4),
    orphan: clip('orphan', 'gone', 0, 100)
  }
  it('selects clips whose box intersects, in any drag direction', () => {
    expect(clipsInMarquee(tracks, clips, { t0: 4, t1: 11, y0: 20, y1: 30 }).sort()).toEqual(['c1', 'c2'])
    expect(clipsInMarquee(tracks, clips, { t0: 6, t1: 2, y0: 100, y1: 40 }).sort()).toEqual(['c1', 'c3'])
  })
  it('misses clips outside the time or lane span, honoring the pad', () => {
    expect(clipsInMarquee(tracks, clips, { t0: 5.5, t1: 9, y0: 0, y1: 200 })).toEqual(['c3'])
    // y 57..59 is inside v1 but inside its 5px pad, and above a1
    expect(clipsInMarquee(tracks, clips, { t0: 0, t1: 20, y0: 57, y1: 59 }, 5)).toEqual([])
  })
})
