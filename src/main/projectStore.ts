import { app, dialog, ipcMain } from 'electron'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { writeRing, findNewestValid, clearRing } from './recoveryRing'

// ---------------------------------------------------------------------------
// Project file IO + crash recovery (main process).
//
// Barriers against losing edits:
//  • atomic writes (write .tmp then rename) so a crash mid-write never corrupts
//    an existing project or the recovery file.
//  • a session.lock written on launch and removed on clean quit. If it is still
//    present next launch, the previous session crashed.
//  • recovery.json, autosaved by the renderer, holds the latest project.
//  • recovery.pending, written by the renderer's error boundary, flags a
//    renderer crash even when the process itself kept running.
// ---------------------------------------------------------------------------

let recoveryDir = ''
let recoveryFile = ''
let sessionLock = ''
let pendingFile = ''
let previousCrash = false

/** Call once after app `ready`, before windows open. */
export function initProjectStore(): void {
  recoveryDir = app.getPath('userData')
  recoveryFile = join(recoveryDir, 'recovery.json')
  sessionLock = join(recoveryDir, 'session.lock')
  pendingFile = join(recoveryDir, 'recovery.pending')

  previousCrash = existsSync(sessionLock)
  try {
    writeFileSync(sessionLock, String(Date.now()))
  } catch {
    /* non-fatal */
  }
}

/** Write the recovery.pending flag so the next launch offers recovery. */
export async function flagRecoveryPending(): Promise<void> {
  if (!pendingFile) return
  try {
    await writeFile(pendingFile, '1', 'utf-8')
  } catch {
    /* non-fatal */
  }
}

/** Remove the session lock to record a clean shutdown. Call on will-quit. */
export function clearSessionLock(): void {
  try {
    if (existsSync(sessionLock)) unlinkSync(sessionLock)
  } catch {
    /* non-fatal */
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, data, 'utf-8')
  await rename(tmp, path)
}

export function registerProjectIpc(): void {
  // Save (to a given path, or prompt). Returns the path written.
  ipcMain.handle('project:save', async (_e, args: { filePath: string | null; json: string }) => {
    try {
      let filePath = args.filePath
      if (!filePath) {
        const r = await dialog.showSaveDialog({
          title: 'Save project',
          defaultPath: 'project.cutroom.json',
          filters: [{ name: 'Cutroom Project', extensions: ['json'] }]
        })
        if (r.canceled || !r.filePath) return { ok: false, canceled: true }
        filePath = r.filePath
      }
      await writeAtomic(filePath, args.json)
      return { ok: true, filePath }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Save failed.' }
    }
  })

  // Open: prompt, read, return raw text for the renderer to validate.
  ipcMain.handle('project:open', async () => {
    try {
      const r = await dialog.showOpenDialog({
        title: 'Open project',
        properties: ['openFile'],
        filters: [
          { name: 'Cutroom Project', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
      const json = await readFile(r.filePaths[0], 'utf-8')
      return { ok: true, filePath: r.filePaths[0], json }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Open failed.' }
    }
  })

  // Autosave the recovery snapshot into the rotating ring (silent, no dialog).
  ipcMain.handle('project:writeRecovery', async (_e, json: string) => {
    try {
      await writeRing(recoveryDir, json)
      return true
    } catch {
      return false
    }
  })

  // The renderer error boundary (or the main crash wiring) flags a crash.
  ipcMain.handle('project:markRecoveryPending', async () => {
    await flagRecoveryPending()
    return true
  })

  // On launch the renderer asks whether to offer recovery. If the primary
  // recovery file is missing/corrupt, walk the backup ring to the newest valid
  // snapshot so a single bad write can't lose everything.
  ipcMain.handle('project:checkRecovery', async () => {
    try {
      if (!recoveryDir || !existsSync(recoveryFile)) return { available: false }
      if (!previousCrash && !existsSync(pendingFile)) return { available: false }

      const validate = (
        raw: string
      ): { json: string; savedPath: string | null; timestamp: number; backup: boolean } | null => {
        try {
          const d = JSON.parse(raw)
          const savedPath = typeof d?.savedPath === 'string' ? d.savedPath : null
          const timestamp = typeof d?.timestamp === 'number' ? d.timestamp : 0
          return { json: raw, savedPath, timestamp, backup: false }
        } catch {
          return null
        }
      }
      // First try the primary.
      let found = validate(await readFile(recoveryFile, 'utf-8').catch(() => ''))
      // Walk the ring on corrupt primary.
      if (!found) {
        found = await findNewestValid(recoveryDir, (raw) => {
          const v = validate(raw)
          if (v) v.backup = true
          return v
        })
      }
      if (!found) return { available: false }
      return {
        available: true,
        json: found.json,
        savedPath: found.savedPath,
        timestamp: found.timestamp,
        fromBackup: found.backup
      }
    } catch {
      return { available: false }
    }
  })

  // User recovered or discarded — don't offer again this session. Also clear
  // the backup ring so a discarded session isn't offered next launch.
  ipcMain.handle('project:clearRecovery', async () => {
    try {
      if (existsSync(pendingFile)) await unlink(pendingFile)
      if (recoveryDir) await clearRing(recoveryDir)
    } catch {
      /* non-fatal */
    }
    previousCrash = false
    return true
  })

  // On explicit Save (Ctrl+S), a saved project needs no recovery offer: clear
  // the ring + pending flag without touching the session lock. Distinct from
  // clearRecovery (which also discards a *crashed* session's offer).
  ipcMain.handle('project:clearRecoveryRing', async () => {
    try {
      if (existsSync(pendingFile)) await unlink(pendingFile)
      if (recoveryDir) await clearRing(recoveryDir)
    } catch {
      /* non-fatal */
    }
    return true
  })
}
