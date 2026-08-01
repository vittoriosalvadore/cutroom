import { useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { abandonTranscription, transcribeClip, type TranscribeProgress } from '../lib/transcribe'

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
  const [wordLevel, setWordLevel] = useState(false)
  // Separate from `running`: Stop only takes effect at the next checkpoint
  // (extraction has no way to abort mid-flight), so without this the button
  // gives no feedback at all while a click is still pending.
  const [stopping, setStopping] = useState(false)
  // Keep cancellation attached to one concrete run. A single boolean can be
  // reset by a retry while the previous extraction promise is still pending,
  // allowing that stale run to wake up and race the new transcription.
  const activeRunRef = useRef<{ cancelled: boolean } | null>(null)
  // A worker call already in flight can't be aborted, only left to finish or
  // hit WorkerJob's own much longer (60s) dead-worker timeout — see run()'s
  // finally block and close() below.
  const stopTimerRef = useRef<number | null>(null)

  if (!open) return null

  const transcribable = !!clip && !!media && (media.kind === 'audio' || media.kind === 'video')
  const running = status === 'running'

  const pct =
    progress.stage === 'loading' && progress.progress != null
      ? progress.progress * 100
      : progress.stage === 'transcribing'
        ? 100
        : 8
  const label = stopping
    ? 'Stopping…'
    : progress.stage === 'extracting'
      ? 'Preparing audio…'
      : progress.stage === 'loading'
        ? `Loading model… ${progress.progress != null ? Math.round(progress.progress * 100) + '%' : ''}`
        : 'Transcribing…'

  const run = async (): Promise<void> => {
    if (!clip) return
    if (stopTimerRef.current != null) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
    // A previous run may still be finishing extraction after the stop safety
    // timer closed the modal. Do not let a retry share its worker or let the
    // old promise continue into a fresh transcription.
    const previousRun = activeRunRef.current
    if (previousRun) {
      previousRun.cancelled = true
      abandonTranscription()
    }
    const runState = { cancelled: false }
    activeRunRef.current = runState
    const shouldCancel = (): boolean => runState.cancelled || activeRunRef.current !== runState
    setStopping(false)
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
          if (shouldCancel()) return
          importSubtitles([cue])
          setCount((c) => c + 1)
        },
        shouldCancel,
        wordLevel
      )
      if (shouldCancel()) return
      setCount(cues.length)
      setStatus('done')
    } catch (e) {
      // A user-initiated stop can surface as JobCancelled's 'cancelled', OR
      // (once close() below force-terminates the worker) as WorkerJob's own
      // "terminated before responding" — either way it's not a real failure,
      // so intent (did the user ask to stop?) decides this, not the message.
      if (runState.cancelled || (e instanceof Error && e.message === 'cancelled')) {
        if (activeRunRef.current !== runState) return
        setStopping(false)
        setStatus('idle') // user stopped it; already-committed cues stay on the timeline
      } else {
        if (activeRunRef.current !== runState) return
        setError(e instanceof Error ? e.message : 'Transcription failed.')
        setStatus('error')
      }
    } finally {
      // The operation genuinely settled (success, cancelled, or error) — a
      // pending force-close from close() below is no longer needed; let the
      // outcome above speak for itself instead of yanking the modal shut
      // under it a moment later.
      if (activeRunRef.current === runState && stopTimerRef.current != null) {
        window.clearTimeout(stopTimerRef.current)
        stopTimerRef.current = null
      }
      if (activeRunRef.current === runState) activeRunRef.current = null
    }
  }

  const close = (): void => {
    const activeRun = activeRunRef.current
    if (running && activeRun) {
      activeRun.cancelled = true
      setStopping(true)
      // Force-terminate the worker now rather than just walking away from
      // it — an abandoned-but-still-pending call left occupying the shared
      // worker is a trap: a follow-up Transcribe posts a NEW call to that
      // SAME worker, and when the old, forgotten call's own timeout later
      // fires, it tears the worker down and takes the new call with it too
      // ("Worker was terminated before responding" on what looked like a
      // fresh attempt). Terminating here resolves the current call almost
      // immediately (caught above) AND guarantees the next Transcribe click
      // starts against a clean worker.
      abandonTranscription()
      // Safety net for a hang that ISN'T the worker (e.g. still stuck in
      // extraction) — abandonTranscription() can't help there, so fall back
      // to just not waiting any longer, same as before.
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = null
        setStopping(false)
        setStatus('idle')
        setOpen(false)
      }, 4000)
      return
    }
    setStopping(false)
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
                recognition (Whisper) — no account or upload. The first run downloads a large model
                (~3 GB) and transcribing is slow without a GPU (a 30s window can take around a
                minute); after the download it works offline.
              </p>
              {status === 'idle' && (
                <label className="insp-switch">
                  <input
                    type="checkbox"
                    checked={wordLevel}
                    onChange={(e) => setWordLevel(e.target.checked)}
                  />
                  <span>Karaoke-style (word highlight)</span>
                </label>
              )}
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
