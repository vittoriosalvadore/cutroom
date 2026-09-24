import {
  EXPORT_FORMATS,
  EXPORT_RESOLUTIONS,
  ENCODER_CHOICES,
  HW_ENCODERS,
  MAX_DIM,
  MAX_MBPS,
  MIN_MBPS,
  formatInfo,
  outputSize,
  resolveEncoder,
  type Container,
  type EncoderChoice,
  type ExportFormat,
  type ExportResolution
} from '../shared/exportOptions'

// ---------------------------------------------------------------------------
// Pure FFmpeg argument builder for export pass 1 (JPEG frames on stdin -> the
// encoded, still-silent video). No electron / fs / child_process imports, so
// it is unit-testable in plain Node — same pattern as muxArgs.ts.
//
// Everything the renderer sends is re-validated here (enums whitelisted,
// numbers clamped, output size recomputed from the resolution key) before it
// can reach an FFmpeg argument.
// ---------------------------------------------------------------------------

export const X264_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'
] as const
export type X264Preset = (typeof X264_PRESETS)[number]

export type Quality = { mode: 'crf'; crf: number } | { mode: 'bitrate'; mbps: number }

export interface VideoEncoderOptions {
  /** Concrete FFmpeg encoder name (libx264, hevc_nvenc, ...). */
  encoder: string
  /** x264-style speed preset; mapped onto each encoder's own scale. */
  preset: X264Preset
  quality: Quality
}

/** Clamp to an integer range. */
function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)))
}

/** Rank of an x264 preset: 0 (ultrafast) .. 8 (veryslow). */
function presetRank(p: X264Preset): number {
  const i = X264_PRESETS.indexOf(p)
  return i < 0 ? 5 : i
}

/** Bitrate-mode rate control shared by encoders that honour VBV (-maxrate/-bufsize). */
function vbvArgs(mbps: number): string[] {
  const kbps = Math.round(mbps * 1000)
  return ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`]
}

/**
 * Per-encoder `-c:v ...` args for a quality target. `crf` is always given on
 * the x264 scale (settings: 14 best .. 28 small) and translated per encoder:
 * x265 runs ~4 higher for the same look, VP9's 0..63 scale ~11 higher, NVENC
 * CQ / QSV ICQ / AMF QP roughly track x264, VideoToolbox's -q:v is 1..100
 * with HIGHER = better. HEVC outputs get the `hvc1` tag so QuickTime/Safari
 * play them.
 */
export function videoEncoderArgs(o: VideoEncoderOptions): string[] {
  const { encoder, preset, quality } = o
  const crf = quality.mode === 'crf' ? quality.crf : 20
  const hevc = encoder.startsWith('hevc_') || encoder === 'libx265'
  const tag = hevc ? ['-tag:v', 'hvc1'] : []
  const rank = presetRank(preset)

  if (encoder === 'libx264') {
    // Kept in the original argument order (the pre-presets export was exactly this).
    const rc = quality.mode === 'crf' ? ['-crf', String(clampInt(crf, 0, 51))] : vbvArgs(quality.mbps)
    return ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', preset, ...rc]
  }
  if (encoder === 'libx265') {
    const rc = quality.mode === 'crf' ? ['-crf', String(clampInt(crf + 4, 0, 51))] : vbvArgs(quality.mbps)
    return ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-preset', preset, ...rc, ...tag, '-x265-params', 'log-level=error']
  }
  if (encoder === 'libvpx-vp9') {
    // -deadline good + cpu-used 5 (fast) .. 0 (slow); row-mt parallelises.
    const cpuUsed = clampInt(5 - (rank * 5) / 8, 0, 5)
    const rc =
      quality.mode === 'crf'
        ? ['-crf', String(clampInt(crf + 11, 0, 63)), '-b:v', '0']
        : ['-b:v', `${Math.round(quality.mbps * 1000)}k`]
    return ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-deadline', 'good', '-cpu-used', String(cpuUsed), '-row-mt', '1', ...rc]
  }
  if (encoder.endsWith('_nvenc')) {
    // p1 (fastest) .. p7 (best quality).
    const p = `p${clampInt(1 + (rank * 6) / 8, 1, 7)}`
    const rc =
      quality.mode === 'crf'
        ? ['-rc', 'vbr', '-cq', String(clampInt(crf, 0, 51)), '-b:v', '0']
        : ['-rc', 'vbr', ...vbvArgs(quality.mbps)]
    return ['-c:v', encoder, '-pix_fmt', 'yuv420p', '-preset', p, ...rc, ...tag]
  }
  if (encoder.endsWith('_qsv')) {
    // QSV presets run veryfast..veryslow (no ultra/superfast).
    const qp = (['veryfast', 'veryfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const)[rank]
    const rc =
      quality.mode === 'crf' ? ['-global_quality', String(clampInt(crf, 1, 51))] : vbvArgs(quality.mbps)
    return ['-c:v', encoder, '-pix_fmt', 'nv12', '-preset', qp, ...rc, ...tag]
  }
  if (encoder.endsWith('_amf')) {
    const q = rank <= 2 ? 'speed' : rank <= 5 ? 'balanced' : 'quality'
    let rc: string[]
    if (quality.mode === 'crf') {
      const qpI = clampInt(crf, 0, 51)
      rc = ['-rc', 'cqp', '-qp_i', String(qpI), '-qp_p', String(clampInt(qpI + 2, 0, 51))]
      if (!hevc) rc.push('-qp_b', String(clampInt(qpI + 4, 0, 51))) // hevc_amf has no B-frames
    } else {
      rc = ['-rc', 'vbr_peak', ...vbvArgs(quality.mbps)]
    }
    return ['-c:v', encoder, '-pix_fmt', 'yuv420p', '-quality', q, ...rc, ...tag]
  }
  if (encoder.endsWith('_videotoolbox')) {
    // Constant quality: CRF 14 -> q 80, 20 -> 65, 28 -> 45.
    const rc =
      quality.mode === 'crf'
        ? ['-q:v', String(clampInt(115 - 2.5 * crf, 1, 100))]
        : ['-b:v', `${Math.round(quality.mbps * 1000)}k`]
    return ['-c:v', encoder, '-pix_fmt', 'yuv420p', ...rc, ...tag]
  }
  // Unknown name: never pass it through — fall back to x264.
  return videoEncoderArgs({ ...o, encoder: 'libx264' })
}

/** A fully validated pass-1 configuration (the output of resolveEncodeConfig). */
export interface EncodeConfig {
  fps: number
  outputPath: string
  container: Container
  /** Output frame size, or null to keep the project size (no scale filter). */
  scale: { width: number; height: number } | null
  encoder: string
  hardware: boolean
  preset: X264Preset
  quality: Quality
}

/** Raw start options as the renderer sends them (untrusted). */
export interface RawStartOptions {
  width?: unknown
  height?: unknown
  fps?: unknown
  outputPath?: unknown
  preset?: unknown
  crf?: unknown
  format?: unknown
  resolution?: unknown
  qualityMode?: unknown
  bitrateMbps?: unknown
  encoder?: unknown
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}
function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Validate the renderer's start options against the probe's working hardware
 * list. Returns null when a required field (output path, frame size) is
 * unusable. Omitted preset fields keep the original behaviour (x264, project
 * size, CRF), so an older caller still gets the pre-presets export.
 */
export function resolveEncodeConfig(raw: RawStartOptions, workingHw: readonly string[]): EncodeConfig | null {
  if (typeof raw.outputPath !== 'string' || !raw.outputPath || raw.outputPath.includes('\0')) return null
  if (!finite(raw.width) || !finite(raw.height)) return null
  const width = clampInt(raw.width, 2, MAX_DIM)
  const height = clampInt(raw.height, 2, MAX_DIM)
  const fps = finite(raw.fps) ? Math.max(1, Math.min(240, raw.fps)) : 30

  const format = oneOf<ExportFormat>(raw.format, EXPORT_FORMATS, 'mp4-h264')
  const resolution = oneOf<ExportResolution>(raw.resolution, EXPORT_RESOLUTIONS, 'project')
  const choice = oneOf<EncoderChoice>(raw.encoder, ENCODER_CHOICES, 'software')
  const preset = oneOf<X264Preset>(raw.preset, X264_PRESETS, 'medium')
  // Only encoders the probe verified may be picked, whatever the renderer claims.
  const working = workingHw.filter((e) => HW_ENCODERS.includes(e))
  const { encoder, hardware } = resolveEncoder(format, choice, working)

  const quality: Quality =
    raw.qualityMode === 'bitrate'
      ? { mode: 'bitrate', mbps: finite(raw.bitrateMbps) ? Math.max(MIN_MBPS, Math.min(MAX_MBPS, raw.bitrateMbps)) : 8 }
      : { mode: 'crf', crf: finite(raw.crf) ? clampInt(raw.crf, 0, 51) : 20 }

  const out = outputSize(width, height, resolution)
  const scale = out.width === width && out.height === height ? null : out

  return { fps, outputPath: raw.outputPath, container: formatInfo(format).container, scale, encoder, hardware, preset, quality }
}

/** JPEG (full-range BT.601) -> limited-range BT.709, inside the scale filter. */
const COLOR_CONVERT = 'in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709'
/** Stream colour tags matching COLOR_CONVERT (carried through the mux's -c:v copy). */
const COLOR_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']

/**
 * Full pass-1 argument list: JPEG frames on stdin (mjpeg image2pipe) -> the
 * chosen encoder, optionally Lanczos-scaled to the preset size (frames are
 * always rendered at project size, so the compositor never changes). The
 * container is forced with -f so it always matches the temp file's extension
 * (the no-audio path copies this file as the final output).
 */
export function buildEncodeArgs(c: EncodeConfig): string[] {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-c:v', 'mjpeg', // renderer sends JPEG frames (faster to encode than PNG)
    '-framerate', String(c.fps),
    '-i', 'pipe:0'
  ]
  // Colour: the canvas holds sRGB (BT.709 primaries), the JPEG carries it as
  // full-range BT.601 YCbCr (JFIF). Convert explicitly to limited-range BT.709
  // and tag the stream: an untagged HD file is decoded as BT.709 by players,
  // so the old implicit BT.601 output looked shifted/washed out (up to ~14
  // levels on saturated colours).
  // setsar=1 keeps pixels square: after even-rounding (853.3 -> 854) scale
  // would otherwise write a fractional SAR (853:854) to preserve the exact DAR.
  const size = c.scale ? `${c.scale.width}:${c.scale.height}:flags=lanczos:` : ''
  args.push('-vf', `scale=${size}${COLOR_CONVERT}${c.scale ? ',setsar=1' : ''}`)
  args.push(...videoEncoderArgs({ encoder: c.encoder, preset: c.preset, quality: c.quality }))
  args.push(...COLOR_TAGS)
  if (c.container === 'mp4') args.push('-movflags', '+faststart')
  args.push('-f', c.container, c.outputPath)
  return args
}

// --- hardware probe ----------------------------------------------------------

/** Encoder names from `ffmpeg -hide_banner -encoders` output. */
export function parseEncoderList(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    // " V....D libx264   libx264 H.264 ..." -> flags column then the name.
    const m = /^\s*[VAS][.A-Z]{5}\s+([A-Za-z0-9_][\w.-]*)/.exec(line)
    if (m) names.add(m[1])
  }
  return names
}

/**
 * A tiny real encode (0.1 s of a 256×256 colour source to the null muxer)
 * using the SAME per-encoder args the export would use — being listed by
 * `-encoders` only means FFmpeg was built with it, not that a GPU/driver is
 * present.
 */
export function buildProbeArgs(encoder: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=s=256x256:d=0.1',
    ...videoEncoderArgs({ encoder, preset: 'medium', quality: { mode: 'crf', crf: 20 } }),
    '-f', 'null',
    '-'
  ]
}
