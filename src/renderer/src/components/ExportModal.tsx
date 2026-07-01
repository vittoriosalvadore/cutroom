import { useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { exportTimeline, timelineDuration, type ExportProgress } from '../lib/exporter'

type Status = 'idle' | 'running' | 'done' | 'error'

export default function ExportModal() {
  const open = useEditor((s) => s.exportOpen)
  const setOpen = useEditor((s) => s.setExportOpen)
  const project = useEditor((s) => s.project)

  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<ExportProgress>({ phase: 'preparing' })
  const [error, setError] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const cancelRef = useRef(false)

  if (!open) return null

  const duration = timelineDuration(project)
  const totalFrames = Math.max(1, Math.round(duration * project.fps))
  const running = status === 'running'

  const pct =
    progress.phase === 'rendering' && progress.totalFrames && progress.frame
      ? Math.round((progress.frame / progress.totalFrames) * 100)
      : progress.phase === 'encoding' || progress.phase === 'muxing' || progress.phase === 'done'
        ? 100
        : 0

  const phaseLabel =
    progress.phase === 'preparing'
      ? 'Loading media…'
      : progress.phase === 'rendering'
        ? `Rendering frame ${progress.frame} / ${progress.totalFrames} (${pct}%)`
        : progress.phase === 'encoding'
          ? 'Encoding video…'
          : progress.phase === 'muxing'
            ? 'Mixing & adding audio…'
            : 'Done'

  const start = async (): Promise<void> => {
    const outputPath = await window.cutroom.saveVideo()
    if (!outputPath) return
    cancelRef.current = false
    setError(null)
    setSavedPath(null)
    setProgress({ phase: 'preparing' })
    setStatus('running')

    const result = await exportTimeline(project, outputPath, setProgress, () => cancelRef.current)

    if (result.ok) {
      setSavedPath(outputPath)
      setStatus('done')
    } else if (result.error === 'Export cancelled.') {
      setStatus('idle')
    } else {
      setError(result.error ?? 'Export failed.')
      setStatus('error')
    }
  }

  const close = (): void => {
    if (running) return
    setStatus('idle')
    setError(null)
    setOpen(false)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Export video</div>
        <div className="modal-body">
          <div className="export-specs">
            <div>
              <span>Resolution</span>
              <strong>
                {project.width}×{project.height}
              </strong>
            </div>
            <div>
              <span>Frame rate</span>
              <strong>{project.fps} fps</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>
                {duration.toFixed(2)}s · {totalFrames} frames
              </strong>
            </div>
            <div>
              <span>Codec</span>
              <strong>H.264 + AAC / MP4</strong>
            </div>
          </div>

          {status === 'idle' && (
            <p className="modal-note">
              Renders the timeline — titles, subtitles, chroma key, and a mixed soundtrack — to an
              MP4. This is an offline render, so it can take a while.
            </p>
          )}

          {(status === 'running' || status === 'done') && (
            <div className="export-progress">
              <div className="bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="phase">{status === 'done' ? 'Export complete' : phaseLabel}</div>
            </div>
          )}

          {status === 'done' && savedPath && (
            <p className="modal-ok">Saved to {savedPath}</p>
          )}

          {status === 'error' && error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-foot">
          {running ? (
            <button className="btn" onClick={() => (cancelRef.current = true)}>
              Cancel
            </button>
          ) : (
            <button className="btn" onClick={close}>
              Close
            </button>
          )}
          {status !== 'done' && (
            <button className="btn primary" disabled={running} onClick={start}>
              {status === 'error' ? 'Retry export' : 'Choose file & export'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
