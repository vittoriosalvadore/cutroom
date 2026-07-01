# Cutroom — Backlog

Running list of things consciously deferred while building, plus parity gaps and
candidate features. Ordered roughly by how much they came up. Update as we go.

## Deferred (explicitly punted during a batch)

- **WebCodecs decode** — hardware-accelerated video decode for faster scrubbing
  and export (currently `HTMLVideoElement` → texture). Punted: "WebCodecs later".
- **Broader codec / container support** — HEVC/H.265, ProRes, MKV, etc. beyond
  what the bundled FFmpeg + Chromium decode out of the box. Punted: "Codec support later".
- **Video transitions (picture dissolve/wipe)** — a real cross-dissolve between
  *pictures* (compositor `xfade`-style). The audio crossfade (X) is done; the
  visual transition is a separate compositor feature.

## Known limitations / parity gaps

- **Pan is audio-tracks-only** — video-track audio is not panned in preview or
  export (it gets volume + mute, centre pan). Add video-track pan if needed.
- **Stereo-source pan parity** — export pan is *sample-exact for mono* sources
  but an equal-power *balance* approximation for already-stereo sources (preview
  uses WebAudio `StereoPannerNode`'s redistribute algorithm). Fine for typical
  use; revisit if exact stereo parity is required.
- **Gate/duck preview vs export parity** — the preview AudioWorklet approximates
  FFmpeg `agate`/`sidechaincompress` (same knobs/units, perceptually matched, not
  sample-identical). Also: the duck key taps the trigger **pre-gate** in preview
  but **post-gate** in export — differs only when the trigger track is itself
  gated. Preview is the WYSIWYG reference.
- **Ducking has no attenuation floor** — `sidechaincompress` has no range param
  and caps ratio at 20, so very deep ducking isn't possible (preview matches, no
  floor). A parallel-bus emulation could add a floor later if wanted.
- **Gate/duck apply to audio tracks only** — video-track audio bypasses the
  per-track dynamics chain in preview. Revisit if video-track gating is needed.

## Candidate features (Vegas-style, not yet built — rough priority)

1. **Reverb** — true convolution reverb: a native `ConvolverNode` (preview) + a shared
   impulse-response WAV echoed by FFmpeg `afir` (export) for WYSIWYG parity. Needs the
   per-track audio chain to gain a native wet/dry node (graph rewiring) — its own pass.
2. **i18n full coverage** — framework + switcher + chrome shipped; sweep the remaining
   Inspector/Transport/MediaBin strings into the dictionary (incremental).
3. **Rubber-band marquee** selection (shift/ctrl-click + group ops shipped; marquee deferred).
4. **Track management** — reorder, add/remove video tracks, resize lane height.
5. **Export presets** — resolution / bitrate / format presets.
6. **Proxy / optimized media** for heavy footage.
7. **Transport niceties** — J/K/L shuttle, frame-step, audio scrubbing.
8. **Preview quality setting** — render the preview at half resolution for perf
   (deferred from Options to avoid touching the compositor before transform).
9. **Hardware export encoder** — h264_nvenc / qsv / amf with x264 fallback; needs
   encoder probing + per-encoder args (deferred from Options; CRF/preset shipped).
10. **Color curves / scopes** — beyond primary grade: RGB curves, histogram/vectorscope.

## Done

- **Per-track mixer** — volume (dB) + pan, preview + export (mono pan sample-exact).
- **Audio crossfades** — `X` crossfades a clip with its nearest neighbour; rides
  the fade/`amix` machinery; fade-ramp visuals on the timeline.
- **Noise gate + ducking** — per-track noise gate (`agate` / AudioWorklet) and
  sidechain ducking (`sidechaincompress` / AudioWorklet), with preview↔export
  parity. Select an audio track → Inspector → Noise Gate / Ducking.
- **Options / Settings** — persisted (`userData/settings.json`), applied live:
  hardware acceleration, placeholders, snapping, waveforms, default fade, export
  preset + CRF, theme presets, accent colour, density, reduce motion. ⚙ / Ctrl+,.
- **Per-clip transform + keyframes** — scale / position / rotation / crop + opacity,
  animatable via a stopwatch + auto-keyframe (Inspector → Transform), with Ken Burns
  / Fill / Reset presets and timeline keyframe diamonds. One pure evaluator shared by
  preview + export (WYSIWYG); split & head-trim rebase keyframe times.
- **AI auto-reframe** — local object detection (`yolos-tiny` via transformers.js, Web
  Worker) tracks the subject across a video clip and writes smoothed follow keyframes
  (position) + a zoom. Inspector → Transform → 🎯 AI Reframe. Aspect-correct framing,
  cancellable, off-thread.
- **Premium button effects** — gradient depth, hover specular sheen, accent glow on
  primary/active buttons; honors the Reduce-motion setting.
- **Color correction** — exposure / contrast / saturation / temperature / tint in the
  fragment shader (neutral = byte-identical), shared by preview + export. Inspector → Color.
- **Speed / velocity** — per-clip 0.25×–4× slow-mo/fast-forward; video retimes in
  preview + export, audio pitches with speed (BufferSource/`<video>`/`asetrate`),
  trim & split account for source consumption. Inspector → Speed.
- **Track EQ + Compressor** — per-track 3-band EQ (RBJ biquads) + compressor, added
  to the `cutroom-dynamics` AudioWorklet (preview) and `bass`/`equalizer`/`treble` +
  `acompressor` on export. Select an audio track → Inspector → EQ / Compressor.
- **Timeline markers** — `M` adds, ruler flags, click select+seek / right-click delete,
  `,`/`.` jump, Inspector label/colour. Persisted; regions render (point creation in-app).
- **Multi-clip selection** — shift/ctrl-click, Ctrl+A, Esc; group move/delete/ripple;
  Ctrl+C/V copy-paste at playhead (fresh ids, project-isolated). `selectedClipId` = primary.
- **Normalize** — one-click per-track peak-normalize (sets the track gain to −1 dBFS;
  parity-perfect since it's just a gain). Inspector → track → Normalize.
- **i18n / languages** — `t()`/`useT()` framework (English = key, fallback-safe), EN/ES/FR/DE
  dictionaries, language switcher in Options; chrome (top bar, Options, Inspector) translated.
</content>
