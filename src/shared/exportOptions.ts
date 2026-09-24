// ---------------------------------------------------------------------------
// Export presets: output format, resolution, quality mode and encoder choice.
// Pure (no electron / DOM / node imports) and shared by BOTH processes: the
// renderer uses it to build the Export modal and preview the output size, the
// main process uses the same functions to validate what the renderer sends
// (never trusting renderer-computed dimensions or encoder names).
// ---------------------------------------------------------------------------

// --- format ------------------------------------------------------------------

export type ExportFormat = 'mp4-h264' | 'mp4-hevc' | 'webm-vp9'
export type VideoCodec = 'h264' | 'hevc' | 'vp9'
export type Container = 'mp4' | 'webm'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['mp4-h264', 'mp4-hevc', 'webm-vp9']

export interface FormatInfo {
  codec: VideoCodec
  container: Container
  /** File extension (no dot) — the save dialog filter and temp file use it. */
  ext: Container
  /** Human label (untranslated: codec names). */
  label: string
  /** Short codec summary for the specs grid. */
  summary: string
}

export function formatInfo(f: ExportFormat): FormatInfo {
  switch (f) {
    case 'mp4-hevc':
      return { codec: 'hevc', container: 'mp4', ext: 'mp4', label: 'MP4 (HEVC/H.265)', summary: 'HEVC + AAC / MP4' }
    case 'webm-vp9':
      return { codec: 'vp9', container: 'webm', ext: 'webm', label: 'WebM (VP9 + Opus)', summary: 'VP9 + Opus / WebM' }
    default:
      return { codec: 'h264', container: 'mp4', ext: 'mp4', label: 'MP4 (H.264)', summary: 'H.264 + AAC / MP4' }
  }
}

// --- resolution --------------------------------------------------------------

export type ExportResolution = 'project' | '2160' | '1080' | '720' | '480' | 'vertical1080'

export const EXPORT_RESOLUTIONS: readonly ExportResolution[] = ['project', '2160', '1080', '720', '480', 'vertical1080']

/** Long side of the 16:9 box for each "Np" size (short side = N). */
const LONG_SIDE: Record<'2160' | '1080' | '720' | '480', number> = {
  '2160': 3840,
  '1080': 1920,
  '720': 1280,
  '480': 854
}

/** Largest output dimension we ever hand FFmpeg (HEVC/VP9 level limits). */
export const MAX_DIM = 8192

export function isVertical(width: number, height: number): boolean {
  return height > width
}

function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2)
}

/**
 * Output frame size for a resolution choice. "Np" sizes are a 16:9 box turned
 * to match the project's orientation (so a vertical project at 1080p renders
 * 1080 wide, not 608), and 'vertical1080' is the literal 1080×1920 box. The
 * project frame is scaled to FIT the box, keeping its aspect ratio, with even
 * dimensions (yuv420p requires them). 'project' keeps the project size, as
 * does 'vertical1080' on a non-vertical project (it is only offered for
 * vertical ones — a remembered choice must not squash a landscape export).
 */
export function outputSize(
  projectWidth: number,
  projectHeight: number,
  res: ExportResolution
): { width: number; height: number } {
  const w = projectWidth
  const h = projectHeight
  if (res === 'project' || !(w > 0) || !(h > 0)) return { width: w, height: h }
  if (res === 'vertical1080' && !isVertical(w, h)) return { width: w, height: h }
  let bw: number
  let bh: number
  if (res === 'vertical1080') {
    bw = 1080
    bh = 1920
  } else {
    const short = Number(res)
    const long = LONG_SIDE[res]
    ;[bw, bh] = isVertical(w, h) ? [short, long] : [long, short]
  }
  const scale = Math.min(bw / w, bh / h)
  return {
    width: Math.min(MAX_DIM, even(w * scale)),
    height: Math.min(MAX_DIM, even(h * scale))
  }
}

/** Resolutions offered for a project (the vertical box only for vertical projects). */
export function resolutionsFor(projectWidth: number, projectHeight: number): ExportResolution[] {
  return EXPORT_RESOLUTIONS.filter((r) => r !== 'vertical1080' || isVertical(projectWidth, projectHeight))
}

// --- quality -----------------------------------------------------------------

export type QualityMode = 'crf' | 'bitrate'

/** Target bitrates (Mbps) offered in bitrate mode. */
export const BITRATE_CHOICES: readonly number[] = [4, 8, 16, 40]

/** Bitrate bounds accepted anywhere (settings + main-side validation). */
export const MIN_MBPS = 1
export const MAX_MBPS = 200

// --- encoder -----------------------------------------------------------------

/** Encoder families: `auto` = first working hardware encoder, else software. */
export type EncoderChoice = 'auto' | 'software' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox'
export type HwFamily = Exclude<EncoderChoice, 'auto' | 'software'>

/** Probe / Auto preference order. */
export const HW_FAMILIES: readonly HwFamily[] = ['nvenc', 'qsv', 'amf', 'videotoolbox']
export const ENCODER_CHOICES: readonly EncoderChoice[] = ['auto', 'software', ...HW_FAMILIES]

export const HW_FAMILY_LABEL: Record<HwFamily, string> = {
  nvenc: 'NVIDIA NVENC',
  qsv: 'Intel Quick Sync',
  amf: 'AMD AMF',
  videotoolbox: 'Apple VideoToolbox'
}

/** Every hardware encoder we know how to drive (the probe tries these). */
export const HW_ENCODERS: readonly string[] = HW_FAMILIES.flatMap((f) => [`h264_${f}`, `hevc_${f}`])

/** Software encoder per codec. */
export function softwareEncoder(codec: VideoCodec): string {
  return codec === 'hevc' ? 'libx265' : codec === 'vp9' ? 'libvpx-vp9' : 'libx264'
}

/** Concrete hardware encoder name for a family + codec (none for VP9). */
export function hwEncoderName(family: HwFamily, codec: VideoCodec): string | null {
  return codec === 'vp9' ? null : `${codec}_${family}`
}

/** Families with at least one working encoder, in preference order. */
export function availableFamilies(working: readonly string[]): HwFamily[] {
  return HW_FAMILIES.filter((f) => working.includes(`h264_${f}`) || working.includes(`hevc_${f}`))
}

/**
 * Pick the concrete encoder for a format + choice given the probe's working
 * list. A hardware choice that doesn't work for this codec (not detected, or a
 * VP9 WebM) degrades to software rather than failing; Auto takes the first
 * working family in HW_FAMILIES order.
 */
export function resolveEncoder(
  format: ExportFormat,
  choice: EncoderChoice,
  working: readonly string[]
): { encoder: string; hardware: boolean } {
  const codec = formatInfo(format).codec
  const families: readonly HwFamily[] =
    choice === 'auto' ? HW_FAMILIES : choice === 'software' ? [] : [choice]
  for (const f of families) {
    const name = hwEncoderName(f, codec)
    if (name && working.includes(name)) return { encoder: name, hardware: true }
  }
  return { encoder: softwareEncoder(codec), hardware: false }
}

// --- named presets -----------------------------------------------------------

export interface ExportFields {
  format: ExportFormat
  resolution: ExportResolution
  qualityMode: QualityMode
  bitrateMbps: number
}

export interface NamedPreset extends ExportFields {
  id: string
  /** English label (translated via t() in the UI). */
  label: string
  /** Only offered for vertical projects. */
  verticalOnly?: boolean
}

export const NAMED_PRESETS: readonly NamedPreset[] = [
  { id: 'youtube1080', label: 'YouTube 1080p', format: 'mp4-h264', resolution: '1080', qualityMode: 'bitrate', bitrateMbps: 16 },
  {
    id: 'vertical',
    label: 'Vertical 1080×1920 (Reels/TikTok)',
    format: 'mp4-h264',
    resolution: 'vertical1080',
    qualityMode: 'bitrate',
    bitrateMbps: 8,
    verticalOnly: true
  },
  { id: 'master', label: 'High quality master', format: 'mp4-h264', resolution: 'project', qualityMode: 'bitrate', bitrateMbps: 40 },
  { id: 'small720', label: 'Small file 720p', format: 'mp4-hevc', resolution: '720', qualityMode: 'bitrate', bitrateMbps: 4 }
]

/** The named preset whose fields match exactly (undefined = "Custom"). */
export function matchPreset(fields: ExportFields): NamedPreset | undefined {
  return NAMED_PRESETS.find(
    (p) =>
      p.format === fields.format &&
      p.resolution === fields.resolution &&
      p.qualityMode === fields.qualityMode &&
      (p.qualityMode === 'crf' || p.bitrateMbps === fields.bitrateMbps)
  )
}
