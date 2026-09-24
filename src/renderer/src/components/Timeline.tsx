import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { audioCacheVersion, getAudioEntry, PEAKS_PER_SEC, subscribeAudioCache } from '../lib/audioCache'
import { computeTrim, snapMove, snapTime } from '../lib/editing'
import { roundRectPath } from '../lib/canvas'
import { clipSpeed } from '../lib/clipTime'
import { timelineDuration } from '../lib/exporter'
import { clampScrollSec, clampScrollY, followPlayhead, zoomAnchoredScroll } from '../lib/timelineScroll'
import { canRemoveTrack, clipsInMarquee, trackDropTarget } from '../lib/tracks'
import { removeTrackWithConfirm } from '../lib/trackActions'
import { useT } from '../lib/i18n'
import type { Clip, Project, Track, TrackKind } from '../types'

// Layout constants (in CSS pixels).
const GUTTER = 78 // left label column width
const RULER = 28 // top time-ruler height
const EDGE_PX = 7 // grab zone (and drawn width) of a trim handle
const CLIP_PAD = 5 // clips are inset this far from their lane's top/bottom
const RESIZE_PX = 4 // grab zone either side of a lane's bottom edge (in the gutter)
const DRAG_SLOP = 4 // px of movement before a press becomes a marquee / track drag

// Canvas can't read CSS variables, so mirror the "Graphite Cut" tokens here.
const TL_COLORS = {
  bg: '#131419',
  laneEven: '#181a21',
  laneOdd: '#15161c',
  laneDivider: '#23262f',
  gutter: '#1d1f27',
  stripeAudio: '#4fd6c0',
  stripeVideo: '#4c8dff',
  laneLabel: '#c4c8d4',
  muteOnBg: '#c2453f',
  muteOffBg: '#2a2d38',
  muteOnText: '#ffffff',
  muteOffText: '#7d8294',
  rulerBg: '#1a1c23',
  rulerGutter: '#0b0c10',
  rulerTickMaj: '#353a47',
  rulerTickMin: '#23262f',
  rulerText: '#8a8f9e',
  clipSubtitleTop: '#c07a3e',
  clipSubtitleBot: '#8a531f',
  clipTitleTop: '#6f57c9',
  clipTitleBot: '#46379a',
  clipAudioTop: '#3a9a73',
  clipAudioBot: '#266049',
  clipVideoTop: '#3f6bc4',
  clipVideoBot: '#2b4a85',
  clipStrokeSel: '#6f9fff',
  clipStrokeIdle: 'rgba(255,255,255,0.16)',
  trimHandle: '#4c8dff',
  clipLabel: 'rgba(255,255,255,0.94)',
  waveform: 'rgba(255,255,255,0.40)',
  fadeRamp: 'rgba(255,255,255,0.6)',
  keyframe: '#ffd866',
  marker: '#ffcf4d',
  markerSel: '#ffffff',
  playhead: '#ff5350',
  marquee: '#4c8dff'
}

// Pull the structural timeline colours from the active theme's CSS variables, so
// the canvas surface matches the themed DOM. The vivid clip/stripe/playhead hues
// stay as fixed brand colours (they read well on every dark theme).
function refreshTimelineColors(): void {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string): string => cs.getPropertyValue(name).trim() || fb
  TL_COLORS.bg = v('--panel', '#131419')
  TL_COLORS.laneEven = v('--panel-2', '#181a21')
  TL_COLORS.laneOdd = v('--panel', '#15161c')
  TL_COLORS.laneDivider = v('--line', '#23262f')
  TL_COLORS.gutter = v('--panel-3', '#1d1f27')
  TL_COLORS.laneLabel = v('--text-2', '#c4c8d4')
  TL_COLORS.rulerBg = v('--panel-2', '#1a1c23')
  TL_COLORS.rulerGutter = v('--sunken', '#0b0c10')
  TL_COLORS.rulerTickMaj = v('--line-strong', '#353a47')
  TL_COLORS.rulerTickMin = v('--line', '#23262f')
  TL_COLORS.rulerText = v('--muted', '#8a8f9e')
  TL_COLORS.clipStrokeSel = v('--accent', '#6f9fff')
  TL_COLORS.trimHandle = v('--accent', '#4c8dff')
  TL_COLORS.stripeVideo = v('--accent', '#4c8dff')
  TL_COLORS.marquee = v('--accent', '#4c8dff')
  TL_COLORS.muteOffBg = v('--line', '#2a2d38')
  TL_COLORS.muteOffText = v('--muted', '#7d8294')
}

/** Snap targets: 0, the playhead, and every other clip's start/end. */
function collectSnapCandidates(project: Project, excludeClipId: string, playhead: number): number[] {
  const cands = [0, playhead]
  for (const c of Object.values(project.clips)) {
    if (c.id === excludeClipId) continue
    cands.push(c.startSec, c.startSec + c.durationSec)
  }
  return cands
}

interface Lane {
  id: string
  top: number
  bottom: number
  kind: TrackKind
  name: string
  height: number
  muted: boolean
}

/** Vertical layout of track lanes, derived from track order/heights and the
 *  vertical scroll `scrollY` (px). Lanes scrolled above RULER sit under it. */
function computeLanes(tracks: Track[], scrollY: number): Lane[] {
  const lanes: Lane[] = []
  let y = RULER - scrollY
  for (const t of tracks) {
    lanes.push({
      id: t.id,
      top: y,
      bottom: y + t.height,
      kind: t.kind,
      name: t.name,
      height: t.height,
      muted: t.muted
    })
    y += t.height
  }
  return lanes
}

/** Total height of all lanes (px), for vertical scroll clamping. */
function lanesHeight(tracks: Track[]): number {
  return tracks.reduce((sum, t) => sum + t.height, 0)
}

/** Seconds of timeline visible in the lane area of a `w`-px-wide canvas. */
function visibleSecFor(w: number, pxPerSec: number): number {
  return Math.max(0, (w - GUTTER) / pxPerSec)
}

/** Normalise a wheel delta to CSS pixels (line/page modes -> px). */
function wheelPx(delta: number, mode: number, pagePx: number): number {
  if (mode === 1) return delta * 16 // DOM_DELTA_LINE
  if (mode === 2) return delta * pagePx // DOM_DELTA_PAGE
  return delta
}

/** The clickable mute badge rectangle inside a lane's gutter. */
function muteRect(lane: Lane): { x: number; y: number; w: number; h: number } {
  const w = 18
  const h = 16
  return { x: GUTTER - w - 6, y: (lane.top + lane.bottom) / 2 - h / 2, w, h }
}

/** The lane whose bottom edge (the resize grip) is within RESIZE_PX of `y`. */
function laneEdgeAt(lanes: Lane[], y: number): Lane | null {
  for (const lane of lanes) {
    if (lane.bottom >= RULER && Math.abs(y - lane.bottom) <= RESIZE_PX) return lane
  }
  return null
}

/** Pick a ruler label interval (seconds) so labels sit ~80px apart. */
function chooseStep(pxPerSec: number): number {
  const raw = 80 / pxPerSec
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return steps.find((s) => s >= raw) ?? 600
}

function formatTick(t: number): string {
  if (t < 60) return Number.isInteger(t) ? `${t}s` : `${t.toFixed(2)}s`
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Drag anchors (`startT`) are TIMELINE times, not pixels, so a drag stays glued
// to the cursor even if the view scrolls mid-drag (wheel / playhead follow).
type DragState =
  | { mode: 'clip'; clipId: string; startT: number; origStart: number; histPushed: boolean }
  | {
      mode: 'trim'
      edge: 'left' | 'right'
      clipId: string
      startT: number
      orig: { startSec: number; durationSec: number; inSec: number }
      /** The clip as it was at drag start (lets the store rebase from it, not
       *  from the previous drag step). */
      origin: Clip
      histPushed: boolean
    }
  | { mode: 'group'; anchorClipId: string; startT: number; minOrigStart: number; applied: number; histPushed: boolean }
  | { mode: 'seek' }
  /** Press on empty lane space: a click (seek + deselect) until it moves past
   *  DRAG_SLOP, then a rubber band. The anchor is in timeline seconds + content
   *  px so it stays put if the view scrolls mid-drag. */
  | {
      mode: 'marquee'
      downX: number
      downY: number
      t0: number
      y0: number
      additive: boolean
      /** Selection at press time (kept and unioned with hits when additive). */
      base: string[]
      active: boolean
    }
  /** Drag a lane's bottom edge in the gutter to resize it. */
  | { mode: 'resize'; trackId: string; downY: number; origHeight: number; histPushed: boolean }
  /** Drag a track header to reorder (activates past DRAG_SLOP). */
  | { mode: 'track'; trackId: string; downY: number; active: boolean; index: number }
  | null

/** Transient drag feedback drawn over the canvas (not part of the cached layer).
 *  Marquee corners are in timeline seconds + content px; `gap` is a lane boundary. */
type Overlay =
  | { kind: 'marquee'; t0: number; y0: number; t1: number; y1: number }
  | { kind: 'insert'; gap: number }
  | null

/** Scroll position: `x` = time (s) at the lane area's left edge, `y` = lane px. */
interface View {
  x: number
  y: number
}

export default function Timeline() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<DragState>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  // Track-header context menu (position in container px).
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const t = useT()

  // Scroll state. Mirrored in a ref so native listeners / handlers always read
  // the latest value without re-binding.
  const [view, setViewState] = useState<View>({ x: 0, y: 0 })
  const viewRef = useRef<View>(view)
  /** Clamp `next` to the current content/viewport and commit it. */
  const applyView = (next: View): void => {
    const container = containerRef.current
    const st = useEditor.getState()
    const w = container?.clientWidth ?? 0
    const h = container?.clientHeight ?? 0
    const contentEnd = Math.max(timelineDuration(st.project), st.playheadSec)
    const v = {
      x: clampScrollSec(next.x, contentEnd, visibleSecFor(w, st.pxPerSec)),
      y: clampScrollY(next.y, lanesHeight(st.project.tracks), h - RULER)
    }
    const cur = viewRef.current
    if (v.x === cur.x && v.y === cur.y) return
    viewRef.current = v
    setViewState(v)
  }
  const applyViewRef = useRef(applyView)
  applyViewRef.current = applyView

  // Subscribe to the slices that affect rendering.
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playheadSec)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  // A stable signature of the selection set so the cached static layer repaints
  // when the multi-selection changes.
  const selKey = useEditor((s) => [...s.selectedClipIds].sort().join(','))
  const selectedMarkerId = useEditor((s) => s.selectedMarkerId)
  const addAudioTrack = useEditor((s) => s.addAudioTrack)
  const addVideoTrack = useEditor((s) => s.addVideoTrack)
  const showWaveforms = useSettings((s) => s.showWaveforms)
  const snapping = useSettings((s) => s.snapping)
  const themeSig = useSettings((s) => `${s.theme}|${s.accent}`)
  const isPlaying = useEditor((s) => s.isPlaying)

  // Redraw when audio decode finishes so waveforms appear.
  const [audioVersion, setAudioVersion] = useState(0)
  useEffect(() => subscribeAudioCache(() => setAudioVersion(audioCacheVersion())), [])

  // --- two-layer rendering ---
  // The static layer (lanes, ruler, clips, waveforms, labels) only changes when
  // project/zoom/selection/peaks change, so it is cached in an offscreen canvas.
  // During playback only the playhead moves, so each frame just blits the cache
  // and strokes the playhead — no full repaint, no per-pixel waveform rebuild,
  // and no canvas backing-store reallocation.
  const staticRef = useRef<HTMLCanvasElement | null>(null)
  const sigRef = useRef<{
    project: Project
    pxPerSec: number
    sel: string
    marker: string | null
    audioVer: number
    wf: boolean
    theme: string
    bw: number
    bh: number
    sx: number
    sy: number
  } | null>(null)

  // Re-clamp the scroll when content, zoom or track layout changes (e.g. the
  // tail was deleted, or zooming out made everything fit). Not mid-drag, so a
  // shrinking timeline can't yank the view out from under the cursor.
  useEffect(() => {
    if (!drag.current) applyViewRef.current(viewRef.current)
  }, [project, pxPerSec])

  // Keep the playhead on screen while it moves on its own (playback, marker
  // jumps, Home). Skipped during pointer drags: a seek-drag near the edge would
  // otherwise page the view under the cursor and run away.
  useEffect(() => {
    if (drag.current) return
    const w = containerRef.current?.clientWidth ?? 0
    const v = viewRef.current
    const nx = followPlayhead(v.x, playhead, visibleSecFor(w, pxPerSec))
    if (nx !== v.x) applyViewRef.current({ x: nx, y: v.y })
    // Not keyed on zoom: Ctrl+wheel zoom anchors on the cursor and must not be
    // overridden by a jump back to an off-screen playhead.
  }, [playhead, isPlaying])

  // Wheel: plain / Shift = horizontal scroll, Ctrl/Cmd = zoom around the cursor,
  // Alt or wheel over the track-label gutter = vertical lane scroll (when lanes
  // overflow). Native listener because React's wheel handler is passive and
  // can't preventDefault the page scroll / pinch-zoom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const st = useEditor.getState()
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const dx = wheelPx(e.deltaX, e.deltaMode, rect.width)
      const dy = wheelPx(e.deltaY, e.deltaMode, rect.height)
      const v = viewRef.current

      if (e.ctrlKey || e.metaKey) {
        const oldPx = st.pxPerSec
        st.setZoom(oldPx * Math.exp(-dy * 0.002))
        const newPx = useEditor.getState().pxPerSec // store clamps the range
        if (newPx === oldPx) return
        const anchor = Math.max(0, x - GUTTER)
        applyViewRef.current({ x: zoomAnchoredScroll(v.x, anchor, oldPx, newPx), y: v.y })
        return
      }

      const overflowY = lanesHeight(st.project.tracks) > rect.height - RULER
      if (overflowY && !e.shiftKey && (e.altKey || x < GUTTER)) {
        applyViewRef.current({ x: v.x, y: v.y + (dy || dx) })
        return
      }

      // Shift+wheel: many platforms already swap into deltaX; accept either.
      const px = e.shiftKey ? dy || dx : Math.abs(dx) > Math.abs(dy) ? dx : dy
      if (px) applyViewRef.current({ x: v.x + px / st.pxPerSec, y: v.y })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    // Draw everything except the playhead into the offscreen `sctx`.
    const sx = view.x
    const sy = view.y
    const drawStatic = (sctx: CanvasRenderingContext2D, w: number, h: number): void => {
      const timeToX = (t: number): number => GUTTER + (t - sx) * pxPerSec
      const lanes = computeLanes(project.tracks, sy)

      sctx.fillStyle = TL_COLORS.bg
      sctx.fillRect(0, 0, w, h)

      // Lanes (and later clips) are clipped below the ruler so vertically
      // scrolled lanes slide under it instead of over it.
      sctx.save()
      sctx.beginPath()
      sctx.rect(0, RULER, w, h - RULER)
      sctx.clip()
      lanes.forEach((lane, i) => {
        sctx.fillStyle = i % 2 === 0 ? TL_COLORS.laneEven : TL_COLORS.laneOdd
        sctx.fillRect(GUTTER, lane.top, w - GUTTER, lane.height)
        sctx.strokeStyle = TL_COLORS.laneDivider
        sctx.beginPath()
        sctx.moveTo(GUTTER, lane.bottom + 0.5)
        sctx.lineTo(w, lane.bottom + 0.5)
        sctx.stroke()

        sctx.fillStyle = TL_COLORS.gutter
        sctx.fillRect(0, lane.top, GUTTER, lane.height)
        sctx.fillStyle = lane.kind === 'audio' ? TL_COLORS.stripeAudio : TL_COLORS.stripeVideo
        sctx.fillRect(0, lane.top, 3, lane.height)
        sctx.fillStyle = TL_COLORS.laneLabel
        sctx.font = '12px system-ui, sans-serif'
        sctx.textBaseline = 'middle'
        sctx.fillText(lane.name, 12, (lane.top + lane.bottom) / 2)

        const mr = muteRect(lane)
        roundRectPath(sctx, mr.x, mr.y, mr.w, mr.h, 4)
        sctx.fillStyle = lane.muted ? TL_COLORS.muteOnBg : TL_COLORS.muteOffBg
        sctx.fill()
        sctx.fillStyle = lane.muted ? TL_COLORS.muteOnText : TL_COLORS.muteOffText
        sctx.font = 'bold 11px system-ui, sans-serif'
        sctx.textAlign = 'center'
        sctx.fillText('M', mr.x + mr.w / 2, mr.y + mr.h / 2 + 0.5)
        sctx.textAlign = 'left'
      })
      sctx.restore()

      sctx.fillStyle = TL_COLORS.rulerBg
      sctx.fillRect(0, 0, w, RULER)
      sctx.fillStyle = TL_COLORS.rulerGutter
      sctx.fillRect(0, 0, GUTTER, RULER)

      const step = chooseStep(pxPerSec)
      const maxT = sx + visibleSecFor(w, pxPerSec)
      sctx.font = '10px system-ui, sans-serif'
      // Integer tick index (not t += step) so labels don't accumulate drift.
      for (let i = Math.ceil(sx / step); i * step <= maxT; i++) {
        const t = i * step
        const x = Math.round(timeToX(t)) + 0.5
        if (x < GUTTER) continue
        sctx.strokeStyle = TL_COLORS.rulerTickMaj
        sctx.beginPath()
        sctx.moveTo(x, RULER - 8)
        sctx.lineTo(x, RULER)
        sctx.stroke()
        sctx.strokeStyle = TL_COLORS.rulerTickMin
        sctx.beginPath()
        sctx.moveTo(x, RULER)
        sctx.lineTo(x, h)
        sctx.stroke()
        sctx.fillStyle = TL_COLORS.rulerText
        sctx.textBaseline = 'top'
        sctx.fillText(formatTick(t), x + 3, 5)
      }

      const selectedSet = useEditor.getState().selectedClipIds
      // Clips live in the lane area only: clip away the gutter and ruler so a
      // horizontally scrolled clip never paints over the track labels.
      sctx.save()
      sctx.beginPath()
      sctx.rect(GUTTER, RULER, w - GUTTER, h - RULER)
      sctx.clip()
      for (const clip of Object.values(project.clips)) {
        const lane = lanes.find((l) => l.id === clip.trackId)
        if (!lane) continue
        const x = timeToX(clip.startSec)
        const cw = Math.max(2, clip.durationSec * pxPerSec)
        if (x + cw < GUTTER || x > w || lane.bottom < RULER || lane.top > h) continue // off-screen
        const pad = 5
        const cy = lane.top + pad
        const ch = lane.height - pad * 2
        const selected = selectedSet.has(clip.id)
        const isPrimary = clip.id === selectedClipId
        const media = clip.mediaId ? project.media[clip.mediaId] : undefined
        const isAudio = lane.kind === 'audio'
        const isTitle = clip.role === 'title'
        const isSubtitle = clip.role === 'subtitle'

        roundRectPath(sctx, x, cy, cw, ch, 6)
        const grad = sctx.createLinearGradient(0, cy, 0, cy + ch)
        if (isSubtitle) {
          grad.addColorStop(0, TL_COLORS.clipSubtitleTop)
          grad.addColorStop(1, TL_COLORS.clipSubtitleBot)
        } else if (isTitle) {
          grad.addColorStop(0, TL_COLORS.clipTitleTop)
          grad.addColorStop(1, TL_COLORS.clipTitleBot)
        } else if (isAudio) {
          grad.addColorStop(0, TL_COLORS.clipAudioTop)
          grad.addColorStop(1, TL_COLORS.clipAudioBot)
        } else {
          grad.addColorStop(0, TL_COLORS.clipVideoTop)
          grad.addColorStop(1, TL_COLORS.clipVideoBot)
        }
        sctx.fillStyle = grad
        sctx.fill()
        sctx.lineWidth = selected ? 2 : 1
        sctx.strokeStyle = selected ? TL_COLORS.clipStrokeSel : TL_COLORS.clipStrokeIdle
        sctx.stroke()

        if (isPrimary && selectedSet.size === 1 && cw > 3 * EDGE_PX) {
          sctx.fillStyle = TL_COLORS.trimHandle
          sctx.fillRect(x, cy, 3, ch)
          sctx.fillRect(x + cw - 3, cy, 3, ch)
        }

        if (isAudio && clip.mediaId) {
          const entry = getAudioEntry(clip.mediaId)
          if (entry?.status === 'loading' || entry?.status === 'error') {
            sctx.save()
            roundRectPath(sctx, x, cy, cw, ch, 6)
            sctx.clip()
            const statusLabel = entry.status === 'error' ? '! decode error' : 'loading...'
            sctx.font = '10px system-ui, sans-serif'
            sctx.textBaseline = 'middle'
            sctx.fillStyle =
              entry.status === 'error' ? 'rgba(255,120,90,0.85)' : 'rgba(255,255,255,0.35)'
            const sw = sctx.measureText(statusLabel).width
            if (sw + 10 < cw) sctx.fillText(statusLabel, x + cw / 2 - sw / 2, cy + ch / 2)
            sctx.restore()
          }
          if (showWaveforms && entry?.status === 'ready' && entry.peaks) {
            const peaks = entry.peaks
            sctx.save()
            roundRectPath(sctx, x, cy, cw, ch, 6)
            sctx.clip()
            const midY = cy + ch / 2
            const half = ch / 2 - 3
            sctx.strokeStyle = TL_COLORS.waveform
            sctx.lineWidth = 1
            sctx.beginPath()
            // Only the visible columns; source time advances `speed` s per
            // timeline second (same mapping as the compositor/audio).
            const speed = clipSpeed(clip)
            const wxEnd = Math.min(cw, w - x)
            for (let wx = Math.max(0, Math.floor(GUTTER - x)); wx <= wxEnd; wx += 1) {
              const srcT = clip.inSec + (wx / pxPerSec) * speed
              const amp = (peaks[Math.floor(srcT * PEAKS_PER_SEC)] ?? 0) * half
              sctx.moveTo(x + wx, midY - amp)
              sctx.lineTo(x + wx, midY + amp)
            }
            sctx.stroke()
            sctx.restore()
          }
        }

        // Fade ramps (audio fades / crossfades) as diagonal lines on the clip.
        const fiPx = (clip.fadeInSec ?? 0) * pxPerSec
        const foPx = (clip.fadeOutSec ?? 0) * pxPerSec
        if (fiPx > 1 || foPx > 1) {
          sctx.save()
          roundRectPath(sctx, x, cy, cw, ch, 6)
          sctx.clip()
          sctx.strokeStyle = TL_COLORS.fadeRamp
          sctx.lineWidth = 1.5
          if (fiPx > 1) {
            sctx.beginPath()
            sctx.moveTo(x, cy + ch)
            sctx.lineTo(x + Math.min(fiPx, cw), cy)
            sctx.stroke()
          }
          if (foPx > 1) {
            sctx.beginPath()
            sctx.moveTo(x + cw - Math.min(foPx, cw), cy)
            sctx.lineTo(x + cw, cy + ch)
            sctx.stroke()
          }
          sctx.restore()
        }

        sctx.save()
        roundRectPath(sctx, x, cy, cw, ch, 6)
        sctx.clip()
        sctx.fillStyle = TL_COLORS.clipLabel
        sctx.font = '11px system-ui, sans-serif'
        sctx.textBaseline = 'top'
        const label = clip.text
          ? clip.text.content.split('\n')[0] || (isSubtitle ? 'Subtitle' : 'Title')
          : media
            ? media.name
            : 'clip'
        // Pin the label to the visible left edge when the clip starts off-screen.
        sctx.fillText(label, Math.max(x, GUTTER) + 7, cy + 6)
        sctx.restore()

        // Keyframe diamonds for the selected clip: a small marker at each unique
        // key time along the clip's bottom edge (read-only in v1).
        if (selected && clip.keyframes && cw > 24) {
          const times = new Set<number>()
          for (const track of Object.values(clip.keyframes)) {
            if (track) for (const k of track) times.add(k.t)
          }
          if (times.size > 0) {
            sctx.save()
            roundRectPath(sctx, x, cy, cw, ch, 6)
            sctx.clip()
            sctx.fillStyle = TL_COLORS.keyframe
            const dy = cy + ch - 5
            for (const tk of times) {
              const dx = x + tk * pxPerSec
              if (dx < x || dx > x + cw) continue
              sctx.beginPath()
              sctx.moveTo(dx, dy - 3)
              sctx.lineTo(dx + 3, dy)
              sctx.lineTo(dx, dy + 3)
              sctx.lineTo(dx - 3, dy)
              sctx.closePath()
              sctx.fill()
            }
            sctx.restore()
          }
        }
      }
      sctx.restore()

      // Markers / regions: a flag in the ruler band + a faint full-height guide.
      for (const m of project.markers ?? []) {
        const mx = timeToX(m.timeSec)
        const isSel = m.id === selectedMarkerId
        // A region stays visible while any part of it is on screen, even when
        // its start has scrolled off the left.
        if (m.endSec !== undefined) {
          const rx = Math.max(GUTTER, mx)
          const ex = Math.min(w, timeToX(m.endSec))
          if (ex > rx) {
            sctx.globalAlpha = 0.12
            sctx.fillStyle = m.color || TL_COLORS.marker
            sctx.fillRect(rx, RULER, Math.max(1, ex - rx), h - RULER)
            sctx.globalAlpha = 1
          }
        }
        if (mx < GUTTER || mx > w) continue
        const col = isSel ? TL_COLORS.markerSel : m.color || TL_COLORS.marker
        sctx.globalAlpha = isSel ? 0.6 : 0.3
        sctx.strokeStyle = col
        sctx.lineWidth = 1
        sctx.beginPath()
        sctx.moveTo(mx + 0.5, RULER)
        sctx.lineTo(mx + 0.5, h)
        sctx.stroke()
        sctx.globalAlpha = 1
        sctx.fillStyle = col
        sctx.beginPath()
        sctx.moveTo(mx, RULER)
        sctx.lineTo(mx - 5, RULER - 9)
        sctx.lineTo(mx + 5, RULER - 9)
        sctx.closePath()
        sctx.fill()
        if (m.label) {
          sctx.fillStyle = TL_COLORS.rulerText
          sctx.font = '10px system-ui, sans-serif'
          sctx.textBaseline = 'alphabetic'
          sctx.fillText(m.label, mx + 7, RULER - 2)
        }
      }
    }

    const render = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = container.clientWidth
      const h = container.clientHeight
      const bw = Math.floor(w * dpr)
      const bh = Math.floor(h * dpr)

      // Resize the visible canvas only when the size actually changed.
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }

      // Rebuild the cached static layer only when its inputs change.
      let s = staticRef.current
      if (!s) {
        s = document.createElement('canvas')
        staticRef.current = s
      }
      const sig = sigRef.current
      if (
        !sig ||
        sig.project !== project ||
        sig.pxPerSec !== pxPerSec ||
        sig.sel !== selKey ||
        sig.marker !== selectedMarkerId ||
        sig.audioVer !== audioVersion ||
        sig.wf !== showWaveforms ||
        sig.theme !== themeSig ||
        sig.bw !== bw ||
        sig.bh !== bh ||
        sig.sx !== sx ||
        sig.sy !== sy
      ) {
        s.width = bw
        s.height = bh
        const sctx = s.getContext('2d')
        if (!sctx) return
        sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        refreshTimelineColors() // sync canvas palette to the active theme
        drawStatic(sctx, w, h)
        sigRef.current = {
          project,
          pxPerSec,
          sel: selKey,
          marker: selectedMarkerId,
          audioVer: audioVersion,
          wf: showWaveforms,
          theme: themeSig,
          bw,
          bh,
          sx,
          sy
        }
      }

      // Composite: blit the static layer, then the playhead on top.
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bw, bh)
      ctx.drawImage(s, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const px = Math.round(GUTTER + (playhead - sx) * pxPerSec) + 0.5
      if (px >= GUTTER && px <= w) {
        ctx.strokeStyle = TL_COLORS.playhead
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, h)
        ctx.stroke()
        ctx.fillStyle = TL_COLORS.playhead
        ctx.beginPath()
        ctx.moveTo(px - 5, 0)
        ctx.lineTo(px + 5, 0)
        ctx.lineTo(px, 9)
        ctx.closePath()
        ctx.fill()
      }

      // Drag feedback: the rubber band (lane area only) or a track-drop line.
      if (overlay?.kind === 'marquee') {
        const x0 = GUTTER + (Math.min(overlay.t0, overlay.t1) - sx) * pxPerSec
        const x1 = GUTTER + (Math.max(overlay.t0, overlay.t1) - sx) * pxPerSec
        const y0 = RULER - sy + Math.min(overlay.y0, overlay.y1)
        const y1 = RULER - sy + Math.max(overlay.y0, overlay.y1)
        ctx.save()
        ctx.beginPath()
        ctx.rect(GUTTER, RULER, w - GUTTER, h - RULER)
        ctx.clip()
        ctx.globalAlpha = 0.14
        ctx.fillStyle = TL_COLORS.marquee
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
        ctx.globalAlpha = 0.9
        ctx.strokeStyle = TL_COLORS.marquee
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0))
        ctx.restore()
      } else if (overlay?.kind === 'insert') {
        let gy = RULER - sy
        for (let i = 0; i < overlay.gap && i < project.tracks.length; i++) gy += project.tracks[i].height
        if (gy >= RULER - 1 && gy <= h + 1) {
          ctx.fillStyle = TL_COLORS.marquee
          ctx.fillRect(0, Math.max(RULER, gy - 1), w, 3)
        }
      }
    }

    render()
    const ro = new ResizeObserver(() => {
      // A resize changes how much fits, so re-clamp the scroll (which re-runs
      // this effect with the new view) before painting.
      applyViewRef.current(viewRef.current)
      render()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [project, playhead, pxPerSec, selKey, selectedMarkerId, audioVersion, showWaveforms, themeSig, view, overlay])

  // --- pointer interactions (seek + drag-to-move clips) ---
  const localPoint = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  // px <-> time through the current zoom and horizontal scroll.
  const xToTime = (x: number): number => viewRef.current.x + (x - GUTTER) / useEditor.getState().pxPerSec
  const timeToXNow = (t: number): number => GUTTER + (t - viewRef.current.x) * useEditor.getState().pxPerSec
  // Canvas y <-> content y (0 = top of the first lane, independent of scroll).
  const yToContent = (y: number): number => y - RULER + viewRef.current.y

  // Hit-test a point against clips, distinguishing the edge (trim) zones from
  // the body (move) zone. Later-drawn clips sit on top, so iterate in reverse.
  const hitTest = (x: number, y: number): { clipId: string; zone: 'left' | 'right' | 'body' } | null => {
    if (x < GUTTER || y <= RULER) return null // gutter / ruler cover any scrolled clip
    const st = useEditor.getState()
    const lanes = computeLanes(st.project.tracks, viewRef.current.y)
    const clips = Object.values(st.project.clips)
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i]
      const lane = lanes.find((l) => l.id === clip.trackId)
      if (!lane) continue
      const cx = timeToXNow(clip.startSec)
      const cw = Math.max(2, clip.durationSec * st.pxPerSec)
      if (x >= cx && x <= cx + cw && y >= lane.top && y <= lane.bottom) {
        const wide = cw > 3 * EDGE_PX
        if (wide && x <= cx + EDGE_PX) return { clipId: clip.id, zone: 'left' }
        if (wide && x >= cx + cw - EDGE_PX) return { clipId: clip.id, zone: 'right' }
        return { clipId: clip.id, zone: 'body' }
      }
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return // right button opens the track menu (onContextMenu)
    const { x, y } = localPoint(e)
    const st = useEditor.getState()
    setMenu(null)

    // Gutter: the M badge toggles mute; a lane's bottom edge resizes it; the
    // rest of the header selects the track and can be dragged to reorder.
    if (x < GUTTER) {
      if (y <= RULER) return // ruler corner (lanes may be scrolled under it)
      const lanes = computeLanes(st.project.tracks, viewRef.current.y)
      for (const lane of lanes) {
        const mr = muteRect(lane)
        if (x >= mr.x && x <= mr.x + mr.w && y >= mr.y && y <= mr.y + mr.h) {
          st.toggleTrackMute(lane.id, !lane.muted)
          return
        }
      }
      const edge = laneEdgeAt(lanes, y)
      if (edge) {
        drag.current = { mode: 'resize', trackId: edge.id, downY: y, origHeight: edge.height, histPushed: false }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
      const lane = lanes.find((l) => y >= l.top && y <= l.bottom)
      if (lane) {
        st.selectTrack(lane.id)
        const index = st.project.tracks.findIndex((tr) => tr.id === lane.id)
        drag.current = { mode: 'track', trackId: lane.id, downY: y, active: false, index }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }
      return
    }

    // Ruler band: a marker FLAG (top ~10px) takes priority (select + seek); the
    // rest of the ruler scrubs (so clicks near a marker still seek precisely).
    if (y <= RULER) {
      if (y >= RULER - 10) {
        for (const m of st.project.markers ?? []) {
          if (Math.abs(x - timeToXNow(m.timeSec)) <= 7) {
            st.selectMarker(m.id)
            st.setPlayhead(m.timeSec)
            return
          }
        }
      }
      st.setPlayhead(xToTime(x))
      drag.current = { mode: 'seek' }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      return
    }

    const hit = hitTest(x, y)
    if (hit) {
      const clip = st.project.clips[hit.clipId]
      // Shift/Ctrl/Cmd-click toggles membership without starting a drag.
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        st.toggleClipSelection(hit.clipId)
        return
      }
      // Plain click on a clip already in a multi-selection -> drag the whole group.
      if (st.selectedClipIds.size > 1 && st.selectedClipIds.has(hit.clipId) && hit.zone === 'body') {
        let minStart = Infinity
        for (const id of st.selectedClipIds) {
          const c = st.project.clips[id]
          if (c) minStart = Math.min(minStart, c.startSec)
        }
        drag.current = {
          mode: 'group',
          anchorClipId: hit.clipId,
          startT: xToTime(x),
          minOrigStart: minStart,
          applied: 0,
          histPushed: false
        }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
      st.selectClip(hit.clipId)
      if (hit.zone === 'body') {
        drag.current = { mode: 'clip', clipId: hit.clipId, startT: xToTime(x), origStart: clip.startSec, histPushed: false }
      } else {
        drag.current = {
          mode: 'trim',
          edge: hit.zone,
          clipId: hit.clipId,
          startT: xToTime(x),
          orig: { startSec: clip.startSec, durationSec: clip.durationSec, inSec: clip.inSec },
          origin: clip,
          histPushed: false
        }
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      return
    }

    // Otherwise: empty lane space. A plain click deselects + seeks (on release,
    // in endDrag); dragging past DRAG_SLOP draws a rubber-band selection
    // instead. Shift/Ctrl/Cmd adds the boxed clips to the current selection.
    if (x > GUTTER) {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      drag.current = {
        mode: 'marquee',
        downX: x,
        downY: y,
        t0: xToTime(x),
        y0: yToContent(y),
        additive,
        base: additive ? [...st.selectedClipIds] : [],
        active: false
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const { x, y } = localPoint(e)
    const d = drag.current
    const st = useEditor.getState()

    // Idle hover: reflect the action under the cursor.
    if (!d) {
      const hit = hitTest(x, y)
      const canvas = canvasRef.current
      if (canvas) {
        const inGutterLanes = x < GUTTER && y > RULER
        const lanes = inGutterLanes ? computeLanes(st.project.tracks, viewRef.current.y) : []
        canvas.style.cursor = hit
          ? hit.zone === 'body'
            ? 'grab'
            : 'ew-resize'
          : x > GUTTER
            ? 'crosshair'
            : inGutterLanes && laneEdgeAt(lanes, y)
              ? 'ns-resize'
              : 'default'
      }
      return
    }

    if (d.mode === 'seek') {
      st.setPlayhead(xToTime(x))
      return
    }

    if (d.mode === 'marquee') {
      if (!d.active) {
        if (Math.hypot(x - d.downX, y - d.downY) < DRAG_SLOP) return
        d.active = true
      }
      const rect = { t0: d.t0, y0: d.y0, t1: xToTime(x), y1: yToContent(y) }
      const hits = clipsInMarquee(st.project.tracks, st.project.clips, rect, CLIP_PAD)
      const next = d.additive ? [...d.base, ...hits.filter((id) => !d.base.includes(id))] : hits
      // Only touch the store when the set changes (each change repaints the clips).
      // An empty non-additive box still clears a track/marker selection once.
      const cur = st.selectedClipIds
      const changed = next.length !== cur.size || next.some((id) => !cur.has(id))
      if (changed || (next.length === 0 && (st.selectedTrackId || st.selectedMarkerId))) st.setClipSelection(next)
      setOverlay({ kind: 'marquee', ...rect })
      return
    }

    if (d.mode === 'track') {
      if (!d.active) {
        if (Math.abs(y - d.downY) < DRAG_SLOP) return
        d.active = true
      }
      const target = trackDropTarget(st.project.tracks, d.trackId, yToContent(y))
      d.index = target.index
      setOverlay({ kind: 'insert', gap: target.gap })
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing'
      return
    }

    // Lane resize: snapshot once on the first real move, so the drag = 1 undo.
    if (d.mode === 'resize') {
      if (!d.histPushed) {
        st.snapshot()
        d.histPushed = true
      }
      st.setTrackHeight(d.trackId, d.origHeight + (y - d.downY))
      return
    }

    // The first real move of a drag snapshots once, so the whole drag = 1 undo.
    if (!d.histPushed) {
      st.snapshot()
      d.histPushed = true
    }

    // Group move: shift every selected clip by the same (clamped) delta.
    if (d.mode === 'group') {
      const groupDelta = Math.max(xToTime(x) - d.startT, -d.minOrigStart)
      st.moveSelectedBy(groupDelta - d.applied)
      d.applied = groupDelta
      return
    }

    const clip = st.project.clips[d.clipId]
    if (!clip) return
    const cands = collectSnapCandidates(st.project, d.clipId, st.playheadSec)

    if (d.mode === 'clip') {
      const raw = d.origStart + (xToTime(x) - d.startT)
      const snapped = Math.max(0, snapping ? snapMove(raw, clip.durationSec, cands, st.pxPerSec) : raw)
      const lanes = computeLanes(st.project.tracks, viewRef.current.y)
      const over = y > RULER ? lanes.find((l) => y >= l.top && y <= l.bottom) : undefined
      const clipKind = st.project.tracks.find((t) => t.id === clip.trackId)?.kind
      const targetTrack = over && over.kind === clipKind ? over.id : undefined
      st.moveClip(d.clipId, snapped, targetTrack)
      return
    }

    // Trim: move the grabbed edge, snapping it, then clamp to valid bounds.
    const media = clip.mediaId ? st.project.media[clip.mediaId] : undefined
    const srcDuration = media && media.durationSec > 0 ? media.durationSec : null
    const dxSec = xToTime(x) - d.startT
    const rawEdge =
      d.edge === 'left' ? d.orig.startSec + dxSec : d.orig.startSec + d.orig.durationSec + dxSec
    const snappedEdge = snapping ? snapTime(rawEdge, cands, st.pxPerSec) : rawEdge
    const delta =
      d.edge === 'left' ? snappedEdge - d.orig.startSec : snappedEdge - (d.orig.startSec + d.orig.durationSec)
    const bounds = computeTrim(d.orig, d.edge, delta, {
      isMedia: !!clip.mediaId,
      srcDuration,
      speed: clip.speed ?? 1
    })
    st.applyTrim(d.clipId, bounds, d.origin)
  }

  const endDrag = (e: React.PointerEvent): void => {
    const d = drag.current
    const st = useEditor.getState()
    const cancelled = e.type === 'pointercancel'
    // A plain click (no move) on a clip already in a multi-selection collapses to it.
    if (d && d.mode === 'group' && !d.histPushed && !cancelled) st.selectClip(d.anchorClipId)
    // A press on empty space that never became a rubber band is a click: seek
    // there and (unless a modifier was held) clear the selection.
    if (d && d.mode === 'marquee' && !d.active && !cancelled) {
      if (!d.additive) st.selectClip(null)
      st.setPlayhead(d.t0)
    }
    // Dropping a dragged track header moves the track (one undo step; no-op if unmoved).
    if (d && d.mode === 'track' && d.active && !cancelled) st.moveTrack(d.trackId, d.index)
    setOverlay(null)
    if (d && d.mode === 'track' && canvasRef.current) canvasRef.current.style.cursor = 'default'
    drag.current = null
    // Re-clamp scroll skipped mid-drag (e.g. a lane shrunk while scrolled down).
    if (d && d.mode === 'resize') applyViewRef.current(viewRef.current)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer may already be released */
    }
  }

  // Right-click a marker flag in the ruler to delete it; right-click a track
  // header to open the track menu.
  const onContextMenu = (e: React.MouseEvent): void => {
    const { x, y } = localPoint(e)
    const st = useEditor.getState()
    if (x < GUTTER && y > RULER) {
      e.preventDefault()
      const lane = computeLanes(st.project.tracks, viewRef.current.y).find((l) => y >= l.top && y <= l.bottom)
      if (!lane) return
      st.selectTrack(lane.id)
      setMenu({ x, y, trackId: lane.id })
      return
    }
    if (y > RULER || y < RULER - 10 || x < GUTTER) return
    for (const m of st.project.markers ?? []) {
      if (Math.abs(x - timeToXNow(m.timeSec)) <= 7) {
        e.preventDefault()
        st.removeMarker(m.id)
        return
      }
    }
  }

  return (
    <section className="timeline">
      <div className="timeline-head">
        <span>Timeline</span>
        <span className="hint">
          drag to move · drag edges to trim · S split · X crossfade · M marker · ,/. jump · shift-click
          multi-select · drag empty area to box-select · Ctrl+A all · Ctrl+C/V copy · Del remove · wheel
          scroll · Ctrl+wheel zoom · track header: drag to reorder, bottom edge to resize, right-click for menu
        </span>
        <button
          className="btn small"
          title={t('Add a video track')}
          style={{ marginLeft: 'auto' }}
          onClick={() => addVideoTrack()}
        >
          + {t('Video')}
        </button>
        <button className="btn small" title={t('Add an audio track')} onClick={() => addAudioTrack()}>
          + {t('Audio')}
        </button>
      </div>
      <div
        className="timeline-canvas-wrap"
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={onContextMenu}
      >
        <canvas ref={canvasRef} />
        {menu && <TrackMenu {...menu} onClose={closeMenu} />}
      </div>
    </section>
  )
}

/**
 * Right-click menu for a track header: reorder (stacking order — top lane
 * composites on top), add tracks, delete. Positioned in the canvas wrap's
 * coordinates and nudged inside it; closes on any outside press, Esc or blur.
 */
function TrackMenu(props: { x: number; y: number; trackId: string; onClose: () => void }) {
  const { x, y, trackId, onClose } = props
  const t = useT()
  const tracks = useEditor((s) => s.project.tracks)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu inside the timeline (it opens near the bottom lanes a lot).
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) return
    setPos({
      left: Math.max(0, Math.min(x, parent.clientWidth - el.offsetWidth - 4)),
      top: Math.max(0, Math.min(y, parent.clientHeight - el.offsetHeight - 4))
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  const index = tracks.findIndex((tr) => tr.id === trackId)
  if (index < 0) return null
  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }
  const st = useEditor.getState
  return (
    <div
      ref={ref}
      className="tl-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="tl-menu-title">{tracks[index].name}</div>
      <button role="menuitem" disabled={index === 0} onClick={run(() => st().moveTrack(trackId, index - 1))}>
        {t('Move track up')}
      </button>
      <button
        role="menuitem"
        disabled={index === tracks.length - 1}
        onClick={run(() => st().moveTrack(trackId, index + 1))}
      >
        {t('Move track down')}
      </button>
      <div className="tl-menu-sep" />
      <button role="menuitem" onClick={run(() => st().addVideoTrack())}>
        {t('Add a video track')}
      </button>
      <button role="menuitem" onClick={run(() => st().addAudioTrack())}>
        {t('Add an audio track')}
      </button>
      <div className="tl-menu-sep" />
      <button
        role="menuitem"
        className="danger"
        disabled={!canRemoveTrack(tracks, trackId)}
        title={canRemoveTrack(tracks, trackId) ? undefined : t('The last video or audio track can’t be deleted.')}
        onClick={run(() => removeTrackWithConfirm(trackId))}
      >
        {t('Delete track')}
      </button>
    </div>
  )
}
