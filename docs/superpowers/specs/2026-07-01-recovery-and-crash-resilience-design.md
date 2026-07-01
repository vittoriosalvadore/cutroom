# Recovery & Crash Resilience — Phase 1 Design

**Status:** Approved (Approach A — rotating snapshots)
**Date:** 2026-07-01
**Branch:** `feat/recovery-and-crash-resilience`

## North star

Cutroom must be optimized, crashless (or fully recoverable when it does), and
smooth — the anti-Adobe / anti-Vegas. FOSS + donations-only (already true:
MIT license, Ko-fi wired). This phase targets the "crashless and recoverable"
half of that north star.

## Problem statement

The current recovery system is solid **for the happy path** but has concrete
single-points-of-failure and unhandled crash surfaces. Specifically:

| Failure | Today | Result |
|---|---|---|
| `recovery.json` corrupts (disk full, partial write, huge project) | Single file, overwritten each autosave | Prior good state gone — no second layer |
| Renderer OOM / hard crash before React's `ErrorBoundary` runs | Only the boundary writes `recovery.pending` | Recovery not even offered |
| GPU process crash (`gpu-process-crashed`) | Not handled | Renderer loses WebGL, freezes |
| WebGL context lost (`webglcontextlost`) on heavy GPU | Not handled | Black preview / apparent crash — the exact Premiere/Vegas symptom |
| Mid-session degenerate state (not a full crash) | Only the undo stack | No safety net below undo |
| "Is it actually crashless?" | Untested | Hope, not verification |

The WebGL black screen is indistinguishable from a crash to a user, and the
single recovery file violates "second layers to recover everything."

## Chosen approach: Rotating snapshots + broadened detection (Approach A)

Keep the existing architecture; add defense in depth. Accept at most ~1s of
lost work on a hard crash (the autosave window). Zero-loss journaling is
deferred to Phase 4+, where it becomes natural after the store refactor
formalizes the undo contract.

## Design

### 1. Rotating recovery ring (the "second layer")

**Goal:** a single corrupt write can never destroy the prior good state.

A ring of N=3 backups plus the primary lives in `userData`:

```
recovery.json      (primary — newest)
recovery.1.json    (one autosave older)
recovery.2.json
recovery.3.json    (oldest, drops off the ring)
```

**On every autosave** (`project:writeRecovery`), rotate down before writing:

1. Delete `recovery.3.json` if present (it falls off the ring).
2. `recovery.2.json` → `recovery.3.json`
3. `recovery.1.json` → `recovery.2.json`
4. `recovery.json` → `recovery.1.json`
5. Write fresh `recovery.json` atomically (`.tmp` → `rename` — existing pattern).

**Recovery on launch** (`project:checkRecovery`): read `recovery.json`; if it
is missing, empty, or fails JSON parse / schema validation, **walk the ring**
(`recovery.1` → `recovery.2` → `recovery.3`) and offer the newest file that
parses. The modal surfaces that a fallback was used, e.g. "Recovering from a
backup snapshot (older than the primary)."

**Ring size = 3 backups** (4 files total): deep enough to survive a corruption
burst, shallow enough not to collect stale states nobody reaches for. Each file
is one project JSON, so storage is negligible.

**Clear on explicit Save:** `Ctrl+S` (the `markSaved` path) clears the whole
ring — a saved project needs no recovery offer. Matches today's `markSaved`
behavior, extended to the ring.

**Why not tighter cadence:** the failure mode of a corrupt write is the lack of
fallback, not the cadence. The 1s debounce stays. Sub-second safety is the
journaling path, consciously deferred.

**Where this lives:** all rotation logic in the **main process**
(`src/main/recoveryRing.ts` — a new pure, Node-testable module), with
`projectStore.ts` calling into it. The renderer's IPC call renames from
`writeRecovery` to `writeRecoveryRing` but the API is a single `json` string,
unchanged shape.

### 2. Broadened crash detection

**Goal:** catch the crashes the React boundary can't.

All in the **main process** (`src/main/index.ts` + a new pure
`src/main/crashFlags.ts` helper):

| Signal | Event | Action |
|---|---|---|
| Renderer gone | `webContents.on('render-process-gone', …)` — reasons: `oom`, `crashed`, `killed` | `writeRecoveryPending()` |
| GPU process crashed | `app.on('child-process-gone', …)` with `details.type === 'GPU'` (the typed Electron 33 event; the legacy `gpu-process-crashed` name is untyped on the `App` interface) | `flagRecoveryPending()` |
| Renderer frozen | `webContents.on('unresponsive', …)` | `writeRecoveryPending()` + log |
| Main uncaught | `process.on('uncaughtException'/'unhandledRejection', …)` | already kept-alive; add: ensure the ring is left intact (do NOT clear `recovery.pending`) so the next launch still offers recovery. The main process has no project state of its own to flush — it only holds whatever the renderer last handed it, which is already in the ring. |

**Renderer last-resort net** (below React's boundary): a `window` `error` +
`unhandledrejection` listener that calls `markRecoveryPending()` and attempts a
final recovery flush. Catches throws outside React's tree.

**`crashFlags.ts` (pure, testable):** the decision "given an event reason, do
we flag?" is a pure function (e.g. `render-process-gone` with reason `oom` →
flag; reason `clean-exit` → don't). Extracted so the logic is unit-testable
without a real `BrowserWindow`.

### 3. WebGL / GPU context-loss recovery

**Goal:** a lost GPU context never looks like a crash.

**`webglcontextlost`:**
- `event.preventDefault()` (signals we'll restore).
- The `Compositor` enters a `reconnecting` state; the render loop pauses.
- The `Preview` shows a non-blocking "Reconnecting GPU…" overlay (no modal,
  no user action needed).

**`webglcontextrestored`:**
- The `Compositor` rebuilds its GL program, quad buffer, attribute/uniform
  locations. Textures repopulate lazily on the next frame (existing content-
  keyed caches already support this).
- Render loop resumes. **No data loss, no user action.**

**Compositor constructor hardening:** `gl.getContext('webgl', …)` can return
null or throw on a failed GPU. Wrap it so a missing context surfaces a
"WebGL unavailable" state with a Retry button, instead of an unhandled throw
that blanks the window.

**GPU process crash:** if `gpu-process-crashed` fires (Section 2), the main
process reloads the renderer, which re-acquires a fresh context. The recovery
ring + pending flag means a reload can still offer recovered work.

### 4. In-memory rollback ring

**Goal:** a safety net for the non-crash catastrophe — a degenerate state
reached mid-session that the user wants to back out hard.

A small ring (4 entries) of `Project` references held in the store, fed from
the autosave subscription (not the undo stack, which a bug could also corrupt).
Conceptually mirrors `past[]` but is independent of it. Costs ~4× a project
object reference in memory — negligible.

**Feed condition:** a snapshot is pushed into the in-memory ring on the same
1s autosave tick (when `state.project !== prev.project`), NOT on every undo
step. This keeps it cheap and decouples it from the history stack's
correctness — if a bug corrupts `past[]`, the rollback ring is untouched.

This is a thin layer, not a new subsystem: it shares the autosave tick that
already exists in `App.tsx`.

### 5. Test harness (verifiable, not hoped-for)

Every logic seam that can run in Node, runs in Node — mirroring how
`editing.ts` / `silence.ts` are structured today.

- **`recoveryRing.test.ts`** (new, main-process-pure):
  - rotate preserves order across N writes.
  - corrupt primary → falls back to `.1`.
  - corrupt primary + `.1` → falls back to `.2`.
  - all corrupt → offers nothing cleanly (no throw).
  - `clear()` empties the ring.
  - partial-write tolerance: a truncated `.json` is detected and skipped.
- **`crashFlags.test.ts`** (new, pure): each `render-process-gone` reason maps
  to flag/no-flag; `gpu-process-crashed` → flag; `unresponsive` → flag.
- **`webglRestore.test.ts`** (new): the context-loss state machine
  (idle → reconnecting → restored / failed) transitions correctly; a restore
  triggers exactly one rebuild.

The actual Electron/`BrowserWindow`/WebGL wiring is thin glue over these pure
cores, not the thing under test.

## Non-goals (deferred)

- **Zero-edit-loss op-journaling** — deferred to Phase 4+ (natural after the
  store refactor formalizes the undo contract).
- **WebCodecs decode** — Phase 2 (smoothness).
- **Feature work** (video transitions, encoders, marquee) — Phase 3.
- **Telemetry/remote crash reporting** — out of scope; FOSS, local-first. The
  crash detection here is for *recovery*, not reporting. Logs stay local.

## Verification

- `npm run typecheck` — clean.
- `npm test` — existing 151 tests still pass; new tests added for each pure
  module above (target: ~+25 tests).
- Manual smoke test matrix documented in the implementation plan:
  - kill renderer devtools → recovery offered.
  - corrupt `recovery.json` by hand → falls back to `.1` and offers it.
  - trigger synthetic context loss → preview recovers without reload.

## Files touched (summary)

**New (main, pure-testable):**
- `src/main/recoveryRing.ts` + `src/main/recoveryRing.test.ts`
- `src/main/crashFlags.ts` + `src/main/crashFlags.test.ts`

**New (renderer):**
- `src/renderer/src/lib/webglRestore.ts` + `src/renderer/src/lib/webglRestore.test.ts`
  (the state machine; compositor calls into it)

**Modified (main):**
- `src/main/projectStore.ts` — calls `recoveryRing`, exposes the walk-to-fallback
- `src/main/index.ts` — wires the crash signals via `crashFlags`

**Modified (renderer):**
- `src/renderer/src/lib/compositor.ts` — context-loss/restore + constructor guard
- `src/renderer/src/components/Preview.tsx` — "Reconnecting GPU…" overlay
- `src/renderer/src/components/RecoveryModal.tsx` — fallback-from-snapshot messaging
- `src/renderer/src/state/store.ts` — in-memory rollback ring
- `src/renderer/src/App.tsx` — renderer last-resort error listeners + rollback feed
