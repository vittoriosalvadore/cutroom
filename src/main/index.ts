import { app, shell, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { extname, join } from 'path'
import { createReadStream } from 'fs'
import { readFile, stat, writeFile } from 'fs/promises'
import { Readable } from 'stream'
import { registerExportIpc } from './export'
import { registerAudioMuxIpc } from './audioMux'
import { clearSessionLock, initProjectStore, registerProjectIpc } from './projectStore'
import { readSettingsSync, registerSettingsIpc } from './settings'

// Keep the main process alive on unexpected errors rather than hard-crashing —
// the renderer autosaves to recovery, and a logged error beats a dead window.
process.on('uncaughtException', (err) => console.error('[cutroom] uncaughtException:', err))
process.on('unhandledRejection', (reason) => console.error('[cutroom] unhandledRejection:', reason))

// Honor the hardware-acceleration preference BEFORE the GPU process starts. This
// must run before app `ready`, so it sits at module load (userData is available
// this early). Default on; only an explicit `false` disables it.
try {
  if (readSettingsSync()?.hardwareAcceleration === false) app.disableHardwareAcceleration()
} catch {
  /* keep acceleration on if settings can't be read */
}

// ---------------------------------------------------------------------------
// Custom media protocol. The renderer is served from http://localhost (dev) or
// file:// (prod), so it cannot load arbitrary `file:///C:/...` paths directly.
// We expose a privileged `cutroom://` scheme that streams a requested file from
// disk, letting <img>/<video> read user media safely without disabling
// webSecurity. Must be declared BEFORE app `ready`.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cutroom',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg'
}

/**
 * Serve a local file for `cutroom://media/?path=<abs path>`, honoring HTTP Range
 * requests. <video> seeks by asking for byte ranges, so partial-content (206)
 * support is what makes scrubbing video work without buffering the whole file.
 */
async function serveMedia(request: Request): Promise<Response> {
  try {
    const filePath = new URL(request.url).searchParams.get('path')
    if (!filePath) return new Response('missing path', { status: 400 })

    const info = await stat(filePath)
    const size = info.size
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const rangeHeader = request.headers.get('range')

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = match && match[1] ? parseInt(match[1], 10) : 0
      let end = match && match[2] ? parseInt(match[2], 10) : size - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= size) end = size - 1
      if (start > end) {
        start = 0
        end = size - 1
      }
      const body = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          // Keep media CORS-clean so <video> audio can feed MediaElementSource.
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

// ---------------------------------------------------------------------------
// Main process: owns the OS window, native dialogs, and (in later phases) the
// FFmpeg sidecar. It must never touch the DOM. The renderer talks to it only
// through the typed bridge defined in src/preload/index.ts.
// ---------------------------------------------------------------------------

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#15151a',
    title: 'Cutroom',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // contextIsolation keeps renderer code from reaching Node directly; the
      // preload bridge is the only door. sandbox:false lets the preload use
      // CommonJS require, which electron-vite emits.
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Open target="_blank" / external links in the user's real browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    // Dev: load Vite's dev server for hot module replacement.
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // Prod: load the bundled renderer from disk.
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // Serve user media files to the renderer over cutroom://media/?path=<abs path>.
  protocol.handle('cutroom', (request) => serveMedia(request))

  // Liveness check used by the renderer on boot to confirm the bridge is wired.
  ipcMain.handle('app:ping', () => 'pong')

  // Import a subtitle file (.srt/.vtt). Returns its raw text, or null if cancelled.
  ipcMain.handle('dialog:openSubtitle', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import subtitles',
      properties: ['openFile'],
      filters: [
        { name: 'Subtitles', extensions: ['srt', 'vtt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return readFile(result.filePaths[0], 'utf-8')
  })

  // Export subtitle text to an .srt file. Returns true if written.
  ipcMain.handle('dialog:saveSubtitle', async (_event, content: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Export subtitles (SRT)',
      defaultPath: 'subtitles.srt',
      filters: [{ name: 'SubRip', extensions: ['srt'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content, 'utf-8')
    return true
  })

  // Video export over FFmpeg (frame streaming) + the audio mux pass.
  registerExportIpc()
  registerAudioMuxIpc()

  // Project save/load + crash recovery.
  registerProjectIpc()

  // App settings (theme, decoding, export, visual options) persistence.
  registerSettingsIpc()

  // Native "Import media" picker. Returns absolute file paths (or [] if cancelled).
  // Probing duration/resolution with ffprobe comes in Phase 2.
  ipcMain.handle('dialog:openMedia', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Media',
          extensions: [
            'mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi',
            'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg',
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'
          ]
        },
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] },
        { name: 'Audio', extensions: ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })
}

app.whenReady().then(() => {
  initProjectStore() // detect a prior crash + mark this session active
  registerIpc()
  createWindow()

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Removing the session lock here records a clean shutdown, so the next launch
// won't offer recovery. A crash/kill skips this, leaving the lock as the signal.
app.on('will-quit', () => clearSessionLock())

app.on('window-all-closed', () => {
  // macOS apps typically stay alive until the user quits explicitly.
  if (process.platform !== 'darwin') app.quit()
})
