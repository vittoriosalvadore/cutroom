import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { Compositor } from '../lib/compositor'
import { AudioPool } from '../lib/audioPool'
import { resumeAudioContext } from '../lib/audioContext'
import { previewScale } from '../lib/previewScale'
import { hasVideoAt, isRealtimeRate, stepShuttleHold, type ShuttleHold } from '../lib/transport'
import { useT } from '../lib/i18n'
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
  playing: boolean
): void {
  try {
    const settings = useSettings.getState()
    comp?.render(project, playhead, playing, {
      hidePlaceholders: !settings.showPlaceholders,
      // Preview-only resolution; the canvas CSS keeps the on-screen size.
      scale: previewScale(settings.previewQuality)
    })
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
  // the paused/scrub path with audio silent, paced by `hold` so each seeked
  // frame gets to land before the next one is requested (lib/transport).
  const isPlaying = useEditor((s) => s.isPlaying && isRealtimeRate(s.shuttleRate))
  const shuttling = useEditor((s) => s.isPlaying && !isRealtimeRate(s.shuttleRate))
  const hold = useRef<ShuttleHold>({ time: 0, at: 0, landed: true })
  const showPlaceholders = useSettings((s) => s.showPlaceholders)
  const previewQuality = useSettings((s) => s.previewQuality)
  const t = useT()

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
        safeFrame(compRef.current, audioRef.current, l.project, l.playhead, l.isPlaying)
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
        safeFrame(comp, audioRef.current, l.project, l.playhead, l.isPlaying)
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

    safeFrame(comp, pool, project, playhead, isPlaying)

    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      window.clearTimeout(stableTimer)
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
    safeFrame(compRef.current, audioRef.current, project, time, isPlaying)
  }, [project, playhead, isPlaying, shuttling, showPlaceholders, previewQuality])

  return (
    <section className="preview">
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
    </section>
  )
}
