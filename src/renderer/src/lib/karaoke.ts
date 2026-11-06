import type { WordTiming } from '../types'
import type { SubtitleCue } from '../state/store'

// ---------------------------------------------------------------------------
// Karaoke (word-timed) subtitles: pure helpers shared by transcription (word
// timings -> caption cards), the store's edits (rebasing on split / head trim)
// and the compositor (which word is active). No DOM, so unit-tested directly.
// ---------------------------------------------------------------------------

/** A Whisper output chunk: [start, end] in seconds from the start of the audio
 *  it was given (end is null when the audio stops mid-phrase). */
export interface WhisperChunk {
  timestamp: [number, number | null]
  text: string
}

/** A one-word chunk. `phraseEnd` marks the last word of a phrase whose word
 *  times were estimated, so its caption card ends there. */
export interface WordChunk extends WhisperChunk {
  phraseEnd?: boolean
}

/**
 * Index of the word active at clip-relative time `tRel`, or -1 before the
 * first word starts. Sticks on the last word that started (through pauses and
 * after its own end, until the card leaves the timeline) rather than blanking
 * between words, which would flicker. Assumes `words` is sorted by startSec
 * (wordsToCues and the project loader guarantee it).
 */
export function activeWordIndex(words: readonly WordTiming[], tRel: number): number {
  if (words.length === 0 || tRel < words[0].startSec) return -1
  let idx = 0
  for (let i = 1; i < words.length; i++) {
    if (words[i].startSec <= tRel) idx = i
    else break
  }
  return idx
}

/** Shift every word by `deltaSec`: rebasing for a clip whose head moved by
 *  -deltaSec (split, head trim), so each word keeps its timeline position. */
export function shiftWords(words: readonly WordTiming[], deltaSec: number): WordTiming[] {
  return words.map((w) => ({ ...w, startSec: w.startSec + deltaSec, endSec: w.endSec + deltaSec }))
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Letters and digits in a word: what takes time to say or sing (punctuation
 *  doesn't). At least 1, so every word gets some time. */
function wordWeight(word: string): number {
  return Math.max(1, word.match(/[\p{L}\p{N}]/gu)?.length ?? 0)
}

/** Split `text` into words and share [start, end] between them in proportion
 *  to their length. The words tile the span: each starts where the last ended. */
export function distributeWords(text: string, start: number, end: number): Array<{ text: string; start: number; end: number }> {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const total = words.reduce((n, w) => n + wordWeight(w), 0)
  const span = Math.max(0, end - start)
  let acc = 0
  return words.map((w) => {
    const s = start + (acc / total) * span
    acc += wordWeight(w)
    return { text: w, start: s, end: start + (acc / total) * span }
  })
}

/** Start of the first later chunk that begins after `after` (an open-ended
 *  chunk's best end estimate). */
function nextStart(chunks: readonly WhisperChunk[], i: number, after: number): number | undefined {
  for (let j = i + 1; j < chunks.length; j++) {
    const s = chunks[j].timestamp?.[0]
    if (isFiniteNum(s) && s > after) return s
  }
  return undefined
}

/**
 * Approximate word timings from phrase (segment) timestamps: each segment's
 * span is shared between its words in proportion to their length. The
 * fallback when a model can't produce word-level timestamps — close enough to
 * follow along, not syllable-exact.
 */
export function estimateWordChunks(segments: readonly WhisperChunk[]): WordChunk[] {
  const out: WordChunk[] = []
  for (let i = 0; i < segments.length; i++) {
    const text = (segments[i].text ?? '').trim()
    const start = segments[i].timestamp?.[0]
    if (!text || !isFiniteNum(start)) continue
    const count = text.split(/\s+/).length
    let end = segments[i].timestamp?.[1]
    if (!isFiniteNum(end)) end = nextStart(segments, i, start) ?? start + Math.max(2, 0.4 * count)
    // A zero-length segment would light every word up at once.
    end = Math.max(end, start + 0.2 * count)
    const words = distributeWords(text, start, end)
    words.forEach((w, k) => {
      out.push({ text: w.text, timestamp: [w.start, w.end], ...(k === words.length - 1 ? { phraseEnd: true } : {}) })
    })
  }
  return out
}

/**
 * Whether word-level output can be trusted: there is at least one word, every
 * word has a finite start, the starts aren't all collapsed onto one instant,
 * and the chunks really are single words (mostly multi-word chunks mean
 * phrase timestamps came back instead).
 */
export function usableWordChunks(chunks: readonly WhisperChunk[]): boolean {
  const spoken = chunks.filter((c) => (c.text ?? '').trim())
  if (spoken.length === 0) return false
  if (!spoken.every((c) => isFiniteNum(c.timestamp?.[0]))) return false
  if (spoken.length > 1 && spoken.every((c) => c.timestamp[0] === spoken[0].timestamp[0])) return false
  const multi = spoken.filter((c) => c.text.trim().split(/\s+/).length > 1).length
  return multi <= spoken.length / 2
}

/** Caption-card limits for word-timed (karaoke) subtitles. */
export interface CardLimits {
  /** Most words on one card. */
  maxWords: number
  /** Longest a card may stay up, in seconds. */
  maxSec: number
  /** A pause at least this long between two words starts a new card (e.g. an
   *  instrumental break between two sung lines). */
  maxGapSec: number
}

export const CARD_LIMITS: CardLimits = { maxWords: 6, maxSec: 3, maxGapSec: 1 }

// Sentence-ending punctuation, optionally followed by closing quotes/brackets.
const SENTENCE_END = /[.!?…。！？]["'”’»)\]]*$/

/**
 * Group word chunks (seconds within a window) into karaoke subtitle cues:
 * consecutive words share a card up to `limits.maxWords` words or
 * `limits.maxSec` seconds, and a card also ends after sentence punctuation, at
 * an estimated phrase's end, and before a long pause. Each cue keeps its
 * words' timing relative to ITS OWN start, since every cue becomes one clip
 * (WordTiming is clip-relative). `toTimeline` maps window seconds to timeline
 * seconds (through the source clip's speed), so the limits apply to what the
 * viewer sees.
 */
export function wordsToCues(
  chunks: readonly WordChunk[],
  toTimeline: (sec: number) => number,
  limits: CardLimits = CARD_LIMITS
): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let group: Array<{ text: string; start: number; end: number }> = []

  const flush = (): void => {
    if (group.length === 0) return
    const start = group[0].start
    const end = Math.max(start + 0.2, ...group.map((w) => w.end))
    cues.push({
      startSec: start,
      endSec: end,
      text: group.map((w) => w.text).join(' '),
      words: group.map((w) => ({ text: w.text, startSec: w.start - start, endSec: w.end - start }))
    })
    group = []
  }

  let prevStart = -Infinity
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    const text = (c.text ?? '').trim()
    const t0 = c.timestamp?.[0]
    if (!text || !isFiniteNum(t0)) continue
    let t1 = c.timestamp?.[1]
    if (!isFiniteNum(t1)) t1 = nextStart(chunks, i, t0) ?? t0 + 0.2
    // Kept in speech order (merged pipeline chunks can overlap a hair), so
    // activeWordIndex's sorted scan holds.
    const start = Math.max(toTimeline(t0), prevStart)
    const end = Math.max(start, toTimeline(Math.max(t0, t1)))
    // Split a multi-word chunk so the card's text and its words stay 1:1 —
    // the renderer pairs them up by position.
    for (const w of distributeWords(text, start, end)) {
      const last = group[group.length - 1]
      if (
        last &&
        (group.length >= limits.maxWords || w.end - group[0].start > limits.maxSec || w.start - last.end >= limits.maxGapSec)
      ) {
        flush()
      }
      group.push(w)
      prevStart = w.start
    }
    if (c.phraseEnd || SENTENCE_END.test(text)) flush()
  }
  flush()
  return cues
}
