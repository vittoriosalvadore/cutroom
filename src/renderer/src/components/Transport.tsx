import { useEditor } from '../state/store'
import { parseSubtitles, projectToCues, toSrt } from '../lib/subtitles'
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
      <button className="btn" title="Go to start (Home)" onClick={() => setPlayhead(0)}>
        ⏮
      </button>
      <button
        className="btn primary"
        title="Play / Pause (Space)"
        onClick={() => setPlaying(!isPlaying)}
      >
        {isPlaying ? '⏸ Pause' : '▶ Play'}
      </button>
      <button className="btn" title="Split clips at playhead (S)" onClick={() => splitAtPlayhead()}>
        ✂ Split
      </button>
      <button className="btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}>
        ⟲
      </button>
      <button className="btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => redo()}>
        ⟳
      </button>
      <span className="tdivider" />
      <button className="btn" title="Add a title at the playhead" onClick={() => addTitle(playhead)}>
        T Title
      </button>
      <button className="btn" title="Import subtitles (.srt / .vtt)" onClick={onImportSrt}>
        ⬇ SRT
      </button>
      <button className="btn" title="Export subtitles to .srt" onClick={onExportSrt}>
        ⬆ SRT
      </button>
      <button
        className="btn"
        title="Auto-generate subtitles from the selected clip's audio (on-device Whisper)"
        onClick={() => setTranscribeOpen(true)}
      >
        ✨ AI Subs
      </button>
      <button
        className="btn"
        title="Detect and ripple-delete quiet ranges in the selected clip's audio"
        onClick={() => setAutoCutSilenceOpen(true)}
      >
        🔇 Cut Silence
      </button>
      <div className="timecode">{timecode(playhead, fps)}</div>
      <div className="spacer" />
      <Meter />
      <button className="btn primary" title="Export the timeline to a video file" onClick={() => setExportOpen(true)}>
        ⤓ Export
      </button>
      <label className="zoom">
        Zoom
        <input
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
