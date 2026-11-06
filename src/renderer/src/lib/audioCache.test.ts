import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The decode itself is faked: each decodeAudioData call parks until the test
// releases it, so a decode can be observed while it is still "in flight".
const h = vi.hoisted(() => ({ pending: [] as Array<(b: unknown) => void> }))

vi.mock('./audioContext', () => ({
  getAudioContext: () => ({
    decodeAudioData: () => new Promise((resolve) => h.pending.push(resolve))
  })
}))

const { ensureAudioDecoded, getOrDecodeBuffer, waitForDecoded } = await import('./audioCache')

const fakeBuffer = (sec: number): unknown => ({
  duration: sec,
  length: sec * 100,
  sampleRate: 100,
  getChannelData: () => new Float32Array(sec * 100)
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let fetches = 0
beforeEach(() => {
  fetches = 0
  h.pending.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetches++
      return { arrayBuffer: async () => new ArrayBuffer(8) }
    })
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('waitForDecoded / getOrDecodeBuffer', () => {
  it('reuses the background decode already in flight instead of decoding the file again', async () => {
    ensureAudioDecoded('song', '/song.mp3', 200) // the import-time decode
    await tick()
    expect(fetches).toBe(1)
    const got = getOrDecodeBuffer('song', '/song.mp3') // e.g. transcription right after import
    await tick()
    expect(fetches).toBe(1) // no second fetch + decode
    const buffer = fakeBuffer(200)
    h.pending[0](buffer)
    expect(await got).toBe(buffer)
  })

  it('resolves null when the cache will not provide the buffer, so the caller decodes on demand', async () => {
    expect(await waitForDecoded('never-requested')).toBeNull()
    ensureAudioDecoded('long', '/long.wav', 3600) // over the cache's length cap: skipped
    expect(await waitForDecoded('long')).toBeNull()
    const got = getOrDecodeBuffer('long', '/long.wav')
    await tick()
    expect(fetches).toBe(1) // decoded on demand
    const buffer = fakeBuffer(3600)
    h.pending[0](buffer)
    expect(await got).toBe(buffer)
  })
})
