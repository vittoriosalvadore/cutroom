import type { Project } from '../types'
import { Compositor } from './compositor'

// ---------------------------------------------------------------------------
// "Save frame": render the timeline at one instant at full project size and
// return it as PNG. Uses its own offscreen compositor built exactly like the
// exporter's (original media, never proxies, preview quality ignored), so the
// still is pixel-identical to that frame of an export.
// ---------------------------------------------------------------------------

export async function captureFramePng(project: Project, timeSec: number): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas')
  canvas.width = project.width
  canvas.height = project.height
  const comp = new Compositor(canvas, () => undefined, { preserveDrawingBuffer: true })
  try {
    await comp.preload(project)
    await comp.renderExact(project, Math.max(0, timeSec))
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode the frame.')
    return await blob.arrayBuffer()
  } finally {
    comp.dispose()
  }
}

/** Default file name for a still: "<project> 00m12s.png". */
export function frameFileName(projectName: string, timeSec: number): string {
  const t = Math.max(0, Math.floor(timeSec))
  const mm = String(Math.floor(t / 60)).padStart(2, '0')
  const ss = String(t % 60).padStart(2, '0')
  const base = (projectName || 'frame').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'frame'
  return `${base} ${mm}m${ss}s.png`
}
