import { describe, it, expect } from 'vitest'
import { serializeProject, deserializeProject } from './projectFile'
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
})
