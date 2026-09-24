// ---------------------------------------------------------------------------
// Pure options + audio windowing for AI subtitles (Whisper). Kept free of
// DOM/worker code so it is unit-tested directly.
// ---------------------------------------------------------------------------

export type TranscribeModel = 'tiny' | 'base' | 'small'

/** Multilingual Whisper checkpoints (the old `.en` model only knew English). */
export const TRANSCRIBE_MODELS: ReadonlyArray<{ id: TranscribeModel; hub: string; label: string; approxMb: number }> = [
  { id: 'tiny', hub: 'Xenova/whisper-tiny', label: 'Fast', approxMb: 40 },
  { id: 'base', hub: 'Xenova/whisper-base', label: 'Balanced', approxMb: 80 },
  { id: 'small', hub: 'Xenova/whisper-small', label: 'Accurate', approxMb: 250 }
]
export const TRANSCRIBE_MODEL_IDS = TRANSCRIBE_MODELS.map((m) => m.id)

export function modelHub(id: TranscribeModel): string {
  return (TRANSCRIBE_MODELS.find((m) => m.id === id) ?? TRANSCRIBE_MODELS[1]).hub
}

/** Whisper language names (what transformers.js expects), plus 'auto'. */
export const TRANSCRIBE_LANGUAGES = [
  'auto',
  'italian',
  'english',
  'spanish',
  'french',
  'german',
  'portuguese',
  'dutch',
  'polish',
  'romanian',
  'greek',
  'turkish',
  'russian',
  'ukrainian',
  'arabic',
  'hindi',
  'chinese',
  'japanese',
  'korean'
] as const
export type TranscribeLanguage = (typeof TRANSCRIBE_LANGUAGES)[number]

const BCP47_TO_WHISPER: Record<string, TranscribeLanguage> = {
  it: 'italian',
  en: 'english',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  pt: 'portuguese',
  nl: 'dutch',
  pl: 'polish',
  ro: 'romanian',
  el: 'greek',
  tr: 'turkish',
  ru: 'russian',
  uk: 'ukrainian',
  ar: 'arabic',
  hi: 'hindi',
  zh: 'chinese',
  ja: 'japanese',
  ko: 'korean'
}

/** Default spoken language from the OS locale (e.g. 'it-IT' -> italian), else auto. */
export function defaultTranscribeLanguage(locale: string | undefined): TranscribeLanguage {
  const prefix = (locale ?? '').toLowerCase().split(/[-_]/)[0]
  return BCP47_TO_WHISPER[prefix] ?? 'auto'
}

function rms(pcm: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i++) sum += pcm[i] * pcm[i]
  return end > start ? Math.sqrt(sum / (end - start)) : 0
}

/**
 * Split PCM into windows of at most `maxSec`, ending each one at the quietest
 * 50 ms spot within the last `searchSec` before the limit — so a word is never
 * sliced in half at a window boundary (Whisper garbles cut-off words). Returns
 * [start, end) sample ranges covering the whole input.
 */
export function splitAtQuiet(pcm: Float32Array, sampleRate: number, maxSec: number, searchSec: number): Array<[number, number]> {
  const max = Math.max(1, Math.floor(maxSec * sampleRate))
  const search = Math.min(max - 1, Math.floor(searchSec * sampleRate))
  const hop = Math.max(1, Math.floor(0.05 * sampleRate))
  const out: Array<[number, number]> = []
  let start = 0
  while (start < pcm.length) {
    if (pcm.length - start <= max) {
      out.push([start, pcm.length])
      break
    }
    let best = start + max
    let bestRms = Infinity
    for (let cut = start + max - search; cut + hop <= start + max; cut += hop) {
      const r = rms(pcm, cut, cut + hop)
      if (r < bestRms) {
        bestRms = r
        best = cut + Math.floor(hop / 2)
      }
    }
    out.push([start, best])
    start = best
  }
  return out
}

/** Below this RMS (~ -50 dBFS) a window is treated as silence and skipped —
 *  Whisper hallucinates stock phrases on silent input. */
export const SILENCE_RMS = 0.003

export function isSilent(pcm: Float32Array, start: number, end: number): boolean {
  return rms(pcm, start, end) < SILENCE_RMS
}
