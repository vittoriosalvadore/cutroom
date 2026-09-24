import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The pool is DOM/WebCodecs glue; the sources are stubbed so what's tested is
// its keying (one entry per clip) and the wanted/audible/eviction bookkeeping.

interface FakeEl {
  path: string
  requests: number[]
  paused: number
  endFrames: number
  disposed: boolean
}
const made: FakeEl[] = []

vi.mock('./videoElementSource', () => ({
  VideoElementSource: class {
    rec: FakeEl
    constructor(path: string) {
      this.rec = { path, requests: [], paused: 0, endFrames: 0, disposed: false }
      made.push(this.rec)
    }
    get frame(): object {
      return this.rec
    }
    width = 16
    height = 9
    requestTime(t: number): void {
      this.rec.requests.push(t)
    }
    seekTo(): Promise<void> {
      return Promise.resolve()
    }
    getElement(): object {
      return this.rec
    }
    pause(): void {
      this.rec.paused++
    }
    endFrame(): void {
      this.rec.endFrames++
    }
    dispose(): void {
      this.rec.disposed = true
    }
  }
}))
vi.mock('./webCodecsSource', () => ({
  WebCodecsSource: class {
    dispose(): void {}
  }
}))
// Every probe settles on the element tier, so the element source stays active.
vi.mock('./videoTier', () => ({ resolveTier: () => Promise.resolve('video-element') }))

const { VideoPool } = await import('./videoPool')

let now = 0
beforeEach(() => {
  made.length = 0
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('document', {
    createElement: () => ({ style: {}, remove: () => undefined }),
    body: { appendChild: () => undefined }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VideoPool', () => {
  it('gives two clips of the same file separate sources and elements', () => {
    const pool = new VideoPool(() => undefined)
    pool.want('clipA', '/f.mp4', 1, true)
    pool.want('clipB', '/f.mp4', 7, true)
    expect(made).toHaveLength(2)
    expect(made[0].requests).toEqual([1])
    expect(made[1].requests).toEqual([7])
    expect(pool.getElement('clipA')).toBe(made[0])
    expect(pool.getElement('clipB')).toBe(made[1])
    pool.want('clipA', '/f.mp4', 1.1, true)
    expect(made).toHaveLength(2) // reused, not recreated
  })

  it('wantAudio drives the element while playing and hard-pauses it while paused', () => {
    const pool = new VideoPool(() => undefined)
    pool.wantAudio('hidden', '/f.mp4', 3, true)
    expect(made[0].requests).toEqual([3])
    pool.wantAudio('hidden', '/f.mp4', 3.5, false)
    expect(made[0].requests).toEqual([3]) // no paused seek
    expect(made[0].paused).toBe(1)
  })

  it('keeps audio-only entries playing and alive; evicts idle ones', () => {
    const evicted: string[] = []
    const pool = new VideoPool(() => undefined, (k) => evicted.push(k))
    pool.want('drawn', '/a.mp4', 0, true)
    pool.wantAudio('heard', '/b.mp4', 0, true)
    pool.want('idle', '/c.mp4', 0, true)
    pool.endFrame()
    now = 11_000
    pool.want('drawn', '/a.mp4', 11, true)
    pool.wantAudio('heard', '/b.mp4', 11, true)
    pool.endFrame()
    expect(evicted).toEqual(['idle'])
    expect(made[1].endFrames).toBe(0) // the heard element was never paused
    expect(made[1].disposed).toBe(false)
    expect(pool.getElement('heard')).toBe(made[1])
    expect(pool.getElement('idle')).toBeNull()
  })

  it('recreates an entry when its clip now points at a different file', () => {
    const evicted: string[] = []
    const pool = new VideoPool(() => undefined, (k) => evicted.push(k))
    pool.want('c', '/old.mp4', 0, false)
    pool.want('c', '/new.mp4', 0, false)
    expect(made.map((m) => m.path)).toEqual(['/old.mp4', '/new.mp4'])
    expect(made[0].disposed).toBe(true)
    expect(evicted).toEqual(['c'])
  })
})
