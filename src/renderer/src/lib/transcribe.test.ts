import { describe, it, expect } from 'vitest'
import { wordsToCues } from './transcribe'

type Chunk = { text: string; timestamp: [number, number | null] }

const w = (text: string, start: number, end: number | null): Chunk => ({ text, timestamp: [start, end] })

describe('wordsToCues', () => {
  it('groups a short sentence into one card', () => {
    const cues = wordsToCues([w(' Hello', 0, 0.3), w(' world.', 0.3, 0.8)], 10)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Hello world.')
    expect(cues[0].startSec).toBeCloseTo(10)
    expect(cues[0].endSec).toBeCloseTo(10.8)
    expect(cues[0].words).toEqual([
      { text: 'Hello', startSec: 0, endSec: 0.3 },
      { text: 'world.', startSec: 0.3, endSec: 0.8 }
    ])
  })

  it('splits on sentence-ending punctuation even when short', () => {
    const cues = wordsToCues([w(' Hi.', 0, 0.4), w(' Bye.', 0.4, 0.9)], 0)
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('Hi.')
    expect(cues[1].text).toBe('Bye.')
    // Second card's words are relative to ITS OWN start, not the first card's.
    expect(cues[1].words?.[0].startSec).toBe(0)
  })

  it('splits after 6 words when there is no punctuation cue', () => {
    const chunks = Array.from({ length: 7 }, (_, i) => w(`w${i}`, i * 0.3, i * 0.3 + 0.25))
    const cues = wordsToCues(chunks, 0)
    expect(cues).toHaveLength(2)
    expect(cues[0].words).toHaveLength(6)
    expect(cues[1].words).toHaveLength(1)
  })

  it('splits when a card would exceed 3 seconds', () => {
    const cues = wordsToCues([w('a', 0, 1), w('b', 1, 2), w('c', 2, 3.5)], 0)
    expect(cues).toHaveLength(2)
    expect(cues[0].words?.map((x) => x.text)).toEqual(['a', 'b'])
    expect(cues[1].words?.map((x) => x.text)).toEqual(['c'])
  })

  it('falls back the end time to the next word start when null', () => {
    const cues = wordsToCues([w('only', 5, null)], 0)
    expect(cues[0].endSec).toBeCloseTo(5.2)
  })

  it('drops empty/whitespace-only chunks', () => {
    const cues = wordsToCues([w('  ', 0, 0.1), w('real', 0.1, 0.4)], 0)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('real')
  })

  it('returns no cues for an empty chunk list', () => {
    expect(wordsToCues([], 0)).toEqual([])
  })
})
