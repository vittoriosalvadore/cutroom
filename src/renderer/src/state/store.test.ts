import { describe, it, expect, beforeEach } from 'vitest'
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
