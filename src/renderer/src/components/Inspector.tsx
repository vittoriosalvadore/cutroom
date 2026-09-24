import { useEffect, useState } from 'react'
import { useEditor } from '../state/store'
import {
  defaultAudio,
  defaultColor,
  defaultEffects,
  defaultTrackGate,
  defaultTrackDuck,
  defaultTrackEQ,
  defaultTrackComp,
  defaultTrackReverb
} from '../types'
import { REVERB_LIMITS } from '../../../shared/reverb'
import { sampleOpacity, sampleTransform, KEY_EPS } from '../lib/keyframes'
import { useT } from '../lib/i18n'
import { SLIDER_KEYS } from '../lib/transport'
import { normalizeGainDb } from '../lib/normalize'
import { canRemoveTrack, MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT } from '../lib/tracks'
import { removeTrackWithConfirm } from '../lib/trackActions'
import CurvesEditor from './CurvesEditor'
import { denoiseCacheVersion, ensureDenoised, getDenoiseEntry, subscribeDenoiseCache } from '../lib/denoiseCache'
import type { AnimProp, Marker, TextAlign, Track, TrackGate, TrackDuck, TrackEQ, TrackComp, TrackReverb } from '../types'

/** Labelled range slider that shows its current value. */
/**
 * Pre-edit undo snapshot for a pointerdown inside an Inspector panel, taken
 * only when it lands on an enabled form control (or a <label> that drives one,
 * e.g. an On/Off switch). Snapshotting on ANY pointerdown pushed a no-op undo
 * step — and wiped redo — for clicks on blank space or headings. Controls whose
 * action records its own history (or doesn't edit) opt out via data-no-snapshot.
 */
function snapshotOnControl(e: { target: EventTarget | null }): void {
  const target = e.target
  if (!(target instanceof Element)) return
  let control: Element | null = target.closest('input, select, textarea, button')
  if (!control) {
    // A label click toggles/opens its control — except a slider's, which only focuses.
    const viaLabel = target.closest('label')?.control ?? null
    if (viaLabel && !(viaLabel instanceof HTMLInputElement && viaLabel.type === 'range')) control = viaLabel
  }
  if (!control || control.matches(':disabled') || control.closest('[data-no-snapshot]')) return
  useEditor.getState().snapshot()
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: (v: number) => string
  disabled?: boolean
}) {
  const { label, value, min, max, step, onChange, format, disabled } = props
  return (
    <label className={`insp-field ${disabled ? 'disabled' : ''}`}>
      <span className="insp-label">
        {label}
        <em>{format ? format(value) : value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

/**
 * A Slider with keyframing: a stopwatch arms the property, the diamond adds /
 * removes a key at the playhead, and ‹ › jump between keys. Armed, dragging the
 * slider writes a key at the playhead; disarmed, it sets the static value. The
 * thumb tracks the value sampled at the current playhead.
 */
function KeyableSlider(props: {
  clipId: string
  clipStart: number
  clipDur: number
  prop: AnimProp
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  tRel: number
  inside: boolean
  keyTimes: number[]
}) {
  const { clipId, clipStart, clipDur, prop, label, value, min, max, step, format, tRel, inside, keyTimes } = props
  const armed = keyTimes.length > 0
  const kfT = Math.max(0, Math.min(clipDur, tRel))
  const onKeyHere = keyTimes.some((t) => Math.abs(t - kfT) <= KEY_EPS)
  const st = useEditor.getState
  const t = useT()

  // Armed edits only land when the playhead is on the clip (so a key can't be
  // written off-clip); disarmed edits set the time-independent static value.
  const onChange = (v: number): void => {
    if (armed) {
      if (inside) st().setKeyframe(clipId, prop, kfT, v)
    } else {
      st().setStaticProp(clipId, prop, v)
    }
  }
  const toggleKeyHere = (): void => {
    if (onKeyHere) st().removeKeyframe(clipId, prop, kfT)
    else st().setKeyframe(clipId, prop, kfT, value)
  }
  const go = (dir: -1 | 1): void => {
    const times = [...keyTimes].sort((a, b) => a - b)
    const next =
      dir < 0 ? [...times].reverse().find((t) => t < tRel - KEY_EPS) : times.find((t) => t > tRel + KEY_EPS)
    if (next !== undefined) st().setPlayhead(clipStart + next)
  }

  return (
    <div className={`keyrow ${armed ? 'armed' : ''}`}>
      <button
        className={`kf-watch ${armed ? 'on' : ''}`}
        title={armed ? t('Stop animating (bake current value)') : t('Animate this property with keyframes')}
        onClick={() => st().toggleKeyframeTrack(clipId, prop, kfT, value)}
      >
        ◷
      </button>
      <div className="keyrow-main">
        <Slider
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
          format={format}
          disabled={armed && !inside}
        />
      </div>
      <div className="kf-nav">
        <button title={t('Previous keyframe')} disabled={!armed} onClick={() => go(-1)}>
          ‹
        </button>
        <button
          className={`kf-dia ${onKeyHere ? 'on' : ''}`}
          title={t('Add / remove a keyframe at the playhead')}
          disabled={!inside}
          onClick={toggleKeyHere}
        >
          ◆
        </button>
        <button title={t('Next keyframe')} disabled={!armed} onClick={() => go(1)}>
          ›
        </button>
      </div>
    </div>
  )
}

const ALIGNS: TextAlign[] = ['left', 'center', 'right']

/** Track layout controls: lane height, stacking order, delete. Reordering and
 *  deleting record their own undo step (data-no-snapshot); the height slider
 *  relies on the panel's pre-edit snapshot like every other slider. */
function TrackLayoutSection(props: { track: Track; tracks: Track[] }) {
  const { track, tracks } = props
  const t = useT()
  const index = tracks.findIndex((tr) => tr.id === track.id)
  const removable = canRemoveTrack(tracks, track.id)
  const st = useEditor.getState
  return (
    <section className="insp-section">
      <h4>{t('Track')}</h4>
      <Slider
        label={t('Height')}
        value={track.height}
        min={MIN_TRACK_HEIGHT}
        max={MAX_TRACK_HEIGHT}
        step={1}
        onChange={(v) => st().setTrackHeight(track.id, v)}
        format={(v) => `${Math.round(v)} px`}
      />
      <div className="insp-row">
        <button
          className="btn small"
          data-no-snapshot
          disabled={index <= 0}
          title={t('Move track up')}
          onClick={() => st().moveTrack(track.id, index - 1)}
        >
          ▲ {t('Up')}
        </button>
        <button
          className="btn small"
          data-no-snapshot
          disabled={index < 0 || index >= tracks.length - 1}
          title={t('Move track down')}
          onClick={() => st().moveTrack(track.id, index + 1)}
        >
          ▼ {t('Down')}
        </button>
        <button
          className="btn small"
          data-no-snapshot
          disabled={!removable}
          title={removable ? undefined : t('The last video or audio track can’t be deleted.')}
          onClick={() => removeTrackWithConfirm(track.id)}
        >
          {t('Delete track')}
        </button>
      </div>
      {track.kind === 'video' && (
        <p className="insp-note">{t('Higher video tracks draw on top of lower ones.')}</p>
      )}
    </section>
  )
}

/** Mixer + dynamics panel for a selected track: volume, pan, gate, ducking. */
function TrackPanel(props: {
  track: Track
  tracks: Track[]
  updateTrack: (id: string, patch: { audioGain?: number; pan?: number }) => void
  updateTrackGate: (id: string, patch: Partial<TrackGate>) => void
  updateTrackDuck: (id: string, patch: Partial<TrackDuck>) => void
  updateTrackEQ: (id: string, patch: Partial<TrackEQ>) => void
  updateTrackComp: (id: string, patch: Partial<TrackComp>) => void
  updateTrackReverb: (id: string, patch: Partial<TrackReverb>) => void
}) {
  const { track, tracks, updateTrack, updateTrackGate, updateTrackDuck, updateTrackEQ, updateTrackComp, updateTrackReverb } =
    props
  const t = useT()
  const gain = track.audioGain ?? 0
  const pan = track.pan ?? 0
  const gate = track.gate ?? defaultTrackGate()
  const duck = track.duck ?? defaultTrackDuck()
  const eq = track.eq ?? defaultTrackEQ()
  const comp = track.comp ?? defaultTrackComp()
  const reverb = track.reverb ?? defaultTrackReverb()
  const otherAudio = tracks.filter((t) => t.kind === 'audio' && t.id !== track.id)
  return (
    <aside className="inspector">
      <div className="panel-head">{t('Inspector')}</div>
      <div
        className="insp-body"
        onPointerDownCapture={snapshotOnControl}
        onKeyDownCapture={(e) => {
          // Keyboard nudges on a slider also need a pre-edit snapshot for undo.
          if ((e.target as HTMLInputElement).type === 'range' && SLIDER_KEYS.has(e.key)) useEditor.getState().snapshot()
        }}
      >
        <div className="insp-clipname">{track.name}</div>
        <div className="insp-clipmeta">
          {track.kind === 'audio' ? t('Audio track') : t('Video track')}
          {track.muted ? ` · ${t('muted')}` : ''}
        </div>
        <TrackLayoutSection track={track} tracks={tracks} />
        <section className="insp-section">
          <h4>{t('Mixer')}</h4>
          <Slider
            label={t('Volume')}
            value={gain}
            min={-40}
            max={6}
            step={0.5}
            onChange={(v) => updateTrack(track.id, { audioGain: v })}
            format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
          />
          {track.kind === 'audio' && (
            <Slider
              label={t('Pan')}
              value={pan}
              min={-1}
              max={1}
              step={0.02}
              onChange={(v) => updateTrack(track.id, { pan: v })}
              format={(v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)}
            />
          )}
          {track.kind === 'audio' && (
            <div className="insp-row">
              <button
                className="btn small"
                title={t('Set the gain so the loudest peak hits -1 dBFS')}
                onClick={() => {
                  const g = normalizeGainDb(useEditor.getState().project, track.id)
                  if (g !== null) updateTrack(track.id, { audioGain: g })
                }}
              >
                {t('Normalize')}
              </button>
            </div>
          )}
          <p className="insp-note">
            {t('Mute this track with the M badge on its timeline lane.')}
            {track.kind === 'video' ? ` ${t('EQ, gate, compressor, pan, ducking and reverb apply to audio tracks.')}` : ''}
          </p>
        </section>

        {track.kind === 'audio' && (
          <section className="insp-section">
            <h4>
              {t('EQ')}
              <label className="insp-switch">
                <input
                  type="checkbox"
                  checked={eq.enabled}
                  onChange={(e) => updateTrackEQ(track.id, { enabled: e.target.checked })}
                />
                <span>{eq.enabled ? t('On') : t('Off')}</span>
              </label>
            </h4>
            <Slider
              label={t('Low')}
              value={eq.lowDb}
              min={-18}
              max={18}
              step={0.5}
              onChange={(v) => updateTrackEQ(track.id, { lowDb: v })}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
            />
            <Slider
              label={t('Mid')}
              value={eq.midDb}
              min={-18}
              max={18}
              step={0.5}
              onChange={(v) => updateTrackEQ(track.id, { midDb: v })}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
            />
            <Slider
              label={t('High')}
              value={eq.highDb}
              min={-18}
              max={18}
              step={0.5}
              onChange={(v) => updateTrackEQ(track.id, { highDb: v })}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
            />
            <p className="insp-note">{t('3-band: low shelf 120 Hz · mid 1 kHz · high shelf 8 kHz.')}</p>
          </section>
        )}

        {track.kind === 'audio' && (
          <section className="insp-section">
            <h4>
              {t('Compressor')}
              <label className="insp-switch">
                <input
                  type="checkbox"
                  checked={comp.enabled}
                  onChange={(e) => updateTrackComp(track.id, { enabled: e.target.checked })}
                />
                <span>{comp.enabled ? t('On') : t('Off')}</span>
              </label>
            </h4>
            <Slider
              label={t('Threshold')}
              value={comp.thresholdDb}
              min={-60}
              max={0}
              step={1}
              onChange={(v) => updateTrackComp(track.id, { thresholdDb: v })}
              format={(v) => `${v.toFixed(0)} dB`}
            />
            <Slider
              label={t('Ratio')}
              value={comp.ratio}
              min={1}
              max={20}
              step={0.5}
              onChange={(v) => updateTrackComp(track.id, { ratio: v })}
              format={(v) => `${v.toFixed(1)}:1`}
            />
            <Slider
              label={t('Attack')}
              value={comp.attackMs}
              min={0}
              max={200}
              step={1}
              onChange={(v) => updateTrackComp(track.id, { attackMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <Slider
              label={t('Release')}
              value={comp.releaseMs}
              min={0}
              max={1000}
              step={5}
              onChange={(v) => updateTrackComp(track.id, { releaseMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <Slider
              label={t('Makeup')}
              value={comp.makeupDb}
              min={0}
              max={24}
              step={0.5}
              onChange={(v) => updateTrackComp(track.id, { makeupDb: v })}
              format={(v) => `+${v.toFixed(1)} dB`}
            />
            <p className="insp-note">{t('Evens out level. Lower threshold + higher ratio = more squeeze.')}</p>
          </section>
        )}

        {track.kind === 'audio' && (
          <section className="insp-section">
            <h4>
              {t('Noise Gate')}
              <label className="insp-switch">
                <input
                  type="checkbox"
                  checked={gate.enabled}
                  onChange={(e) => updateTrackGate(track.id, { enabled: e.target.checked })}
                />
                <span>{gate.enabled ? t('On') : t('Off')}</span>
              </label>
            </h4>
            <Slider
              label={t('Threshold')}
              value={gate.thresholdDb}
              min={-80}
              max={0}
              step={1}
              onChange={(v) => updateTrackGate(track.id, { thresholdDb: v })}
              format={(v) => `${v.toFixed(0)} dB`}
            />
            <Slider
              label={t('Range')}
              value={gate.rangeDb}
              min={-90}
              max={0}
              step={1}
              onChange={(v) => updateTrackGate(track.id, { rangeDb: v })}
              format={(v) => `${v.toFixed(0)} dB`}
            />
            <Slider
              label={t('Ratio')}
              value={gate.ratio}
              min={1}
              max={20}
              step={0.5}
              onChange={(v) => updateTrackGate(track.id, { ratio: v })}
              format={(v) => `${v.toFixed(1)}:1`}
            />
            <Slider
              label={t('Attack')}
              value={gate.attackMs}
              min={0}
              max={200}
              step={1}
              onChange={(v) => updateTrackGate(track.id, { attackMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <Slider
              label={t('Release')}
              value={gate.releaseMs}
              min={0}
              max={1000}
              step={5}
              onChange={(v) => updateTrackGate(track.id, { releaseMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <p className="insp-note">{t('Silences hiss below the threshold — clean up voice tracks between words.')}</p>
          </section>
        )}

        {track.kind === 'audio' && (
          <section className="insp-section">
            <h4>
              {t('Ducking')}
              <label className="insp-switch">
                <input
                  type="checkbox"
                  checked={duck.enabled}
                  onChange={(e) => updateTrackDuck(track.id, { enabled: e.target.checked })}
                />
                <span>{duck.enabled ? t('On') : t('Off')}</span>
              </label>
            </h4>
            <label className="insp-field">
              <span className="insp-label">{t('Trigger track')}</span>
              <select
                className="insp-select"
                value={duck.triggerTrackId ?? ''}
                onChange={(e) => updateTrackDuck(track.id, { triggerTrackId: e.target.value || null })}
              >
                <option value="">{t('— none —')}</option>
                {otherAudio.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <Slider
              label={t('Threshold')}
              value={duck.thresholdDb}
              min={-60}
              max={0}
              step={1}
              onChange={(v) => updateTrackDuck(track.id, { thresholdDb: v })}
              format={(v) => `${v.toFixed(0)} dB`}
            />
            <Slider
              label={t('Amount')}
              value={duck.ratio}
              min={1}
              max={20}
              step={0.5}
              onChange={(v) => updateTrackDuck(track.id, { ratio: v })}
              format={(v) => `${v.toFixed(1)}:1`}
            />
            <Slider
              label={t('Attack')}
              value={duck.attackMs}
              min={0}
              max={200}
              step={1}
              onChange={(v) => updateTrackDuck(track.id, { attackMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <Slider
              label={t('Release')}
              value={duck.releaseMs}
              min={0}
              max={1000}
              step={5}
              onChange={(v) => updateTrackDuck(track.id, { releaseMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <p className="insp-note">
              {t('Lowers this track automatically while the trigger track (e.g. a voiceover) is loud.')}
            </p>
          </section>
        )}

        {track.kind === 'audio' && (
          <section className="insp-section">
            <h4>
              {t('Reverb')}
              <label className="insp-switch">
                <input
                  type="checkbox"
                  checked={reverb.enabled}
                  onChange={(e) => updateTrackReverb(track.id, { enabled: e.target.checked })}
                />
                <span>{reverb.enabled ? t('On') : t('Off')}</span>
              </label>
            </h4>
            <Slider
              label={t('Mix')}
              value={reverb.mix}
              min={REVERB_LIMITS.mix[0]}
              max={REVERB_LIMITS.mix[1]}
              step={0.01}
              onChange={(v) => updateTrackReverb(track.id, { mix: v })}
              format={(v) => `${Math.round(v * 100)}% ${t('wet')}`}
            />
            <Slider
              label={t('Decay')}
              value={reverb.decaySec}
              min={REVERB_LIMITS.decaySec[0]}
              max={REVERB_LIMITS.decaySec[1]}
              step={0.1}
              onChange={(v) => updateTrackReverb(track.id, { decaySec: v })}
              format={(v) => `${v.toFixed(1)} s`}
            />
            <Slider
              label={t('Pre-delay')}
              value={reverb.preDelayMs}
              min={REVERB_LIMITS.preDelayMs[0]}
              max={REVERB_LIMITS.preDelayMs[1]}
              step={1}
              onChange={(v) => updateTrackReverb(track.id, { preDelayMs: v })}
              format={(v) => `${v.toFixed(0)} ms`}
            />
            <Slider
              label={t('Tone')}
              value={reverb.tone}
              min={REVERB_LIMITS.tone[0]}
              max={REVERB_LIMITS.tone[1]}
              step={0.01}
              onChange={(v) => updateTrackReverb(track.id, { tone: v })}
              format={(v) => (v < 0.34 ? t('Dark') : v > 0.66 ? t('Bright') : t('Neutral'))}
            />
            <p className="insp-note">{t('Convolution reverb — the export uses the exact same impulse response.')}</p>
          </section>
        )}
      </div>
    </aside>
  )
}

/** Shown when more than one clip is selected: count + safe batch actions. */
function MultiClipPanel(props: { count: number }) {
  const st = useEditor.getState
  const t = useT()
  return (
    <aside className="inspector">
      <div className="panel-head">{t('Inspector')}</div>
      <div className="insp-body">
        <div className="insp-clipname">{t('{n} clips selected', { n: props.count })}</div>
        <div className="insp-clipmeta">{t('Drag to move all · Del removes all')}</div>
        <section className="insp-section">
          <div className="insp-row">
            <button className="btn small" onClick={() => st().copySelectedClips()}>
              {t('Copy')}
            </button>
            <button className="btn small" onClick={() => st().removeSelectedClips()}>
              {t('Delete')}
            </button>
            <button className="btn small" onClick={() => st().rippleDeleteSelected()}>
              {t('Ripple delete')}
            </button>
          </div>
          <p className="insp-note">{t('Select a single clip to edit its properties.')}</p>
        </section>
      </div>
    </aside>
  )
}

/** Editor for a selected timeline marker: label, colour, delete. */
function MarkerPanel(props: { marker: Marker }) {
  const { marker } = props
  const updateMarker = useEditor((s) => s.updateMarker)
  const removeMarker = useEditor((s) => s.removeMarker)
  const t = useT()
  return (
    <aside className="inspector">
      <div className="panel-head">{t('Inspector')}</div>
      <div className="insp-body" onPointerDownCapture={snapshotOnControl}>
        <div className="insp-clipname">{t('Marker')}</div>
        <div className="insp-clipmeta">{t('at {time}s', { time: marker.timeSec.toFixed(2) })}</div>
        <section className="insp-section">
          <textarea
            className="insp-textarea"
            rows={1}
            value={marker.label ?? ''}
            placeholder={t('Label…')}
            onChange={(e) => updateMarker(marker.id, { label: e.target.value })}
          />
          <div className="insp-row">
            <label className="insp-color">
              {t('Colour')}
              <input
                type="color"
                value={marker.color ?? '#ffcf4d'}
                onChange={(e) => updateMarker(marker.id, { color: e.target.value })}
              />
            </label>
            {/* removeMarker records its own undo step; a snapshot here would duplicate it. */}
            <button className="btn small" data-no-snapshot onClick={() => removeMarker(marker.id)}>
              {t('Delete')}
            </button>
          </div>
          <p className="insp-note">{t('M adds a marker at the playhead · , / . jump between markers.')}</p>
        </section>
      </div>
    </aside>
  )
}

export default function Inspector() {
  const clip = useEditor((s) => (s.selectedClipId ? s.project.clips[s.selectedClipId] : null))
  const media = useEditor((s) =>
    s.selectedClipId && s.project.clips[s.selectedClipId]?.mediaId
      ? s.project.media[s.project.clips[s.selectedClipId]!.mediaId as string]
      : null
  )
  const updateText = useEditor((s) => s.updateText)
  const updateChroma = useEditor((s) => s.updateChroma)
  const updateColor = useEditor((s) => s.updateColor)
  const setSpeed = useEditor((s) => s.setSpeed)
  const updateAudio = useEditor((s) => s.updateAudio)
  const setDenoiseEnabled = useEditor((s) => s.setDenoiseEnabled)
  // Re-render when a denoise job's status changes (processing -> ready/error).
  const [, setDenoiseVersion] = useState(0)
  useEffect(() => subscribeDenoiseCache(() => setDenoiseVersion(denoiseCacheVersion())), [])
  // If denoise was already enabled on this clip from a previous session (e.g.
  // a recovered project), start the job here instead of relying solely on the
  // checkbox's own onChange — otherwise nothing ever kicks it off and the
  // Inspector is stuck showing "Processing…" forever.
  useEffect(() => {
    if (clip?.denoiseEnabled && media?.path && !getDenoiseEntry(media.id)) {
      ensureDenoised(media.id, media.path)
    }
  }, [clip?.id, clip?.denoiseEnabled, media?.id, media?.path])
  // Subscribe to the playhead so keyframe sliders track the value live as you scrub.
  const playhead = useEditor((s) => s.playheadSec)
  const tracks = useEditor((s) => s.project.tracks)
  const track = useEditor((s) =>
    s.selectedTrackId ? s.project.tracks.find((t) => t.id === s.selectedTrackId) ?? null : null
  )
  const updateTrack = useEditor((s) => s.updateTrack)
  const updateTrackGate = useEditor((s) => s.updateTrackGate)
  const updateTrackDuck = useEditor((s) => s.updateTrackDuck)
  const updateTrackEQ = useEditor((s) => s.updateTrackEQ)
  const updateTrackComp = useEditor((s) => s.updateTrackComp)
  const updateTrackReverb = useEditor((s) => s.updateTrackReverb)
  const selCount = useEditor((s) => s.selectedClipIds.size)
  const marker = useEditor((s) =>
    s.selectedMarkerId ? s.project.markers?.find((m) => m.id === s.selectedMarkerId) ?? null : null
  )
  const t = useT()

  // More than one clip selected -> batch panel (the primary clip still drives 1-clip edits).
  if (selCount > 1) return <MultiClipPanel count={selCount} />

  if (!clip) {
    if (marker) return <MarkerPanel marker={marker} />
    if (track)
      return (
        <TrackPanel
          track={track}
          tracks={tracks}
          updateTrack={updateTrack}
          updateTrackGate={updateTrackGate}
          updateTrackDuck={updateTrackDuck}
          updateTrackEQ={updateTrackEQ}
          updateTrackComp={updateTrackComp}
          updateTrackReverb={updateTrackReverb}
        />
      )
    return (
      <aside className="inspector">
        <div className="panel-head">{t('Inspector')}</div>
        <div className="empty">{t('Select a clip or a track to edit it.')}</div>
      </aside>
    )
  }

  const id = clip.id
  const isText = (clip.role === 'title' || clip.role === 'subtitle') && !!clip.text
  const text = clip.text
  const eff = clip.effects ?? defaultEffects()
  const chroma = eff.chroma
  const color = eff.color ?? defaultColor()
  const isTimed = media?.kind === 'video' || media?.kind === 'audio'
  const speed = clip.speed ?? 1
  const title =
    clip.role === 'title' ? t('Title') : clip.role === 'subtitle' ? t('Subtitle') : media?.name ?? t('Clip')

  // Audio clips have no picture; visual clips (video/image/title/subtitle) do.
  const isVisual = media?.kind !== 'audio'
  const isAudible =
    !!clip.mediaId && clip.role !== 'title' && clip.role !== 'subtitle' && !!media && media.kind !== 'image'
  const audio = {
    volume: clip.volume ?? defaultAudio().volume,
    fadeInSec: clip.fadeInSec ?? 0,
    fadeOutSec: clip.fadeOutSec ?? 0
  }
  const fadeMax = Math.max(0.1, clip.durationSec)

  // Transform / keyframes: sample at the clip-relative playhead so sliders show
  // the animated value, and gate keyframe edits on the playhead being in-clip.
  const tRel = playhead - clip.startSec
  const inside = tRel >= -1e-6 && tRel <= clip.durationSec + 1e-6
  const sampled = sampleTransform(clip, tRel)
  const sampledOpacity = sampleOpacity(clip, eff.opacity, tRel)
  const keyTimes = (p: AnimProp): number[] => clip.keyframes?.[p]?.map((k) => k.t) ?? []
  const kProps = { clipId: id, clipStart: clip.startSec, clipDur: clip.durationSec, tRel, inside }

  return (
    <aside className="inspector">
      <div className="panel-head">{t('Inspector')}</div>
      {/* Snapshot once at the start of any control interaction so a slider sweep
          or button click is a single undo step. */}
      <div
        className="insp-body"
        onPointerDownCapture={snapshotOnControl}
        onKeyDownCapture={(e) => {
          // Keyboard nudges on a slider also need a pre-edit snapshot for undo.
          if ((e.target as HTMLInputElement).type === 'range' && SLIDER_KEYS.has(e.key)) useEditor.getState().snapshot()
        }}
      >
        <div className="insp-clipname">{title}</div>
        <div className="insp-clipmeta">
          {clip.startSec.toFixed(2)}s → {(clip.startSec + clip.durationSec).toFixed(2)}s
        </div>

        {isTimed && (
          <section className="insp-section">
            <h4>{t('Speed')}</h4>
            <Slider
              label={t('Playback speed')}
              value={speed}
              min={0.25}
              max={4}
              step={0.05}
              onChange={(v) => setSpeed(id, v)}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <p className="insp-note">{t('Slow-mo below 1×, fast-forward above. Audio pitches with speed.')}</p>
          </section>
        )}

        {isText && text && (
          <section className="insp-section">
            <h4>{t('Text')}</h4>
            <textarea
              className="insp-textarea"
              rows={2}
              value={text.content}
              placeholder={t('Type your text…')}
              onChange={(e) => updateText(id, { content: e.target.value })}
            />
            <div className="insp-row">
              <label className="insp-color">
                {t('Fill')}
                <input
                  type="color"
                  value={text.color}
                  onChange={(e) => updateText(id, { color: e.target.value })}
                />
              </label>
              <div className="insp-toggle-group">
                <button
                  className={`btn small ${text.bold ? 'active' : ''}`}
                  onClick={() => updateText(id, { bold: !text.bold })}
                >
                  B
                </button>
                <button
                  className={`btn small ${text.italic ? 'active' : ''}`}
                  onClick={() => updateText(id, { italic: !text.italic })}
                >
                  <i>I</i>
                </button>
              </div>
              <div className="insp-toggle-group">
                {ALIGNS.map((a) => (
                  <button
                    key={a}
                    className={`btn small ${text.align === a ? 'active' : ''}`}
                    title={a === 'left' ? t('Align left') : a === 'center' ? t('Align center') : t('Align right')}
                    onClick={() => updateText(id, { align: a })}
                  >
                    {a[0].toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <Slider
              label={t('Size')}
              value={text.fontSizePct}
              min={1}
              max={25}
              step={0.1}
              onChange={(v) => updateText(id, { fontSizePct: v })}
              format={(v) => `${v.toFixed(1)}%`}
            />
            <Slider
              label={t('Position X')}
              value={text.xPct}
              min={0}
              max={100}
              step={0.5}
              onChange={(v) => updateText(id, { xPct: v })}
              format={(v) => `${v.toFixed(0)}%`}
            />
            <Slider
              label={t('Position Y')}
              value={text.yPct}
              min={0}
              max={100}
              step={0.5}
              onChange={(v) => updateText(id, { yPct: v })}
              format={(v) => `${v.toFixed(0)}%`}
            />
            <div className="insp-row">
              <label className="insp-color">
                {t('Outline')}
                <input
                  type="color"
                  value={text.strokeColor}
                  onChange={(e) => updateText(id, { strokeColor: e.target.value })}
                />
              </label>
              <label className="insp-color">
                {t('Box')}
                <input
                  type="color"
                  value={text.boxColor}
                  onChange={(e) => updateText(id, { boxColor: e.target.value })}
                />
              </label>
            </div>
            <Slider
              label={t('Outline width')}
              value={text.strokeWidthPct}
              min={0}
              max={20}
              step={0.5}
              onChange={(v) => updateText(id, { strokeWidthPct: v })}
              format={(v) => `${v.toFixed(1)}%`}
            />
            <Slider
              label={t('Box opacity')}
              value={text.boxOpacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateText(id, { boxOpacity: v })}
            />
          </section>
        )}

        {isVisual && (
          <section className="insp-section">
            <h4>
              {t('Transform')}
              <button
                className="btn small"
                title={t('Reset transform & keyframes')}
                onClick={() => useEditor.getState().resetTransform(id)}
              >
                {t('Reset')}
              </button>
            </h4>
            <KeyableSlider
              {...kProps}
              prop="opacity"
              label={t('Opacity')}
              value={sampledOpacity}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              keyTimes={keyTimes('opacity')}
            />
            <KeyableSlider
              {...kProps}
              prop="scale"
              label={t('Scale')}
              value={sampled.scale}
              min={0.1}
              max={4}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              keyTimes={keyTimes('scale')}
            />
            <KeyableSlider
              {...kProps}
              prop="posX"
              label={t('Position X')}
              value={sampled.posX}
              min={-1}
              max={1}
              step={0.005}
              format={(v) => `${Math.round(v * 100)}%`}
              keyTimes={keyTimes('posX')}
            />
            <KeyableSlider
              {...kProps}
              prop="posY"
              label={t('Position Y')}
              value={sampled.posY}
              min={-1}
              max={1}
              step={0.005}
              format={(v) => `${Math.round(v * 100)}%`}
              keyTimes={keyTimes('posY')}
            />
            <KeyableSlider
              {...kProps}
              prop="rotationDeg"
              label={t('Rotation')}
              value={sampled.rotationDeg}
              min={-180}
              max={180}
              step={1}
              format={(v) => `${v.toFixed(0)}°`}
              keyTimes={keyTimes('rotationDeg')}
            />
            <div className="insp-row">
              <button className="btn small" title={t('Slow zoom + pan')} onClick={() => useEditor.getState().applyKenBurns(id)}>
                ✨ {t('Ken Burns')}
              </button>
              <button className="btn small" title={t('Scale to fill the frame')} onClick={() => useEditor.getState().fillFrame(id)}>
                {t('Fill frame')}
              </button>
              {media?.kind === 'video' && (
                <button
                  className="btn small"
                  title={t('Track the subject with AI and add follow keyframes')}
                  data-no-snapshot // only opens the modal; applyReframe records its own step
                  onClick={() => useEditor.getState().setReframeOpen(true)}
                >
                  🎯 {t('AI Reframe')}
                </button>
              )}
            </div>
            <details className="insp-crop">
              <summary>{t('Crop')}</summary>
              {(['cropTop', 'cropBottom', 'cropLeft', 'cropRight'] as const).map((p) => (
                <KeyableSlider
                  key={p}
                  {...kProps}
                  prop={p}
                  label={t(p.replace('crop', ''))}
                  value={sampled.crop[p.replace('crop', '').toLowerCase() as 'top' | 'bottom' | 'left' | 'right']}
                  min={0}
                  max={0.49}
                  step={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  keyTimes={keyTimes(p)}
                />
              ))}
            </details>
          </section>
        )}

        {isVisual && (
          <section className="insp-section">
            <h4>
              {t('Chroma Key')}
              <label className="insp-switch">
                <input
                  type="checkbox"
                  checked={chroma.enabled}
                  onChange={(e) => updateChroma(id, { enabled: e.target.checked })}
                />
                <span>{chroma.enabled ? t('On') : t('Off')}</span>
              </label>
            </h4>
            <div className="insp-row">
              <button className="btn small" onClick={() => updateChroma(id, { color: '#00d000', enabled: true })}>
                🟩 {t('Green')}
              </button>
              <button className="btn small" onClick={() => updateChroma(id, { color: '#0047bb', enabled: true })}>
                🟦 {t('Blue')}
              </button>
              <label className="insp-color">
                {t('Key')}
                <input
                  type="color"
                  value={chroma.color}
                  onChange={(e) => updateChroma(id, { color: e.target.value })}
                />
              </label>
            </div>
            <Slider
              label={t('Similarity')}
              value={chroma.similarity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateChroma(id, { similarity: v })}
            />
            <Slider
              label={t('Smoothness')}
              value={chroma.smoothness}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateChroma(id, { smoothness: v })}
            />
            <Slider
              label={t('Spill suppression')}
              value={chroma.spill}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateChroma(id, { spill: v })}
            />
            <p className="insp-note">
              {t('Works on images and video. Drop in green/blue-screen footage and pick the screen color.')}
            </p>
          </section>
        )}

        {isVisual && (
          <section className="insp-section">
            <h4>
              {t('Color')}
              <button className="btn small" title={t('Reset color grade')} onClick={() => useEditor.getState().resetColor(id)}>
                {t('Reset')}
              </button>
            </h4>
            <Slider
              label={t('Exposure')}
              value={color.exposure}
              min={-2}
              max={2}
              step={0.01}
              onChange={(v) => updateColor(id, { exposure: v })}
              format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`}
            />
            <Slider
              label={t('Contrast')}
              value={color.contrast}
              min={0}
              max={2}
              step={0.01}
              onChange={(v) => updateColor(id, { contrast: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label={t('Saturation')}
              value={color.saturation}
              min={0}
              max={2}
              step={0.01}
              onChange={(v) => updateColor(id, { saturation: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label={t('Temperature')}
              value={color.temperature}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => updateColor(id, { temperature: v })}
              format={(v) =>
                Math.abs(v) < 0.005
                  ? t('Neutral')
                  : v < 0
                    ? t('Cool {n}', { n: Math.round(-v * 100) })
                    : t('Warm {n}', { n: Math.round(v * 100) })
              }
            />
            <Slider
              label={t('Tint')}
              value={color.tint}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => updateColor(id, { tint: v })}
              format={(v) =>
                Math.abs(v) < 0.005
                  ? t('Neutral')
                  : v < 0
                    ? t('Green {n}', { n: Math.round(-v * 100) })
                    : t('Magenta {n}', { n: Math.round(v * 100) })
              }
            />
          </section>
        )}

        {isVisual && (
          <section className="insp-section">
            <h4>
              {t('Curves')}
              <button
                className="btn small"
                title={t('Reset all curves')}
                disabled={!eff.curves}
                onClick={() => useEditor.getState().resetCurves(id)}
              >
                {t('Reset all')}
              </button>
            </h4>
            <CurvesEditor clipId={id} curves={eff.curves} />
            <p className="insp-note">
              {t('Click to add a point, drag to move, double-click or right-click to remove. Applied after the color grade.')}
            </p>
          </section>
        )}

        {isAudible && (
          <section className="insp-section">
            <h4>{t('Audio')}</h4>
            <Slider
              label={t('Volume')}
              value={audio.volume}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => updateAudio(id, { volume: v })}
            />
            <Slider
              label={t('Fade in')}
              value={Math.min(audio.fadeInSec, fadeMax)}
              min={0}
              max={fadeMax}
              step={0.05}
              onChange={(v) => updateAudio(id, { fadeInSec: v })}
              format={(v) => `${v.toFixed(2)}s`}
            />
            <Slider
              label={t('Fade out')}
              value={Math.min(audio.fadeOutSec, fadeMax)}
              min={0}
              max={fadeMax}
              step={0.05}
              onChange={(v) => updateAudio(id, { fadeOutSec: v })}
              format={(v) => `${v.toFixed(2)}s`}
            />
            {media?.path && (
              <>
                <label className="insp-switch">
                  <input
                    type="checkbox"
                    checked={!!clip.denoiseEnabled}
                    onChange={(e) => {
                      const enabled = e.target.checked
                      setDenoiseEnabled(id, enabled)
                      if (enabled) ensureDenoised(media.id, media.path as string)
                    }}
                  />
                  <span>{t('Denoise')}</span>
                </label>
                {clip.denoiseEnabled &&
                  (() => {
                    const entry = getDenoiseEntry(media.id)
                    return (
                      <p className="insp-note">
                        {entry?.status === 'ready'
                          ? t('Noise removal applied — reused for export.')
                          : entry?.status === 'error'
                            ? t('Denoise failed: {error}', { error: entry.error ?? t('unknown error') })
                            : t('Processing… this can take a while for long clips.')}
                      </p>
                    )
                  })()}
              </>
            )}
            {media?.kind === 'video' && (
              <p className="insp-note">{t("This is the video clip's own audio (plays in preview and export).")}</p>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
