import { useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { autoReframe, type ReframeProgress } from '../lib/autoReframe'

type Status = 'idle' | 'running' | 'error'

export default function AutoReframeModal() {
  const open = useEditor((s) => s.reframeOpen)
  const setOpen = useEditor((s) => s.setReframeOpen)
  const applyReframe = useEditor((s) => s.applyReframe)
  const project = useEditor((s) => s.project)
  const clip = useEditor((s) => (s.selectedClipId ? s.project.clips[s.selectedClipId] : null))

  const [target, setTarget] = useState<'person' | 'auto'>('person')
  const [zoom, setZoom] = useState(1.3)
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<ReframeProgress>({ stage: 'sampling' })
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef(false)

  if (!open) return null

  const media = clip?.mediaId ? project.media[clip.mediaId] : null
  const ok = !!clip && !!media && media.kind === 'video'
  const pct = Math.round((progress.progress ?? 0) * 100)
  const phase =
    progress.stage === 'loading'
      ? `Loading AI model… ${pct}%`
      : progress.stage === 'sampling'
        ? `Sampling frames… ${pct}%`
        : progress.stage === 'detecting'
          ? `Tracking subject… ${pct}%`
          : 'Done'

  const run = async (): Promise<void> => {
    if (!clip) return
    cancelRef.current = false
    setError(null)
    setStatus('running')
    setProgress({ stage: 'sampling' })
    try {
      const result = await autoReframe(
        project,
        clip,
        { target, zoom, samples: 24 },
        setProgress,
        () => cancelRef.current
      )
      applyReframe(clip.id, result)
      setStatus('idle')
      setOpen(false)
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') {
        setStatus('idle') // user stopped it; stay on the options screen
      } else {
        setError(e instanceof Error ? e.message : 'Auto-reframe failed.')
        setStatus('error')
      }
    }
  }

  const close = (): void => {
    if (status === 'running') {
      cancelRef.current = true // let an in-flight run unwind, then it can be reopened
      return
    }
    setStatus('idle')
    setError(null)
    setOpen(false)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">AI Auto-Reframe</div>
        <div className="modal-body">
          {!ok ? (
            <p className="modal-error">Select a video clip first.</p>
          ) : status === 'running' ? (
            <div className="export-progress">
              <div className="bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="phase">{phase}</div>
            </div>
          ) : (
            <>
              <p className="modal-note">
                Tracks the subject across the clip and adds position keyframes that keep it framed. Runs
                entirely on your machine — the first run downloads a small detection model.
              </p>
              <div className="set-row">
                <div className="set-text">
                  <div className="set-label">Follow</div>
                </div>
                <div className="set-seg">
                  <button className={target === 'person' ? 'active' : ''} onClick={() => setTarget('person')}>
                    Person
                  </button>
                  <button className={target === 'auto' ? 'active' : ''} onClick={() => setTarget('auto')}>
                    Main subject
                  </button>
                </div>
              </div>
              <label className="insp-field">
                <span className="insp-label">
                  Zoom<em>{Math.round(zoom * 100)}%</em>
                </span>
                <input
                  type="range"
                  min={1.1}
                  max={2}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              {error && <p className="modal-error">{error}</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={close}>
            {status === 'running' ? 'Stop' : 'Cancel'}
          </button>
          {ok && status !== 'running' && (
            <button className="btn primary" onClick={run}>
              {status === 'error' ? 'Retry' : 'Analyze & apply'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
