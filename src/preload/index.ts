import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { EncoderChoice, ExportFormat, ExportResolution, QualityMode } from '../shared/exportOptions'

/** Settings for a video export. Main re-validates every field. */
export interface ExportStartOptions {
  /** Project (render) size; the output size is derived from `resolution` in main. */
  width: number
  height: number
  fps: number
  outputPath: string
  /** x264 speed/quality preset (default 'medium'); mapped per encoder. */
  preset?: string
  /** x264-scale constant rate factor; lower = higher quality (default 20). */
  crf?: number
  /** Container + codec (default MP4 H.264). */
  format?: ExportFormat
  /** Output size preset (default: project size). */
  resolution?: ExportResolution
  /** CRF (quality) or a target bitrate. */
  qualityMode?: QualityMode
  bitrateMbps?: number
  /** Encoder family (default software). */
  encoder?: EncoderChoice
}

/** Result of an export IPC call. */
export interface ExportResult {
  ok: boolean
  error?: string
}

/** export:start also reports which encoder actually runs. */
export interface ExportStartResult extends ExportResult {
  encoder?: string
  hardware?: boolean
}

/** Result of an AI noise-removal (denoise) pass on a source file. */
export interface DenoiseResult {
  ok: boolean
  /** Path to the denoised temp WAV, present only when ok. */
  tempPath?: string
  error?: string
}

/** Result of a proxy (optimized preview media) job. */
export interface ProxyResult {
  ok: boolean
  /** The proxy file in the userData cache, present only when ok. */
  proxyPath?: string
  cancelled?: boolean
  error?: string
}

/** Live status of a queued/running proxy job (pushed from main). */
export interface ProxyProgress {
  sourcePath: string
  state: 'queued' | 'running'
  /** 0..1 */
  progress: number
}

// NOTE: these gate/duck shapes are hand-duplicated from renderer types.ts
// (TrackGate/TrackDuck) because preload shares no imports with the renderer.
// Keep them in sync if the renderer shapes change.
/** Resolved per-track gate for the export filtergraph (present only when on). */
export interface AudioPlanGate {
  thresholdDb: number
  rangeDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}
/** Resolved per-track ducker for the export filtergraph (present only when valid). */
export interface AudioPlanDuck {
  triggerTrackId: string
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}
/** Per-track 3-band EQ for the export filtergraph (present only when enabled). */
export interface AudioPlanEQ {
  lowDb: number
  midDb: number
  highDb: number
}
/** Per-track compressor for the export filtergraph (present only when enabled). */
export interface AudioPlanComp {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  makeupDb: number
}

/**
 * Per-track convolution reverb for the export (present only when enabled with
 * a non-zero mix). Main clamps every field and generates the impulse response
 * from decay / pre-delay / tone with the same code as the preview.
 */
export interface AudioPlanReverb {
  /** Wet amount 0..1. */
  mix: number
  decaySec: number
  preDelayMs: number
  /** 0 = dark .. 1 = bright. */
  tone: number
}

/** One audible clip in the export plan (positions/gains for the mux filtergraph). */
export interface AudioClipPlanEntry {
  path: string
  startSec: number
  durationSec: number
  inSec: number
  volume: number
  fadeInSec: number
  fadeOutSec: number
  trackGainDb: number
  pan: number
  /** Playback speed (1 = normal). */
  speed: number
  /** Owning track id — used to group clips into per-track submixes for gate/duck. */
  trackId: string
  /** Present only when the track's gate is enabled. */
  gate?: AudioPlanGate
  /** Present only when ducking resolves to a valid trigger. */
  duck?: AudioPlanDuck
  /** Present only when the track's EQ is enabled. */
  eq?: AudioPlanEQ
  /** Present only when the track's compressor is enabled. */
  comp?: AudioPlanComp
  /** Present only when the track's reverb is enabled (mix > 0). */
  reverb?: AudioPlanReverb
  /** True when the preview plays this clip via its <video> element tap (no
   *  track panner): the export then up-mixes a mono source at unity too. */
  directTap?: boolean
}

/** Inputs for the export audio-mux pass. */
export interface MuxAudioOptions {
  silentPath: string
  outputPath: string
  sampleRate: number
  clips: AudioClipPlanEntry[]
  /** Length of the exported video in seconds (caps the padded soundtrack). */
  durationSec?: number
}

/** Result of saving a project. */
export interface SaveResult {
  ok: boolean
  filePath?: string
  canceled?: boolean
  error?: string
}

/** Result of opening a project. */
export interface OpenResult {
  ok: boolean
  filePath?: string
  json?: string
  canceled?: boolean
  error?: string
}

/** Recovery availability reported on launch. */
export interface RecoveryResult {
  available: boolean
  json?: string
  savedPath?: string | null
  timestamp?: number
  /** True when the primary recovery file was corrupt/missing and the offered
   *  snapshot came from a backup slot in the ring. */
  fromBackup?: boolean
}

// The single, typed surface the renderer is allowed to call. Anything the UI
// needs from the OS/Node side gets one explicit method here — no raw ipcRenderer
// and no Node globals leak into the page.
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  /** Absolute filesystem path of a dropped/picked File (replaces the removed
   *  File.path, gone since Electron 32). Empty string when it has none. */
  getPathForFile: (f: File): string => webUtils.getPathForFile(f),
  /** Opens the native file picker and resolves to selected absolute paths. */
  openMedia: (): Promise<string[]> => ipcRenderer.invoke('dialog:openMedia'),
  /** Opens a subtitle file and resolves to its raw text, or null if cancelled. */
  openSubtitle: (): Promise<string | null> => ipcRenderer.invoke('dialog:openSubtitle'),
  /** Saves SRT text to a user-chosen file. Resolves true if written. */
  saveSubtitle: (content: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:saveSubtitle', content),

  // --- video export ---
  /** Native save dialog for the output (.mp4 / .webm per format). Resolves the path, or null. */
  saveVideo: (format?: ExportFormat): Promise<string | null> => ipcRenderer.invoke('dialog:saveVideo', format),
  /** Working hardware encoders (probed once in main; [] = software only). */
  hwEncoders: (): Promise<string[]> => ipcRenderer.invoke('export:hwEncoders'),
  /** Spawn the FFmpeg encoder for a new export. */
  exportStart: (opts: ExportStartOptions): Promise<ExportStartResult> =>
    ipcRenderer.invoke('export:start', opts),
  /** Stream one PNG frame (backpressured). */
  exportFrame: (data: ArrayBuffer): Promise<ExportResult> =>
    ipcRenderer.invoke('export:frame', data),
  /** Close the input stream and wait for FFmpeg to finish muxing. */
  exportFinish: (): Promise<ExportResult> => ipcRenderer.invoke('export:finish'),
  /** Abort the current export and kill FFmpeg. */
  exportCancel: (): Promise<ExportResult> => ipcRenderer.invoke('export:cancel'),
  /** A fresh temp path for the silent (pass-1) video, with the container's extension. */
  exportTempVideoPath: (ext?: 'mp4' | 'webm'): Promise<string> => ipcRenderer.invoke('export:tempVideoPath', ext),
  /** Pass 2: mix the timeline audio and mux it into the silent video. */
  muxAudio: (opts: MuxAudioOptions): Promise<ExportResult> => ipcRenderer.invoke('export:muxAudio', opts),
  /** Delete a leftover temp silent video after a cancelled/failed export. */
  discardTemp: (path: string): Promise<boolean> => ipcRenderer.invoke('export:discardTemp', path),

  // --- AI noise removal ---
  /** Run FFmpeg's arnndn filter on a source file; resolves a temp WAV path. */
  denoiseStart: (sourcePath: string): Promise<DenoiseResult> => ipcRenderer.invoke('denoise:start', sourcePath),
  /** Light mono copy of a video's audio, used only for audio-scrub grains. */
  scrubAudioStart: (sourcePath: string): Promise<DenoiseResult> => ipcRenderer.invoke('scrubAudio:start', sourcePath),

  // --- proxies (optimized preview media) ---
  /** Finished proxies for these sources (null = none). Never creates one. */
  proxyLookup: (paths: string[]): Promise<Record<string, string | null>> => ipcRenderer.invoke('proxy:lookup', paths),
  /** Queue a proxy transcode (one runs at a time); resolves when it finishes. */
  proxyCreate: (sourcePath: string, durationSec: number): Promise<ProxyResult> =>
    ipcRenderer.invoke('proxy:create', sourcePath, durationSec),
  /** Cancel a queued/running proxy job (its partial file is deleted). */
  proxyCancel: (sourcePath: string): Promise<boolean> => ipcRenderer.invoke('proxy:cancel', sourcePath),
  /** Size of the proxy cache on disk. */
  proxyCacheInfo: (): Promise<{ bytes: number; files: number }> => ipcRenderer.invoke('proxy:cacheInfo'),
  /** Cancel every job and delete every cached proxy. `failed` = files still in use. */
  proxyClearCache: (): Promise<{ ok: boolean; failed: number }> => ipcRenderer.invoke('proxy:clearCache'),
  /** Subscribe to proxy job progress. Returns an unsubscribe function. */
  onProxyProgress: (cb: (p: ProxyProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: ProxyProgress): void => cb(p)
    ipcRenderer.on('proxy:progress', listener)
    return () => {
      ipcRenderer.removeListener('proxy:progress', listener)
    }
  },

  // --- project save / load + recovery ---
  /** Save project JSON to `filePath`, or prompt when null. */
  saveProject: (args: { filePath: string | null; json: string }): Promise<SaveResult> =>
    ipcRenderer.invoke('project:save', args),
  /** Prompt for and read a project file. */
  openProject: (): Promise<OpenResult> => ipcRenderer.invoke('project:open'),
  /** Autosave the recovery snapshot (silent). */
  writeRecovery: (json: string): Promise<boolean> => ipcRenderer.invoke('project:writeRecovery', json),
  /** Flag a renderer crash so the next launch offers recovery. */
  markRecoveryPending: (): Promise<boolean> => ipcRenderer.invoke('project:markRecoveryPending'),
  /** Ask whether autosaved work should be offered for recovery. */
  checkRecovery: (): Promise<RecoveryResult> => ipcRenderer.invoke('project:checkRecovery'),
  /** Dismiss the recovery offer for this session. */
  clearRecovery: (): Promise<boolean> => ipcRenderer.invoke('project:clearRecovery'),
  /** Clear the recovery ring + pending flag (called on explicit Save). */
  clearRecoveryRing: (): Promise<boolean> => ipcRenderer.invoke('project:clearRecoveryRing'),

  // --- app settings ---
  /** Read the persisted settings JSON (or null if never saved). */
  readSettings: (): Promise<string | null> => ipcRenderer.invoke('settings:read'),
  /** Persist the settings JSON (atomic write). */
  writeSettings: (json: string): Promise<boolean> => ipcRenderer.invoke('settings:write', json)
}

export type CutroomApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('cutroom', api)
  } catch (error) {
    console.error('Failed to expose Cutroom bridge:', error)
  }
} else {
  // Fallback for the (non-default) case where context isolation is off.
  // @ts-ignore - augmenting window in a non-isolated world
  window.cutroom = api
}
