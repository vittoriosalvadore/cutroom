import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES, dictionary, interpolate, interpolateParts, translate, type Lang } from './i18n'

const OTHER: Exclude<Lang, 'en'>[] = ['es', 'fr', 'de']
const SRC = join(__dirname, '..')

/** Every renderer source file (tests excluded). */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

/**
 * The literal keys passed to t(...) across the renderer — `t('…')` / `t("…")`,
 * possibly with the string on the next line. Dynamic keys (t(variable)) can't
 * be seen here; they're listed in DYNAMIC_KEYS below.
 */
function usedKeys(): Set<string> {
  const keys = new Set<string>()
  const re = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(re)) keys.add((m[1] ?? m[2]).replace(/\\(.)/g, '$1'))
  }
  return keys
}

// Keys reached through t(variable): settings tab names, crop sides, media kinds,
// export preset names (shared/exportOptions) and the exporter's fallback warning.
const DYNAMIC_KEYS = [
  // transcription model labels (lib/transcribeOptions)
  'Fast',
  'Balanced',
  'Accurate',
  'Performance',
  'Editing',
  'Export',
  'Appearance',
  'Top',
  'Bottom',
  'Left',
  'Right',
  'Video',
  'Image',
  'YouTube 1080p',
  'Vertical 1080×1920 (Reels/TikTok)',
  'High quality master',
  'Small file 720p',
  'The hardware encoder failed, so this export used the software encoder.'
]

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('i18n dictionaries', () => {
  it('lists every language that has a dictionary', () => {
    expect(LANGUAGES.map((l) => l.value).sort()).toEqual(['de', 'en', 'es', 'fr'])
  })

  it('translates every t() key used in the UI into each language', () => {
    const keys = [...usedKeys(), ...DYNAMIC_KEYS]
    expect(keys.length).toBeGreaterThan(100) // the scan actually found the call sites
    for (const lang of OTHER) {
      const dict = dictionary(lang)
      const missing = keys.filter((k) => !(k in dict))
      expect(missing, `${lang} is missing translations`).toEqual([])
    }
  })

  it('has no stale entries: each dictionary key is used by the UI', () => {
    const used = new Set([...usedKeys(), ...DYNAMIC_KEYS])
    for (const lang of OTHER) {
      const stale = Object.keys(dictionary(lang)).filter((k) => !used.has(k))
      expect(stale, `${lang} has unused keys`).toEqual([])
    }
  })

  it('all languages share one key set (the English keys)', () => {
    const es = Object.keys(dictionary('es')).sort()
    for (const lang of OTHER) expect(Object.keys(dictionary(lang)).sort()).toEqual(es)
  })

  it('translations keep the same {placeholders} as their English key', () => {
    for (const lang of OTHER) {
      for (const [key, value] of Object.entries(dictionary(lang))) {
        expect(placeholders(value), `${lang}: ${key}`).toEqual(placeholders(key))
        expect(value.trim().length, `${lang}: ${key}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('translate', () => {
  it('English is the key; other languages fall back to it', () => {
    expect(translate('Play', 'en')).toBe('Play')
    expect(translate('Play', 'es')).toBe('Reproducir')
    expect(translate('Not a real key', 'de')).toBe('Not a real key')
  })

  it('fills placeholders after translating', () => {
    expect(translate('{n} clips selected', 'en', { n: 3 })).toBe('3 clips selected')
    expect(translate('{n} clips selected', 'fr', { n: 3 })).toBe('3 clips sélectionnés')
  })
})

describe('interpolate', () => {
  it('substitutes named placeholders, repeated ones included', () => {
    expect(interpolate('{a} + {a} = {b}', { a: 1, b: '2' })).toBe('1 + 1 = 2')
  })

  it('leaves unknown placeholders visible and text without vars untouched', () => {
    expect(interpolate('Hi {name}', { other: 'x' })).toBe('Hi {name}')
    expect(interpolate('Hi {name}')).toBe('Hi {name}')
  })
})

describe('interpolateParts', () => {
  it('splits around placeholders, keeping non-string values intact', () => {
    const bold = { tag: 'b' }
    expect(interpolateParts('Found {n} in {name}.', { n: 3, name: bold })).toEqual(['Found ', 3, ' in ', bold, '.'])
  })

  it('handles placeholders at the edges and unknown ones', () => {
    expect(interpolateParts('{x} end', { x: 1 })).toEqual([1, ' end'])
    expect(interpolateParts('start {x}', { x: 1 })).toEqual(['start ', 1])
    expect(interpolateParts('keep {y} as text', { x: 1 })).toEqual(['keep {y} as text'])
  })
})
