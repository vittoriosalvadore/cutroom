// ---------------------------------------------------------------------------
// Preview resolution (Options → Performance → Preview quality). The preview
// compositor draws into a smaller backing canvas and CSS stretches it to the
// same on-screen size; all geometry is in normalized frame units, so only the
// pixel density changes. Export builds its own Compositor at scale 1.
// ---------------------------------------------------------------------------

export type PreviewQuality = 'full' | 'half' | 'quarter'

export const PREVIEW_QUALITIES: readonly PreviewQuality[] = ['full', 'half', 'quarter']

const SCALE: Record<PreviewQuality, number> = { full: 1, half: 0.5, quarter: 0.25 }

/** Linear render scale for a quality setting (unknown values render full). */
export function previewScale(q: unknown): number {
  return typeof q === 'string' && Object.hasOwn(SCALE, q) ? SCALE[q as PreviewQuality] : 1
}

/**
 * Backing-canvas size for a `w`×`h` project at `scale` (clamped to (0, 1]).
 * Rounded to whole pixels, never below 2×2; scale 1 returns the size as-is.
 */
export function scaledCanvasSize(w: number, h: number, scale: number): { w: number; h: number } {
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1
  if (s === 1) return { w, h }
  return { w: Math.max(2, Math.round(w * s)), h: Math.max(2, Math.round(h * s)) }
}
