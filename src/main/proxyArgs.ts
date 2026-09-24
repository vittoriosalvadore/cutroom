import { createHash } from 'crypto'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Pure helpers for proxy (optimized preview media) generation: cache naming,
// the FFmpeg command line, progress parsing and the duration sanity check. No
// electron imports, so all of it is unit-testable in plain Node.
// ---------------------------------------------------------------------------

/** The proxy's shorter side (px). 720 keeps a 1080p/4K picture readable in
 *  the monitor while decoding at a fraction of the cost. */
export const PROXY_SHORT_SIDE = 720

/** Frames between keyframes. A short GOP bounds every seek to <= 15 decodes,
 *  which is what makes scrubbing a proxy fast (long-GOP camera files can need
 *  hundreds). */
export const PROXY_GOP = 15

/**
 * Cache file name for a source. Keyed by the absolute path AND its size +
 * mtime, so an edited/replaced source gets a fresh proxy instead of a stale
 * one, while an untouched file maps to the same proxy across restarts.
 */
export function proxyFileName(sourcePath: string, size: number, mtimeMs: number): string {
  const h = createHash('sha1')
    .update(`${resolve(sourcePath)}\0${size}\0${Math.floor(mtimeMs)}`)
    .digest('hex')
    .slice(0, 32)
  return `${h}.mp4`
}

/** Name of the in-progress file for a proxy (renamed into place on success,
 *  so a half-written proxy is never mistaken for a finished one). */
export function partialName(fileName: string): string {
  return fileName.replace(/\.mp4$/, '.partial')
}

/** True for a finished proxy name (32 hex + .mp4) — the only files the cache
 *  size / clear touch besides partials. */
export function isProxyFileName(name: string): boolean {
  return /^[0-9a-f]{32}\.(mp4|partial)$/.test(name)
}

/**
 * FFmpeg arguments for a proxy. Choices:
 *  - scale the SHORTER side down to 720 (never up; even dims for yuv420p).
 *    FFmpeg auto-rotates before the filter chain and drops the display
 *    matrix, so rotation is baked in and iw/ih are the upright size — the
 *    preview must NOT rotate the proxy again (it carries no matrix).
 *  - `-fps_mode passthrough`: every source frame keeps its timestamp (no
 *    dup/drop, VFR preserved), so source time t maps 1:1 onto the proxy.
 *  - H.264 veryfast, `-tune fastdecode`, no B-frames, GOP 15: cheap to decode
 *    and to seek, not archival quality (export never reads the proxy).
 *  - AAC audio kept (the preview falls back to the element's audio for very
 *    long files), faststart for instant open.
 *  - `-progress pipe:1` streams key=value progress on stdout.
 */
export function buildProxyArgs(sourcePath: string, outPath: string): string[] {
  const s = PROXY_SHORT_SIDE
  const scale =
    `scale='if(gte(iw,ih),-2,trunc(min(${s},iw)/2)*2)'` +
    `:'if(gte(iw,ih),trunc(min(${s},ih)/2)*2,-2)':flags=bicubic`
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-nostats',
    '-progress', 'pipe:1',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `${scale},format=yuv420p`,
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'fastdecode',
    '-crf', '23',
    '-g', String(PROXY_GOP),
    '-keyint_min', String(PROXY_GOP),
    '-sc_threshold', '0',
    '-bf', '0',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    // The output name ends in .partial, so the muxer must be named.
    '-f', 'mp4',
    outPath
  ]
}

/** Seconds from FFmpeg's first "Duration: HH:MM:SS.xx" line, or 0. */
export function parseDurationLine(stderr: string): number {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/**
 * Latest encoded position (seconds) in a `-progress` stdout chunk, or null.
 * Prefers `out_time_us` (microseconds); `out_time_ms` is ALSO microseconds in
 * FFmpeg despite its name, and `N/A` (before the first packet) is skipped.
 */
export function parseProgressTime(chunk: string): number | null {
  let last: number | null = null
  for (const m of chunk.matchAll(/^out_time_(?:us|ms)=(\d+)\s*$/gm)) last = Number(m[1]) / 1e6
  return last
}

/** Progress fraction 0..1 (clamped); 0 while the duration is unknown. */
export function progressFraction(timeSec: number, durationSec: number): number {
  if (!(durationSec > 0) || !(timeSec > 0)) return 0
  return Math.min(1, timeSec / durationSec)
}

/**
 * Proxy and source must run the same length for source times to map 1:1.
 * Re-encoding the audio adds up to ~2 AAC frames of padding (~43 ms at 48k),
 * so allow the larger of 150 ms or 0.5 %. Unknown (0) durations pass: we
 * can't prove a mismatch.
 */
export function durationsMatch(sourceSec: number, proxySec: number): boolean {
  if (!(sourceSec > 0) || !(proxySec > 0)) return true
  return Math.abs(sourceSec - proxySec) <= Math.max(0.15, sourceSec * 0.005)
}
