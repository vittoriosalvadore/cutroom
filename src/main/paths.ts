import { basename, dirname, isAbsolute, resolve } from 'path'

// ---------------------------------------------------------------------------
// Pure path guards for anything the renderer (or a project file) hands to the
// main process. No electron imports, so they are unit-testable in plain Node.
// ---------------------------------------------------------------------------

/**
 * True for an absolute local file path. FFmpeg treats `http:`, `concat:`,
 * `subfile,` etc. as protocols, so a relative/URL-looking path from an
 * untrusted project file must never reach an `-i`. Absolute POSIX paths start
 * with `/` and absolute Windows paths with a drive letter or UNC prefix, none
 * of which FFmpeg parses as a protocol.
 */
export function isLocalFilePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0') && isAbsolute(p)
}

/** True when `p` is one of our own `cutroom-*` temp files directly inside `tmp`. */
export function isOwnTempFile(p: unknown, tmp: string): p is string {
  if (!isLocalFilePath(p)) return false
  const abs = resolve(p)
  return dirname(abs) === resolve(tmp) && basename(abs).startsWith('cutroom-')
}
