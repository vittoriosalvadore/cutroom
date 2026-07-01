import type { Project } from '../types'
import type { SubtitleCue } from '../state/store'

// ---------------------------------------------------------------------------
// SubRip (.srt) and WebVTT (.vtt) parsing/serialization. Kept dependency-free
// and pure so it is trivial to unit-test and reuse from an export pipeline.
// ---------------------------------------------------------------------------

/** Parse "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" / "MM:SS.mmm" (VTT) to seconds. */
function parseTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/)
  if (!m) return null
  const [, h, mm, ss, ms] = m
  const hours = h ? Number(h) : 0
  return hours * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000
}

/** Seconds -> "HH:MM:SS,mmm" for SRT output. */
function formatSrtTimestamp(sec: number): string {
  const t = Math.max(0, sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const ms = Math.round((t - Math.floor(t)) * 1000)
  const p = (n: number, len = 2): string => n.toString().padStart(len, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

/**
 * Parse SRT or VTT text into cues. Tolerant of CRLF, BOM, blank lines, the
 * "WEBVTT" header, and missing index numbers. Cue/position settings on VTT
 * timing lines are ignored (we only need timing + text).
 */
export function parseSubtitles(text: string): SubtitleCue[] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = clean.split(/\n{2,}/)
  const cues: SubtitleCue[] = []

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) continue
    if (/^WEBVTT/i.test(lines[0])) lines.shift()
    if (lines.length === 0) continue

    // The timing line contains "-->". A leading numeric index line is optional.
    let timingIdx = lines.findIndex((l) => l.includes('-->'))
    if (timingIdx === -1) continue
    const timing = lines[timingIdx]
    const arrow = timing.split('-->')
    if (arrow.length < 2) continue

    const startSec = parseTimestamp(arrow[0])
    // The end side may carry trailing VTT settings ("00:00:04.000 line:90%").
    const endSec = parseTimestamp(arrow[1].trim().split(/\s+/)[0])
    if (startSec === null || endSec === null) continue

    const content = lines.slice(timingIdx + 1).join('\n').trim()
    if (!content) continue
    cues.push({ startSec, endSec, text: content })
  }

  return cues
}

/** Serialize subtitle cues to SubRip (.srt) text. */
export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .slice()
    .sort((a, b) => a.startSec - b.startSec)
    .map((cue, i) => {
      const time = `${formatSrtTimestamp(cue.startSec)} --> ${formatSrtTimestamp(cue.endSec)}`
      return `${i + 1}\n${time}\n${cue.text}\n`
    })
    .join('\n')
}

/** Collect every subtitle-role clip in the project back into ordered cues. */
export function projectToCues(project: Project): SubtitleCue[] {
  return Object.values(project.clips)
    .filter((c) => c.role === 'subtitle' && c.text)
    .map((c) => ({
      startSec: c.startSec,
      endSec: c.startSec + c.durationSec,
      text: c.text?.content ?? ''
    }))
    .sort((a, b) => a.startSec - b.startSec)
}
