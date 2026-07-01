import type { Settings } from '../state/settings'

// ---------------------------------------------------------------------------
// Theme application. Each preset overrides the surface/text/border tokens; the
// accent is user-controlled and we DERIVE its hover/active/soft/ring/on-accent
// companions so a custom accent stays cohesive. Density rescales spacing tokens
// and reduce-motion zeroes the transition tokens. Everything is applied as
// inline custom properties on :root, which override the stylesheet defaults.
// ---------------------------------------------------------------------------

type Tokens = Record<string, string>

export const DEFAULT_ACCENT = '#4c8dff'

const PRESETS: Record<string, Tokens> = {
  graphite: {
    '--bg': '#0f1014', '--panel': '#16171d', '--panel-2': '#1d1f27', '--panel-3': '#262932',
    '--sunken': '#0b0c10', '--overlay': 'rgba(8,9,12,0.62)',
    '--line': '#2a2d38', '--line-strong': '#3a3e4c', '--line-soft': '#20232c',
    '--text': '#e7e9f0', '--text-2': '#b6bac6', '--muted': '#7d8294', '--faint': '#565b69'
  },
  midnight: {
    '--bg': '#080b14', '--panel': '#0e1322', '--panel-2': '#141b2e', '--panel-3': '#1c2540',
    '--sunken': '#05070f', '--overlay': 'rgba(4,6,14,0.66)',
    '--line': '#222c44', '--line-strong': '#33405e', '--line-soft': '#171e30',
    '--text': '#e6eaf5', '--text-2': '#aeb6cc', '--muted': '#737c96', '--faint': '#4e566e'
  },
  slate: {
    '--bg': '#141518', '--panel': '#1c1e22', '--panel-2': '#24272d', '--panel-3': '#2e323a',
    '--sunken': '#101113', '--overlay': 'rgba(10,11,13,0.62)',
    '--line': '#33373f', '--line-strong': '#444955', '--line-soft': '#26292f',
    '--text': '#e9eaec', '--text-2': '#b8bcc4', '--muted': '#82868f', '--faint': '#5a5e68'
  },
  contrast: {
    '--bg': '#000000', '--panel': '#0c0d10', '--panel-2': '#15171c', '--panel-3': '#202329',
    '--sunken': '#000000', '--overlay': 'rgba(0,0,0,0.72)',
    '--line': '#454a57', '--line-strong': '#5e6473', '--line-soft': '#2e323c',
    '--text': '#ffffff', '--text-2': '#d6d9e2', '--muted': '#9aa0ae', '--faint': '#6b7080'
  }
}

const SP_COMFORTABLE: Tokens = { '--sp-4': '8px', '--sp-5': '10px', '--sp-6': '12px', '--sp-7': '16px', '--sp-8': '20px', '--sp-9': '24px' }
const SP_COMPACT: Tokens = { '--sp-4': '6px', '--sp-5': '8px', '--sp-6': '9px', '--sp-7': '12px', '--sp-8': '15px', '--sp-9': '18px' }

const MOTION_ON: Tokens = { '--t-fast': '90ms var(--ease)', '--t-base': '140ms var(--ease)', '--t-slow': '220ms var(--ease)' }
const MOTION_OFF: Tokens = { '--t-fast': '0ms', '--t-base': '0ms', '--t-slow': '0ms' }

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(v || '000000', 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c) => clampByte(c).toString(16).padStart(2, '0')).join('')
}

/** Mix `hex` toward `target` by amount 0..1. */
function mix(hex: string, target: [number, number, number], amt: number): string {
  const [r, g, b] = hexToRgb(hex)
  return toHex(r + (target[0] - r) * amt, g + (target[1] - g) * amt, b + (target[2] - b) * amt)
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** WCAG relative luminance (0..1). */
function relLuminance(hex: string): number {
  const lin = hexToRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** WCAG contrast ratio between two hex colours (1..21). */
function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The more readable of dark-navy vs white text over the accent. */
function bestOnAccent(accent: string): string {
  return contrastRatio(accent, '#06122b') >= contrastRatio(accent, '#ffffff') ? '#06122b' : '#ffffff'
}

const WHITE: [number, number, number] = [255, 255, 255]
const BLACK: [number, number, number] = [0, 0, 0]

/** Apply the full set of theme-managed custom properties to :root. Idempotent. */
export function applyTheme(s: Settings): void {
  const root = document.documentElement
  const setAll = (t: Tokens): void => {
    for (const [k, v] of Object.entries(t)) root.style.setProperty(k, v)
  }

  setAll(PRESETS[s.theme] ?? PRESETS.graphite)

  // Accent + derived companions, so any custom accent stays self-consistent.
  const accent = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.accent) ? s.accent : DEFAULT_ACCENT
  setAll({
    '--accent': accent,
    '--accent-hover': mix(accent, WHITE, 0.18),
    '--accent-active': mix(accent, BLACK, 0.12),
    '--accent-soft': rgba(accent, 0.14),
    '--accent-ring': rgba(accent, 0.45),
    '--accent-disabled': mix(accent, hexToRgb(PRESETS[s.theme]?.['--bg'] ?? '#0f1014'), 0.62),
    '--on-accent': bestOnAccent(accent)
  })

  setAll(s.density === 'compact' ? SP_COMPACT : SP_COMFORTABLE)
  setAll(s.reduceMotion ? MOTION_OFF : MOTION_ON)
}
