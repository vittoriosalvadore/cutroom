import { create } from 'zustand'
import { applyTheme } from '../lib/theme'
import type { Lang } from '../lib/i18n'

// ---------------------------------------------------------------------------
// App settings (theme, decoding, editing, export, visual options).
//
// The schema + defaults live here in the renderer; the main process just
// durably stores the JSON blob. Settings hydrate once on boot, apply live, and
// persist (debounced) on every change. Every option below maps to real
// behavior somewhere in the app — nothing here is decorative.
// ---------------------------------------------------------------------------

export type ThemePreset = 'graphite' | 'midnight' | 'slate' | 'contrast'
export type Density = 'comfortable' | 'compact'
export type ExportPreset = 'ultrafast' | 'veryfast' | 'fast' | 'medium' | 'slow'

export interface Settings {
  // --- decoding & performance ---
  /** Use the GPU for decode/compositing. Requires a restart to take effect. */
  hardwareAcceleration: boolean
  /** Show placeholder cards in the preview for clips that can't be decoded yet. */
  showPlaceholders: boolean
  // --- editing ---
  /** Snap clip edges to other clips and the playhead while dragging. */
  snapping: boolean
  /** Default crossfade / fade length, in seconds. */
  defaultFadeSec: number
  /** Draw audio waveforms on timeline clips. */
  showWaveforms: boolean
  // --- export ---
  exportPreset: ExportPreset
  /** x264 CRF, 14 (high quality) .. 28 (small file). */
  exportCrf: number
  // --- appearance ---
  theme: ThemePreset
  /** Accent colour (hex). Drives all primary + selection state. */
  accent: string
  density: Density
  /** Disable UI transitions/animations. */
  reduceMotion: boolean
  /** UI language. */
  language: Lang
}

export const DEFAULT_SETTINGS: Settings = {
  hardwareAcceleration: true,
  showPlaceholders: true,
  snapping: true,
  defaultFadeSec: 0.5,
  showWaveforms: true,
  exportPreset: 'medium',
  exportCrf: 20,
  theme: 'graphite',
  accent: '#4c8dff',
  density: 'comfortable',
  reduceMotion: false,
  language: 'en'
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}
function clampNum(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : undefined
}

/**
 * Validate untrusted settings JSON field-by-field. A hand-edited or partially
 * written settings.json must never inject a wrong-typed value (e.g. a NaN-coercing
 * defaultFadeSec that would corrupt crossfade timing). Anything invalid is simply
 * omitted, so the merge over DEFAULT_SETTINGS falls back to the default.
 */
export function sanitize(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  const out: Partial<Settings> = {}
  const bool = (k: keyof Settings): void => {
    if (typeof o[k] === 'boolean') (out as Record<string, unknown>)[k] = o[k]
  }
  bool('hardwareAcceleration')
  bool('showPlaceholders')
  bool('snapping')
  bool('showWaveforms')
  bool('reduceMotion')
  const fade = clampNum(o.defaultFadeSec, 0.1, 2)
  if (fade !== undefined) out.defaultFadeSec = fade
  const crf = clampNum(o.exportCrf, 14, 28)
  if (crf !== undefined) out.exportCrf = crf
  const preset = oneOf(o.exportPreset, ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'] as const)
  if (preset) out.exportPreset = preset
  const theme = oneOf(o.theme, ['graphite', 'midnight', 'slate', 'contrast'] as const)
  if (theme) out.theme = theme
  const density = oneOf(o.density, ['comfortable', 'compact'] as const)
  if (density) out.density = density
  const language = oneOf(o.language, ['en', 'es', 'fr', 'de'] as const)
  if (language) out.language = language
  if (typeof o.accent === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(o.accent)) out.accent = o.accent
  return out
}

/** Pull just the persistable Settings out of the store state (drop store methods). */
function pick(s: Settings): Settings {
  return {
    hardwareAcceleration: s.hardwareAcceleration,
    showPlaceholders: s.showPlaceholders,
    snapping: s.snapping,
    defaultFadeSec: s.defaultFadeSec,
    showWaveforms: s.showWaveforms,
    exportPreset: s.exportPreset,
    exportCrf: s.exportCrf,
    theme: s.theme,
    accent: s.accent,
    density: s.density,
    reduceMotion: s.reduceMotion,
    language: s.language
  }
}

interface SettingsState extends Settings {
  hydrated: boolean
  /** Bumps on any change so canvas surfaces (the timeline) can re-read theme vars. */
  rev: number
  set: (patch: Partial<Settings>) => void
  reset: () => void
  hydrate: () => Promise<void>
}

let writeTimer: number | undefined
function persist(s: Settings): void {
  if (writeTimer) window.clearTimeout(writeTimer)
  writeTimer = window.setTimeout(() => {
    void window.cutroom?.writeSettings(JSON.stringify(pick(s)))
  }, 300)
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,
  rev: 0,
  set: (patch) => {
    for (const k of Object.keys(patch) as (keyof Settings)[]) touched.add(k)
    set((s) => ({ ...patch, rev: s.rev + 1 }))
    const s = get()
    applyTheme(s)
    persist(s)
  },
  reset: () => {
    set((s) => ({ ...DEFAULT_SETTINGS, rev: s.rev + 1 }))
    const s = get()
    applyTheme(s)
    persist(s)
  },
  hydrate: async () => {
    try {
      const json = await window.cutroom?.readSettings()
      if (json) {
        // Only apply loaded values for keys the user hasn't already changed in
        // this session (the modal can be touched during the async read), then
        // validate every field so a corrupt file can't inject a bad value.
        const clean = sanitize(JSON.parse(json))
        const untouched = {} as Partial<Settings>
        for (const k of Object.keys(clean) as (keyof Settings)[]) {
          if (!touched.has(k)) (untouched as Record<string, unknown>)[k] = clean[k]
        }
        set({ ...untouched, hydrated: true })
      } else {
        set({ hydrated: true })
      }
    } catch {
      set({ hydrated: true })
    }
    applyTheme(get())
  }
}))

// Keys the user changed this session — so a late-resolving hydrate can't clobber them.
const touched = new Set<keyof Settings>()

/** Write any pending settings change immediately (best effort) — used on quit. */
export function flushSettings(): void {
  if (writeTimer !== undefined) {
    window.clearTimeout(writeTimer)
    writeTimer = undefined
    void window.cutroom?.writeSettings(JSON.stringify(pick(useSettings.getState())))
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushSettings)
  window.addEventListener('pagehide', flushSettings)
}
