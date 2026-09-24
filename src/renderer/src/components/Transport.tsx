import { useEditor } from '../state/store'
import { parseSubtitles, projectToCues, toSrt } from '../lib/subtitles'
import { useT } from '../lib/i18n'
import { formatShuttleRate } from '../lib/transport'
import Meter from './Meter'

/** SMPTE-ish timecode HH:MM:SS:FF (frames assume the project fps). */
function timecode(sec: number, fps: number): string {
  const s = Math.max(0, sec)
  const p = (n: number, len = 2): string => Math.floor(n).toString().padStart(len, '0')
  const frames = Math.floor((s % 1) * fps)
  return `${p(s / 3600)}:${p((s % 3600) / 60)}:${p(s % 60)}:${p(frames)}`
}

export default function Transport() {
  const isPlaying = useEditor((s) => s.isPlaying)
  const shuttleRate = useEditor((s) => s.shuttleRate)
  const playhead = useEditor((s) => s.playheadSec)
  const fps = useEditor((s) => s.project.fps)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const setPlaying = useEditor((s) => s.setPlaying)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead)
  const setZoom = useEditor((s) => s.setZoom)
  const addTitle = useEditor((s) => s.addTitle)
  const importSubtitles = useEditor((s) => s.importSubtitles)
  const setExportOpen = useEditor((s) => s.setExportOpen)
  const setTranscribeOpen = useEditor((s) => s.setTranscribeOpen)
  const setAutoCutSilenceOpen = useEditor((s) => s.setAutoCutSilenceOpen)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const t = useT()
  const shuttleLabel = isPlaying ? formatShuttleRate(shuttleRate) : ''

  const onImportSrt = async (): Promise<void> => {
    const content = await window.cutroom.openSubtitle()
    if (!content) return
    const cues = parseSubtitles(content)
    if (cues.length) importSubtitles(cues)
  }

  const onExportSrt = async (): Promise<void> => {
    const cues = projectToCues(useEditor.getState().project)
    if (cues.length === 0) return
    await window.cutroom.saveSubtitle(toSrt(cues))
  }

  return (
    <div className="transport">
      <button className="btn" title={t('Go to start (Home)')} onClick={() => setPlayhead(0)}>
        ⏮
      </button>
      <button
        className="btn primary"
        title={t('Play / Pause (Space) · Shuttle J/K/L · Frame step ←/→ (Shift = 1 s)')}
        onClick={() => setPlaying(!isPlaying)}
      >
        {isPlaying ? `⏸ ${t('Pause')}` : `▶ ${t('Play')}`}
      </button>
      {shuttleLabel && (
        <span className="shuttle-rate" title={t('Shuttle speed (J/K/L)')}>
          {shuttleLabel}
        </span>
      )}
      <button
        className="btn"
        title={t('Split clips at playhead (S)')}
        aria-label={t('Split')}
        onClick={() => splitAtPlayhead()}
      >
        ✂ <span className="lbl">{t('Split')}</span>
      </button>
      <button className="btn" title={`${t('Undo')} (Ctrl+Z)`} disabled={!canUndo} onClick={() => undo()}>
        ⟲
      </button>
      <button className="btn" title={`${t('Redo')} (Ctrl+Shift+Z)`} disabled={!canRedo} onClick={() => redo()}>
        ⟳
      </button>
      <span className="tdivider" />
      <button
        className="btn"
        title={t('Add a title at the playhead')}
        aria-label={t('Title')}
        onClick={() => addTitle(playhead)}
      >
        T <span className="lbl">{t('Title')}</span>
      </button>
      <button className="btn" title={t('Import subtitles (.srt / .vtt)')} onClick={onImportSrt}>
        ⬇<span className="lbl-srt"> SRT</span>
      </button>
      <button className="btn" title={t('Export subtitles to .srt')} onClick={onExportSrt}>
        ⬆<span className="lbl-srt"> SRT</span>
      </button>
      <button
        className="btn"
        title={t("Auto-generate subtitles from the selected clip's audio (on-device Whisper)")}
        aria-label={t('AI Subs')}
        onClick={() => setTranscribeOpen(true)}
      >
        ✨ <span className="lbl">{t('AI Subs')}</span>
      </button>
      <button
        className="btn"
        title={t("Detect and ripple-delete quiet ranges in the selected clip's audio")}
        aria-label={t('Cut Silence')}
        onClick={() => setAutoCutSilenceOpen(true)}
      >
        🔇 <span className="lbl">{t('Cut Silence')}</span>
      </button>
      <div className="timecode">{timecode(playhead, fps)}</div>
      <div className="spacer" />
      <Meter />
      <button className="btn primary" title={t('Export the timeline to a video file')} onClick={() => setExportOpen(true)}>
        ⤓ {t('Export')}
      </button>
      <label className="zoom" title={t('Zoom')}>
        <span className="lbl">{t('Zoom')}</span>
        <input
          aria-label={t('Zoom')}
          type="range"
          min={10}
          max={400}
          value={pxPerSec}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </label>
    </div>
  )
}
