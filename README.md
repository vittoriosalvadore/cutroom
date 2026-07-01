# Cutroom

A free, open-source, non-linear video editor built from scratch with Electron, TypeScript, and React.
Works on Windows and Linux. No subscription, no watermark, no cloud.

> **Download:** grab the latest installer from the [Releases](../../releases/latest) page.

---

## Features

**Timeline & editing**
- Multi-track timeline — video, audio, and image tracks
- Drag clips to move, trim handles to resize, S to split at playhead
- Multi-select, copy/paste, ripple delete
- Undo / redo (full history)
- Markers with keyboard navigation (M to add, , / . to jump)
- Clip speed / rate change
- Audio crossfade between adjacent clips (X)
- Snap-to-clip and playhead scrubbing

**Preview**
- Real-time WebGL compositor — what you see is what you export (WYSIWYG)
- Frame-accurate playback with audio sync
- Color correction per clip (brightness, contrast, saturation, temperature)
- Transform: scale, position, rotation per clip

**Audio**
- Per-track volume, pan, fade in/out
- Per-track 3-band EQ (low / mid / high)
- Noise gate with attack/release
- Compressor with makeup gain
- Sidechain ducking between tracks
- Mute / solo

**Export**
- H.264 / AAC MP4 via bundled FFmpeg (no install required)
- Configurable CRF quality and encoder preset
- Export matches preview exactly (same WebGL pipeline)

**AI features**
- **Auto-subtitles** — transcribe any clip locally with Whisper (no internet, no API key)
- **Auto-reframe** — AI crop to 9:16, 1:1, or any aspect ratio

**Other**
- Save / load projects (`.cutroom` JSON files)
- Crash recovery — autosave every second
- Drag-and-drop media import (video, audio, images)
- Dark / light theme
- Keyboard shortcuts for everything

---

## Download & install

Go to the [Releases](../../releases/latest) page and download:

| Platform | File |
|----------|------|
| Windows | `Cutroom Setup x.x.x.exe` (NSIS one-click installer) |
| Linux | `Cutroom-x.x.x.AppImage` (no install, just run) |

**Windows note:** the installer and app are unsigned (no EV certificate). Windows SmartScreen will show a "Windows protected your PC" warning on first run — click **More info → Run anyway**. This is a one-time prompt.

---

## Build from source

Requirements: **Node.js 18+**

```bash
git clone https://github.com/YOUR_USERNAME/cutroom.git
cd cutroom
npm install
npm run dev          # launch with hot-reload
```

To build a distributable:

```bash
npm run package:win      # Windows .exe installer  (run on Windows)
npm run package:linux    # Linux AppImage           (run on Linux)
npm run package:mac      # macOS .dmg               (run on macOS)
```

Output goes to `dist/`.

Other scripts:

```bash
npm run typecheck    # TypeScript check (main + preload + renderer)
npm run test         # run unit tests
npm run build        # compile to out/ without packaging
```

---

## Tech stack

| Layer | Technology |
|-------|------------|
| App shell | Electron 33 |
| Build | electron-vite, Vite 5 |
| UI | React 18, TypeScript |
| State | Zustand |
| Preview / export | WebGL compositor (shared pipeline) |
| Video encoding | FFmpeg (bundled via ffmpeg-static) |
| AI transcription | Whisper via @xenova/transformers (runs locally) |

---

## Support the project

Cutroom is free and open-source. If it saves you time or money, consider buying me a coffee:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/YOUR_KOFI_USERNAME)

---

## Contributing

Bug reports and pull requests are welcome. Please open an issue first for larger changes.

---

## License

MIT — see [LICENSE](LICENSE).

FFmpeg is bundled as a static binary and is subject to its own license (LGPL/GPL depending on build configuration). See [ffmpeg.org/legal](https://ffmpeg.org/legal.html).
