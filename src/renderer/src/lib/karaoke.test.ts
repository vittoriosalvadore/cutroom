import { describe, it, expect } from 'vitest'
import {
  activeWordIndex,
  distributeWords,
  estimateWordChunks,
  shiftWords,
  usableWordChunks,
  wordsToCues,
  type WordChunk
} from './karaoke'
import type { WordTiming } from '../types'

const words: WordTiming[] = [
  { text: 'Hello', startSec: 0, endSec: 0.3 },
  { text: 'world', startSec: 0.3, endSec: 0.7 },
  { text: 'today', startSec: 0.9, endSec: 1.3 }
]

describe('activeWordIndex', () => {
  it('returns -1 for an empty word list', () => {
    expect(activeWordIndex([], 0.5)).toBe(-1)
  })

  it('returns -1 before the first word starts', () => {
    expect(activeWordIndex(words, -0.1)).toBe(-1)
  })

  it('returns the first word right at its start', () => {
    expect(activeWordIndex(words, 0)).toBe(0)
  })

  it('returns the word covering the given time', () => {
    expect(activeWordIndex(words, 0.5)).toBe(1)
  })

  it('sticks on the previous word during a gap between words', () => {
    expect(activeWordIndex(words, 0.8)).toBe(1)
  })

  it('returns the last word right at its start', () => {
    expect(activeWordIndex(words, 0.9)).toBe(2)
  })

  it('sticks on the last word after its own window ends', () => {
    expect(activeWordIndex(words, 5)).toBe(2)
  })

  it('handles words rebased before the clip start (negative times)', () => {
    const rebased = shiftWords(words, -0.5) // a split 0.5 s into the clip
    expect(activeWordIndex(rebased, 0)).toBe(1) // "world" was mid-word at the cut
  })
})

describe('shiftWords', () => {
  it('moves every word by the delta without touching the input', () => {
    const out = shiftWords(words, 2)
    expect(out.map((w) => [w.text, w.startSec, w.endSec])).toEqual([
      ['Hello', 2, 2.3],
      ['world', 2.3, 2.7],
      ['today', 2.9, 3.3]
    ])
    expect(words[0].startSec).toBe(0)
  })
})

describe('distributeWords', () => {
  it('shares the span in proportion to word length, tiling it without gaps', () => {
    // "a" = 1 letter, "bbb" = 3 letters: a gets 1/4 of the 2 s, bbb 3/4.
    const out = distributeWords('a bbb', 10, 12)
    expect(out).toEqual([
      { text: 'a', start: 10, end: 10.5 },
      { text: 'bbb', start: 10.5, end: 12 }
    ])
  })

  it('ignores punctuation when weighing words, but gives every word some time', () => {
    const out = distributeWords('Oh, — yeah!', 0, 6)
    expect(out.map((w) => w.text)).toEqual(['Oh,', '—', 'yeah!'])
    // weights 2 / 1 (no letters -> minimum 1) / 4 = 7
    expect(out[0].end).toBeCloseTo(6 * (2 / 7))
    expect(out[1].end).toBeCloseTo(6 * (3 / 7))
    expect(out[2].end).toBe(6)
  })

  it('returns nothing for blank text', () => {
    expect(distributeWords('   ', 0, 1)).toEqual([])
  })
})

describe('estimateWordChunks (fallback when the model cannot time words)', () => {
  it('splits each phrase into words timed by length and marks the phrase end', () => {
    const out = estimateWordChunks([
      { text: ' I love you', timestamp: [2, 4] },
      { text: ' baby', timestamp: [5, 6] }
    ])
    expect(out.map((c) => c.text)).toEqual(['I', 'love', 'you', 'baby'])
    // 1 + 4 + 3 = 8 letters over 2 s
    expect(out[0].timestamp[0]).toBe(2)
    expect(out[0].timestamp[1]).toBeCloseTo(2.25)
    expect(out[1].timestamp[1]).toBeCloseTo(3.25)
    expect(out[2].timestamp[1]).toBeCloseTo(4)
    expect(out.map((c) => !!c.phraseEnd)).toEqual([false, false, true, true])
  })

  it('ends an open-ended phrase at the next phrase start, else estimates from its length', () => {
    const out = estimateWordChunks([
      { text: 'one two', timestamp: [0, null] },
      { text: 'three', timestamp: [3, null] }
    ])
    expect(out[1].timestamp[1]).toBeCloseTo(3) // "two" ends where "three" begins
    expect(out[2].timestamp[1]).toBeCloseTo(5) // last: start + max(2 s, 0.4 s/word)
  })

  it('gives a zero-length phrase a minimal span and drops blank or untimed ones', () => {
    const out = estimateWordChunks([
      { text: '  ', timestamp: [0, 1] },
      { text: 'lost', timestamp: [NaN, 2] },
      { text: 'a b', timestamp: [4, 4] }
    ])
    expect(out.map((c) => c.text)).toEqual(['a', 'b'])
    expect(out[1].timestamp[1]).toBeGreaterThan(4)
    expect(out[1].timestamp[0]).toBeGreaterThan(out[0].timestamp[0])
  })
})

describe('usableWordChunks', () => {
  const w = (text: string, start: number): WordChunk => ({ text, timestamp: [start, start + 0.2] })

  it('accepts real word-level output', () => {
    expect(usableWordChunks([w(' Hello', 0), w(' world.', 0.3)])).toBe(true)
  })

  it('rejects no words, untimed words, and timings collapsed onto one instant', () => {
    expect(usableWordChunks([])).toBe(false)
    expect(usableWordChunks([w('  ', 0)])).toBe(false)
    expect(usableWordChunks([w('a', NaN), w('b', 1)])).toBe(false)
    expect(usableWordChunks([w('a', 0), w('b', 0), w('c', 0)])).toBe(false)
  })

  it('rejects phrase-level chunks passed off as words', () => {
    expect(usableWordChunks([w(' I love you', 0), w(' so much baby', 2)])).toBe(false)
  })
})

describe('wordsToCues', () => {
  type Chunk = WordChunk
  const w = (text: string, start: number, end: number | null): Chunk => ({ text, timestamp: [start, end] })
  const offset =
    (sec: number) =>
    (s: number): number =>
      sec + s

  it('groups a short sentence into one card with words relative to the card', () => {
    const cues = wordsToCues([w(' Hello', 0, 0.3), w(' world.', 0.3, 0.8)], offset(10))
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Hello world.')
    expect(cues[0].startSec).toBeCloseTo(10)
    expect(cues[0].endSec).toBeCloseTo(10.8)
    expect(cues[0].words?.map((x) => x.text)).toEqual(['Hello', 'world.'])
    expect(cues[0].words?.[0].startSec).toBeCloseTo(0)
    expect(cues[0].words?.[1].startSec).toBeCloseTo(0.3)
    expect(cues[0].words?.[1].endSec).toBeCloseTo(0.8)
  })

  it('splits on sentence-ending punctuation even when short', () => {
    const cues = wordsToCues([w(' Hi.', 0, 0.4), w(' Bye.', 0.4, 0.9)], offset(0))
    expect(cues.map((c) => c.text)).toEqual(['Hi.', 'Bye.'])
    // Second card's words are relative to ITS OWN start, not the first card's.
    expect(cues[1].words?.[0].startSec).toBe(0)
  })

  it('treats a closing quote after the punctuation as a sentence end too', () => {
    expect(wordsToCues([w('"Go!"', 0, 0.4), w('Now', 0.5, 0.9)], offset(0))).toHaveLength(2)
  })

  it('splits after 6 words when there is no punctuation cue', () => {
    const chunks = Array.from({ length: 7 }, (_, i) => w(`w${i}`, i * 0.3, i * 0.3 + 0.25))
    const cues = wordsToCues(chunks, offset(0))
    expect(cues).toHaveLength(2)
    expect(cues[0].words).toHaveLength(6)
    expect(cues[1].words).toHaveLength(1)
  })

  it('splits when a card would exceed 3 seconds', () => {
    const cues = wordsToCues([w('a', 0, 1), w('b', 1, 2), w('c', 2, 3.5)], offset(0))
    expect(cues.map((c) => c.words?.map((x) => x.text))).toEqual([['a', 'b'], ['c']])
  })

  it('starts a new card after a long pause (e.g. between two sung lines)', () => {
    const cues = wordsToCues([w('la', 0, 0.4), w('la', 0.5, 0.8), w('next', 2, 2.4)], offset(0))
    expect(cues.map((c) => c.text)).toEqual(['la la', 'next'])
  })

  it('ends a card at an estimated phrase end', () => {
    const cues = wordsToCues([{ ...w('one', 0, 0.3), phraseEnd: true }, w('two', 0.3, 0.6)], offset(0))
    expect(cues.map((c) => c.text)).toEqual(['one', 'two'])
  })

  it('falls back the end time to the next word start, else a short default', () => {
    const cues = wordsToCues([w('a', 1, null), w('b', 1.4, 1.6), w('only.', 5, null)], offset(0))
    expect(cues[0].words?.[0].endSec).toBeCloseTo(0.4)
    expect(cues[cues.length - 1].endSec).toBeCloseTo(5.2)
  })

  it('drops empty/whitespace-only chunks', () => {
    const cues = wordsToCues([w('  ', 0, 0.1), w('real', 0.1, 0.4)], offset(0))
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('real')
  })

  it('returns no cues for an empty chunk list', () => {
    expect(wordsToCues([], offset(0))).toEqual([])
  })

  it('maps through the source clip speed: limits and word times are in timeline seconds', () => {
    // A 2x clip: 2 source seconds pass per timeline second.
    const toTimeline = (s: number): number => 10 + s / 2
    // 5.8 s of source is 2.9 s on screen (under the 3 s limit), and the 1.8 s
    // source pause before "here" is 0.9 s on screen (under the 1 s pause rule).
    const cues = wordsToCues([w('fast', 0, 1), w('song', 1, 2), w('here', 3.8, 5.8)], toTimeline)
    expect(cues).toHaveLength(1)
    expect(cues[0].startSec).toBeCloseTo(10)
    expect(cues[0].endSec).toBeCloseTo(12.9)
    const got = cues[0].words!.flatMap((x) => [x.startSec, x.endSec])
    ;[0, 0.5, 0.5, 1, 1.9, 2.9].forEach((v, i) => expect(got[i]).toBeCloseTo(v))
    // The same words on a 1x clip span 5.8 s: too long for one card.
    expect(wordsToCues([w('fast', 0, 1), w('song', 1, 2), w('here', 3.8, 5.8)], offset(10)).length).toBeGreaterThan(1)
  })

  it('keeps words in speech order when merged chunks overlap', () => {
    const cues = wordsToCues(
      [w('a', 1, 1.5), w('b', 0.9, 1.2), w(' New York', 1.6, 2.4), w('city', 1.8, 2.6)],
      offset(0)
    )
    const starts = cues.flatMap((c) => c.words?.map((x) => c.startSec + x.startSec) ?? [])
    expect(starts).toHaveLength(5)
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
  })

  it('splits a multi-word chunk so the card text and its words stay 1:1', () => {
    const cues = wordsToCues([w(' New York', 0, 1)], offset(0))
    expect(cues[0].text).toBe('New York')
    expect(cues[0].words?.map((x) => x.text)).toEqual(['New', 'York'])
    expect(cues[0].text.split(/\s+/)).toHaveLength(cues[0].words!.length)
  })

  it('turns estimated phrase timings into cards whose words tile each phrase', () => {
    const cues = wordsToCues(
      estimateWordChunks([
        { text: ' Shine on you crazy diamond', timestamp: [0, 2.5] },
        { text: ' remember when', timestamp: [2.5, 3.5] }
      ]),
      offset(0)
    )
    expect(cues.map((c) => c.text)).toEqual(['Shine on you crazy diamond', 'remember when'])
    const first = cues[0].words!
    for (let i = 1; i < first.length; i++) expect(first[i].startSec).toBeCloseTo(first[i - 1].endSec)
    expect(first[first.length - 1].endSec).toBeCloseTo(2.5)
  })
})
