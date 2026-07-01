import type { Project } from '../types'
import type { AudioClipPlanEntry } from '../../../preload'
import { Compositor } from './compositor'
import { resolveDuck } from '../state/selectors'
import { useSettings } from '../state/settings'

// ---------------------------------------------------------------------------
// Export driver (renderer side). Two passes:
//   1. Render the timeline frame-by-frame with the preview compositor, stream
//      PNGs to FFmpeg -> a SILENT temp MP4 (WYSIWYG: it is the preview pipeline).
//   2. Build the audible-clip plan and have the main process mux a mixed
//      soundtrack into that video, writing the user's chosen file.
// ---------------------------------------------------------------------------

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'encoding' | 'muxing' | 'done'
  frame?: number
  totalFrames?: number
}

/** Collect the audible clips (audio + video sources, minus muted tracks). */
function buildAudioPlan(project: Project): AudioClipPlanEntry[] {
  const trackById = new Map(project.tracks.map((t) => [t.id, t]))
  const plan: AudioClipPlanEntry[] = []
  for (const clip of Object.values(project.clips)) {
    if (!clip.mediaId || clip.role === 'title' || clip.role === 'subtitle') continue
    const media = project.media[clip.mediaId]
    if (!media || !media.path || media.kind === 'image') continue
    const track = trackById.get(clip.trackId)
    if (!track || track.muted) continue
    const gate =
      track.kind === 'audio' && track.gate?.enabled
        ? {
            thresholdDb: track.gate.thresholdDb,
            rangeDb: track.gate.rangeDb,
            ratio: track.gate.ratio,
            attackMs: track.gate.attackMs,
            releaseMs: track.gate.releaseMs
          }
        : undefined
    const resolved = resolveDuck(track, project.tracks)
    const duck =
      resolved && resolved.triggerTrackId
        ? {
            triggerTrackId: resolved.triggerTrackId,
            thresholdDb: resolved.thresholdDb,
            ratio: resolved.ratio,
            attackMs: resolved.attackMs,
            releaseMs: resolved.releaseMs
          }
        : undefined
    const eq =
      track.kind === 'audio' && track.eq?.enabled
        ? { lowDb: track.eq.lowDb, midDb: track.eq.midDb, highDb: track.eq.highDb }
        : undefined
    const comp =
      track.kind === 'audio' && track.comp?.enabled
        ? {
            thresholdDb: track.comp.thresholdDb,
            ratio: track.comp.ratio,
            attackMs: track.comp.attackMs,
            releaseMs: track.comp.releaseMs,
            makeupDb: track.comp.makeupDb
          }
        : undefined
    plan.push({
      path: media.path,
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      inSec: clip.inSec,
      volume: clip.volume ?? 1,
      fadeInSec: clip.fadeInSec ?? 0,
      fadeOutSec: clip.fadeOutSec ?? 0,
      trackGainDb: track.audioGain ?? 0,
      // Pan applies to audio tracks only (video-track audio keeps centre).
      pan: track.kind === 'audio' ? track.pan ?? 0 : 0,
      speed: clip.speed ?? 1,
      trackId: track.id,
      gate,
      duck,
      eq,
      comp
    })
  }
  return plan
}

/** Timeline length = the end of the last clip. */
export function timelineDuration(project: Project): number {
  let end = 0
  for (const clip of Object.values(project.clips)) {
    end = Math.max(end, clip.startSec + clip.durationSec)
  }
  return end
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Frame capture failed (toBlob returned null)'))
          return
        }
        blob.arrayBuffer().then(resolve, reject)
      },
      'image/jpeg',
      0.97
    )
  })
}

/**
 * Returns a cheap integer hash of the rendered canvas content by drawing it
 * to a 32×18 thumbnail and sampling all pixels. Used to detect identical
 * frames and skip re-encoding (huge win for static-image timelines).
 */
function frameHash(src: HTMLCanvasElement, thumb: HTMLCanvasElement): number {
  const ctx = thumb.getContext('2d')!
  ctx.drawImage(src, 0, 0, thumb.width, thumb.height)
  const d = ctx.getImageData(0, 0, thumb.width, thumb.height).data
  let h = 0
  for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) & 0x7fffffff
  return h
}

/**
 * Run a full export. Returns when the file is written (ok:true) or on
 * error/cancel. `shouldCancel` is polled each frame.
 */
export async function exportTimeline(
  project: Project,
  outputPath: string,
  onProgress: (p: ExportProgress) => void,
  shouldCancel: () => boolean
): Promise<{ ok: boolean; error?: string }> {
  const duration = timelineDuration(project)
  if (duration <= 0) return { ok: false, error: 'Timeline is empty — add a clip first.' }

  const fps = project.fps
  const totalFrames = Math.max(1, Math.round(duration * fps))

  const canvas = document.createElement('canvas')
  canvas.width = project.width
  canvas.height = project.height

  let comp: Compositor
  try {
    comp = new Compositor(canvas, () => undefined, { preserveDrawingBuffer: true })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'WebGL initialization failed' }
  }

  // The pass-1 silent file is normally consumed (deleted) by muxAudio. On any
  // other exit — cancel, frame failure, encode failure, exception — we delete it
  // here so temp MP4s don't accumulate.
  let silentPath = ''
  const discardTemp = async (): Promise<void> => {
    if (silentPath) {
      await window.cutroom.discardTemp(silentPath).catch(() => undefined)
      silentPath = ''
    }
  }

  try {
    onProgress({ phase: 'preparing' })
    await comp.preload(project)

    // Pass 1: render the silent video to a temp file.
    silentPath = await window.cutroom.exportTempVideoPath()
    const settings = useSettings.getState()
    const started = await window.cutroom.exportStart({
      width: project.width,
      height: project.height,
      fps,
      outputPath: silentPath,
      preset: settings.exportPreset,
      crf: settings.exportCrf
    })
    if (!started.ok) {
      await discardTemp()
      return { ok: false, error: started.error ?? 'Could not start FFmpeg.' }
    }

    // 32×18 thumbnail canvas used for frame-change detection (< 2 KB of pixels).
    // drawImage from the WebGL canvas to a 2D context is GPU-accelerated and
    // costs ~1 ms — much cheaper than a full PNG/JPEG encode.
    const thumb = document.createElement('canvas')
    thumb.width = 32
    thumb.height = 18
    let lastHash = -1
    let lastJpeg: ArrayBuffer | null = null

    for (let i = 0; i < totalFrames; i++) {
      if (shouldCancel()) {
        await window.cutroom.exportCancel()
        await discardTemp()
        return { ok: false, error: 'Export cancelled.' }
      }
      await comp.renderExact(project, i / fps)

      // Skip re-encoding if the rendered output is identical to the previous frame.
      // This gives a massive speedup for static-image timelines (all frames equal).
      const hash = frameHash(canvas, thumb)
      let jpeg: ArrayBuffer
      if (hash === lastHash && lastJpeg !== null) {
        jpeg = lastJpeg
      } else {
        jpeg = await canvasToJpeg(canvas)
        lastHash = hash
        lastJpeg = jpeg
      }

      const wrote = await window.cutroom.exportFrame(jpeg)
      if (!wrote.ok) {
        await window.cutroom.exportCancel()
        await discardTemp()
        return { ok: false, error: wrote.error ?? 'Failed while writing a frame.' }
      }
      onProgress({ phase: 'rendering', frame: i + 1, totalFrames })
    }

    onProgress({ phase: 'encoding' })
    const finished = await window.cutroom.exportFinish()
    if (!finished.ok) {
      await discardTemp()
      return finished
    }

    // Pass 2: mux the mixed audio into the silent video at the user's path.
    onProgress({ phase: 'muxing' })
    const mux = await window.cutroom.muxAudio({
      silentPath,
      outputPath,
      sampleRate: project.sampleRate,
      clips: buildAudioPlan(project)
    })
    if (!mux.ok) {
      await discardTemp() // covers mux guard-returns that don't delete the temp
      return mux
    }
    silentPath = '' // consumed by a successful mux

    onProgress({ phase: 'done', frame: totalFrames, totalFrames })
    return { ok: true }
  } catch (e) {
    await window.cutroom.exportCancel().catch(() => undefined)
    await discardTemp()
    return { ok: false, error: e instanceof Error ? e.message : 'Export failed.' }
  } finally {
    comp.dispose()
  }
}
