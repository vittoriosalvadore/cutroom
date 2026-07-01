import { app, ipcMain } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// App settings persistence (main process).
//
// Settings live in userData/settings.json. The renderer owns the schema and
// defaults; the main process just durably reads/writes the blob (atomic write,
// like the project store) and reads ONE field synchronously at startup — the
// hardware-acceleration toggle, which must be applied before the app's GPU
// process spins up.
// ---------------------------------------------------------------------------

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Synchronous read for app startup (before `ready`). Returns parsed JSON or null. */
export function readSettingsSync(): Record<string, unknown> | null {
  try {
    const p = settingsPath()
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function registerSettingsIpc(): void {
  // Return the raw settings JSON (or null if never saved) for the renderer to merge.
  ipcMain.handle('settings:read', () => {
    try {
      const p = settingsPath()
      return existsSync(p) ? readFileSync(p, 'utf-8') : null
    } catch {
      return null
    }
  })

  // Atomic write (tmp + rename) so a crash mid-write never corrupts settings.
  ipcMain.handle('settings:write', (_e, json: string) => {
    try {
      const p = settingsPath()
      const tmp = `${p}.tmp`
      writeFileSync(tmp, json, 'utf-8')
      renameSync(tmp, p)
      return true
    } catch {
      return false
    }
  })
}
