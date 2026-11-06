import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import {
  cbcr709,
  density,
  maxCount,
  VECTORSCOPE_SIZE,
  VECTORSCOPE_TARGETS,
  vectorscopeXY,
  type ScopeData
} from '../lib/scopes'

// ---------------------------------------------------------------------------
// Scopes panel: histogram (RGB + luma), luma waveform, vectorscope. Preview
// pushes fresh ScopeData through the imperative handle (throttled, see
// Preview.tsx); drawing goes straight to the canvases, no React re-render per
// sample. `null` data shows why the scopes are paused instead.
// ---------------------------------------------------------------------------

export type ScopesPause = 'gpu' | 'export' | null

export interface ScopesHandle {
  update(data: ScopeData | null, pause?: ScopesPause): void
}

const HIST_W = 256
const HIST_H = 100
/** Waveform rows: two luma levels per row, ~1:1 with the on-screen height. */
const WAVE_H = 128
const GRID = 'rgba(255,255,255,0.12)'
const LABEL = 'rgba(255,255,255,0.45)'

function drawHistogram(canvas: HTMLCanvasElement, data: ScopeData): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  canvas.width = HIST_W
  canvas.height = HIST_H
  ctx.clearRect(0, 0, HIST_W, HIST_H)
  ctx.fillStyle = GRID
  for (const g of [64, 128, 192]) ctx.fillRect(g, 0, 1, HIST_H)
  const { r, g, b, luma } = data.histogram
  // Scale by the interior bins, so a clipped 0 / 255 spike doesn't flatten the rest.
  const max = Math.max(maxCount(r, 1, 255), maxCount(g, 1, 255), maxCount(b, 1, 255), maxCount(luma, 1, 255)) || 1
  const y = (c: number): number => HIST_H - Math.min(1, c / max) * (HIST_H - 2)
  ctx.globalCompositeOperation = 'lighter'
  const fills: [Uint32Array, string][] = [
    [r, 'rgba(255,70,70,0.55)'],
    [g, 'rgba(70,220,90,0.55)'],
    [b, 'rgba(80,130,255,0.6)']
  ]
  for (const [bins, color] of fills) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, HIST_H)
    for (let i = 0; i < 256; i++) ctx.lineTo(i + 0.5, y(bins[i]))
    ctx.lineTo(HIST_W, HIST_H)
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < 256; i++) ctx[i === 0 ? 'moveTo' : 'lineTo'](i + 0.5, y(luma[i]))
  ctx.stroke()
}

function drawWaveform(canvas: HTMLCanvasElement, data: ScopeData): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = data.w
  canvas.width = w
  canvas.height = WAVE_H
  const img = ctx.createImageData(w, WAVE_H)
  const px = img.data
  // A column holds `h` samples: a flat field (all h at one level) is full brightness.
  const ref = data.h
  for (let r = 0; r < WAVE_H; r++) {
    const level = (WAVE_H - 1 - r) * 2
    const row = r * w
    for (let x = 0; x < w; x++) {
      const c = data.waveform[level * w + x] + data.waveform[(level + 1) * w + x]
      if (!c) continue
      const v = Math.max(0.3, density(c, ref))
      const o = (row + x) * 4
      px[o] = 110 * v
      px[o + 1] = 255 * v
      px[o + 2] = 130 * v
      px[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  // Graticule: 0 / 25 / 50 / 75 / 100 %.
  ctx.fillStyle = GRID
  for (const pct of [0, 25, 50, 75, 100]) ctx.fillRect(0, Math.min(WAVE_H - 1, Math.round((1 - pct / 100) * WAVE_H)), w, 1)
}

function drawVectorscope(canvas: HTMLCanvasElement, data: ScopeData): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const S = VECTORSCOPE_SIZE
  canvas.width = S
  canvas.height = S
  const img = ctx.createImageData(S, S)
  const px = img.data
  const max = Math.max(16, maxCount(data.vectorscope))
  // Each hit is splatted 3×3 (keeping the brightest), so a flat colour field — a
  // single cell — still reads as a dot once the plot is scaled down on screen.
  for (let i = 0; i < S * S; i++) {
    const c = data.vectorscope[i]
    if (!c) continue
    const v = Math.max(0.35, density(c, max))
    const cx = i % S
    const cy = (i - cx) / S
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy
      if (y < 0 || y >= S) continue
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx
        if (x < 0 || x >= S) continue
        const o = (y * S + x) * 4
        if (px[o + 1] >= 255 * v) continue
        px[o] = 200 * v
        px[o + 1] = 255 * v
        px[o + 2] = 200 * v
        px[o + 3] = 255
      }
    }
  }
  ctx.putImageData(img, 0, 0)
  // Graticule: outer circle (100% Cb/Cr), crosshair, skin-tone line, 75% bar targets.
  const c = S / 2
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(c, c, S / 2 - 1, 0, Math.PI * 2)
  ctx.moveTo(c, 0)
  ctx.lineTo(c, S)
  ctx.moveTo(0, c)
  ctx.lineTo(S, c)
  ctx.stroke()
  // Skin-tone line (~123° from the +Cb axis, towards red/yellow).
  const a = (123 * Math.PI) / 180
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(c, c)
  ctx.lineTo(c + Math.cos(a) * (S / 2), c - Math.sin(a) * (S / 2))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.font = '10px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const tg of VECTORSCOPE_TARGETS) {
    const [x, y] = vectorscopeXY(...cbcr709(...tg.rgb), S)
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'
    ctx.strokeRect(x - 5, y - 5, 10, 10)
    ctx.fillStyle = LABEL
    // Label just outside the box, away from the centre.
    const dx = x - c
    const dy = y - c
    const len = Math.hypot(dx, dy) || 1
    ctx.fillText(tg.label, x + (dx / len) * 14, y + (dy / len) * 14)
  }
}

const Scopes = forwardRef<ScopesHandle>(function Scopes(_props, ref) {
  const t = useT()
  const histRef = useRef<HTMLCanvasElement>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const vecRef = useRef<HTMLCanvasElement>(null)
  const [pause, setPause] = useState<ScopesPause>(null)
  const pauseRef = useRef<ScopesPause>(null)

  useImperativeHandle(ref, () => ({
    update(data, why = null) {
      // Only touch React state when the pause reason actually changes.
      const next = data ? null : why
      if (next !== pauseRef.current) {
        pauseRef.current = next
        setPause(next)
      }
      if (!data) return
      try {
        if (histRef.current) drawHistogram(histRef.current, data)
        if (waveRef.current) drawWaveform(waveRef.current, data)
        if (vecRef.current) drawVectorscope(vecRef.current, data)
      } catch (e) {
        console.error('[cutroom] scopes draw error:', e)
      }
    }
  }))

  return (
    <div className="scopes">
      <figure className="scope">
        <figcaption>{t('Histogram')}</figcaption>
        <canvas ref={histRef} className="scope-hist" width={HIST_W} height={HIST_H} />
      </figure>
      <figure className="scope">
        <figcaption>{t('Waveform')}</figcaption>
        <canvas ref={waveRef} className="scope-wave" width={256} height={WAVE_H} />
      </figure>
      <figure className="scope">
        <figcaption>{t('Vectorscope')}</figcaption>
        <canvas ref={vecRef} className="scope-vec" width={VECTORSCOPE_SIZE} height={VECTORSCOPE_SIZE} />
      </figure>
      {pause && (
        <div className="scopes-paused">
          {pause === 'gpu' ? t('Scopes paused while the GPU reconnects.') : t('Scopes paused during export.')}
        </div>
      )}
    </div>
  )
})

export default Scopes
