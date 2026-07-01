import { app, dialog, ipcMain } from 'electron'
import { existsSync, unlinkSync, writeFileSync } from 'fs'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

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

let recoveryFile = ''
let sessionLock = ''
let pendingFile = ''
let previousCrash = false

/** Call once after app `ready`, before windows open. */
export function initProjectStore(): void {
  const dir = app.getPath('userData')
  recoveryFile = join(dir, 'recovery.json')
  sessionLock = join(dir, 'session.lock')
  pendingFile = join(dir, 'recovery.pending')

  previousCrash = existsSync(sessionLock)
  try {
    writeFileSync(sessionLock, String(Date.now()))
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

  // Autosave the recovery snapshot (silent, no dialog).
  ipcMain.handle('project:writeRecovery', async (_e, json: string) => {
    try {
      await writeAtomic(recoveryFile, json)
      return true
    } catch {
      return false
    }
  })

  // The renderer error boundary flags a renderer crash.
  ipcMain.handle('project:markRecoveryPending', async () => {
    try {
      await writeFile(pendingFile, '1', 'utf-8')
      return true
    } catch {
      return false
    }
  })

  // On launch the renderer asks whether to offer recovery.
  ipcMain.handle('project:checkRecovery', async () => {
    try {
      if (!recoveryFile || !existsSync(recoveryFile)) return { available: false }
      if (!previousCrash && !existsSync(pendingFile)) return { available: false }
      const json = await readFile(recoveryFile, 'utf-8')
      let savedPath: string | null = null
      let timestamp = 0
      try {
        const d = JSON.parse(json)
        savedPath = typeof d?.savedPath === 'string' ? d.savedPath : null
        timestamp = typeof d?.timestamp === 'number' ? d.timestamp : 0
      } catch {
        /* still offer the raw json */
      }
      return { available: true, json, savedPath, timestamp }
    } catch {
      return { available: false }
    }
  })

  // User recovered or discarded — don't offer again this session.
  ipcMain.handle('project:clearRecovery', async () => {
    try {
      if (existsSync(pendingFile)) await unlink(pendingFile)
    } catch {
      /* non-fatal */
    }
    previousCrash = false
    return true
  })
}
