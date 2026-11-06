import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  PROXY_GOP,
  buildProxyArgs,
  durationsMatch,
  isProxyFileName,
  parseDurationLine,
  parseProgressTime,
  partialName,
  progressFraction,
  proxyFileName
} from './proxyArgs'

const SRC = join(tmpdir(), 'clip.mov')

describe('proxyFileName', () => {
  it('is stable for the same path + size + mtime', () => {
    const a = proxyFileName(SRC, 1000, 1700000000123.4)
    expect(a).toBe(proxyFileName(SRC, 1000, 1700000000123.9)) // sub-ms mtime noise ignored
    expect(a).toMatch(/^[0-9a-f]{32}\.mp4$/)
    expect(isProxyFileName(a)).toBe(true)
  })

  it('changes when the source is edited, replaced or moved', () => {
    const a = proxyFileName(SRC, 1000, 1700000000000)
    expect(proxyFileName(SRC, 1001, 1700000000000)).not.toBe(a)
    expect(proxyFileName(SRC, 1000, 1700000005000)).not.toBe(a)
    expect(proxyFileName(join(tmpdir(), 'other.mov'), 1000, 1700000000000)).not.toBe(a)
  })

  it('partials are distinct but still recognised as cache files', () => {
    const name = proxyFileName(SRC, 1, 1)
    const partial = partialName(name)
    expect(partial).not.toBe(name)
    expect(partial.endsWith('.partial')).toBe(true)
    expect(isProxyFileName(partial)).toBe(true)
  })

  it('never treats foreign files in the dir as cache files', () => {
    expect(isProxyFileName('settings.json')).toBe(false)
    expect(isProxyFileName('notes.mp4')).toBe(false)
    expect(isProxyFileName('../' + proxyFileName(SRC, 1, 1))).toBe(false)
  })
})

describe('buildProxyArgs', () => {
  const args = buildProxyArgs(SRC, '/cache/x.partial')
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }

  it('reads the source and writes an mp4 to the partial path', () => {
    expect(val('-i')).toBe(SRC)
    expect(args[args.length - 1]).toBe('/cache/x.partial')
    expect(val('-f')).toBe('mp4')
    expect(val('-movflags')).toBe('+faststart')
  })

  it('keeps every frame timestamp (1:1 source time mapping)', () => {
    expect(val('-fps_mode')).toBe('passthrough')
    expect(args).not.toContain('-r')
    expect(args).not.toContain('-ss')
    expect(args).not.toContain('-t')
  })

  it('is a short-GOP, B-frame-free H.264 yuv420p + AAC file', () => {
    expect(val('-c:v')).toBe('libx264')
    expect(val('-g')).toBe(String(PROXY_GOP))
    expect(PROXY_GOP).toBeLessThanOrEqual(15)
    expect(val('-bf')).toBe('0')
    expect(val('-vf')).toMatch(/format=yuv420p$/)
    expect(val('-c:a')).toBe('aac')
    expect(args).toContain('0:a:0?') // sources without audio still work
  })

  it('scales the short side down (never up) to even dims and leaves autorotate on', () => {
    const vf = val('-vf') as string
    expect(vf).toContain('min(720,ih)')
    expect(vf).toContain('min(720,iw)')
    expect(vf).toContain('-2')
    expect(args).not.toContain('-noautorotate')
  })

  it('streams machine-readable progress on stdout', () => {
    expect(val('-progress')).toBe('pipe:1')
    expect(args).toContain('-nostdin')
  })
})

describe('progress parsing', () => {
  it('reads the latest out_time_us from a chunk', () => {
    const chunk = 'frame=10\nout_time_us=1000000\nprogress=continue\nframe=20\nout_time_us=2500000\n'
    expect(parseProgressTime(chunk)).toBeCloseTo(2.5)
  })

  it('accepts out_time_ms (also microseconds) and skips N/A', () => {
    expect(parseProgressTime('out_time_ms=3000000\n')).toBeCloseTo(3)
    expect(parseProgressTime('out_time_us=N/A\nout_time_ms=N/A\n')).toBeNull()
    expect(parseProgressTime('frame=1\n')).toBeNull()
  })

  it('turns time into a clamped fraction of the duration', () => {
    expect(progressFraction(3, 6)).toBe(0.5)
    expect(progressFraction(7, 6)).toBe(1)
    expect(progressFraction(3, 0)).toBe(0)
    expect(progressFraction(-1, 6)).toBe(0)
  })

  it('parses the Duration line from ffmpeg -i output', () => {
    expect(parseDurationLine('  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s')).toBeCloseTo(62.5)
    expect(parseDurationLine('  Duration: 01:00:00.00, start')).toBe(3600)
    expect(parseDurationLine('  Duration: N/A, start')).toBe(0)
  })
})

describe('durationsMatch', () => {
  it('tolerates AAC padding', () => {
    expect(durationsMatch(6.0, 6.02)).toBe(true)
    expect(durationsMatch(5.0, 5.01)).toBe(true)
  })

  it('scales with length and rejects a real mismatch', () => {
    expect(durationsMatch(3600, 3601)).toBe(true) // 0.5 % of an hour = 18 s
    expect(durationsMatch(6, 5)).toBe(false)
    expect(durationsMatch(10, 10.5)).toBe(false)
  })

  it('passes when a duration is unknown', () => {
    expect(durationsMatch(0, 5)).toBe(true)
    expect(durationsMatch(5, 0)).toBe(true)
  })
})
