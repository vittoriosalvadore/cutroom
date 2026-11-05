import { describe, it, expect } from 'vitest'
import { parseSubtitles, projectToCues, toSrt } from './subtitles'
import { defaultSubtitleText } from '../types'
import type { Project } from '../types'

describe('projectToCues', () => {
  it('exports a karaoke subtitle as plain text, without its word timings', () => {
    const text = {
      ...defaultSubtitleText('la la land'),
      words: [
        { text: 'la', startSec: 0, endSec: 0.4 },
        { text: 'la', startSec: 0.4, endSec: 0.8 },
        { text: 'land', startSec: 0.8, endSec: 1.6 }
      ],
      karaokeStyle: 'fill-wipe' as const
    }
    const project = {
      clips: { s: { id: 's', trackId: 't', mediaId: null, startSec: 2, durationSec: 2, inSec: 0, role: 'subtitle', text } }
    } as unknown as Project
    const cues = projectToCues(project)
    expect(cues).toEqual([{ startSec: 2, endSec: 4, text: 'la la land' }])
    expect(toSrt(cues)).toBe('1\n00:00:02,000 --> 00:00:04,000\nla la land\n')
  })
})

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
