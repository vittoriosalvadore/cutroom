import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { detectSilenceRanges, totalRemovedSec, type SilenceCutRange } from '../lib/autoCutSilence'
import { interpolateParts, useT } from '../lib/i18n'

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
  // Detected ranges are tied to the clip they were computed for, so Apply cuts
  // THAT clip even if the selection changed since.
  const [result, setResult] = useState<{ clipId: string; ranges: SilenceCutRange[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped whenever a run is superseded (close / back / new run); a detection
  // that resolves with a stale token is dropped instead of landing in the UI.
  const runToken = useRef(0)
  const t = useT()

  // Opening or closing (from anywhere) invalidates any in-flight detection and
  // starts from a clean slate, so a reopen never shows another clip's ranges.
  useEffect(() => {
    runToken.current++
    setStatus('idle')
    setResult(null)
    setError(null)
  }, [open])

  if (!open) return null
  const ranges = result?.ranges ?? []

  const analyzable = !!clip && !!media && (media.kind === 'audio' || media.kind === 'video')
  const detecting = status === 'detecting'

  const detect = async (): Promise<void> => {
    if (!clip) return
    const token = ++runToken.current
    const clipId = clip.id
    setStatus('detecting')
    setError(null)
    try {
      const found = await detectSilenceRanges(useEditor.getState().project, clip, {
        thresholdDb,
        minSilenceSec,
        paddingSec
      })
      if (token !== runToken.current) return // cancelled / superseded
      setResult({ clipId, ranges: found })
      setStatus('preview')
    } catch (e) {
      if (token !== runToken.current) return
      setError(e instanceof Error ? e.message : t('Silence detection failed.'))
      setStatus('error')
    }
  }

  const apply = (): void => {
    if (!result) return
    applySilenceCuts(result.clipId, result.ranges)
    runToken.current++
    setStatus('idle')
    setResult(null)
    setOpen(false)
  }

  const back = (): void => {
    runToken.current++
    setStatus('idle')
    setResult(null)
    setError(null)
  }

  const close = (): void => {
    runToken.current++
    setStatus('idle')
    setResult(null)
    setError(null)
    setOpen(false)
  }

  const removedSec = totalRemovedSec(ranges)

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{t('Auto-Cut Silence')}</div>
        <div className="modal-body">
          {!analyzable ? (
            <p className="modal-error">{t('Select an audio or video clip first.')}</p>
          ) : status === 'preview' ? (
            <>
              <p className="modal-note">
                {interpolateParts(
                  ranges.length === 1
                    ? t('Found {n} silent range in {name}, totalling {total}.')
                    : t('Found {n} silent ranges in {name}, totalling {total}.'),
                  {
                    n: <strong key="n">{ranges.length}</strong>,
                    name: <strong key="name">{media?.name}</strong>,
                    total: <strong key="total">{removedSec.toFixed(1)}s</strong>
                  }
                )}{' '}
                {t('Nothing has been changed yet — Apply commits the cut as one undo step.')}
              </p>
              {ranges.length === 0 && (
                <p className="modal-note">
                  {t('Nothing under the threshold — try a higher threshold or shorter minimum.')}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="modal-note">
                {interpolateParts(
                  t(
                    "Detects quiet ranges in {name}'s audio and ripple-deletes them. Runs entirely on your machine — nothing is applied until you review and confirm."
                  ),
                  { name: <strong key="name">{media?.name}</strong> }
                )}
              </p>
              <label className="insp-field">
                <span className="insp-label">
                  {t('Threshold')}
                  <em>{thresholdDb} dB</em>
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
                  {t('Min silence')}
                  <em>{Math.round(minSilenceSec * 1000)}ms</em>
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
                  {t('Padding')}
                  <em>{Math.round(paddingSec * 1000)}ms</em>
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
              {detecting && <p className="modal-note">{t('Analyzing audio…')}</p>}
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
              <button className="btn primary" onClick={apply} disabled={ranges.length === 0}>
                {t('Apply')}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={close}>
                {t('Cancel')}
              </button>
              {analyzable && (
                <button className="btn primary" onClick={detect} disabled={detecting}>
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
