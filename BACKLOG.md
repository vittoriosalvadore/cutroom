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
- **Mixed mono + stereo clips on one panned track (FX projects)** — when a project
  uses track FX, a plain track's clips are summed (`amix`) *before* its pan, so a
  mono clip sharing a track with a stereo clip is up-mixed at −3 dB and then gets
  the stereo pan law; the preview pans each clip with the law for whatever is
  playing at that instant (mono law for the mono clip). Identical when centred;
  differs only for a panned track that holds both kinds. The flat (no-FX) export
  pans per clip and is exact.
- **Dynamics worklet stays in after its FX are turned off (preview)** — once a
  track has had EQ/gate/comp/duck on, the preview keeps the worklet inserted
  (passthrough, so toggling never clicks). Its 2-channel input up-mixes mono at
  unity, so a *mono* source on that track stays 3 dB louder (centred) than a fresh
  preview or the export until the project is reopened. Stereo sources unaffected.
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
- **Audio scrubbing skips `<video>`-element audio** — scrub grains are cut from
  decoded AudioBuffers, which exist for audio media (and denoised clips). A plain
  video-track clip's audio lives only in its `<video>` element, so it is silent
  while scrubbing/shuttling (1× playback is unaffected). Grains also play at the
  clip's normal pitch whatever the shuttle speed.

## Candidate features (Vegas-style, not yet built — rough priority)

1. **Proxy / optimized media** for heavy footage.
2. **Color curves / scopes** — beyond primary grade: RGB curves, histogram/vectorscope.

## Done

- **Per-track mixer** — volume (dB) + pan, preview + export (pan sample-exact for mono and
  stereo sources, see Mono/stereo level parity).
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
- **Transport niceties** — J/K/L shuttle (L/J forward/reverse, repeat for 2×/4×, K pauses; off-1×
  rates scrub the preview frame-paced with scrub-grain audio; rate badge in the transport), ←/→ frame
  step and Shift+←/→ one second. Stops at the timeline end / at 0.
- **i18n full coverage** — every Inspector/Transport/MediaBin/Timeline/modal string goes through
  `t()` with ES/FR/DE translations and `{name}` interpolation; a test fails on any untranslated key.
- **Mono/stereo level parity** — the export now reproduces WebAudio's channel handling instead of
  FFmpeg's −3 dB mono→stereo conversion: one `pan` filter carries StereoPannerNode's mono law (on
  FC) *and* stereo law (on FL/FR) — `pan` drops terms for channels the input lacks, so it works
  without knowing the channel count — and a unity up-mix (`FL=FL+FC|FR=FR+FC`) goes wherever the
  preview up-mixes at unity: tracks running the dynamics worklet, the duck key, the reverb wet, and
  `<video>`-tap clips. Measured vs Chromium (16 mono/stereo × pan × EQ/reverb/duck/video cases):
  ≤ −87 dB error (EQ cases, float32 worklet biquads), ≤ −105 dB elsewhere; was 3 dB off for mono.
- **Audio scrubbing** — dragging the ruler playhead or shuttling off 1× (incl. reverse) plays ~70 ms
  windowed grains of the audio under the playhead through each clip's track chain (mute / gain /
  pan / FX / reverb), at most every 45 ms and only when the playhead moved; reverse plays the audio
  just before the playhead backwards. Options → Editing → Audio scrubbing (on by default).
