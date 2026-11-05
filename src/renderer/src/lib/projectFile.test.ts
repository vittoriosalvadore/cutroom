import { describe, it, expect } from 'vitest'
import { serializeProject, deserializeProject, FILE_VERSION, projectFileLabel } from './projectFile'
import { defaultSubtitleText } from '../types'
import type { Project } from '../types'

function sample(): Project {
  return {
    id: 'p',
    name: 'My Edit',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    media: { m1: { id: 'm1', name: 'a.mp4', path: '/a.mp4', kind: 'video', durationSec: 12 } },
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', height: 68, muted: false, hidden: false }],
    clips: { c1: { id: 'c1', trackId: 'v1', mediaId: 'm1', startSec: 0, durationSec: 5, inSec: 0 } },
    markers: []
  }
}

describe('project (de)serialize', () => {
  it('round-trips a project', () => {
    const r = deserializeProject(serializeProject(sample()))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.project).toEqual(sample())
  })

  it('includes metadata in the wrapper but still parses back', () => {
    const json = serializeProject(sample(), { savedPath: '/x.json', timestamp: 123 })
    const parsed = JSON.parse(json)
    expect(parsed.savedPath).toBe('/x.json')
    expect(parsed.timestamp).toBe(123)
    expect(parsed.app).toBe('cutroom')
    const r = deserializeProject(json)
    expect(r.ok).toBe(true)
  })

  it('tolerates a bare (unwrapped) project', () => {
    const r = deserializeProject(JSON.stringify(sample()))
    expect(r.ok).toBe(true)
  })

  it('rejects non-JSON', () => {
    const r = deserializeProject('not json {')
    expect(r.ok).toBe(false)
  })

  it('rejects structurally invalid data (no tracks)', () => {
    const r = deserializeProject(JSON.stringify({ project: { clips: {}, media: {} } }))
    expect(r.ok).toBe(false)
  })

  it('round-trips markers and defaults a markerless (old) file to []', () => {
    const withMarkers: Project = {
      ...sample(),
      markers: [{ id: 'mk1', timeSec: 3, label: 'intro', color: '#fff' }]
    }
    const r = deserializeProject(serializeProject(withMarkers))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.project.markers).toEqual([{ id: 'mk1', timeSec: 3, endSec: undefined, label: 'intro', color: '#fff' }])
    }
    // An old file without a markers key loads with markers defaulted to [].
    const old = deserializeProject(JSON.stringify({ project: { tracks: [], clips: {}, media: {} } }))
    expect(old.ok && old.project.markers).toEqual([])
  })

  it('fills missing scalar settings with defaults', () => {
    const r = deserializeProject(JSON.stringify({ project: { tracks: [], clips: {}, media: {} } }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.project.fps).toBe(30)
      expect(r.project.width).toBe(1920)
      expect(r.project.sampleRate).toBe(48000)
      expect(r.project.name).toBe('Untitled Project')
    }
  })

  it('rejects a file from a newer format version with a clear error', () => {
    const json = JSON.stringify({ app: 'cutroom', version: FILE_VERSION + 1, project: sample() })
    const r = deserializeProject(json)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/newer version/)
  })

  it('rejects arrays in place of the clips/media maps', () => {
    expect(deserializeProject(JSON.stringify({ project: { ...sample(), clips: [] } })).ok).toBe(false)
    expect(deserializeProject(JSON.stringify({ project: { ...sample(), media: [] } })).ok).toBe(false)
  })

  it('rejects malformed tracks (non-object, missing id, unknown kind)', () => {
    const bad = (tracks: unknown[]): boolean => deserializeProject(JSON.stringify({ project: { ...sample(), tracks } })).ok
    expect(bad([null])).toBe(false)
    expect(bad([{ kind: 'video' }])).toBe(false)
    expect(bad([{ id: 'v1', kind: 'subtitle' }])).toBe(false)
  })

  it('drops invalid clips but keeps the rest of the file', () => {
    const p = sample()
    const raw = {
      ...p,
      clips: {
        ...p.clips,
        nan: { ...p.clips.c1, id: 'nan', startSec: 'x' },
        zero: { ...p.clips.c1, id: 'zero', durationSec: 0 },
        orphan: { ...p.clips.c1, id: 'orphan', trackId: 'gone' },
        noMedia: { ...p.clips.c1, id: 'noMedia', mediaId: 'm_missing' },
        title: { ...p.clips.c1, id: 'title', mediaId: null },
        junk: 42
      }
    }
    const r = deserializeProject(JSON.stringify({ project: raw }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.project.clips).sort()).toEqual(['c1', 'title'])
  })

  it('sorts keyframes and drops malformed keys', () => {
    const p = sample()
    const raw = {
      ...p,
      clips: {
        c1: {
          ...p.clips.c1,
          keyframes: {
            scale: [
              { t: 3, v: 2, ease: 'linear' },
              { t: 'bad', v: 1, ease: 'linear' },
              { t: 1, v: 1, ease: 'hold' }
            ]
          }
        }
      }
    }
    const r = deserializeProject(JSON.stringify({ project: raw }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.project.clips.c1.keyframes?.scale).toEqual([
        { t: 1, v: 1, ease: 'hold' },
        { t: 3, v: 2, ease: 'linear' }
      ])
    }
  })

  it('validates track effect blocks instead of passing garbage through', () => {
    const p = sample()
    const audio = { id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false }
    const raw = {
      ...p,
      tracks: [...p.tracks, audio].map((t) =>
        t.id === audio.id
          ? {
              ...t,
              pan: 7,
              reverb: { enabled: true, decaySec: '2', mix: 5 },
              gate: { enabled: 'yes', thresholdDb: -30, attackMs: null },
              duck: { enabled: true, triggerTrackId: 42 },
              eq: 'loud'
            }
          : t
      )
    }
    const r = deserializeProject(JSON.stringify({ project: raw }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const t = r.project.tracks.find((x) => x.id === audio.id)!
    expect(t.pan).toBe(1)
    expect(t.reverb?.enabled).toBe(true)
    expect(typeof t.reverb?.decaySec).toBe('number') // "2" -> default, never a string
    expect(t.reverb?.mix).toBeLessThanOrEqual(1)
    expect(t.gate?.enabled).toBe(false) // non-boolean -> default
    expect(t.gate?.thresholdDb).toBe(-30)
    expect(Number.isFinite(t.gate?.attackMs)).toBe(true)
    expect(t.duck?.triggerTrackId).toBeNull()
    expect(t.eq).toBeUndefined()
  })

  it('round-trips RGB curves on a clip', () => {
    const p = sample()
    const curves = {
      master: [{ x: 0, y: 0 }, { x: 0.25, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }],
      r: [{ x: 0, y: 0 }, { x: 1, y: 0.9 }],
      g: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      b: [{ x: 0, y: 0.05 }, { x: 1, y: 1 }]
    }
    p.clips.c1.effects = { opacity: 1, chroma: { enabled: false, color: '#00d000', similarity: 0.4, smoothness: 0.1, spill: 0.25 }, curves }
    const r = deserializeProject(serializeProject(p))
    expect(r.ok && r.project.clips.c1.effects?.curves).toEqual(curves)
  })

  it('sanitizes curve points: clamps, sorts, drops malformed, identity -> removed', () => {
    const p = sample() as unknown as { clips: Record<string, Record<string, unknown>> }
    p.clips.c1.effects = {
      opacity: 1,
      chroma: { enabled: false, color: '#00d000', similarity: 0.4, smoothness: 0.1, spill: 0.25 },
      curves: { master: [{ x: 1, y: 1.4 }, 'junk', { x: 0.5, y: 0.2 }, { x: -3, y: 0 }], r: 'nope' }
    }
    p.clips.c2 = { ...p.clips.c1, id: 'c2', effects: { opacity: 1, chroma: {}, curves: { g: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } } }
    const r = deserializeProject(JSON.stringify(p))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = r.project.clips.c1.effects?.curves
    expect(c?.master).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.2 }, { x: 1, y: 1 }])
    expect(c?.r).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }])
    expect(r.project.clips.c2.effects).toBeDefined()
    expect(r.project.clips.c2.effects && 'curves' in r.project.clips.c2.effects).toBe(false)
  })

  const subtitle = (text: Record<string, unknown>): Record<string, unknown> => ({
    id: 's1',
    trackId: 'v1',
    mediaId: null,
    startSec: 2,
    durationSec: 3,
    inSec: 0,
    role: 'subtitle',
    text: { ...defaultSubtitleText('la la land'), ...text }
  })

  it('round-trips a karaoke subtitle (words, style, colour)', () => {
    const p = sample()
    const karaoke = {
      words: [
        { text: 'la', startSec: -0.5, endSec: 0.2 }, // negative: rebased by a split
        { text: 'la', startSec: 0.2, endSec: 0.6 },
        { text: 'land', startSec: 0.6, endSec: 1.4 }
      ],
      karaokeStyle: 'underline',
      karaokeColor: '#ff3366'
    }
    const raw = { ...p, clips: { ...p.clips, s1: subtitle(karaoke) } }
    const r = deserializeProject(JSON.stringify({ project: raw }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.project.clips.s1.text).toEqual({ ...defaultSubtitleText('la la land'), ...karaoke })
    const again = deserializeProject(serializeProject(r.project))
    expect(again.ok && again.project.clips.s1).toEqual(r.project.clips.s1)
  })

  it('sanitizes karaoke fields: bad words dropped and sorted, bad style/colour removed', () => {
    const p = sample()
    const raw = {
      ...p,
      clips: {
        ...p.clips,
        s1: subtitle({
          words: [
            { text: 'land', startSec: 1, endSec: 0.5, extra: 'x' }, // end before start -> clamped
            'junk',
            { text: 'la', startSec: 'soon', endSec: 1 },
            { text: 7, startSec: 0, endSec: 1 },
            { text: 'la', startSec: 0, endSec: 0.4 }
          ],
          karaokeStyle: 'sparkle',
          karaokeColor: 'yellow'
        }),
        s2: subtitle({ words: 'nope', karaokeStyle: 'pop', karaokeColor: '#FD3' }),
        s3: subtitle({ words: [] })
      }
    }
    const r = deserializeProject(JSON.stringify({ project: raw }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s1 = r.project.clips.s1.text!
    expect(s1.words).toEqual([
      { text: 'la', startSec: 0, endSec: 0.4 },
      { text: 'land', startSec: 1, endSec: 1 }
    ])
    expect(s1).not.toHaveProperty('karaokeStyle')
    expect(s1).not.toHaveProperty('karaokeColor')
    const s2 = r.project.clips.s2.text!
    expect(s2).not.toHaveProperty('words')
    expect(s2.karaokeStyle).toBe('pop')
    expect(s2.karaokeColor).toBe('#FFDD33') // expanded for the colour input
    expect(r.project.clips.s3.text).not.toHaveProperty('words') // empty -> plain subtitle
    expect(r.project.clips.s3.text!.content).toBe('la la land')
  })
})

describe('projectFileLabel', () => {
  it('shows the file name without the project extension, on any OS', () => {
    expect(projectFileLabel('C:\\cuts\\My Edit.cutroom.json')).toBe('My Edit')
    expect(projectFileLabel('/home/v/clip.json')).toBe('clip')
    expect(projectFileLabel('/home/v/.cutroom.json')).toBe('.cutroom.json')
  })
})
