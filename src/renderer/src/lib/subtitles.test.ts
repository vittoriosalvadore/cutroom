import { describe, it, expect } from 'vitest'
import { parseSubtitles, toSrt } from './subtitles'

describe('toSrt', () => {
  it('formats timestamps as HH:MM:SS,mmm', () => {
    const srt = toSrt([{ startSec: 3723.5, endSec: 3725.042, text: 'hi' }])
    expect(srt).toBe('1\n01:02:03,500 --> 01:02:05,042\nhi\n')
  })

  it('carries a rounded-up millisecond into the seconds field (never ",1000")', () => {
    const srt = toSrt([{ startSec: 1.9996, endSec: 59.9999, text: 'x' }])
    expect(srt).toContain('00:00:02,000 --> 00:01:00,000')
    expect(srt).not.toContain('1000')
  })

  it('clamps negative times to zero and sorts cues by start', () => {
    const srt = toSrt([
      { startSec: 5, endSec: 6, text: 'b' },
      { startSec: -1, endSec: 1, text: 'a' }
    ])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:05,000 --> 00:00:06,000\nb\n')
  })
})

describe('parseSubtitles', () => {
  it('round-trips toSrt output', () => {
    const cues = [
      { startSec: 1.25, endSec: 2.5, text: 'one' },
      { startSec: 3, endSec: 4.999, text: 'two\nlines' }
    ]
    expect(parseSubtitles(toSrt(cues))).toEqual(cues)
  })

  it('parses VTT with a header, CRLF and cue settings', () => {
    const vtt = 'WEBVTT\r\n\r\n00:01.000 --> 00:02.500 line:90%\r\nhello\r\n'
    expect(parseSubtitles(vtt)).toEqual([{ startSec: 1, endSec: 2.5, text: 'hello' }])
  })
})
