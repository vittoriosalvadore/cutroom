import { useState } from 'react'
import { useEditor } from '../state/store'
import { detectSilenceRanges, totalRemovedSec, type SilenceCutRange } from '../lib/autoCutSilence'

type Status = 'idle' | 'detecting' | 'preview' | 'error'

export default function AutoCutSilenceModal() {
  const open = useEditor((s) => s.autoCutSilenceOpen)
  const setOpen = useEditor((s) => s.setAutoCutSilenceOpen)
  const clip = useEditor((s) => (s.selectedClipId ? s.project.clips[s.selectedClipId] : null))
  const media = useEditor((s) => {
    const c = s.selectedClipId ? s.project.clips[s.selectedClipId] : null
    return c?.mediaId ? s.project.media[c.mediaId] : null
  })
  const applySilenceCuts = useEditor((s) => s.applySilenceCuts)

  const [thresholdDb, setThresholdDb] = useState(-40)
  const [minSilenceSec, setMinSilenceSec] = useState(0.4)
  const [paddingSec, setPaddingSec] = useState(0.12)
  const [status, setStatus] = useState<Status>('idle')
  const [ranges, setRanges] = useState<SilenceCutRange[]>([])
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const analyzable = !!clip && !!media && (media.kind === 'audio' || media.kind === 'video')
  const detecting = status === 'detecting'

  const detect = async (): Promise<void> => {
    if (!clip) return
    setStatus('detecting')
    setError(null)
    try {
      const found = await detectSilenceRanges(useEditor.getState().project, clip, {
        thresholdDb,
        minSilenceSec,
        paddingSec
      })
      setRanges(found)
      setStatus('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Silence detection failed.')
      setStatus('error')
    }
  }

  const apply = (): void => {
    if (!clip) return
    applySilenceCuts(clip.id, ranges)
    setStatus('idle')
    setRanges([])
    setOpen(false)
  }

  const back = (): void => {
    setStatus('idle')
    setRanges([])
    setError(null)
  }

  const close = (): void => {
    setStatus('idle')
    setRanges([])
    setError(null)
    setOpen(false)
  }

  const removedSec = totalRemovedSec(ranges)

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Auto-Cut Silence</div>
        <div className="modal-body">
          {!analyzable ? (
            <p className="modal-error">Select an audio or video clip first.</p>
          ) : status === 'preview' ? (
            <>
              <p className="modal-note">
                Found <strong>{ranges.length}</strong> silent range{ranges.length === 1 ? '' : 's'} in{' '}
                <strong>{media?.name}</strong>, totalling <strong>{removedSec.toFixed(1)}s</strong>. Nothing has
                been changed yet — Apply commits the cut as one undo step.
              </p>
              {ranges.length === 0 && (
                <p className="modal-note">Nothing under the threshold — try a higher threshold or shorter minimum.</p>
              )}
            </>
          ) : (
            <>
              <p className="modal-note">
                Detects quiet ranges in <strong>{media?.name}</strong>'s audio and ripple-deletes them. Runs
                entirely on your machine — nothing is applied until you review and confirm.
              </p>
              <label className="insp-field">
                <span className="insp-label">
                  Threshold<em>{thresholdDb} dB</em>
                </span>
                <input
                  type="range"
                  min={-60}
                  max={-15}
                  step={1}
                  value={thresholdDb}
                  disabled={detecting}
                  onChange={(e) => setThresholdDb(Number(e.target.value))}
                />
              </label>
              <label className="insp-field">
                <span className="insp-label">
                  Min silence<em>{Math.round(minSilenceSec * 1000)}ms</em>
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={minSilenceSec}
                  disabled={detecting}
                  onChange={(e) => setMinSilenceSec(Number(e.target.value))}
                />
              </label>
              <label className="insp-field">
                <span className="insp-label">
                  Padding<em>{Math.round(paddingSec * 1000)}ms</em>
                </span>
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={paddingSec}
                  disabled={detecting}
                  onChange={(e) => setPaddingSec(Number(e.target.value))}
                />
              </label>
              {detecting && <p className="modal-note">Analyzing audio…</p>}
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
              <button className="btn primary" onClick={apply} disabled={ranges.length === 0}>
                Apply
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              {analyzable && (
                <button className="btn primary" onClick={detect} disabled={detecting}>
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
