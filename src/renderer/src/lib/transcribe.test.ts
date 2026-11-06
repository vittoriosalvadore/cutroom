import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Clip, Project } from '../types'
import type { SubtitleCue } from '../state/store'
import { sourceToTimeline } from './clipTime'

// transcribeClip with the Worker and the audio decode faked out: the fake
// WorkerJob answers each window from `replies` (in order) and records what was
// posted, so the window -> timeline mapping is checked end to end.
const h = vi.hoisted(() => ({
  replies: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ pcm: Float32Array; words: boolean }>,
  decode: null as null | (() => Promise<unknown>)
}))

vi.mock('./workerJob', () => {
  class JobCancelled extends Error {
    constructor() {
      super('cancelled')
      this.name = 'JobCancelled'
    }
  }
  class WorkerJob {
    async call(msg: { pcm: Float32Array; words: boolean }, opts?: { shouldCancel?: () => boolean }): Promise<unknown> {
      if (opts?.shouldCancel?.()) throw new JobCancelled()
      h.sent.push(msg)
      return h.replies.shift()
    }
    terminate(): void {}
  }
  return { WorkerJob, JobCancelled }
})

vi.mock('./audioCache', () => ({
  getOrDecodeBuffer: () => (h.decode ? h.decode() : Promise.resolve({ duration: 600 }))
}))

// Renders "speech": a constant tone, so no window counts as silent.
class FakeOfflineAudioContext {
  destination = {}
  constructor(
    _channels: number,
    private length: number,
    _rate: number
  ) {}
  createBufferSource(): object {
    return { buffer: null, connect: () => undefined, start: () => undefined }
  }
  async startRendering(): Promise<{ getChannelData: () => Float32Array }> {
    const pcm = new Float32Array(this.length).fill(0.2)
    return { getChannelData: () => pcm }
  }
}

const { transcribeClip } = await import('./transcribe')

function setup(clip: Partial<Clip>, mediaSec = 600): { project: Project; clip: Clip } {
  const c: Clip = { id: 'c', trackId: 'a1', mediaId: 'm', startSec: 0, durationSec: 5, inSec: 0, ...clip }
  const project: Project = {
    id: 'p',
    name: 'P',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    media: { m: { id: 'm', name: 'song.mp3', path: '/song.mp3', kind: 'audio', durationSec: mediaSec } },
    tracks: [{ id: 'a1', kind: 'audio', name: 'A1', height: 52, muted: false, hidden: false }],
    clips: { c }
  }
  return { project, clip: c }
}

const KARAOKE = { model: 'small', language: 'auto', karaoke: true } as const

beforeEach(() => {
  h.replies.length = 0
  h.sent.length = 0
  h.decode = null
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('transcribeClip (karaoke)', () => {
  it('maps word times (source seconds in the window) to the timeline through the clip speed', async () => {
    // A 2x clip at 10 s reading source from 4 s: source 4 + w -> timeline 10 + w / 2.
    const { project, clip } = setup({ startSec: 10, durationSec: 5, inSec: 4, speed: 2 })
    h.replies.push({
      chunks: [
        { text: ' Hello', timestamp: [1, 1.5] },
        { text: ' world.', timestamp: [2, 3] }
      ],
      text: ' Hello world.',
      wordTimestamps: true
    })
    const cues: SubtitleCue[] = []
    const res = await transcribeClip(project, clip, () => undefined, (c) => cues.push(c), () => false, KARAOKE)
    expect(h.sent[0].words).toBe(true)
    expect(res.estimatedWords).toBe(false)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Hello world.')
    expect(cues[0].startSec).toBeCloseTo(sourceToTimeline(clip, 4 + 1)) // 10.5
    expect(cues[0].endSec).toBeCloseTo(sourceToTimeline(clip, 4 + 3)) // 11.5
    // Clip-relative to the cue (= the subtitle clip it becomes), in timeline seconds.
    const w = cues[0].words!
    expect(w.map((x) => x.text)).toEqual(['Hello', 'world.'])
    expect(w[0].startSec).toBeCloseTo(0)
    expect(w[0].endSec).toBeCloseTo(0.25)
    expect(w[1].startSec).toBeCloseTo(0.5)
    expect(w[1].endSec).toBeCloseTo(1)
  })

  it('estimates word timings from phrase timestamps when the model returned no word timings', async () => {
    const { project, clip } = setup({ startSec: 2 })
    h.replies.push({ chunks: [{ text: ' la la land', timestamp: [0, 3] }], text: ' la la land', wordTimestamps: false })
    const cues: SubtitleCue[] = []
    const res = await transcribeClip(project, clip, () => undefined, (c) => cues.push(c), () => false, KARAOKE)
    expect(res.estimatedWords).toBe(true)
    expect(cues).toHaveLength(1)
    expect(cues[0].startSec).toBeCloseTo(2)
    // 2 + 2 + 4 letters share the 3 s phrase.
    expect(cues[0].words!.map((x) => [x.text, +x.startSec.toFixed(3), +x.endSec.toFixed(3)])).toEqual([
      ['la', 0, 0.75],
      ['la', 0.75, 1.5],
      ['land', 1.5, 3]
    ])
  })

  it('offsets each later window by where it starts in the clip', async () => {
    // 130 s of source -> two windows (max 120 s each).
    const { project, clip } = setup({ startSec: 1, durationSec: 130, inSec: 3 })
    h.replies.push(
      { chunks: [{ text: ' first', timestamp: [1, 1.4] }], text: ' first', wordTimestamps: true },
      { chunks: [{ text: ' second', timestamp: [1, 1.4] }], text: ' second', wordTimestamps: true }
    )
    const cues: SubtitleCue[] = []
    await transcribeClip(project, clip, () => undefined, (c) => cues.push(c), () => false, KARAOKE)
    expect(h.sent).toHaveLength(2)
    const total = 130 * 16000
    const secondWindowSec = (total - h.sent[1].pcm.length) / 16000
    expect(cues.map((c) => c.text)).toEqual(['first', 'second'])
    expect(cues[0].startSec).toBeCloseTo(sourceToTimeline(clip, 3 + 1))
    expect(cues[1].startSec).toBeCloseTo(sourceToTimeline(clip, 3 + secondWindowSec + 1))
  })

  it('keeps plain transcription as phrase cues without words', async () => {
    const { project, clip } = setup({})
    h.replies.push({ chunks: [{ text: ' Just talking', timestamp: [0.5, 2] }], text: ' Just talking' })
    const cues: SubtitleCue[] = []
    const res = await transcribeClip(project, clip, () => undefined, (c) => cues.push(c), () => false, {
      model: 'small',
      language: 'auto'
    })
    expect(h.sent[0].words).toBe(false)
    expect(res.estimatedWords).toBe(false)
    expect(cues).toEqual([{ startSec: 0.5, endSec: 2, text: 'Just talking' }])
  })

  it('stops between windows, keeping the cues already delivered', async () => {
    const { project, clip } = setup({ durationSec: 130 })
    h.replies.push({ chunks: [{ text: ' kept', timestamp: [1, 1.4] }], text: ' kept', wordTimestamps: true })
    const cues: SubtitleCue[] = []
    const run = transcribeClip(project, clip, () => undefined, (c) => cues.push(c), () => h.sent.length >= 1, KARAOKE)
    await expect(run).rejects.toThrow('cancelled')
    expect(cues.map((c) => c.text)).toEqual(['kept'])
  })

  it('gives up on a decode that never finishes instead of hanging', async () => {
    vi.useFakeTimers()
    h.decode = () => new Promise(() => undefined)
    const { project, clip } = setup({}, 8)
    const run = transcribeClip(project, clip, () => undefined, () => undefined, () => false, KARAOKE)
    const failed = expect(run).rejects.toThrow(/took too long/)
    await vi.advanceTimersByTimeAsync(60_000 + 8 * 250 + 1)
    await failed
    expect(h.sent).toHaveLength(0)
  })
})
