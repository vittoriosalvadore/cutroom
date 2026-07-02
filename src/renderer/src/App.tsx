import { useEffect, useRef, useState } from 'react'
import { useEditor } from './state/store'
import { useSettings } from './state/settings'
import { probeAudio, probeImage, probeVideo } from './lib/probe'
import { ensureAudioDecoded } from './lib/audioCache'
import { serializeProject } from './lib/projectFile'
import { createNewProject, openProject, saveProject } from './lib/projectIO'
import { useT } from './lib/i18n'
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
 * latest playhead via getState() each tick to avoid stale-closure drift.
 */
function usePlaybackClock(): void {
  const isPlaying = useEditor((s) => s.isPlaying)
  const raf = useRef<number | null>(null)
  const last = useRef<number>(0)

  useEffect(() => {
    if (!isPlaying) return
    last.current = performance.now()
    const tick = (now: number): void => {
      const dt = (now - last.current) / 1000
      last.current = now
      const st = useEditor.getState()
      st.setPlayhead(st.playheadSec + dt)
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

/** Global keyboard shortcuts. Ignored while typing in an input. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
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
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path: string }).path)
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
          <button className="btn small" title="New project (Ctrl+N)" onClick={() => createNewProject()}>
            {t('New')}
          </button>
          <button className="btn small" title="Open project (Ctrl+O)" onClick={() => void openProject()}>
            {t('Open')}
          </button>
          <button
            className={`btn small ${dirty ? 'active' : ''}`}
            title="Save (Ctrl+S) · Save As (Ctrl+Shift+S)"
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
