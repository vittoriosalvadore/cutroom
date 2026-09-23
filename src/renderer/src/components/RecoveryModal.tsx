import { useEffect, useState } from 'react'
import { useEditor } from '../state/store'
import { deserializeProject } from '../lib/projectFile'

// On launch, asks the main process whether the last session crashed with
// autosaved work. If so, offers to restore it.

interface RecoveryInfo {
  json: string
  savedPath: string | null
  timestamp: number
  fromBackup: boolean
}

export default function RecoveryModal() {
  const [info, setInfo] = useState<RecoveryInfo | null>(null)
  const loadProject = useEditor((s) => s.loadProject)

  useEffect(() => {
    let active = true
    window.cutroom
      ?.checkRecovery()
      .then((r) => {
        if (active && r.available && r.json) {
          setInfo({
            json: r.json,
            savedPath: r.savedPath ?? null,
            timestamp: r.timestamp ?? 0,
            fromBackup: !!r.fromBackup
          })
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  if (!info) return null

  const when = info.timestamp ? new Date(info.timestamp).toLocaleString() : 'an earlier session'

  const recover = (): void => {
    const parsed = deserializeProject(info.json)
    // Clear first so the autosave that follows the load re-seeds recovery with
    // the restored project rather than racing the clear.
    void window.cutroom?.clearRecovery()
    // Recovered work was never saved: keep it dirty so closing still prompts.
    if (parsed.ok) loadProject(parsed.project, info.savedPath, { dirty: true })
    else window.alert('The recovered file was unreadable.')
    setInfo(null)
  }

  const discard = (): void => {
    void window.cutroom?.clearRecovery()
    setInfo(null)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">Recover your work?</div>
        <div className="modal-body">
          <p className="modal-note">
            Cutroom didn&apos;t close cleanly last time. There is autosaved work from {when}.
            {info.savedPath ? ` It was based on ${info.savedPath}.` : ''}
            {info.fromBackup && ' The latest snapshot was damaged, so this is a slightly older backup.'}
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={discard}>
            Discard
          </button>
          <button className="btn primary" onClick={recover}>
            Recover
          </button>
        </div>
      </div>
    </div>
  )
}
