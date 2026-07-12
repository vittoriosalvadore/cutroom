import { useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { detectScenes, type SceneCut, type SceneDetectProgress } from '../lib/sceneDetect'

type Status = 'idle' | 'running' | 'preview' | 'error'

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

export default function SceneDetectModal() {
  const open = useEditor((s) => s.sceneDetectOpen)
  const setOpen = useEditor((s) => s.setSceneDetectOpen)
  const project = useEditor((s) => s.project)
  const clip = useEditor((s) => (s.selectedClipId ? s.project.clips[s.selectedClipId] : null))
  const media = useEditor((s) => {
    const c = s.selectedClipId ? s.project.clips[s.selectedClipId] : null
    return c?.mediaId ? s.project.media[c.mediaId] : null
  })
  const splitClipAtTimes = useEditor((s) => s.splitClipAtTimes)

  const [intervalSec, setIntervalSec] = useState(0.5)
  const [threshold, setThreshold] = useState(0.35)
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<SceneDetectProgress>({ stage: 'sampling' })
  const [cuts, setCuts] = useState<SceneCut[]>([])
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef(false)

  if (!open) return null

  const analyzable = !!clip && !!media && media.kind === 'video'
  const running = status === 'running'
  const pct = Math.round((progress.progress ?? 0) * 100)
  const phase =
    progress.stage === 'sampling'
      ? `Sampling frames… ${pct}%`
      : progress.stage === 'refining'
        ? `Pinning down cuts… ${pct}%`
        : 'Done'

  const detect = async (): Promise<void> => {
    if (!clip) return
    cancelRef.current = false
    setStatus('running')
    setError(null)
    setProgress({ stage: 'sampling' })
    try {
      const found = await detectScenes(project, clip, { intervalSec, threshold }, setProgress, () => cancelRef.current)
      setCuts(found)
      setExcluded(new Set())
      setStatus('preview')
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') {
        setStatus('idle') // user stopped it; stay on the options screen
      } else {
        setError(e instanceof Error ? e.message : 'Scene detection failed.')
        setStatus('error')
      }
    }
  }

  const toggleExcluded = (i: number): void => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const back = (): void => {
    setStatus('idle')
    setCuts([])
    setExcluded(new Set())
    setError(null)
  }

  const apply = (): void => {
    if (!clip) return
    const kept = cuts.filter((_, i) => !excluded.has(i))
    if (kept.length > 0) splitClipAtTimes(clip.id, kept.map((c) => clip.startSec + c.atSec))
    back()
    setOpen(false)
  }

  const close = (): void => {
    if (running) {
      cancelRef.current = true // let the in-flight refine step finish, then it can be reopened
      return
    }
    back()
    setOpen(false)
  }

  const keptCount = cuts.length - excluded.size

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Detect Scenes</div>
        <div className="modal-body">
          {!analyzable ? (
            <p className="modal-error">Select a video clip first.</p>
          ) : running ? (
            <div className="export-progress">
              <div className="bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="phase">{phase}</div>
            </div>
          ) : status === 'preview' ? (
            <>
              <p className="modal-note">
                Found <strong>{cuts.length}</strong> candidate cut{cuts.length === 1 ? '' : 's'} in{' '}
                <strong>{media?.name}</strong>. Uncheck any false positives, then Apply to split the clip at
                the checked times — nothing is removed, and it's a single undo step.
              </p>
              {cuts.length === 0 ? (
                <p className="modal-note">No cuts found — try a lower threshold or a shorter interval.</p>
              ) : (
                <div className="scene-list">
                  {cuts.map((cut, i) => (
                    <div className="set-row" key={i}>
                      <div className="set-text">
                        <div className="set-label">{formatTime(cut.atSec)}</div>
                      </div>
                      <label className="insp-switch">
                        <input type="checkbox" checked={!excluded.has(i)} onChange={() => toggleExcluded(i)} />
                        <span>Keep</span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="modal-note">
                Detects hard cuts in <strong>{media?.name}</strong> by comparing sampled frames' color, then
                splits the clip at each one — content is kept, this is a split, not a delete. Runs entirely
                on your machine.
              </p>
              <label className="insp-field">
                <span className="insp-label">
                  Sample interval<em>{intervalSec.toFixed(2)}s</em>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={intervalSec}
                  disabled={running}
                  onChange={(e) => setIntervalSec(Number(e.target.value))}
                />
              </label>
              <label className="insp-field">
                <span className="insp-label">
                  Threshold<em>{Math.round(threshold * 100)}%</em>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={0.8}
                  step={0.01}
                  value={threshold}
                  disabled={running}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
              </label>
              <p className="insp-note">Lower threshold finds more cuts, including more false positives.</p>
              {status === 'error' && error && <p className="modal-error">{error}</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          {status === 'preview' ? (
            <>
              <button className="btn" onClick={back}>
                Back
              </button>
              <button className="btn primary" onClick={apply} disabled={keptCount === 0}>
                Apply{keptCount > 0 ? ` (${keptCount})` : ''}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {running ? 'Stop' : 'Cancel'}
              </button>
              {analyzable && !running && (
                <button className="btn primary" onClick={detect}>
                  {status === 'error' ? 'Retry' : 'Detect'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
