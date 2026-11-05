import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { detectScenes, type SceneCut, type SceneDetectProgress } from '../lib/sceneDetect'
import { interpolateParts, useT } from '../lib/i18n'

type Status = 'idle' | 'running' | 'preview' | 'error'
/** What Apply does with the kept cuts. */
type ApplyMode = 'split' | 'splitMarkers' | 'markers'

/** Timeline time as m:ss.ss. */
function formatTime(sec: number): string {
  const cs = Math.round(sec * 100) // whole hundredths, so 59.999 can't print as 0:60.00
  const m = Math.floor(cs / 6000)
  return `${m}:${((cs - m * 6000) / 100).toFixed(2).padStart(5, '0')}`
}

export default function SceneDetectModal() {
  const open = useEditor((s) => s.sceneDetectOpen)
  const setOpen = useEditor((s) => s.setSceneDetectOpen)
  const clip = useEditor((s) => (s.selectedClipId ? s.project.clips[s.selectedClipId] : null))
  const media = useEditor((s) => {
    const c = s.selectedClipId ? s.project.clips[s.selectedClipId] : null
    return c?.mediaId ? s.project.media[c.mediaId] : null
  })
  const splitClipAtTimes = useEditor((s) => s.splitClipAtTimes)
  const addMarkers = useEditor((s) => s.addMarkers)

  const [intervalSec, setIntervalSec] = useState(0.5)
  const [threshold, setThreshold] = useState(0.35)
  const [mode, setMode] = useState<ApplyMode>('split')
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<SceneDetectProgress>({ stage: 'sampling' })
  // Detected cuts are tied to the clip they were computed for, so Apply splits
  // THAT clip even if the selection changed since.
  const [result, setResult] = useState<{ clipId: string; cuts: SceneCut[] } | null>(null)
  // Indices of cuts the user unchecked (false positives).
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Bumped whenever a run is superseded (Stop / close / back / new run). The
  // in-flight detection polls it as its cancel flag, so it stops seeking, and
  // its result is dropped instead of landing in the UI.
  const runToken = useRef(0)
  const t = useT()

  // Opening or closing (from anywhere) cancels any in-flight detection and
  // starts from a clean slate, so a reopen never shows another clip's cuts.
  useEffect(() => {
    runToken.current++
    setStatus('idle')
    setResult(null)
    setExcluded(new Set())
    setError(null)
  }, [open])

  if (!open) return null
  const cuts = result?.cuts ?? []

  const analyzable = !!clip && !!media && media.kind === 'video' && !!media.path
  const running = status === 'running'
  const pct = Math.round((progress.progress ?? 0) * 100)
  const phase =
    progress.stage === 'sampling'
      ? `${t('Sampling frames…')} ${pct}%`
      : progress.stage === 'refining'
        ? `${t('Pinning down cuts…')} ${pct}%`
        : t('Done')

  const detect = async (): Promise<void> => {
    if (!clip) return
    const token = ++runToken.current
    const clipId = clip.id
    setStatus('running')
    setError(null)
    setProgress({ stage: 'sampling' })
    try {
      const found = await detectScenes(
        useEditor.getState().project,
        clip,
        { intervalSec, threshold },
        (p) => {
          if (token === runToken.current) setProgress(p)
        },
        () => token !== runToken.current
      )
      if (token !== runToken.current) return // stopped / superseded
      setResult({ clipId, cuts: found })
      setExcluded(new Set())
      setStatus('preview')
    } catch (e) {
      if (token !== runToken.current) return // a stopped run lands here (JobCancelled)
      setError(e instanceof Error ? e.message : t('Scene detection failed.'))
      setStatus('error')
    }
  }

  const stop = (): void => {
    runToken.current++
    setStatus('idle') // back to the options screen
  }

  const back = (): void => {
    runToken.current++
    setStatus('idle')
    setResult(null)
    setExcluded(new Set())
    setError(null)
  }

  const close = (): void => {
    back() // also cancels a running detection
    setOpen(false)
  }

  const toggleKept = (i: number): void => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const apply = (): void => {
    if (!result) return
    const times = result.cuts.filter((_, i) => !excluded.has(i)).map((c) => c.atSec)
    if (mode === 'markers') addMarkers(times)
    else splitClipAtTimes(result.clipId, times, { markers: mode === 'splitMarkers' })
    close()
  }

  const keptCount = cuts.length - excluded.size

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{t('Detect Scenes')}</div>
        <div className="modal-body">
          {!analyzable ? (
            <p className="modal-error">{t('Select a video clip first.')}</p>
          ) : running ? (
            <div className="export-progress">
              <div className="bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="phase">{phase}</div>
            </div>
          ) : status === 'preview' ? (
            cuts.length === 0 ? (
              <p className="modal-note">{t('No cuts found — try a lower threshold or a shorter interval.')}</p>
            ) : (
              <>
                <p className="modal-note">
                  {interpolateParts(
                    cuts.length === 1 ? t('Found {n} cut in {name}.') : t('Found {n} cuts in {name}.'),
                    {
                      n: <strong key="n">{cuts.length}</strong>,
                      name: <strong key="name">{media?.name}</strong>
                    }
                  )}{' '}
                  {t('Uncheck any false positives — nothing changes until you apply, as one undo step.')}
                </p>
                <div className="scene-list">
                  {cuts.map((cut, i) => (
                    <div className="set-row" key={cut.atSec}>
                      <div className="set-text">
                        <div className="set-label">
                          {formatTime(cut.atSec)}
                          <em title={t('How much the picture changes across the cut')}>
                            {Math.round(cut.score * 100)}%
                          </em>
                        </div>
                      </div>
                      <label className="insp-switch">
                        <input type="checkbox" checked={!excluded.has(i)} onChange={() => toggleKept(i)} />
                        <span>{t('Keep')}</span>
                      </label>
                    </div>
                  ))}
                </div>
                <div className="set-row">
                  <div className="set-text">
                    <div className="set-label">{t('Apply as')}</div>
                  </div>
                  <div className="set-seg">
                    <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')}>
                      {t('Split')}
                    </button>
                    <button className={mode === 'splitMarkers' ? 'active' : ''} onClick={() => setMode('splitMarkers')}>
                      {t('Split + markers')}
                    </button>
                    <button className={mode === 'markers' ? 'active' : ''} onClick={() => setMode('markers')}>
                      {t('Markers only')}
                    </button>
                  </div>
                </div>
              </>
            )
          ) : (
            <>
              <p className="modal-note">
                {interpolateParts(
                  t(
                    'Finds hard cuts in {name} by comparing the colors of sampled frames, pinning each one to the first frame of the new shot. Runs entirely on your machine — you review the cuts before anything changes.'
                  ),
                  { name: <strong key="name">{media?.name}</strong> }
                )}
              </p>
              <label className="insp-field">
                <span className="insp-label">
                  {t('Sample interval')}
                  <em>{intervalSec.toFixed(2)}s</em>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(Number(e.target.value))}
                />
              </label>
              <label className="insp-field">
                <span className="insp-label">
                  {t('Threshold')}
                  <em>{Math.round(threshold * 100)}%</em>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={0.8}
                  step={0.01}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
              </label>
              <p className="insp-note">
                {t('A lower threshold finds more cuts, but also more false positives (fast motion, flashes).')}
              </p>
              {status === 'error' && error && <p className="modal-error">{error}</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          {status === 'preview' ? (
            <>
              <button className="btn" onClick={back}>
                {t('Back')}
              </button>
              <button className="btn primary" onClick={apply} disabled={keptCount === 0}>
                {t('Apply')}
                {keptCount > 0 ? ` (${keptCount})` : ''}
              </button>
            </>
          ) : running ? (
            <button className="btn" onClick={stop}>
              {t('Stop')}
            </button>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {t('Cancel')}
              </button>
              {analyzable && (
                <button className="btn primary" onClick={detect}>
                  {status === 'error' ? t('Retry') : t('Detect')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
