import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { audioCacheVersion, getAudioEntry, PEAKS_PER_SEC, subscribeAudioCache } from '../lib/audioCache'
import { computeTrim, snapMove, snapTime } from '../lib/editing'
import { roundRectPath } from '../lib/canvas'
import type { Project, Track, TrackKind } from '../types'

// Layout constants (in CSS pixels).
const GUTTER = 78 // left label column width
const RULER = 28 // top time-ruler height
const EDGE_PX = 7 // grab zone (and drawn width) of a trim handle

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
  playhead: '#ff5350'
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

/** Vertical layout of track lanes, derived from track order/heights. */
function computeLanes(tracks: Track[]): Lane[] {
  const lanes: Lane[] = []
  let y = RULER
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

/** The clickable mute badge rectangle inside a lane's gutter. */
function muteRect(lane: Lane): { x: number; y: number; w: number; h: number } {
  const w = 18
  const h = 16
  return { x: GUTTER - w - 6, y: (lane.top + lane.bottom) / 2 - h / 2, w, h }
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

type DragState =
  | { mode: 'clip'; clipId: string; startX: number; origStart: number; histPushed: boolean }
  | {
      mode: 'trim'
      edge: 'left' | 'right'
      clipId: string
      startX: number
      orig: { startSec: number; durationSec: number; inSec: number }
      histPushed: boolean
    }
  | { mode: 'group'; anchorClipId: string; startX: number; minOrigStart: number; applied: number; histPushed: boolean }
  | { mode: 'seek' }
  | null

export default function Timeline() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<DragState>(null)

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
  const showWaveforms = useSettings((s) => s.showWaveforms)
  const snapping = useSettings((s) => s.snapping)
  const themeSig = useSettings((s) => `${s.theme}|${s.accent}`)

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
  } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    // Draw everything except the playhead into the offscreen `sctx`.
    const drawStatic = (sctx: CanvasRenderingContext2D, w: number, h: number): void => {
      const timeToX = (t: number): number => GUTTER + t * pxPerSec
      const lanes = computeLanes(project.tracks)

      sctx.fillStyle = TL_COLORS.bg
      sctx.fillRect(0, 0, w, h)

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

      sctx.fillStyle = TL_COLORS.rulerBg
      sctx.fillRect(0, 0, w, RULER)
      sctx.fillStyle = TL_COLORS.rulerGutter
      sctx.fillRect(0, 0, GUTTER, RULER)

      const step = chooseStep(pxPerSec)
      const maxT = (w - GUTTER) / pxPerSec
      sctx.font = '10px system-ui, sans-serif'
      for (let t = 0; t <= maxT; t += step) {
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
      for (const clip of Object.values(project.clips)) {
        const lane = lanes.find((l) => l.id === clip.trackId)
        if (!lane) continue
        const x = timeToX(clip.startSec)
        const cw = Math.max(2, clip.durationSec * pxPerSec)
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
            for (let wx = 0; wx <= cw; wx += 1) {
              const srcT = clip.inSec + wx / pxPerSec
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
        sctx.fillText(label, x + 7, cy + 6)
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

      // Markers / regions: a flag in the ruler band + a faint full-height guide.
      for (const m of project.markers ?? []) {
        const mx = timeToX(m.timeSec)
        if (mx < GUTTER || mx > w) continue
        const isSel = m.id === selectedMarkerId
        const col = isSel ? TL_COLORS.markerSel : m.color || TL_COLORS.marker
        if (m.endSec !== undefined) {
          const ex = Math.min(w, timeToX(m.endSec))
          sctx.globalAlpha = 0.12
          sctx.fillStyle = m.color || TL_COLORS.marker
          sctx.fillRect(mx, RULER, Math.max(1, ex - mx), h - RULER)
          sctx.globalAlpha = 1
        }
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
        sig.bh !== bh
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
          bh
        }
      }

      // Composite: blit the static layer, then the playhead on top.
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, bw, bh)
      ctx.drawImage(s, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const px = Math.round(GUTTER + playhead * pxPerSec) + 0.5
      if (px >= GUTTER) {
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
    }

    render()
    const ro = new ResizeObserver(render)
    ro.observe(container)
    return () => ro.disconnect()
  }, [project, playhead, pxPerSec, selKey, selectedMarkerId, audioVersion, showWaveforms, themeSig])

  // --- pointer interactions (seek + drag-to-move clips) ---
  const localPoint = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // Hit-test a point against clips, distinguishing the edge (trim) zones from
  // the body (move) zone. Later-drawn clips sit on top, so iterate in reverse.
  const hitTest = (x: number, y: number): { clipId: string; zone: 'left' | 'right' | 'body' } | null => {
    const st = useEditor.getState()
    const lanes = computeLanes(st.project.tracks)
    const clips = Object.values(st.project.clips)
    for (let i = clips.length - 1; i >= 0; i--) {
      const clip = clips[i]
      const lane = lanes.find((l) => l.id === clip.trackId)
      if (!lane) continue
      const cx = GUTTER + clip.startSec * st.pxPerSec
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
    const { x, y } = localPoint(e)
    const st = useEditor.getState()

    // Gutter: the M badge toggles mute; clicking elsewhere selects the track.
    if (x < GUTTER) {
      const lanes = computeLanes(st.project.tracks)
      for (const lane of lanes) {
        const mr = muteRect(lane)
        if (x >= mr.x && x <= mr.x + mr.w && y >= mr.y && y <= mr.y + mr.h) {
          st.toggleTrackMute(lane.id, !lane.muted)
          return
        }
      }
      const lane = lanes.find((l) => y >= l.top && y <= l.bottom)
      if (lane) st.selectTrack(lane.id)
      return
    }

    // Ruler band: a marker FLAG (top ~10px) takes priority (select + seek); the
    // rest of the ruler scrubs (so clicks near a marker still seek precisely).
    if (y <= RULER) {
      if (y >= RULER - 10) {
        for (const m of st.project.markers ?? []) {
          if (Math.abs(x - (GUTTER + m.timeSec * st.pxPerSec)) <= 7) {
            st.selectMarker(m.id)
            st.setPlayhead(m.timeSec)
            return
          }
        }
      }
      st.setPlayhead((x - GUTTER) / st.pxPerSec)
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
        drag.current = { mode: 'group', anchorClipId: hit.clipId, startX: x, minOrigStart: minStart, applied: 0, histPushed: false }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
      st.selectClip(hit.clipId)
      if (hit.zone === 'body') {
        drag.current = { mode: 'clip', clipId: hit.clipId, startX: x, origStart: clip.startSec, histPushed: false }
      } else {
        drag.current = {
          mode: 'trim',
          edge: hit.zone,
          clipId: hit.clipId,
          startX: x,
          orig: { startSec: clip.startSec, durationSec: clip.durationSec, inSec: clip.inSec },
          histPushed: false
        }
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      return
    }

    // Otherwise: click in the time area scrubs the playhead.
    if (x > GUTTER) {
      st.selectClip(null)
      st.setPlayhead((x - GUTTER) / st.pxPerSec)
      drag.current = { mode: 'seek' }
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
        canvas.style.cursor = hit
          ? hit.zone === 'body'
            ? 'grab'
            : 'ew-resize'
          : x > GUTTER
            ? 'crosshair'
            : 'default'
      }
      return
    }

    if (d.mode === 'seek') {
      st.setPlayhead((x - GUTTER) / st.pxPerSec)
      return
    }

    // The first real move of a drag snapshots once, so the whole drag = 1 undo.
    if (!d.histPushed) {
      st.snapshot()
      d.histPushed = true
    }

    // Group move: shift every selected clip by the same (clamped) delta.
    if (d.mode === 'group') {
      const groupDelta = Math.max((x - d.startX) / st.pxPerSec, -d.minOrigStart)
      st.moveSelectedBy(groupDelta - d.applied)
      d.applied = groupDelta
      return
    }

    const clip = st.project.clips[d.clipId]
    if (!clip) return
    const cands = collectSnapCandidates(st.project, d.clipId, st.playheadSec)

    if (d.mode === 'clip') {
      const raw = d.origStart + (x - d.startX) / st.pxPerSec
      const snapped = Math.max(0, snapping ? snapMove(raw, clip.durationSec, cands, st.pxPerSec) : raw)
      const lanes = computeLanes(st.project.tracks)
      const over = lanes.find((l) => y >= l.top && y <= l.bottom)
      const clipKind = st.project.tracks.find((t) => t.id === clip.trackId)?.kind
      const targetTrack = over && over.kind === clipKind ? over.id : undefined
      st.moveClip(d.clipId, snapped, targetTrack)
      return
    }

    // Trim: move the grabbed edge, snapping it, then clamp to valid bounds.
    const media = clip.mediaId ? st.project.media[clip.mediaId] : undefined
    const srcDuration = media && media.durationSec > 0 ? media.durationSec : null
    const dxSec = (x - d.startX) / st.pxPerSec
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
    st.applyTrim(d.clipId, bounds)
  }

  const endDrag = (e: React.PointerEvent): void => {
    const d = drag.current
    // A plain click (no move) on a clip already in a multi-selection collapses to it.
    if (d && d.mode === 'group' && !d.histPushed) useEditor.getState().selectClip(d.anchorClipId)
    drag.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer may already be released */
    }
  }

  // Right-click a marker flag in the ruler to delete it.
  const onContextMenu = (e: React.MouseEvent): void => {
    const { x, y } = localPoint(e)
    if (y > RULER || y < RULER - 10 || x < GUTTER) return
    const st = useEditor.getState()
    for (const m of st.project.markers ?? []) {
      if (Math.abs(x - (GUTTER + m.timeSec * st.pxPerSec)) <= 7) {
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
          multi-select · Ctrl+A all · Ctrl+C/V copy · Del remove
        </span>
        <button
          className="btn small"
          title="Add an audio track"
          style={{ marginLeft: 'auto' }}
          onClick={() => addAudioTrack()}
        >
          + Audio
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
      </div>
    </section>
  )
}
