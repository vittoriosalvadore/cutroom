import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { Compositor } from '../lib/compositor'
import { AudioPool } from '../lib/audioPool'
import { resumeAudioContext } from '../lib/audioContext'
import { previewScale } from '../lib/previewScale'
import { hasVideoAt, isRealtimeRate, stepShuttleHold, type ShuttleHold } from '../lib/transport'
import { scrubDirection } from '../lib/scrub'
import { useT } from '../lib/i18n'
import { ScopeSampler } from '../lib/scopeSampler'
import { SCOPE_INTERVAL_MS, shouldSample } from '../lib/scopes'
import Scopes, { type ScopesHandle } from './Scopes'
import type { Project } from '../types'

/**
 * Render one frame defensively: a transient WebGL or WebAudio error in a single
 * frame is logged and skipped, never allowed to crash the React tree.
 */
function safeFrame(
  comp: Compositor | null,
  pool: AudioPool | null,
  project: Project,
  playhead: number,
  playing: boolean,
  afterRender?: () => void
): void {
  try {
    const settings = useSettings.getState()
    comp?.render(project, playhead, playing, {
      hidePlaceholders: !settings.showPlaceholders,
      // Preview-only resolution; the canvas CSS keeps the on-screen size.
      scale: previewScale(settings.previewQuality)
    })
    // Same task as the render: the drawing buffer is still readable (scopes).
    afterRender?.()
  } catch (e) {
    console.error('[cutroom] preview render error:', e)
  }
  try {
    pool?.sync(project, playhead, playing, comp?.getVideoPool())
  } catch (e) {
    console.error('[cutroom] audio sync error:', e)
  }
}

/**
 * Program monitor. Owns a WebGL Compositor that draws the frame at the current
 * playhead: stacked video tracks, titles/subtitles, and chroma-keyed layers.
 * The playback clock in App.tsx advances the playhead, which re-renders us each
 * frame, so this doubles as the realtime preview.
 */
export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compRef = useRef<Compositor | null>(null)
  const audioRef = useRef<AudioPool | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gpuStatus, setGpuStatus] = useState<'ok' | 'reconnecting' | 'failed'>('ok')

  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playheadSec)
  // Only 1× forward is real playback. J/K/L shuttle rates (reverse, 2×, 4×) ride
  // the paused/scrub path (audio as scrub grains, lib/scrub), paced by `hold` so
  // each seeked frame gets to land before the next one is requested (lib/transport).
  const isPlaying = useEditor((s) => s.isPlaying && isRealtimeRate(s.shuttleRate))
  const shuttling = useEditor((s) => s.isPlaying && !isRealtimeRate(s.shuttleRate))
  const hold = useRef<ShuttleHold>({ time: 0, at: 0, landed: true })
  const showPlaceholders = useSettings((s) => s.showPlaceholders)
  const previewQuality = useSettings((s) => s.previewQuality)
  const scrubbing = useEditor((s) => s.scrubbing)
  const audioScrub = useSettings((s) => s.audioScrub)
  const lastScrubTime = useRef(playhead)
  const showScopes = useSettings((s) => s.showScopes)
  const t = useT()

  // --- scopes -------------------------------------------------------------
  // After each preview render, at most every SCOPE_INTERVAL_MS (and only while
  // the panel is open), the frame is read back small and reduced to scopes.
  // A render skipped by the throttle while PAUSED schedules one trailing
  // re-render + sample, so the scopes always settle on the frame on screen;
  // during playback the next frame's render samples anyway. The export renders
  // on its own offscreen compositor, and sampling stops while the Export dialog
  // is open, so scopes never cost the export anything.
  const scopesRef = useRef<ScopesHandle>(null)
  const scopeState = useRef({ sampler: null as ScopeSampler | null, last: -Infinity, trailing: 0 })
  const scopeTap = useRef<() => void>(() => undefined)
  scopeTap.current = () => {
    const scopes = scopesRef.current
    const canvas = canvasRef.current
    const comp = compRef.current
    if (!scopes || !canvas || !comp) return
    if (useEditor.getState().exportOpen) return scopes.update(null, 'export')
    if (comp.restoring || comp.restoreFailed) return scopes.update(null, 'gpu')
    const st = scopeState.current
    const now = performance.now()
    if (!shouldSample(now, st.last, SCOPE_INTERVAL_MS)) {
      if (!st.trailing && !latest.current.isPlaying) {
        st.trailing = window.setTimeout(
          () => {
            st.trailing = 0
            if (performance.now() - st.last < SCOPE_INTERVAL_MS) return // sampled meanwhile
            const l = latest.current
            safeFrame(compRef.current, audioRef.current, l.project, l.playhead, l.isPlaying, () => scopeTap.current())
          },
          SCOPE_INTERVAL_MS - (now - st.last)
        )
      }
      return
    }
    st.last = now
    st.sampler ??= new ScopeSampler()
    try {
      scopes.update(st.sampler.sample(canvas))
    } catch (e) {
      // A readback can fail mid context-loss; skip this sample, keep the last image.
      console.warn('[cutroom] scopes readback skipped:', e)
    }
  }
  const tap = (): void => scopeTap.current()

  // Keep the newest state reachable from async redraws (e.g. an image finishing
  // loading or a video seek completing) without re-creating the compositor.
  // While shuttling, async redraws show the HELD time (the frame in flight).
  const latest = useRef({ project, playhead, isPlaying })
  latest.current = { project, playhead: shuttling ? hold.current.time : playhead, isPlaying }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let comp: Compositor
    try {
      comp = new Compositor(canvas, () => {
        hold.current.landed = true // a decoded frame / finished seek arrived
        const l = latest.current
        safeFrame(compRef.current, audioRef.current, l.project, l.playhead, l.isPlaying, tap)
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'WebGL initialization failed')
      return
    }
    compRef.current = comp

    // WebGL context-loss recovery: a lost GPU context rebuilds its GL resources
    // instead of black-screening. The overlay tells the user what's happening.
    let stableTimer = 0
    const onLost = (e: Event): void => {
      // A restore that didn't survive its stable window isn't stable.
      window.clearTimeout(stableTimer)
      comp.handleContextLoss(e)
      setGpuStatus('reconnecting')
      scopesRef.current?.update(null, 'gpu')
    }
    const onRestored = (): void => {
      comp.handleContextRestore()
      setGpuStatus(comp.restoreFailed ? 'failed' : 'ok')
      // Mark stable after a short delay so a flapping context is caught.
      window.clearTimeout(stableTimer)
      stableTimer = window.setTimeout(() => comp.markStable(), 1000)
      // Nothing else redraws a paused preview: paint the rebuilt context now.
      if (!comp.restoring) {
        const l = latest.current
        safeFrame(comp, audioRef.current, l.project, l.playhead, l.isPlaying, tap)
      }
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    let pool: AudioPool | null = null
    try {
      pool = new AudioPool()
      audioRef.current = pool
    } catch {
      pool = null // audio is optional; preview still works silently
    }

    // Browser autoplay policy: the AudioContext starts suspended. Unlock it on
    // the first user gesture anywhere in the window.
    const unlock = (): void => resumeAudioContext()
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)

    safeFrame(comp, pool, project, playhead, isPlaying, tap)

    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      window.clearTimeout(stableTimer)
      window.clearTimeout(scopeState.current.trailing)
      scopeState.current.trailing = 0
      comp.dispose()
      compRef.current = null
      pool?.dispose()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    let time = playhead
    if (shuttling) {
      const step = stepShuttleHold(
        hold.current,
        playhead,
        performance.now(),
        hasVideoAt(project, hold.current.time),
        2 / (project.fps || 30)
      )
      hold.current = step.hold
      if (!step.render) return // let the in-flight frame land first
      time = step.hold.time
      latest.current.playhead = time
    } else {
      hold.current = { time: playhead, at: 0, landed: true }
    }
    safeFrame(compRef.current, audioRef.current, project, time, isPlaying, tap)
  }, [project, playhead, isPlaying, shuttling, showPlaceholders, previewQuality])

  // Audio scrubbing: while the ruler playhead is dragged or the shuttle runs
  // off 1×, each playhead move offers a short grain at the LIVE playhead (not
  // the held shuttle frame; the pool throttles). 1× playback is untouched.
  useEffect(() => {
    const prev = lastScrubTime.current
    lastScrubTime.current = playhead
    if (!audioScrub || isPlaying || !(scrubbing || shuttling)) return
    const st = useEditor.getState()
    const dir = shuttling ? (st.shuttleRate < 0 ? -1 : 1) : scrubDirection(prev, playhead)
    try {
      audioRef.current?.scrub(st.project, playhead, dir)
    } catch (e) {
      console.error('[cutroom] audio scrub error:', e)
    }
  }, [playhead, scrubbing, shuttling, isPlaying, audioScrub])

  // Opening the panel (or closing the Export dialog) needs a fresh sample even
  // when nothing else is redrawing a paused preview.
  const exportOpen = useEditor((s) => s.exportOpen)
  useEffect(() => {
    if (!showScopes || exportOpen) return
    scopeState.current.last = -Infinity
    const l = latest.current
    safeFrame(compRef.current, audioRef.current, l.project, l.playhead, l.isPlaying, tap)
  }, [showScopes, exportOpen])

  return (
    <section className={`preview ${showScopes ? 'with-scopes' : ''}`}>
      <div className="monitor-inner">
        {error ? (
          <div className="ph-frame">
            <div className="note">{t('Preview unavailable: {error}', { error })}</div>
          </div>
        ) : (
          <canvas ref={canvasRef} className="preview-canvas" />
        )}
        <div className="monitor-overlay">
          {project.width}×{project.height} · {project.fps} fps · {playhead.toFixed(2)}s
          {previewQuality !== 'full' && ` · ${t('Preview')} ${previewQuality === 'half' ? '½' : '¼'}`}
        </div>
        <button
          className={`btn small monitor-scopes-btn ${showScopes ? 'active' : ''}`}
          title={showScopes ? t('Hide scopes') : t('Show scopes (histogram, waveform, vectorscope)')}
          aria-pressed={showScopes}
          onClick={() => useSettings.getState().set({ showScopes: !showScopes })}
        >
          {t('Scopes')}
        </button>
        {gpuStatus === 'reconnecting' && (
          <div className="monitor-overlay warn">{t('Reconnecting GPU…')}</div>
        )}
        {gpuStatus === 'failed' && (
          <div className="monitor-overlay warn">
            {t('GPU context lost.')}{' '}
            <button className="btn small" onClick={() => window.location.reload()}>
              {t('Reload')}
            </button>
          </div>
        )}
      </div>
      {showScopes && !error && <Scopes ref={scopesRef} />}
    </section>
  )
}
