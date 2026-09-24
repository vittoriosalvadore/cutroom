import { useMemo, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { useT } from '../lib/i18n'
import {
  addCurvePoint,
  compileCurve,
  CURVE_CHANNELS,
  identityCurves,
  isDefaultChannel,
  moveCurvePoint,
  removeCurvePoint
} from '../lib/curves'
import type { ColorCurves, CurveChannel, CurvePoint } from '../types'

// ---------------------------------------------------------------------------
// Inspector RGB-curves widget (SVG). Click empty space to add a point, drag a
// point to move it, double-click or right-click a point to remove it. One undo
// step per gesture: the pointerdown snapshots (the Inspector's control-snapshot
// only covers form controls), every move then edits the same step.
// ---------------------------------------------------------------------------

const CHANNEL_COLOR: Record<CurveChannel, string> = {
  master: '#e8e8e8',
  r: '#ff5a5a',
  g: '#4fd65f',
  b: '#5a8dff'
}

/** Grab radius around a point, in CSS pixels. */
const HIT_PX = 9
/** SVG user-space size (the curve square is 0..VB on both axes). */
const VB = 256

function curvePath(points: CurvePoint[]): string {
  const f = compileCurve(points)
  let d = ''
  for (let i = 0; i <= 64; i++) {
    const x = i / 64
    d += `${i === 0 ? 'M' : 'L'}${(x * VB).toFixed(1)},${((1 - f(x)) * VB).toFixed(1)}`
  }
  return d
}

export default function CurvesEditor({ clipId, curves }: { clipId: string; curves: ColorCurves | undefined }) {
  const t = useT()
  const [channel, setChannel] = useState<CurveChannel>('master')
  const svgRef = useRef<SVGSVGElement>(null)
  // Index of the point being dragged (null = no gesture in progress).
  const drag = useRef<number | null>(null)
  /** Whether this gesture already recorded its undo snapshot. */
  const snapped = useRef(false)
  const [active, setActive] = useState<number | null>(null)

  const all = curves ?? identityCurves()
  const points = all[channel]
  const paths = useMemo(() => {
    const out = {} as Record<CurveChannel, string>
    for (const ch of CURVE_CHANNELS) out[ch] = curvePath(all[ch])
    return out
  }, [all])

  const labels: Record<CurveChannel, string> = { master: t('Master'), r: t('Red'), g: t('Green'), b: t('Blue') }

  /** Pointer -> normalized curve coordinates (x right, y up), plus the element box. */
  const toCurve = (e: { clientX: number; clientY: number }): { x: number; y: number; w: number; h: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const r = svg.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height, w: r.width, h: r.height }
  }

  /** Nearest point within the grab radius, or -1. */
  const hit = (pos: { x: number; y: number; w: number; h: number }): number => {
    let best = -1
    let bestD = HIT_PX
    points.forEach((p, i) => {
      const d = Math.hypot((p.x - pos.x) * pos.w, (p.y - pos.y) * pos.h)
      if (d <= bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  const set = (pts: CurvePoint[]): void => useEditor.getState().setCurvePoints(clipId, channel, pts)

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return
    const pos = toCurve(e)
    if (!pos) return
    let i = hit(pos)
    // Snapshot for undo only once something actually changes: a plain click
    // on a point (or a refused add) must not push an empty step / clear redo.
    snapped.current = false
    if (i < 0) {
      const added = addCurvePoint(points, pos.x, pos.y)
      if (!added) return
      useEditor.getState().snapshot()
      snapped.current = true
      set(added.points)
      i = added.index
    }
    drag.current = i
    setActive(i)
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const i = drag.current
    if (i === null) return
    const pos = toCurve(e)
    if (!pos) return
    // Read the live points (the prop may lag a render behind a fast drag).
    const live = useEditor.getState().project.clips[clipId]?.effects?.curves?.[channel] ?? points
    const moved = moveCurvePoint(live, i, pos.x, pos.y)
    if (moved[i]?.x === live[i]?.x && moved[i]?.y === live[i]?.y) return
    if (!snapped.current) {
      useEditor.getState().snapshot() // first real move of this drag = one undo step
      snapped.current = true
    }
    set(moved)
  }

  const endDrag = (): void => {
    drag.current = null
  }

  const removeAt = (e: { clientX: number; clientY: number }): void => {
    const pos = toCurve(e)
    if (!pos) return
    const i = hit(pos)
    if (i < 0 || points.length <= 2) return
    useEditor.getState().snapshot()
    set(removeCurvePoint(points, i))
    setActive(null)
  }

  return (
    <div className="curves" data-no-snapshot>
      <div className="insp-row curves-bar">
        <div className="insp-toggle-group">
          {CURVE_CHANNELS.map((ch) => (
            <button
              key={ch}
              className={`btn small ${channel === ch ? 'active' : ''}`}
              style={{ color: channel === ch ? CHANNEL_COLOR[ch] : undefined }}
              title={labels[ch]}
              onClick={() => {
                setChannel(ch)
                setActive(null)
              }}
            >
              {ch === 'master' ? labels.master : ch.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          className="btn small"
          title={t('Reset curve')}
          disabled={isDefaultChannel(points)}
          onClick={() => {
            useEditor.getState().snapshot()
            useEditor.getState().resetCurves(clipId, channel)
            setActive(null)
          }}
        >
          {t('Reset')}
        </button>
      </div>
      <svg
        ref={svgRef}
        className="curves-svg"
        viewBox={`0 0 ${VB} ${VB}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('{channel} curve', { channel: labels[channel] })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={removeAt}
        onContextMenu={(e) => {
          e.preventDefault()
          removeAt(e)
        }}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} className="curves-grid">
            <line x1={g * VB} y1={0} x2={g * VB} y2={VB} />
            <line x1={0} y1={g * VB} x2={VB} y2={g * VB} />
          </g>
        ))}
        <line className="curves-diag" x1={0} y1={VB} x2={VB} y2={0} />
        {/* Other channels faintly underneath, the edited one on top. */}
        {CURVE_CHANNELS.filter((ch) => ch !== channel && !isDefaultChannel(all[ch])).map((ch) => (
          <path key={ch} d={paths[ch]} className="curves-line faint" style={{ stroke: CHANNEL_COLOR[ch] }} />
        ))}
        <path d={paths[channel]} className="curves-line" style={{ stroke: CHANNEL_COLOR[channel] }} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x * VB}
            cy={(1 - p.y) * VB}
            r={i === active ? 7 : 5.5}
            className={`curves-pt ${i === active ? 'active' : ''}`}
            style={{ stroke: CHANNEL_COLOR[channel] }}
          />
        ))}
      </svg>
    </div>
  )
}
