import { useEffect, useRef, useState } from 'react'
import { posFromThumb, thumbGeometry } from '../lib/timelineScroll'

// ---------------------------------------------------------------------------
// A plain scrollbar for the canvas timeline (which draws its own content, so
// there is no native overflow to scroll). `pos`, `visible` and `extent` share
// one unit (seconds horizontally, px vertically). Drag the thumb to scroll;
// press the track to page one view toward the pointer.
// ---------------------------------------------------------------------------

interface Props {
  orientation: 'horizontal' | 'vertical'
  pos: number
  visible: number
  extent: number
  onChange: (pos: number) => void
  className?: string
  style?: React.CSSProperties
  label: string
}

export default function ScrollBar({ orientation, pos, visible, extent, onChange, className, style, label }: Props) {
  const horizontal = orientation === 'horizontal'
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackPx, setTrackPx] = useState(0)
  const drag = useRef<{ startClient: number; startOffset: number } | null>(null)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = (): void => setTrackPx(horizontal ? el.clientWidth : el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [horizontal])

  const { offset, size } = thumbGeometry(pos, visible, extent, trackPx)
  const scrollable = extent > visible && trackPx > 0
  const client = (e: React.PointerEvent): number => (horizontal ? e.clientX : e.clientY)

  const onThumbDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    drag.current = { startClient: client(e), startOffset: offset }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onThumbMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    onChange(posFromThumb(d.startOffset + client(e) - d.startClient, visible, extent, trackPx))
  }
  const onThumbUp = (): void => {
    drag.current = null
  }

  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !scrollable) return
    const rect = e.currentTarget.getBoundingClientRect()
    const at = client(e) - (horizontal ? rect.left : rect.top)
    onChange(pos + (at < offset ? -visible : visible) * 0.9)
  }

  return (
    <div
      ref={trackRef}
      className={`scrollbar ${horizontal ? 'scrollbar-h' : 'scrollbar-v'} ${scrollable ? '' : 'idle'} ${className ?? ''}`}
      style={style}
      role="scrollbar"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(extent - visible))}
      aria-valuenow={Math.round(pos)}
      onPointerDown={onTrackDown}
    >
      {scrollable && (
        <div
          className="scrollbar-thumb"
          style={horizontal ? { left: offset, width: size } : { top: offset, height: size }}
          onPointerDown={onThumbDown}
          onPointerMove={onThumbMove}
          onPointerUp={onThumbUp}
          onPointerCancel={onThumbUp}
        />
      )}
    </div>
  )
}
