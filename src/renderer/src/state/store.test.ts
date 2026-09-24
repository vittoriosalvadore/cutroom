import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditor } from './store'
import { resolveDuck } from './selectors'
import { defaultTrackGate } from '../types'
import type { Project, Track, TrackDuck } from '../types'

function makeProject(): Project {
  return {
    id: 'p',
    name: 'T',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    media: { m1: { id: 'm1', name: 'a.mp4', path: '/a.mp4', kind: 'video', durationSec: 100 } },
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', height: 68, muted: false, hidden: false }],
    clips: {
      c1: { id: 'c1', trackId: 'v1', mediaId: 'm1', startSec: 0, durationSec: 5, inSec: 0 },
      c2: { id: 'c2', trackId: 'v1', mediaId: 'm1', startSec: 5, durationSec: 5, inSec: 0 },
      c3: { id: 'c3', trackId: 'v1', mediaId: 'm1', startSec: 10, durationSec: 5, inSec: 0 }
    }
  }
}

beforeEach(() => {
  useEditor.setState({
    project: makeProject(),
    past: [],
    future: [],
    selectedClipId: null,
    selectedClipIds: new Set(),
    selectedMarkerId: null,
    playheadSec: 0
  })
})

describe('history', () => {
  it('removeClip is undoable and redoable', () => {
    useEditor.getState().removeClip('c2')
    expect(useEditor.getState().project.clips.c2).toBeUndefined()
    expect(useEditor.getState().past.length).toBe(1)

    useEditor.getState().undo()
    expect(useEditor.getState().project.clips.c2).toBeDefined()

    useEditor.getState().redo()
    expect(useEditor.getState().project.clips.c2).toBeUndefined()
  })

  it('dedupes consecutive identical snapshots', () => {
    useEditor.getState().snapshot()
    useEditor.getState().snapshot()
    expect(useEditor.getState().past.length).toBe(1)
  })

  it('treats snapshot + applyTrim as one undo step', () => {
    useEditor.getState().snapshot()
    useEditor.getState().applyTrim('c1', { startSec: 0, durationSec: 3, inSec: 0 })
    expect(useEditor.getState().project.clips.c1.durationSec).toBe(3)
    useEditor.getState().undo()
    expect(useEditor.getState().project.clips.c1.durationSec).toBe(5)
  })

  it('preserves the current media bin across undo', () => {
    useEditor.getState().removeClip('c2')
    // A probe/import lands after the edit.
    useEditor.setState((st) => ({
      project: {
        ...st.project,
        media: { ...st.project.media, m2: { id: 'm2', name: 'b', path: '/b', kind: 'video', durationSec: 50 } }
      }
    }))
    useEditor.getState().undo()
    expect(useEditor.getState().project.media.m2).toBeDefined() // media kept
    expect(useEditor.getState().project.clips.c2).toBeDefined() // edit undone
  })
})

describe('track dynamics', () => {
  beforeEach(() => {
    useEditor.setState({
      project: {
        ...makeProject(),
        tracks: [
          { id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false },
          { id: 'a2', kind: 'audio', name: 'A2', height: 52, muted: false, hidden: false }
        ]
      },
      past: [],
      future: [],
      selectedClipId: null
    })
  })

  it('updateTrackGate merges over defaults and does not record history', () => {
    useEditor.getState().updateTrackGate('a1', { enabled: true, thresholdDb: -30 })
    const t = useEditor.getState().project.tracks.find((x) => x.id === 'a1')!
    expect(t.gate?.enabled).toBe(true)
    expect(t.gate?.thresholdDb).toBe(-30)
    expect(t.gate?.ratio).toBe(defaultTrackGate().ratio) // untouched field keeps its default
    expect(useEditor.getState().past.length).toBe(0) // the Inspector snapshots, not the action
  })

  it('updateTrackDuck merges over defaults', () => {
    useEditor.getState().updateTrackDuck('a1', { enabled: true, triggerTrackId: 'a2' })
    const t = useEditor.getState().project.tracks.find((x) => x.id === 'a1')!
    expect(t.duck?.enabled).toBe(true)
    expect(t.duck?.triggerTrackId).toBe('a2')
  })
})

describe('resolveDuck', () => {
  const mkDuck = (over: Partial<TrackDuck> = {}): TrackDuck => ({
    enabled: true,
    triggerTrackId: 'a2',
    thresholdDb: -30,
    ratio: 8,
    attackMs: 15,
    releaseMs: 250,
    ...over
  })
  const a = (over: Partial<Track>): Track =>
    ({ id: 'a1', kind: 'audio', name: 'A', height: 52, muted: false, hidden: false, ...over }) as Track
  const trig = a({ id: 'a2', name: 'A2' })

  it('returns null when ducking cannot apply', () => {
    expect(resolveDuck(a({}), [a({}), trig])).toBeNull() // no duck set
    expect(resolveDuck(a({ duck: mkDuck({ enabled: false }) }), [trig])).toBeNull() // disabled
    expect(resolveDuck(a({ duck: mkDuck({ triggerTrackId: 'a1' }) }), [trig])).toBeNull() // self
    expect(resolveDuck(a({ duck: mkDuck({ triggerTrackId: 'gone' }) }), [trig])).toBeNull() // missing
    expect(resolveDuck(a({ duck: mkDuck() }), [a({ id: 'a2', muted: true })])).toBeNull() // muted trigger
    expect(resolveDuck(a({ duck: mkDuck() }), [a({ id: 'a2', kind: 'video' })])).toBeNull() // video trigger
  })

  it('returns the duck for a valid audio trigger', () => {
    const r = resolveDuck(a({ duck: mkDuck() }), [trig])
    expect(r?.triggerTrackId).toBe('a2')
  })
})

describe('rippleDelete', () => {
  it('closes the gap by shifting later clips left', () => {
    useEditor.getState().rippleDelete('c1')
    const clips = useEditor.getState().project.clips
    expect(clips.c1).toBeUndefined()
    expect(clips.c2.startSec).toBe(0)
    expect(clips.c3.startSec).toBe(5)
  })

  it('is undoable', () => {
    useEditor.getState().rippleDelete('c1')
    useEditor.getState().undo()
    const clips = useEditor.getState().project.clips
    expect(clips.c1).toBeDefined()
    expect(clips.c2.startSec).toBe(5)
  })
})

describe('transform & keyframes', () => {
  it('setKeyframe upserts sorted and replaces within epsilon', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'scale', 2, 1.5)
    st.setKeyframe('c1', 'scale', 0, 1)
    expect(useEditor.getState().project.clips.c1.keyframes!.scale!.map((k) => k.t)).toEqual([0, 2])
    st.setKeyframe('c1', 'scale', 2.00001, 1.8) // within epsilon of t=2 -> replace, not add
    const kf = useEditor.getState().project.clips.c1.keyframes!.scale!
    expect(kf.length).toBe(2)
    expect(kf[1].v).toBeCloseTo(1.8)
  })

  it('removeKeyframe drops the track then the map (identity fast path restored)', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'posX', 1, 0.5)
    st.removeKeyframe('c1', 'posX', 1)
    expect(useEditor.getState().project.clips.c1.keyframes).toBeUndefined()
  })

  it('disarming a track bakes the sampled value into the static transform', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'scale', 0, 1)
    st.setKeyframe('c1', 'scale', 4, 3)
    st.toggleKeyframeTrack('c1', 'scale', 2, 2) // disarm, sampled value 2
    const c = useEditor.getState().project.clips.c1
    expect(c.keyframes).toBeUndefined()
    expect(c.transform!.scale).toBe(2)
  })

  it('splitAtPlayhead rebases keyframe times across the cut', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'scale', 0, 1)
    st.setKeyframe('c1', 'scale', 4, 5)
    st.setPlayhead(2) // c1 spans 0..5
    st.splitAtPlayhead()
    const right = Object.values(useEditor.getState().project.clips).find(
      (c) => Math.abs(c.startSec - 2) < 1e-6 && c.trackId === 'v1'
    )!
    const rt = right.keyframes!.scale!
    expect(rt[0].t).toBe(0) // rebased to the new clip start
    expect(rt[0].v).toBeCloseTo(3) // value held at the cut (lerp of 1..5 at t=2)
  })

  it('setStaticProp on opacity writes through to effects', () => {
    useEditor.getState().setStaticProp('c1', 'opacity', 0.4)
    expect(useEditor.getState().project.clips.c1.effects!.opacity).toBe(0.4)
  })

  it('applyReframe writes posX/posY keyframes + static zoom and drops a stale scale track', () => {
    const st = useEditor.getState()
    st.applyKenBurns('c1') // leaves a scale + posX keyframe track behind
    const posX = [
      { t: 0, v: -0.1, ease: 'smooth' as const },
      { t: 4, v: 0.1, ease: 'smooth' as const }
    ]
    const posY = [{ t: 0, v: 0, ease: 'smooth' as const }]
    st.applyReframe('c1', { posX, posY, scale: 1.3 })
    const c = useEditor.getState().project.clips.c1
    expect(c.keyframes!.scale).toBeUndefined() // stale scale track dropped...
    expect(c.transform!.scale).toBe(1.3) // ...so the static zoom actually applies
    expect(c.keyframes!.posX).toEqual(posX)
    expect(useEditor.getState().past.length).toBe(1) // one undo step
  })

  it('setSpeed sets the clamped speed and keeps source in bounds', () => {
    const st = useEditor.getState()
    st.setSpeed('c1', 2)
    expect(useEditor.getState().project.clips.c1.speed).toBe(2)
    expect(useEditor.getState().project.clips.c1.durationSec).toBe(5) // 5*2=10 <= 100s media
    st.setSpeed('c1', 99)
    expect(useEditor.getState().project.clips.c1.speed).toBe(4) // clamped to MAX_SPEED
  })

  it('applyTrim clamps stored fades to the new (shorter) duration', () => {
    const st = useEditor.getState()
    st.updateAudio('c1', { fadeInSec: 2, fadeOutSec: 8 }) // c1 starts at durationSec 5
    st.applyTrim('c1', { startSec: 0, durationSec: 3, inSec: 0 }) // trim to 3s, shorter than fadeOutSec
    const clip = useEditor.getState().project.clips.c1
    expect(clip.fadeInSec! + clip.fadeOutSec!).toBeLessThanOrEqual(3)
    expect(clip.fadeOutSec!).toBeLessThan(8) // must not keep the stale, now-oversized value
  })

  it('applySilenceCuts removes the ranges and closes the gaps (single call)', () => {
    // c1 [0,5) c2 [5,10) c3 [10,15) on v1. Two 1s ranges: one inside c1, one inside c2.
    const before = Object.values(useEditor.getState().project.clips).reduce((n, c) => n + c.durationSec, 0)
    useEditor.getState().applySilenceCuts('c1', [
      { startSec: 1, endSec: 2 },
      { startSec: 7, endSec: 8 }
    ])
    const clips = Object.values(useEditor.getState().project.clips)
    const after = clips.reduce((n, c) => n + c.durationSec, 0)
    expect(before - after).toBeCloseTo(2) // exactly the 2 seconds removed, nothing else lost
    // The last clip (originally c3, starting at 10) must end up 2s earlier.
    const last = clips.reduce((a, b) => (b.startSec + b.durationSec > a.startSec + a.durationSec ? b : a))
    expect(last.startSec + last.durationSec).toBeCloseTo(13) // was 15, minus 2s removed
  })

  it('applySilenceCuts is a single undo step regardless of range count', () => {
    useEditor.getState().applySilenceCuts('c1', [
      { startSec: 1, endSec: 2 },
      { startSec: 7, endSec: 8 }
    ])
    expect(useEditor.getState().past.length).toBe(1)
    useEditor.getState().undo()
    const clips = useEditor.getState().project.clips
    expect(clips.c1).toEqual({ id: 'c1', trackId: 'v1', mediaId: 'm1', startSec: 0, durationSec: 5, inSec: 0 })
    expect(clips.c3).toEqual({ id: 'c3', trackId: 'v1', mediaId: 'm1', startSec: 10, durationSec: 5, inSec: 0 })
  })

  it('applySilenceCuts shifts markers along with the ripple', () => {
    useEditor.getState().addMarker(12) // inside c3, after both ranges
    useEditor.getState().applySilenceCuts('c1', [
      { startSec: 1, endSec: 2 },
      { startSec: 7, endSec: 8 }
    ])
    const markers = useEditor.getState().project.markers ?? []
    expect(markers[0].timeSec).toBeCloseTo(10) // 12 - 2s removed
  })

  it('applySilenceCuts skips a range with no matching clip instead of throwing', () => {
    expect(() =>
      useEditor.getState().applySilenceCuts('c1', [{ startSec: 999, endSec: 1000 }])
    ).not.toThrow()
  })

  it('applyTrim rebases keyframes on a head (left) trim', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'scale', 0, 1)
    st.setKeyframe('c1', 'scale', 4, 5)
    st.applyTrim('c1', { startSec: 2, durationSec: 3, inSec: 2 }) // head-trim c1 (0..5) by 2
    const kf = useEditor.getState().project.clips.c1.keyframes!.scale!
    expect(kf[0].t).toBe(0) // rebased to the new head
    expect(kf[0].v).toBeCloseTo(3) // value held at the cut
  })
})

describe('multi-select', () => {
  it('toggleClipSelection adds/removes and tracks the primary', () => {
    const st = useEditor.getState()
    st.selectClip('c1')
    st.toggleClipSelection('c2')
    expect([...useEditor.getState().selectedClipIds].sort()).toEqual(['c1', 'c2'])
    expect(useEditor.getState().selectedClipId).toBe('c2') // newest becomes primary
    st.toggleClipSelection('c2')
    expect([...useEditor.getState().selectedClipIds]).toEqual(['c1'])
    expect(useEditor.getState().selectedClipId).toBe('c1')
  })

  it('selectAllClips selects every clip', () => {
    useEditor.getState().selectAllClips()
    expect(useEditor.getState().selectedClipIds.size).toBe(3)
  })

  it('moveSelectedBy shifts all selected, clamped so the leftmost stays >= 0', () => {
    const st = useEditor.getState()
    st.setClipSelection(['c1', 'c2']) // c1@0, c2@5
    st.moveSelectedBy(-3) // leftmost c1@0 can't go below 0
    expect(useEditor.getState().project.clips.c1.startSec).toBe(0)
    expect(useEditor.getState().project.clips.c2.startSec).toBe(5)
    st.moveSelectedBy(2)
    expect(useEditor.getState().project.clips.c1.startSec).toBe(2)
    expect(useEditor.getState().project.clips.c2.startSec).toBe(7)
  })

  it('removeSelectedClips deletes the set in one undo step', () => {
    const st = useEditor.getState()
    st.setClipSelection(['c1', 'c2'])
    st.removeSelectedClips()
    expect(useEditor.getState().project.clips.c1).toBeUndefined()
    expect(useEditor.getState().project.clips.c2).toBeUndefined()
    expect(useEditor.getState().past.length).toBe(1)
    useEditor.getState().undo()
    expect(useEditor.getState().project.clips.c1).toBeDefined()
  })

  it('rippleDeleteSelected closes gaps per track', () => {
    const st = useEditor.getState()
    st.setClipSelection(['c1', 'c2']) // c1@0(5) c2@5(5), c3@10(5) survives
    st.rippleDeleteSelected()
    expect(useEditor.getState().project.clips.c3.startSec).toBe(0)
  })

  it('copy + paste creates fresh clips at the playhead', () => {
    const st = useEditor.getState()
    st.setClipSelection(['c2'])
    st.copySelectedClips()
    st.pasteClips(20)
    const pasted = Object.values(useEditor.getState().project.clips).find(
      (c) => Math.abs(c.startSec - 20) < 1e-6 && c.id !== 'c2'
    )
    expect(pasted).toBeDefined()
    expect(pasted!.id).not.toBe('c2')
  })

  it('pasteClips skips a clip whose media is absent in the destination project', () => {
    const st = useEditor.getState()
    st.setClipSelection(['c1'])
    st.copySelectedClips()
    useEditor.setState((s) => ({ project: { ...s.project, media: {} } })) // media bin emptied
    st.pasteClips(20)
    const pasted = Object.values(useEditor.getState().project.clips).find((c) => Math.abs(c.startSec - 20) < 1e-6)
    expect(pasted).toBeUndefined() // dangling-media clip not inserted
  })
})

describe('markers', () => {
  it('addMarker at a time, dedupes near-duplicates', () => {
    const st = useEditor.getState()
    st.addMarker(3)
    st.addMarker(3.005) // within epsilon -> ignored
    expect(useEditor.getState().project.markers!.length).toBe(1)
    expect(useEditor.getState().project.markers![0].timeSec).toBe(3)
  })

  it('jumpMarker moves to the next/prev marker (no wrap)', () => {
    const st = useEditor.getState()
    st.addMarker(2)
    st.addMarker(8)
    st.setPlayhead(0)
    st.jumpMarker(1)
    expect(useEditor.getState().playheadSec).toBe(2)
    st.jumpMarker(1)
    expect(useEditor.getState().playheadSec).toBe(8)
    st.jumpMarker(1) // no next
    expect(useEditor.getState().playheadSec).toBe(8)
    st.jumpMarker(-1)
    expect(useEditor.getState().playheadSec).toBe(2)
  })

  it('addMarker clears any clip/track selection (mutual exclusion)', () => {
    const st = useEditor.getState()
    st.selectClip('c1')
    st.addMarker(3)
    expect(useEditor.getState().selectedClipId).toBeNull()
    expect(useEditor.getState().selectedClipIds.size).toBe(0)
    expect(useEditor.getState().selectedMarkerId).not.toBeNull()
  })

  it('removeMarker is undoable', () => {
    const st = useEditor.getState()
    st.addMarker(4)
    const id = useEditor.getState().project.markers![0].id
    st.removeMarker(id)
    expect(useEditor.getState().project.markers!.length).toBe(0)
    useEditor.getState().undo()
    expect(useEditor.getState().project.markers!.length).toBe(1)
  })
})

describe('head-trim drag (applyTrim with origin)', () => {
  it('derives keyframes/fades from the drag-start clip, so trimming in and back out is lossless', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'scale', 0, 1)
    st.setKeyframe('c1', 'scale', 4, 5)
    st.updateAudio('c1', { fadeInSec: 2, fadeOutSec: 2 })
    const origin = useEditor.getState().project.clips.c1
    // Simulated pointer moves: drag the head in to 4s (length 1s), then back to 0.
    st.applyTrim('c1', { startSec: 2, durationSec: 3, inSec: 2 }, origin)
    st.applyTrim('c1', { startSec: 4, durationSec: 1, inSec: 4 }, origin)
    st.applyTrim('c1', { startSec: 0, durationSec: 5, inSec: 0 }, origin)
    const c1 = useEditor.getState().project.clips.c1
    expect(c1.keyframes!.scale!.map((k) => [k.t, k.v])).toEqual([
      [0, 1],
      [4, 5]
    ])
    expect(c1.fadeInSec).toBe(2)
    expect(c1.fadeOutSec).toBe(2)
  })

  it('without origin still rebases off the current clip (2-arg behaviour)', () => {
    const st = useEditor.getState()
    st.setKeyframe('c1', 'scale', 4, 5)
    st.applyTrim('c1', { startSec: 1, durationSec: 4, inSec: 1 })
    expect(useEditor.getState().project.clips.c1.keyframes!.scale!.at(-1)!.t).toBe(3)
  })
})

describe('dirty tracking', () => {
  it('loadProject marks a normal open clean and a recovered project dirty', () => {
    const st = useEditor.getState()
    st.loadProject(makeProject(), '/x.cutroom')
    expect(useEditor.getState().project).toBe(useEditor.getState().savedProject)
    st.loadProject(makeProject(), '/x.cutroom', { dirty: true })
    expect(useEditor.getState().project).not.toBe(useEditor.getState().savedProject)
  })

  it('undo back to the saved state reads clean again', () => {
    const st = useEditor.getState()
    st.loadProject(makeProject(), null)
    st.removeClip('c2')
    expect(useEditor.getState().project).not.toBe(useEditor.getState().savedProject)
    st.undo()
    expect(useEditor.getState().project).toBe(useEditor.getState().savedProject)
    st.redo()
    st.undo()
    expect(useEditor.getState().project).toBe(useEditor.getState().savedProject)
  })

  it('setMediaInfo with already-known values leaves the project untouched', () => {
    const st = useEditor.getState()
    st.loadProject(makeProject(), null)
    st.setMediaInfo('m1', { durationSec: 100 })
    st.setMediaInfo('m1', { durationSec: 100, width: undefined })
    expect(useEditor.getState().project).toBe(useEditor.getState().savedProject)
    st.setMediaInfo('m1', { width: 1280 })
    expect(useEditor.getState().project.media.m1.width).toBe(1280)
  })

  it('markSaved marks the captured (written) project, not later edits', () => {
    const clearRecoveryRing = vi.fn()
    vi.stubGlobal('window', { cutroom: { clearRecoveryRing } })
    try {
      const written = useEditor.getState().project
      useEditor.getState().removeClip('c3') // edit lands while the save is in flight
      useEditor.getState().markSaved('/x.cutroom', written)
      const s = useEditor.getState()
      expect(s.savedProject).toBe(written)
      expect(s.project).not.toBe(s.savedProject) // the later edit is still unsaved
      expect(clearRecoveryRing).not.toHaveBeenCalled()
      useEditor.getState().markSaved('/x.cutroom')
      expect(useEditor.getState().savedProject).toBe(useEditor.getState().project)
      expect(clearRecoveryRing).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('setMediaInfo placeholder extension', () => {
  it('extends a 5s pre-probe clip to the real duration but stops at the next clip', () => {
    const p = makeProject()
    p.media.m2 = { id: 'm2', name: 'b.wav', path: '/b.wav', kind: 'audio', durationSec: 0 }
    p.tracks.push({ id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false })
    p.clips = {
      a: { id: 'a', trackId: 'a1', mediaId: 'm2', startSec: 0, durationSec: 5, inSec: 0 },
      b: { id: 'b', trackId: 'a1', mediaId: 'm2', startSec: 8, durationSec: 5, inSec: 0 },
      other: { id: 'other', trackId: 'v1', mediaId: 'm1', startSec: 6, durationSec: 1, inSec: 0 }
    }
    useEditor.setState({ project: p })
    useEditor.getState().setMediaInfo('m2', { durationSec: 30 })
    const clips = useEditor.getState().project.clips
    expect(clips.a.durationSec).toBe(8) // capped at b's start (other lanes don't count)
    expect(clips.b.durationSec).toBe(30) // nothing after it on the lane
  })
})

describe('ripple markers across tracks', () => {
  it('rippleDeleteSelected removes parallel cross-track time once and collapses inner markers', () => {
    const p = makeProject()
    p.tracks.push({ id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false })
    p.clips.a = { id: 'a', trackId: 'a1', mediaId: 'm1', startSec: 5, durationSec: 5, inSec: 0 }
    p.markers = [
      { id: 'in', timeSec: 7 },
      { id: 'after', timeSec: 12 }
    ]
    useEditor.setState({ project: p })
    const st = useEditor.getState()
    st.setClipSelection(['c2', 'a']) // [5,10) on both V1 and A1
    st.rippleDeleteSelected()
    const m = Object.fromEntries(useEditor.getState().project.markers!.map((x) => [x.id, x.timeSec]))
    expect(m.after).toBe(7) // 12 - 5, not 12 - 10
    expect(m.in).toBe(5) // inside the removed span -> its start
  })
})

describe('auto-cut selection', () => {
  it('prunes a selection that pointed at a clip the cut deleted', () => {
    const st = useEditor.getState()
    st.selectClip('c2')
    // A range starting exactly at c2's head deletes the c2 id itself.
    st.applySilenceCuts('c2', [{ startSec: 5, endSec: 6 }])
    const s = useEditor.getState()
    expect(s.project.clips.c2).toBeUndefined()
    expect(s.selectedClipId).toBeNull()
    expect(s.selectedClipIds.size).toBe(0)
  })

  it('cutSilenceRange also prunes the selection', () => {
    const st = useEditor.getState()
    st.setClipSelection(['c1', 'c2'])
    st.cutSilenceRange('c2', { startSec: 5, endSec: 6 })
    const s = useEditor.getState()
    expect([...s.selectedClipIds]).toEqual(['c1'])
    expect(s.selectedClipId).toBe('c1')
  })
})

describe('streamed subtitle import', () => {
  it('records one undo step for the first batch and none for follow-ups', () => {
    const st = useEditor.getState()
    st.importSubtitles([{ startSec: 0, endSec: 1, text: 'a' }], { recordHistory: true })
    for (let i = 1; i < 150; i++) st.importSubtitles([{ startSec: i, endSec: i + 1, text: `c${i}` }], { recordHistory: false })
    expect(useEditor.getState().past.length).toBe(1)
    useEditor.getState().undo()
    expect(Object.values(useEditor.getState().project.clips).some((c) => c.role === 'subtitle')).toBe(false)
  })
})

describe('track management', () => {
  const withTracks = (): void => {
    const p = makeProject()
    p.tracks = [
      { id: 'v1', kind: 'video', name: 'V1', height: 68, muted: false, hidden: false },
      { id: 'v2', kind: 'video', name: 'V2', height: 68, muted: false, hidden: false },
      { id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false },
      {
        id: 'a2',
        kind: 'audio',
        name: 'A2',
        height: 52,
        muted: false,
        hidden: false,
        duck: { enabled: true, triggerTrackId: 'a1', thresholdDb: -30, ratio: 8, attackMs: 20, releaseMs: 250 }
      }
    ]
    p.clips.c3 = { ...p.clips.c3, trackId: 'v2' }
    p.clips.c4 = { id: 'c4', trackId: 'a1', mediaId: 'm1', startSec: 0, durationSec: 5, inSec: 0 }
    useEditor.setState({ project: p, past: [], future: [], selectedTrackId: null })
  }
  const ids = (): string[] => useEditor.getState().project.tracks.map((t) => t.id)

  it('addVideoTrack inserts above the topmost video track, undoably', () => {
    useEditor.getState().addVideoTrack()
    const tracks = useEditor.getState().project.tracks
    expect(tracks[0].kind).toBe('video')
    expect(tracks[0].name).toBe('V2')
    expect(tracks[1].id).toBe('v1')
    useEditor.getState().undo()
    expect(ids()).toEqual(['v1'])
  })

  it('removeTrack deletes its clips, prunes selection and dangling duck triggers', () => {
    withTracks()
    useEditor.getState().setClipSelection(['c1', 'c3'])
    useEditor.getState().removeTrack('v2')
    let s = useEditor.getState()
    expect(ids()).toEqual(['v1', 'a1', 'a2'])
    expect(s.project.clips.c3).toBeUndefined()
    expect([...s.selectedClipIds]).toEqual(['c1'])

    useEditor.getState().selectTrack('a1')
    useEditor.getState().removeTrack('a1')
    s = useEditor.getState()
    expect(s.project.clips.c4).toBeUndefined()
    expect(s.project.tracks.find((t) => t.id === 'a2')!.duck!.triggerTrackId).toBeNull()
    expect(s.selectedTrackId).toBeNull()

    // One undo step per removal, restoring the clips and the ducker link.
    useEditor.getState().undo()
    s = useEditor.getState()
    expect(s.project.clips.c4).toBeDefined()
    expect(s.project.tracks.find((t) => t.id === 'a2')!.duck!.triggerTrackId).toBe('a1')
    useEditor.getState().undo()
    expect(ids()).toEqual(['v1', 'v2', 'a1', 'a2'])
    expect(useEditor.getState().project.clips.c3.trackId).toBe('v2')
  })

  it('refuses to remove the last video (or audio) track', () => {
    useEditor.getState().removeTrack('v1')
    expect(ids()).toEqual(['v1'])
    expect(useEditor.getState().past.length).toBe(0)
  })

  it('moveTrack reorders (stacking order) as one undo step; no-op records nothing', () => {
    withTracks()
    useEditor.getState().moveTrack('v2', 0)
    expect(ids()).toEqual(['v2', 'v1', 'a1', 'a2'])
    expect(useEditor.getState().past.length).toBe(1)
    useEditor.getState().moveTrack('v2', 0)
    expect(useEditor.getState().past.length).toBe(1)
    useEditor.getState().undo()
    expect(ids()).toEqual(['v1', 'v2', 'a1', 'a2'])
    useEditor.getState().redo()
    expect(ids()).toEqual(['v2', 'v1', 'a1', 'a2'])
  })

  it('setTrackHeight clamps and pairs with snapshot for a single undo', () => {
    useEditor.getState().snapshot()
    useEditor.getState().setTrackHeight('v1', 120)
    useEditor.getState().setTrackHeight('v1', 5000)
    expect(useEditor.getState().project.tracks[0].height).toBe(200)
    useEditor.getState().setTrackHeight('v1', 1)
    expect(useEditor.getState().project.tracks[0].height).toBe(36)
    useEditor.getState().undo()
    expect(useEditor.getState().project.tracks[0].height).toBe(68)
  })

  it('undoing an added track clears it from the track selection', () => {
    useEditor.getState().addVideoTrack()
    const added = useEditor.getState().project.tracks[0].id
    useEditor.getState().selectTrack(added)
    useEditor.getState().undo()
    expect(useEditor.getState().selectedTrackId).toBeNull()
  })
})

describe('shuttle transport', () => {
  it('setShuttle plays at the rate; setPlaying (Space / K) resets it to 1×', () => {
    const st = useEditor.getState()
    st.setShuttle(-2)
    expect(useEditor.getState().isPlaying).toBe(true)
    expect(useEditor.getState().shuttleRate).toBe(-2)
    st.setPlaying(false)
    expect(useEditor.getState().isPlaying).toBe(false)
    expect(useEditor.getState().shuttleRate).toBe(1)
    st.setShuttle(4)
    st.setPlaying(true)
    expect(useEditor.getState().shuttleRate).toBe(1)
  })
})
