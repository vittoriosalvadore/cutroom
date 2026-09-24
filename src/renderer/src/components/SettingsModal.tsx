import { useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { LANGUAGES, useT } from '../lib/i18n'

// Reusable rows -------------------------------------------------------------

function Toggle(props: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{props.label}</div>
        {props.desc && <div className="set-desc">{props.desc}</div>}
      </div>
      <label className="set-switch">
        <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
        <span className="set-track">
          <span className="set-thumb" />
        </span>
      </label>
    </div>
  )
}

function Segmented<T extends string>(props: {
  label: string
  desc?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{props.label}</div>
        {props.desc && <div className="set-desc">{props.desc}</div>}
      </div>
      <div className="set-seg">
        {props.options.map((o) => (
          <button
            key={o.value}
            className={o.value === props.value ? 'active' : ''}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function RangeRow(props: {
  label: string
  desc?: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">
          {props.label}
          <em>{props.format(props.value)}</em>
        </div>
        {props.desc && <div className="set-desc">{props.desc}</div>}
      </div>
      <input
        className="set-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  )
}

const ACCENTS = ['#4c8dff', '#4fd6c0', '#8b7bff', '#ff6b8a', '#f4a93c', '#46c98a']
const TABS = ['Performance', 'Editing', 'Export', 'Appearance'] as const
type Tab = (typeof TABS)[number]

export default function SettingsModal() {
  const open = useEditor((s) => s.settingsOpen)
  const setOpen = useEditor((s) => s.setSettingsOpen)
  const s = useSettings()
  const t = useT()
  const [tab, setTab] = useState<Tab>('Performance')

  // Gate on `hydrated` so a click during the (sub-100ms) boot read can't be
  // clobbered by the late-resolving hydrate.
  if (!open || !s.hydrated) return null

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{t('Options')}</div>
        <div className="settings-body">
          <nav className="settings-tabs">
            {TABS.map((tabName) => (
              <button key={tabName} className={tabName === tab ? 'active' : ''} onClick={() => setTab(tabName)}>
                {t(tabName)}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {tab === 'Performance' && (
              <>
                <Toggle
                  label={t('Hardware acceleration')}
                  desc={t('Use the GPU for decoding & compositing. Requires a restart to take effect.')}
                  checked={s.hardwareAcceleration}
                  onChange={(v) => s.set({ hardwareAcceleration: v })}
                />
                <Toggle
                  label={t('Show placeholders in preview')}
                  desc={t("Display a card for clips that can't be decoded yet (e.g. while a video buffers).")}
                  checked={s.showPlaceholders}
                  onChange={(v) => s.set({ showPlaceholders: v })}
                />
                <Segmented
                  label={t('Preview quality')}
                  desc={t('Render the preview at a lower resolution for smoother playback. Export always renders at full resolution.')}
                  value={s.previewQuality}
                  options={[
                    { value: 'full', label: t('Full') },
                    { value: 'half', label: t('Half') },
                    { value: 'quarter', label: t('Quarter') }
                  ]}
                  onChange={(v) => s.set({ previewQuality: v })}
                />
              </>
            )}

            {tab === 'Editing' && (
              <>
                <Toggle
                  label={t('Snapping')}
                  desc={t('Snap clip edges to other clips and the playhead while dragging.')}
                  checked={s.snapping}
                  onChange={(v) => s.set({ snapping: v })}
                />
                <Toggle
                  label={t('Show waveforms')}
                  desc={t('Draw audio waveforms on timeline clips.')}
                  checked={s.showWaveforms}
                  onChange={(v) => s.set({ showWaveforms: v })}
                />
                <RangeRow
                  label={t('Default fade length')}
                  desc={t('Used for the X crossfade and new fades.')}
                  value={s.defaultFadeSec}
                  min={0.1}
                  max={2}
                  step={0.05}
                  format={(v) => `${v.toFixed(2)} s`}
                  onChange={(v) => s.set({ defaultFadeSec: v })}
                />
              </>
            )}

            {tab === 'Export' && (
              <>
                <Segmented
                  label={t('Encoder speed')}
                  desc={t('Faster encodes are larger; slower encodes are smaller at the same quality.')}
                  value={s.exportPreset}
                  options={[
                    { value: 'veryfast', label: t('Faster') },
                    { value: 'medium', label: t('Balanced') },
                    { value: 'slow', label: t('Best') }
                  ]}
                  onChange={(v) => s.set({ exportPreset: v })}
                />
                <RangeRow
                  label={t('Quality')}
                  desc={t('Lower CRF = higher quality & bigger file. 20 is a good default.')}
                  value={s.exportCrf}
                  min={14}
                  max={28}
                  step={1}
                  format={(v) => `CRF ${v}`}
                  onChange={(v) => s.set({ exportCrf: v })}
                />
              </>
            )}

            {tab === 'Appearance' && (
              <>
                <Segmented
                  label={t('Theme')}
                  value={s.theme}
                  options={[
                    { value: 'graphite', label: t('Graphite') },
                    { value: 'midnight', label: t('Midnight') },
                    { value: 'slate', label: t('Slate') },
                    { value: 'contrast', label: t('Contrast') }
                  ]}
                  onChange={(v) => s.set({ theme: v })}
                />
                <div className="set-row">
                  <div className="set-text">
                    <div className="set-label">{t('Accent colour')}</div>
                    <div className="set-desc">{t('Drives primary buttons and selection.')}</div>
                  </div>
                  <div className="set-accents">
                    {ACCENTS.map((c) => (
                      <button
                        key={c}
                        className={`set-swatch ${s.accent.toLowerCase() === c ? 'active' : ''}`}
                        style={{ background: c }}
                        title={c}
                        onClick={() => s.set({ accent: c })}
                      />
                    ))}
                    <label className="set-swatch set-swatch-custom" title={t('Custom colour')}>
                      <input type="color" value={s.accent} onChange={(e) => s.set({ accent: e.target.value })} />
                    </label>
                  </div>
                </div>
                <Segmented
                  label={t('Density')}
                  value={s.density}
                  options={[
                    { value: 'comfortable', label: t('Comfortable') },
                    { value: 'compact', label: t('Compact') }
                  ]}
                  onChange={(v) => s.set({ density: v })}
                />
                <Toggle
                  label={t('Reduce motion')}
                  desc={t('Disable UI transitions and animations.')}
                  checked={s.reduceMotion}
                  onChange={(v) => s.set({ reduceMotion: v })}
                />
                <Segmented
                  label={t('Language')}
                  value={s.language}
                  options={LANGUAGES}
                  onChange={(v) => s.set({ language: v })}
                />
              </>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button
            className="btn"
            onClick={() => {
              if (confirm(t('Reset all options to their defaults?'))) s.reset()
            }}
          >
            {t('Reset to defaults')}
          </button>
          <button className="btn primary" onClick={() => setOpen(false)}>
            {t('Done')}
          </button>
        </div>
      </div>
    </div>
  )
}
