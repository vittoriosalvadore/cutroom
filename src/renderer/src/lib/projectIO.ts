import { useEditor } from '../state/store'
import { deserializeProject, serializeProject } from './projectFile'

// ---------------------------------------------------------------------------
// Imperative project IO, callable from shortcuts and toolbar buttons. Talks to
// the main process for the actual file dialogs/writes and updates the store.
// ---------------------------------------------------------------------------

/** Save to the current file, or prompt for one. `forceDialog` => Save As. */
export async function saveProject(forceDialog = false): Promise<boolean> {
  const st = useEditor.getState()
  const json = serializeProject(st.project)
  const filePath = forceDialog ? null : st.projectFilePath
  const res = await window.cutroom.saveProject({ filePath, json })
  if (res.ok && res.filePath) {
    useEditor.getState().markSaved(res.filePath)
    return true
  }
  return false
}

export async function openProject(): Promise<void> {
  const st = useEditor.getState()
  const isDirty = st.project !== st.savedProject
  if (isDirty && !window.confirm('Discard unsaved changes and open another project?')) return

  const res = await window.cutroom.openProject()
  if (!res.ok || res.json == null) return
  const parsed = deserializeProject(res.json)
  if (!parsed.ok) {
    window.alert(`Could not open project: ${parsed.error}`)
    return
  }
  useEditor.getState().loadProject(parsed.project, res.filePath ?? null)
}

export function createNewProject(): void {
  const st = useEditor.getState()
  const isDirty = st.project !== st.savedProject
  if (isDirty && !window.confirm('Discard unsaved changes and start a new project?')) return
  useEditor.getState().newProject()
}
