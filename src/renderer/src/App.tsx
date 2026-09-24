import { useEffect, useRef, useState } from 'react'
import { useEditor } from './state/store'
import { useSettings } from './state/settings'
import { probeAudio, probeImage, probeVideo } from './lib/probe'
import { ensureAudioDecoded } from './lib/audioCache'
import { serializeProject } from './lib/projectFile'
import { timelineDuration } from './lib/exporter'
import { createNewProject, openProject, saveProject } from './lib/projectIO'
import { useT } from './lib/i18n'
import { advancePlayhead, nextShuttleRate, playStartSec, SLIDER_KEYS, stepFrames } from './lib/transport'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import Transport from './components/Transport'
import Inspector from './components/Inspector'
import ExportModal from './components/ExportModal'
import RecoveryModal from './components/RecoveryModal'
import TranscribeModal from './components/TranscribeModal'
import SettingsModal from './components/SettingsModal'
import AutoReframeModal from './components/AutoReframeModal'
import AutoCutSilenceModal from './components/AutoCutSilenceModal'

/**
 * Drives the playhead while playing. Uses requestAnimationFrame and reads the
 * latest playhead + shuttle rate via getState() each tick to avoid stale-closure
 * drift (a J/K/L rate change mid-play doesn't restart the loop). Forward play
 * stops at the timeline end, reverse at 0; pressing play while parked at (or
 * past) the end restarts from 0 (lib/transport).
 */
function usePlaybackClock(): void {
  const isPlaying = useEditor((s) => s.isPlaying)
  const raf = useRef<number | null>(null)
  const last = useRef<number>(0)

  useEffect(() => {
    if (!isPlaying) return
    const st0 = useEditor.getState()
    const start = playStartSec(st0.playheadSec, st0.shuttleRate, timelineDuration(st0.project))
    if (start === null) {
      st0.setPlaying(false) // nothing to play
      return
    }
    if (start !== st0.playheadSec) st0.setPlayhead(start)
    last.current = performance.now()
    const tick = (now: number): void => {
      const dt = (now - last.current) / 1000
      last.current = now
      const st = useEditor.getState()
      const next = advancePlayhead(st.playheadSec, dt, st.shuttleRate, timelineDuration(st.project))
      st.setPlayhead(next.sec)
      if (next.stop) {
        st.setPlaying(false)
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [isPlaying])
}

/**
 * Reads real duration/resolution from newly imported media via the platform
 * decoders, so the bin shows correct lengths and clips inherit them on add.
 * Each item is probed once; failures are swallowed (unsupported codec, etc.).
 */
function useMediaProbe(): void {
  const media = useEditor((s) => s.project.media)
  const setMediaInfo = useEditor((s) => s.setMediaInfo)
  const probed = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const m of Object.values(media)) {
      if (!m.path || probed.current.has(m.id)) continue
      probed.current.add(m.id)
      if (m.kind === 'video') {
        probeVideo(m.path)
          .then((r) => setMediaInfo(m.id, r))
          .catch(() => undefined)
      } else if (m.kind === 'image') {
        probeImage(m.path)
          .then((r) => setMediaInfo(m.id, { width: r.width, height: r.height }))
          .catch(() => undefined)
      } else if (m.kind === 'audio') {
        probeAudio(m.path)
          .then((r) => {
            setMediaInfo(m.id, { durationSec: r.durationSec })
            // Start decode immediately after probe so the 2-step render-cycle lag
            // collapses to 1. Also ensures decode runs even when durationSec=0
            // (VBR mp3 without a Xing/VBRI header → a.duration=NaN in Chromium).
            ensureAudioDecoded(m.id, m.path, r.durationSec)
          })
          .catch(() => {
            // Probe failed entirely (bad codec, permission, etc.) — still attempt
            // decode; the file might be playable even if the <audio> element can't
            // read its metadata. Passes durationSec=0 so ensureAudioDecoded
            // skips the pre-check and uses the post-decode buffer.duration guard.
            ensureAudioDecoded(m.id, m.path, 0)
          })
      }
    }
  }, [media, setMediaInfo])
}

/**
 * Fallback: re-triggers ensureAudioDecoded from store state for any audio media
 * that already has a known durationSec (e.g. reopened project where the saved
 * JSON carries the probed value). useMediaProbe handles the normal fresh-import
 * path inline, making this a no-op in the common case (idempotent cache check).
 */
function useAudioProbe(): void {
  const media = useEditor((s) => s.project.media)
  useEffect(() => {
    for (const m of Object.values(media)) {
      if (m.kind === 'audio' && m.path && m.durationSec > 0) {
        ensureAudioDecoded(m.id, m.path, m.durationSec)
      }
    }
  }, [media])
}

/** Debounced autosave to the crash-recovery file whenever the project changes. */
function useAutosave(): void {
  useEffect(() => {
    let timer: number | undefined
    const flush = (): void => {
      const st = useEditor.getState()
      // Feed the in-memory rollback ring on the same tick as the disk autosave
      // (independent of the undo stack, so a corrupted past[] can't lose it).
      st.pushRollback()
      const json = serializeProject(st.project, { savedPath: st.projectFilePath, timestamp: Date.now() })
      void window.cutroom?.writeRecovery(json)
    }
    const unsub = useEditor.subscribe((state, prev) => {
      if (state.project === prev.project) return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(flush, 1000)
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      unsub()
    }
  }, [])
}

/**
 * Last-resort crash net BELOW React's ErrorBoundary: a throw outside React's
 * tree (or a promise rejection it didn't catch) still flags recovery pending,
 * so the next launch can offer recovered work. The boundary catches the rest.
 */
function useLastResortCrashNet(): void {
  useEffect(() => {
    const onError = (): void => {
      void window.cutroom?.markRecoveryPending()
      // Best-effort synchronous final flush before the page might die.
      try {
        const st = useEditor.getState()
        const json = serializeProject(st.project, { savedPath: st.projectFilePath, timestamp: Date.now() })
        void window.cutroom?.writeRecovery(json)
      } catch {
        /* if this throws too, we at least flagged pending above */
      }
    }
    const onRejection = (): void => {
      void window.cutroom?.markRecoveryPending()
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}

/** Reflect the project name and unsaved state in the window title. */
function useDocumentTitle(): void {
  const name = useEditor((s) => s.project.name)
  const dirty = useEditor((s) => s.project !== s.savedProject)
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${name} — Cutroom`
  }, [name, dirty])
}

/**
 * Prompt before the window closes/reloads with unsaved changes. The renderer
 * only vetoes the unload; the main process turns that veto into a native
 * confirm dialog via 'will-prevent-unload'. (A dev HMR full reload of a dirty
 * project prompts too, which is harmless.)
 */
function useUnsavedGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      const st = useEditor.getState()
      if (st.project === st.savedProject) return
      e.preventDefault()
      e.returnValue = '' // legacy requirement for Chromium to honour the veto
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}

// <input> types that take typed text — shortcuts must not steal their keys.
// Range/checkbox/color/radio/button inputs are deliberately NOT here: after
// dragging a slider focus stays on it, and Space/Ctrl+Z should still work.
const TEXT_INPUT_TYPES = new Set([
  'text',
  'number',
  'search',
  'email',
  'password',
  'url',
  'tel',
  'date',
  'datetime-local',
  'month',
  'time',
  'week'
])

/** True when keystrokes on `el` belong to a text-editing control. */
function isTextEditingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type)
  return el.isContentEditable
}

/** True while any modal dialog is up (store-driven or self-managed). */
function isModalOpen(): boolean {
  const st = useEditor.getState()
  if (st.exportOpen || st.transcribeOpen || st.settingsOpen || st.reframeOpen || st.autoCutSilenceOpen) return true
  // Self-managed modals (e.g. RecoveryModal) keep their open state locally;
  // every modal renders a .modal-backdrop, so the DOM is the catch-all.
  return document.querySelector('.modal-backdrop') !== null
}

/** Global keyboard shortcuts. Ignored while typing in a text control or while a modal is open. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTextEditingTarget(e.target) || isModalOpen()) return
      // A focused slider owns its navigation keys (←/→ nudge it, Home/End jump);
      // other shortcuts (Space, Ctrl+Z, S…) still apply after touching one.
      if (e.target instanceof HTMLInputElement && e.target.type === 'range' && SLIDER_KEYS.has(e.key)) return
      const st = useEditor.getState()
      const meta = e.ctrlKey || e.metaKey

      // Undo / redo.
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
        return
      }
      if (meta && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        st.redo()
        return
      }

      // Project file shortcuts.
      if (meta && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void saveProject(e.shiftKey) // Shift = Save As
        return
      }
      if (meta && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        void openProject()
        return
      }
      if (meta && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        createNewProject()
        return
      }
      if (meta && e.key === ',') {
        e.preventDefault()
        st.setSettingsOpen(true)
        return
      }
      if (meta && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        st.selectAllClips()
        return
      }
      if (meta && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        st.copySelectedClips()
        return
      }
      if (meta && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        st.pasteClips(st.playheadSec)
        return
      }
      if (meta) return // leave other Ctrl/Cmd combos alone

      if (e.code === 'Space') {
        e.preventDefault()
        st.setPlaying(!st.isPlaying)
      } else if (e.key === 'l' || e.key === 'L') {
        // L / J: shuttle forward / reverse; repeat presses double up to 4×.
        st.setShuttle(nextShuttleRate(st.shuttleRate, st.isPlaying, 1))
      } else if (e.key === 'j' || e.key === 'J') {
        st.setShuttle(nextShuttleRate(st.shuttleRate, st.isPlaying, -1))
      } else if (e.key === 'k' || e.key === 'K') {
        st.setPlaying(false)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Frame step (Shift = one second), always from a paused playhead.
        e.preventDefault()
        const dir = e.key === 'ArrowRight' ? 1 : -1
        const fps = st.project.fps
        const frames = e.shiftKey ? Math.max(1, Math.round(fps)) : 1
        if (st.isPlaying) st.setPlaying(false)
        st.setPlayhead(stepFrames(useEditor.getState().playheadSec, fps, dir * frames))
      } else if (e.key === 's' || e.key === 'S') {
        st.splitAtPlayhead()
      } else if (e.key === 'm' || e.key === 'M') {
        st.addMarker()
      } else if (e.key === ',') {
        st.jumpMarker(-1)
      } else if (e.key === '.') {
        st.jumpMarker(1)
      } else if (e.key === 'Escape') {
        st.clearSelection()
      } else if (e.key === 'x' || e.key === 'X') {
        if (st.selectedClipId) st.crossfadeWithNeighbor(st.selectedClipId)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selectedClipIds.size > 1) {
          if (e.shiftKey) st.rippleDeleteSelected()
          else st.removeSelectedClips()
        } else if (st.selectedClipId) {
          if (e.shiftKey) st.rippleDelete(st.selectedClipId)
          else st.removeClip(st.selectedClipId)
        } else if (st.selectedMarkerId) {
          st.removeMarker(st.selectedMarkerId)
        }
      } else if (e.key === 'Home') {
        st.setPlayhead(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

// Extensions accepted by the import dialog — kept in sync with main/index.ts.
const MEDIA_EXT = /\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|aac|flac|m4a|ogg|png|jpg|jpeg|gif|webp|bmp)$/i

export default function App() {
  usePlaybackClock()
  useShortcuts()
  useMediaProbe()
  useAudioProbe()
  useAutosave()
  useDocumentTitle()
  useLastResortCrashNet()
  useUnsavedGuard()
  const dirty = useEditor((s) => s.project !== s.savedProject)
  const setSettingsOpen = useEditor((s) => s.setSettingsOpen)
  const importMedia = useEditor((s) => s.importMedia)
  const t = useT()

  const [draggingOver, setDraggingOver] = useState(false)

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDraggingOver(true)
  }

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    // Only clear when the drag leaves the window entirely, not when moving
    // between child elements (relatedTarget is still inside currentTarget).
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDraggingOver(false)
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDraggingOver(false)
    // File.path was removed in Electron 32; resolve paths through the preload.
    const getPath = window.cutroom?.getPathForFile
    if (!getPath) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => getPath(f))
      .filter((p) => p && MEDIA_EXT.test(p))
    if (paths.length) importMedia(paths)
  }

  // Load persisted settings and apply the theme before first paint settles.
  useEffect(() => {
    void useSettings.getState().hydrate()
  }, [])

  // One-time bridge sanity check, surfaced in DevTools console.
  useEffect(() => {
    window.cutroom
      ?.ping()
      .then((r) => console.log('[cutroom] bridge:', r))
      .catch(() => console.warn('[cutroom] preload bridge not available'))
  }, [])

  return (
    <div
      className={`app${draggingOver ? ' drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          Cutroom<span className="badge">MVP</span>
        </div>
        <div className="filebar">
          <button className="btn small" title={`${t('New project')} (Ctrl+N)`} onClick={() => createNewProject()}>
            {t('New')}
          </button>
          <button className="btn small" title={`${t('Open project')} (Ctrl+O)`} onClick={() => void openProject()}>
            {t('Open')}
          </button>
          <button
            className={`btn small ${dirty ? 'active' : ''}`}
            title={`${t('Save')} (Ctrl+S) · ${t('Save As')} (Ctrl+Shift+S)`}
            onClick={() => void saveProject()}
          >
            {dirty ? `${t('Save')} •` : t('Save')}
          </button>
          <button
            className="btn small icon"
            title={`${t('Options')} (Ctrl+,)`}
            aria-label={t('Options')}
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>
        <Transport />
      </header>
      <main className="workspace">
        <MediaBin />
        <Preview />
        <Inspector />
      </main>
      <Timeline />
      <ExportModal />
      <RecoveryModal />
      <TranscribeModal />
      <SettingsModal />
      <AutoReframeModal />
      <AutoCutSilenceModal />
    </div>
  )
}
