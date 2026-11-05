import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Pure helpers for timeline thumbnails ("filmstrips"). No electron imports, so
// they are unit-testable in plain Node. See thumbs.ts for the job runner.
// ---------------------------------------------------------------------------

/** Tile height in px (timeline lanes are 36–200 px; HiDPI-friendly). */
export const THUMB_HEIGHT = 90
export const MIN_TILES = 6
export const MAX_TILES = 40

/** Bump when the strip format changes so stale cache entries are ignored. */
const FORMAT = 'v1'

/** How many tiles a source of `durationSec` gets: about one per 2 s, clamped. */
export function tileCount(durationSec: number): number {
  if (!(durationSec > 0)) return MIN_TILES
  return Math.min(MAX_TILES, Math.max(MIN_TILES, Math.ceil(durationSec / 2)))
}

/** Source time of each tile: the middle of its equal share of the duration. */
export function tileTimes(durationSec: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count))
  const d = Math.max(0, durationSec)
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * d) / n)
}

/** Cache file name for a source (changes when the file does). */
export function thumbFileName(sourcePath: string, size: number, mtimeMs: number, count: number): string {
  const h = createHash('sha1')
  h.update(`${FORMAT}\n${sourcePath}\n${size}\n${Math.floor(mtimeMs)}\n${count}`)
  return `${h.digest('hex').slice(0, 32)}.jpg`
}

export function isThumbFileName(name: string): boolean {
  return /^[0-9a-f]{32}\.(jpg|partial)$/.test(name)
}

/**
 * One FFmpeg run that fast-seeks to every tile time (input-side -ss, one input
 * per tile) and hstacks the scaled frames into a single horizontal JPEG strip.
 * Input seeking keeps this cheap even on long files: only a few frames around
 * each seek point are decoded, never the whole video. FFmpeg auto-rotates
 * inputs, so phone clips come out upright.
 */
export function buildThumbStripArgs(sourcePath: string, outPath: string, times: number[]): string[] {
  const args = ['-y', '-v', 'error']
  for (const t of times) args.push('-ss', t.toFixed(3), '-i', sourcePath)
  const scaled = times.map((_, i) => `[${i}:v:0]scale=-2:${THUMB_HEIGHT},setsar=1[t${i}]`)
  const graph =
    times.length === 1
      ? `[0:v:0]scale=-2:${THUMB_HEIGHT},setsar=1[out]`
      : `${scaled.join(';')};${times.map((_, i) => `[t${i}]`).join('')}hstack=inputs=${times.length}[out]`
  args.push('-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', outPath)
  return args
}
