import { useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { transcribeClip, type TranscribeProgress } from '../lib/transcribe'

type Status = 'idle' | 'running' | 'done' | 'error'

export default function TranscribeModal() {
  const open = useEditor((s) => s.transcribeOpen)
  const setOpen = useEditor((s) => s.setTranscribeOpen)
  const clip = useEditor((s) => (s.selectedClipId ? s.project.clips[s.selectedClipId] : null))
  const media = useEditor((s) => {
    const c = s.selectedClipId ? s.project.clips[s.selectedClipId] : null
    return c?.mediaId ? s.project.media[c.mediaId] : null
  })
  const importSubtitles = useEditor((s) => s.importSubtitles)

  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<TranscribeProgress>({ stage: 'extracting' })
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const cancelRef = useRef(false)

  if (!open) return null

  const transcribable = !!clip && !!media && (media.kind === 'audio' || media.kind === 'video')
  const running = status === 'running'

  const pct =
    progress.stage === 'loading' && progress.progress != null
      ? progress.progress * 100
      : progress.stage === 'transcribing'
        ? 100
        : 8
  const label =
    progress.stage === 'extracting'
      ? 'Preparing audio…'
      : progress.stage === 'loading'
        ? `Loading model… ${progress.progress != null ? Math.round(progress.progress * 100) + '%' : ''}`
        : 'Transcribing…'

  const run = async (): Promise<void> => {
    if (!clip) return
    cancelRef.current = false
    setStatus('running')
    setError(null)
    setProgress({ stage: 'extracting' })
    setCount(0)
    try {
      // Each cue is committed to the project the moment its 30s window resolves
      // (not batched until the whole clip finishes) — a crash mid-transcription
      // only loses the window in flight, not everything already transcribed.
      const cues = await transcribeClip(
        useEditor.getState().project,
        clip,
        setProgress,
        (cue) => {
          importSubtitles([cue])
          setCount((c) => c + 1)
        },
        () => cancelRef.current
      )
      setCount(cues.length)
      setStatus('done')
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') {
        setStatus('idle') // user stopped it; already-committed cues stay on the timeline
      } else {
        setError(e instanceof Error ? e.message : 'Transcription failed.')
        setStatus('error')
      }
    }
  }

  const close = (): void => {
    if (running) {
      cancelRef.current = true // let the in-flight window finish, then it can be reopened
      return
    }
    setStatus('idle')
    setError(null)
    setOpen(false)
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">AI Subtitles</div>
        <div className="modal-body">
          {!transcribable ? (
            <p className="modal-note">
              Select an audio or video clip on the timeline first, then reopen this.
            </p>
          ) : (
            <>
              <p className="modal-note">
                Transcribe <strong>{media?.name}</strong> into subtitle clips using on-device speech
                recognition (Whisper) — no account or upload. The first run downloads a small model
                (~75 MB); after that it works offline.
              </p>
              {running && (
                <div className="export-progress">
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="phase">{label}</div>
                </div>
              )}
              {status === 'done' && (
                <p className="modal-ok">
                  Added {count} subtitle{count === 1 ? '' : 's'} to the Subtitles track.
                </p>
              )}
              {status === 'error' && error && <p className="modal-error">{error}</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={close}>
            {running ? 'Stop' : 'Close'}
          </button>
          {transcribable && status !== 'done' && (
            <button className="btn primary" onClick={run} disabled={running}>
              {status === 'error' ? 'Retry' : 'Transcribe'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
