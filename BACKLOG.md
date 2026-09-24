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
- **Mono-source level: preview vs export (pre-existing, measured)** — FFmpeg's
  `aformat` mono→stereo upmix is −3 dB, WebAudio's is unity. So a *mono* source is
  3 dB quieter in export than preview when it is panned off-centre (export upmixes
  then pans; preview pans mono at full level) or when its track runs the dynamics
  worklet (EQ/gate/comp/duck — the worklet upmixes at unity). Unpanned, worklet-free
  mono and all stereo sources match. Fix: build the pan with StereoPannerNode's exact
  mono/stereo matrices in one `pan` filter (the reverb wet branch already does, see
  `stereoPanFilter`) and upmix at unity where the preview does.
- **Reverb wet level on a ducked mono track** — the duck path forces stereo via
  `aformat` (−3 dB for mono) before the reverb split, so the wet follows the gap
  above in that one case. Reverb is otherwise sample-exact (see Done).

## Candidate features (Vegas-style, not yet built — rough priority)

1. **i18n full coverage** — framework + switcher + chrome shipped; sweep the remaining
   Inspector/Transport/MediaBin strings into the dictionary (incremental).
2. **Proxy / optimized media** for heavy footage.
3. **Transport niceties** — J/K/L shuttle, frame-step, audio scrubbing.
4. **Color curves / scopes** — beyond primary grade: RGB curves, histogram/vectorscope.

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
- **Reverb** — per-track convolution reverb (mix / decay / pre-delay / tone). One pure
  seeded IR generator (`src/shared/reverb.ts`) feeds the preview `ConvolverNode`
  (normalize off) and a float-WAV IR for FFmpeg `afir` (`irnorm=-1`, no auto-gain);
  equal-power dry/wet, post-duck/pre-pan. Measured vs Chromium: wet sample-exact
  (≤ −107 dB error). Select an audio track → Inspector → Reverb.
- **Preview quality** — Full / Half / Quarter preview resolution (Options → Performance);
  the compositor renders a smaller backing canvas, CSS keeps the size, export stays full.
- **i18n / languages** — `t()`/`useT()` framework (English = key, fallback-safe), EN/ES/FR/DE
  dictionaries, language switcher in Options; chrome (top bar, Options, Inspector) translated.
- **Rubber-band marquee** — drag on empty lane space to box-select clips (Shift/Ctrl adds);
  scroll-aware; a plain click still deselects + seeks. Pure hit-test in `lib/tracks.ts`.
- **Track management** — `+ Video` / `+ Audio`, delete (confirm if it has clips; last video /
  audio track kept), reorder (drag header, right-click menu, Inspector ▲/▼ = compositor stacking),
  drag a lane's bottom edge to resize (36–200 px, saved). All undoable.
- **Export presets** — Export modal picks format (MP4 H.264 / MP4 HEVC / WebM VP9+Opus),
  resolution (project / 2160–480p / vertical 1080×1920, Lanczos fit, even dims), CRF or
  4–40 Mbps, plus named presets (YouTube, Reels/TikTok, master, small 720p); remembered.
- **Hardware export encoder** — NVENC / QSV / AMF / VideoToolbox probed once in main (listed +
  tiny test encode); Encoder = Auto / Software / detected; a failed hw encode retries in software.
