import { useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { transcribeClip, type TranscribeProgress } from '../lib/transcribe'
import { interpolateParts, useT } from '../lib/i18n'
import { useSettings } from '../state/settings'
import {
  TRANSCRIBE_LANGUAGES,
  TRANSCRIBE_MODELS,
  type TranscribeLanguage,
  type TranscribeModel
} from '../lib/transcribeOptions'

/** Display names for the spoken-language picker (endonyms, so they read the
 *  same in every UI language). */
const LANGUAGE_NAMES: Record<TranscribeLanguage, string> = {
  auto: '',
  italian: 'Italiano',
  english: 'English',
  spanish: 'Español',
  french: 'Français',
  german: 'Deutsch',
  portuguese: 'Português',
  dutch: 'Nederlands',
  polish: 'Polski',
  romanian: 'Română',
  greek: 'Ελληνικά',
  turkish: 'Türkçe',
  russian: 'Русский',
  ukrainian: 'Українська',
  arabic: 'العربية',
  hindi: 'हिन्दी',
  chinese: '中文',
  japanese: '日本語',
  korean: '한국어'
}

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
  const t = useT()
  const model = useSettings((s) => s.transcribeModel)
  const language = useSettings((s) => s.transcribeLanguage)
  const setSettings = useSettings((s) => s.set)

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
      ? t('Preparing audio…')
      : progress.stage === 'loading'
        ? `${t('Loading model…')} ${progress.progress != null ? Math.round(progress.progress * 100) + '%' : ''}`
        : t('Transcribing…')

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
      // Only the first cue records an undo step; the rest join it, so the whole
      // transcription undoes at once and a long one can't flush the history.
      let first = true
      const cues = await transcribeClip(
        useEditor.getState().project,
        clip,
        setProgress,
        (cue) => {
          importSubtitles([cue], { recordHistory: first })
          first = false
          setCount((c) => c + 1)
        },
        () => cancelRef.current,
        { model, language }
      )
      setCount(cues.length)
      setStatus('done')
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') {
        setStatus('idle') // user stopped it; already-committed cues stay on the timeline
      } else {
        setError(e instanceof Error ? e.message : t('Transcription failed.'))
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
        <div className="modal-head">{t('AI Subtitles')}</div>
        <div className="modal-body">
          {!transcribable ? (
            <p className="modal-note">
              {t('Select an audio or video clip on the timeline first, then reopen this.')}
            </p>
          ) : (
            <>
              <p className="modal-note">
                {interpolateParts(
                  t(
                    'Transcribe {name} into subtitle clips using on-device speech recognition (Whisper) — no account or upload. Each model is downloaded once on first use; after that it works offline.'
                  ),
                  { name: <strong key="name">{media?.name}</strong> }
                )}
              </p>
              <div className="export-options">
                <label className="export-opt">
                  <span>{t('Spoken language')}</span>
                  <select
                    className="insp-select"
                    disabled={running}
                    value={language}
                    onChange={(e) => setSettings({ transcribeLanguage: e.target.value as TranscribeLanguage })}
                  >
                    {TRANSCRIBE_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {l === 'auto' ? t('Detect automatically') : LANGUAGE_NAMES[l]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="export-opt">
                  <span>{t('Model')}</span>
                  <select
                    className="insp-select"
                    disabled={running}
                    value={model}
                    onChange={(e) => setSettings({ transcribeModel: e.target.value as TranscribeModel })}
                  >
                    {TRANSCRIBE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {t(m.label)} (~{m.approxMb} MB)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="modal-note">
                {t('Pick the language spoken in the clip for the best results. "Accurate" is much better on non-English speech but slower.')}
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
                  {count === 1
                    ? t('Added {n} subtitle to the Subtitles track.', { n: count })
                    : t('Added {n} subtitles to the Subtitles track.', { n: count })}
                </p>
              )}
              {status === 'error' && error && <p className="modal-error">{error}</p>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={close}>
            {running ? t('Stop') : t('Close')}
          </button>
          {transcribable && status !== 'done' && (
            <button className="btn primary" onClick={run} disabled={running}>
              {status === 'error' ? t('Retry') : t('Transcribe')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
