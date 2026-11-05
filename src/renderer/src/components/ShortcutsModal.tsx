import { useEffect } from 'react'
import { create } from 'zustand'
import { useT } from '../lib/i18n'

// ---------------------------------------------------------------------------
// Keyboard shortcut reference. Opened with "?" or by clicking the timeline's
// hint line. Self-contained open state (it is pure UI, not project state); the
// global shortcut handler treats it like any modal via its .modal-backdrop.
// Keep the list in sync with useShortcuts() in App.tsx and the timeline's
// pointer gestures.
// ---------------------------------------------------------------------------

export const useShortcutsPanel = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

type Row = [keys: string[], what: string]

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: 'Playback',
    rows: [
      [['Space'], 'Play / pause'],
      [['J', 'K', 'L'], 'Shuttle reverse / stop / forward (press again for 2× and 4×)'],
      [['←', '→'], 'Step one frame'],
      [['Shift+←', 'Shift+→'], 'Step one second'],
      [['Home'], 'Go to start']
    ]
  },
  {
    title: 'Editing',
    rows: [
      [['S'], 'Split at the playhead'],
      [['Delete'], 'Remove the selected clips'],
      [['Shift+Delete'], 'Ripple delete (close the gap)'],
      [['X'], 'Crossfade with the neighbouring clip'],
      [['Ctrl+C', 'Ctrl+V'], 'Copy / paste at the playhead'],
      [['Ctrl+A'], 'Select all clips'],
      [['Esc'], 'Clear the selection'],
      [['Ctrl+Z'], 'Undo'],
      [['Ctrl+Shift+Z', 'Ctrl+Y'], 'Redo']
    ]
  },
  {
    title: 'Markers',
    rows: [
      [['M'], 'Add a marker at the playhead'],
      [[',', '.'], 'Jump to the previous / next marker']
    ]
  },
  {
    title: 'Timeline (mouse)',
    rows: [
      [['Wheel'], 'Scroll the timeline'],
      [['Ctrl+Wheel'], 'Zoom around the pointer'],
      [['Alt+Wheel'], 'Scroll the tracks'],
      [['Drag'], 'Move clips · drag a clip edge to trim'],
      [['Drag empty area'], 'Box-select clips'],
      [['Shift+Click'], 'Add to / remove from the selection'],
      [['Track header'], 'Drag to reorder · drag its bottom edge to resize · right-click for the menu']
    ]
  },
  {
    title: 'File',
    rows: [
      [['Ctrl+N'], 'New project'],
      [['Ctrl+O'], 'Open project'],
      [['Ctrl+S'], 'Save'],
      [['Ctrl+Shift+S'], 'Save As'],
      [['Ctrl+,'], 'Options'],
      [['?'], 'Show this list']
    ]
  }
]

/** Key labels that are words (translated); the rest are key caps (Space, Ctrl+Z…). */
const WORD_KEYS = new Set(['Wheel', 'Ctrl+Wheel', 'Alt+Wheel', 'Drag', 'Drag empty area', 'Shift+Click', 'Track header'])

/** Every translated string in the panel (for the i18n coverage test). */
export const SHORTCUT_STRINGS: string[] = [
  ...GROUPS.flatMap((g) => [g.title, ...g.rows.map((r) => r[1])]),
  ...WORD_KEYS
]

export default function ShortcutsModal() {
  const open = useShortcutsPanel((s) => s.open)
  const setOpen = useShortcutsPanel((s) => s.setOpen)
  const t = useT()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{t('Keyboard shortcuts')}</div>
        <div className="modal-body shortcuts-body">
          {GROUPS.map((g) => (
            <section key={g.title} className="shortcuts-group">
              <h4>{t(g.title)}</h4>
              {g.rows.map(([keys, what]) => (
                <div key={what} className="shortcuts-row">
                  <span className="shortcuts-keys">
                    {keys.map((k) => (
                      <kbd key={k}>{WORD_KEYS.has(k) ? t(k) : k}</kbd>
                    ))}
                  </span>
                  <span className="shortcuts-what">{t(what)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => setOpen(false)}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  )
}
