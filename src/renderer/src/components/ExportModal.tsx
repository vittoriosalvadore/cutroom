import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { useT } from '../lib/i18n'
import { exportTimeline, timelineDuration, type ExportProgress } from '../lib/exporter'
import {
  BITRATE_CHOICES,
  EXPORT_FORMATS,
  HW_FAMILY_LABEL,
  NAMED_PRESETS,
  availableFamilies,
  formatInfo,
  isVertical,
  matchPreset,
  outputSize,
  resolutionsFor,
  resolveEncoder,
  softwareEncoder,
  type EncoderChoice,
  type ExportFormat,
  type ExportResolution
} from '../../../shared/exportOptions'

type Status = 'idle' | 'running' | 'done' | 'error'

// Hardware encoder probe result, shared across modal opens (main caches too).
let hwCache: string[] | null = null

export default function ExportModal() {
  const open = useEditor((s) => s.exportOpen)
  const setOpen = useEditor((s) => s.setExportOpen)
  const project = useEditor((s) => s.project)
  const settings = useSettings()
  const t = useT()

  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<ExportProgress>({ phase: 'preparing' })
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [hw, setHw] = useState<string[] | null>(hwCache)
  const cancelRef = useRef(false)

  // Ask main which hardware encoders actually work (first call runs the probe).
  useEffect(() => {
    if (!open || hwCache) return
    let alive = true
    window.cutroom
      .hwEncoders()
      .catch(() => [] as string[])
      .then((list) => {
        hwCache = list
        if (alive) setHw(list)
      })
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const duration = timelineDuration(project)
  const totalFrames = Math.max(1, Math.round(duration * project.fps))
  const running = status === 'running'
  const locked = running || !settings.hydrated

  // --- preset fields (all remembered in settings) ---
  const vertical = isVertical(project.width, project.height)
  const resolutions = resolutionsFor(project.width, project.height)
  // A remembered vertical choice on a landscape project falls back to project size.
  const resolution: ExportResolution = resolutions.includes(settings.exportResolution)
    ? settings.exportResolution
    : 'project'
  const out = outputSize(project.width, project.height, resolution)
  const fields = {
    format: settings.exportFormat,
    resolution,
    qualityMode: settings.exportQualityMode,
    bitrateMbps: settings.exportBitrateMbps
  }
  const presets = NAMED_PRESETS.filter((p) => !p.verticalOnly || vertical)
  const activePreset = matchPreset(fields)
  const info = formatInfo(settings.exportFormat)
  const families = availableFamilies(hw ?? [])
  const encoderChoice: EncoderChoice =
    settings.exportEncoder === 'auto' || settings.exportEncoder === 'software' || families.includes(settings.exportEncoder)
      ? settings.exportEncoder
      : 'auto'
  // What will actually run (main re-resolves identically from the same probe).
  const resolved = resolveEncoder(settings.exportFormat, encoderChoice, hw ?? [])

  const resLabel = (r: ExportResolution): string => {
    const s = outputSize(project.width, project.height, r)
    const dims = `${s.width}×${s.height}`
    if (r === 'project') return `${t('Project')} (${dims})`
    if (r === 'vertical1080') return `${dims} (${t('vertical')})`
    return `${r}p (${dims})`
  }
  const bitrates = BITRATE_CHOICES.includes(settings.exportBitrateMbps)
    ? BITRATE_CHOICES
    : [...BITRATE_CHOICES, settings.exportBitrateMbps].sort((a, b) => a - b)
  const qualityValue = settings.exportQualityMode === 'crf' ? 'crf' : `b${settings.exportBitrateMbps}`

  const pct =
    progress.phase === 'rendering' && progress.totalFrames && progress.frame
      ? Math.round((progress.frame / progress.totalFrames) * 100)
      : progress.phase === 'encoding' || progress.phase === 'muxing' || progress.phase === 'done'
        ? 100
        : 0

  const phaseLabel =
    progress.phase === 'preparing'
      ? t('Loading media…')
      : progress.phase === 'rendering'
        ? `${t('Rendering frame')} ${progress.frame} / ${progress.totalFrames} (${pct}%)`
        : progress.phase === 'encoding'
          ? t('Encoding video…')
          : progress.phase === 'muxing'
            ? t('Mixing & adding audio…')
            : t('Done')

  const start = async (): Promise<void> => {
    const outputPath = await window.cutroom.saveVideo(settings.exportFormat)
    if (!outputPath) return
    cancelRef.current = false
    setError(null)
    setWarning(null)
    setSavedPath(null)
    setProgress({ phase: 'preparing' })
    setStatus('running')

    const result = await exportTimeline(project, outputPath, setProgress, () => cancelRef.current)

    if (result.ok) {
      setSavedPath(outputPath)
      setWarning(result.warning ?? null)
      setStatus('done')
    } else if (result.error === 'Export cancelled.') {
      setStatus('idle')
    } else {
      setError(result.error ?? 'Export failed.')
      setStatus('error')
    }
  }

  const close = (): void => {
    if (running) return
    setStatus('idle')
    setError(null)
    setWarning(null)
    setOpen(false)
  }

  const applyPreset = (id: string): void => {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    settings.set({
      exportFormat: p.format,
      exportResolution: p.resolution,
      exportQualityMode: p.qualityMode,
      exportBitrateMbps: p.bitrateMbps
    })
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{t('Export video')}</div>
        <div className="modal-body">
          <div className="export-options">
            <label className="export-opt export-opt-wide">
              <span>{t('Preset')}</span>
              <select
                className="insp-select"
                disabled={locked}
                value={activePreset?.id ?? ''}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="">{t('Custom')}</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(p.label)}
                  </option>
                ))}
              </select>
            </label>
            <label className="export-opt">
              <span>{t('Format')}</span>
              <select
                className="insp-select"
                disabled={locked}
                value={settings.exportFormat}
                onChange={(e) => settings.set({ exportFormat: e.target.value as ExportFormat })}
              >
                {EXPORT_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {formatInfo(f).label}
                  </option>
                ))}
              </select>
            </label>
            <label className="export-opt">
              <span>{t('Resolution')}</span>
              <select
                className="insp-select"
                disabled={locked}
                value={resolution}
                onChange={(e) => settings.set({ exportResolution: e.target.value as ExportResolution })}
              >
                {resolutions.map((r) => (
                  <option key={r} value={r}>
                    {resLabel(r)}
                  </option>
                ))}
              </select>
            </label>
            <label className="export-opt">
              <span>{t('Quality')}</span>
              <select
                className="insp-select"
                disabled={locked}
                value={qualityValue}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'crf') settings.set({ exportQualityMode: 'crf' })
                  else settings.set({ exportQualityMode: 'bitrate', exportBitrateMbps: Number(v.slice(1)) })
                }}
              >
                <option value="crf">
                  {t('Constant quality')} (CRF {settings.exportCrf})
                </option>
                {bitrates.map((b) => (
                  <option key={b} value={`b${b}`}>
                    {b} Mbps
                  </option>
                ))}
              </select>
            </label>
            <label className="export-opt">
              <span>{t('Encoder')}</span>
              <select
                className="insp-select"
                disabled={locked || info.codec === 'vp9'}
                value={info.codec === 'vp9' ? 'software' : encoderChoice}
                onChange={(e) => settings.set({ exportEncoder: e.target.value as EncoderChoice })}
              >
                <option value="auto">
                  {t('Auto')}
                  {hw === null ? ` (${t('detecting…')})` : ` (${resolved.encoder})`}
                </option>
                <option value="software">
                  {t('Software')} ({softwareEncoder(info.codec)})
                </option>
                {families.map((f) => (
                  <option key={f} value={f}>
                    {HW_FAMILY_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="export-specs">
            <div>
              <span>{t('Output')}</span>
              <strong>
                {out.width}×{out.height} · {project.fps} fps
              </strong>
            </div>
            <div>
              <span>{t('Duration')}</span>
              <strong>
                {duration.toFixed(2)}s · {totalFrames} {t('frames')}
              </strong>
            </div>
            <div>
              <span>{t('Codec')}</span>
              <strong>{info.summary}</strong>
            </div>
            <div>
              <span>{t('Encoder')}</span>
              <strong>
                {resolved.encoder}
                {resolved.hardware ? ` (${t('hardware')})` : ''}
              </strong>
            </div>
          </div>

          {status === 'idle' && (
            <p className="modal-note">
              {t(
                'Renders the timeline — titles, subtitles, chroma key, and a mixed soundtrack — to a video file. This is an offline render, so it can take a while.'
              )}
            </p>
          )}

          {(status === 'running' || status === 'done') && (
            <div className="export-progress">
              <div className="bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="phase">{status === 'done' ? t('Export complete') : phaseLabel}</div>
            </div>
          )}

          {status === 'done' && savedPath && (
            <p className="modal-ok">
              {t('Saved to')} {savedPath}
            </p>
          )}

          {status === 'done' && warning && <p className="modal-warn">{t(warning)}</p>}

          {status === 'error' && error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-foot">
          {running ? (
            <button className="btn" onClick={() => (cancelRef.current = true)}>
              {t('Cancel')}
            </button>
          ) : (
            <button className="btn" onClick={close}>
              {t('Close')}
            </button>
          )}
          {status !== 'done' && (
            <button className="btn primary" disabled={locked} onClick={start}>
              {status === 'error' ? t('Retry export') : t('Choose file & export')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
