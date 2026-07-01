# Recovery & Crash Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cutroom crashless-or-recoverable with redundant recovery layers, so no single failure (corrupt file, OOM, GPU context loss) can lose the user's work or look like a crash.

**Architecture:** Rotating recovery file ring (N=3 backups) in the main process as the on-disk "second layer"; broadened main-process crash detection (`render-process-gone`, `gpu-process-crashed`, `unresponsive`) plus a renderer last-resort listener; WebGL/GPU context-loss recovery in the compositor so a lost context restores instead of black-screening; an in-memory rollback ring for mid-session catastrophes. All hard logic extracted into pure Node-testable modules mirroring the `editing.ts`/`silence.ts` convention.

**Tech Stack:** Electron 33 (main process IPC + `app`/`webContents` events), React 18, Zustand, WebGL, TypeScript, Vitest (node env).

---

## File Structure

**New (main process, pure-testable):**
- `src/main/recoveryRing.ts` — ring rotation + walk-to-fallback logic. No Electron deps. Pure functions over a directory + filename scheme.
- `src/main/recoveryRing.test.ts` — rotation order, corrupt-primary fallback, all-corrupt, clear, partial-write tolerance.
- `src/main/crashFlags.ts` — pure decision: given an event kind + reason, should we flag recovery pending? No Electron deps.
- `src/main/crashFlags.test.ts` — each reason → flag/no-flag.

**New (renderer, pure-testable):**
- `src/renderer/src/lib/webglRestore.ts` — context-loss state machine (idle → reconnecting → restored / failed). No DOM deps.
- `src/renderer/src/lib/webglRestore.test.ts` — transition correctness.

**Modified (main process):**
- `src/main/projectStore.ts` — call `recoveryRing` from the IPC handlers; expose walk-to-fallback in `checkRecovery`; clear the ring in a new `clearRecoveryRing` path.
- `src/main/index.ts` — wire `render-process-gone` / `gpu-process-crashed` / `unresponsive` via `crashFlags`; reload renderer on GPU crash.

**Modified (renderer):**
- `src/renderer/src/lib/compositor.ts` — context-loss/restore handling (preventDefault, rebuild) + constructor guard already exists (keep).
- `src/renderer/src/components/Preview.tsx` — canvas context-loss listeners, "Reconnecting GPU…" overlay.
- `src/renderer/src/components/RecoveryModal.tsx` — fallback-from-snapshot messaging.
- `src/renderer/src/state/store.ts` — in-memory rollback ring.
- `src/renderer/src/App.tsx` — renderer last-resort `window` error listeners + rollback feed.
- `src/preload/index.ts` — add `clearRecoveryRing` IPC (clears ring on explicit save); keep `writeRecovery` name stable but it now drives the ring.
- `src/renderer/src/global.d.ts` — no change (typed via `CutroomApi`).

---

## Task 1: Recovery ring — pure rotation + fallback module

**Files:**
- Create: `src/main/recoveryRing.ts`
- Test: `src/main/recoveryRing.test.ts`

- [ ] **Step 1: Write the failing test (rotation order)**

Create `src/main/recoveryRing.test.ts`:

```typescript
import { rm, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeRing, findNewestValid, clearRing, RING_SLOTS } from './recoveryRing'

const TMP = join(__dirname, '__ringtmp__')

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8')
  } catch {
    return null
  }
}

describe('recoveryRing', () => {
  beforeEach(async () => {
    await rm(TMP, { recursive: true, force: true })
    await mkdir(TMP, { recursive: true })
  })
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true })
  })

  it('writes the primary and rotates older snapshots down on each write', async () => {
    await writeRing(TMP, 'one')
    await writeRing(TMP, 'two')
    await writeRing(TMP, 'three')

    expect(await readIfExists(join(TMP, 'recovery.json'))).toBe('three')
    expect(await readIfExists(join(TMP, 'recovery.1.json'))).toBe('two')
    expect(await readIfExists(join(TMP, 'recovery.2.json'))).toBe('one')
  })

  it('keeps at most RING_SLOTS backups (oldest drops off)', async () => {
    for (let i = 0; i < RING_SLOTS + 2; i++) await writeRing(TMP, `v${i}`)
    // primary is the newest; .1..RING_SLOTS are older. Anything beyond drops.
    expect(await readIfExists(join(TMP, 'recovery.json'))).toBe(`v${RING_SLOTS + 1}`)
    expect(await readIfExists(join(TMP, `recovery.${RING_SLOTS}.json`))).toBe(`v1`)
    // v0 should have dropped off the bottom
    expect(await readIfExists(join(TMP, `recovery.${RING_SLOTS + 1}.json`))).toBeNull()
  })

  it('falls back to .1 when the primary is corrupt', async () => {
    await writeRing(TMP, 'good')
    await writeRing(TMP, 'better')
    // Corrupt the primary (partial / unparseable JSON).
    await writeFile(join(TMP, 'recovery.json'), '{ broken')

    const found = await findNewestValid(TMP, (raw) => {
      if (!raw || !raw.startsWith('g')) return null
      return raw
    })
    expect(found).toBe('good')
  })

  it('walks the whole ring when primary and .1 are both corrupt', async () => {
    await writeRing(TMP, 'good')
    await writeRing(TMP, 'better')
    await writeRing(TMP, 'best')
    await writeFile(join(TMP, 'recovery.json'), 'xxx')
    await writeFile(join(TMP, 'recovery.1.json'), 'yyy')

    const found = await findNewestValid(TMP, (raw) => (raw && raw.startsWith('g') ? raw : null))
    expect(found).toBe('good')
  })

  it('returns null cleanly when every file is corrupt (no throw)', async () => {
    await writeRing(TMP, 'good')
    await writeFile(join(TMP, 'recovery.json'), 'bad')
    await writeFile(join(TMP, 'recovery.1.json'), 'bad')
    const found = await findNewestValid(TMP, (raw) => (raw === 'good' ? raw : null))
    expect(found).toBeNull()
  })

  it('clearRing removes every ring file', async () => {
    await writeRing(TMP, 'one')
    await writeRing(TMP, 'two')
    await clearRing(TMP)
    expect(await readIfExists(join(TMP, 'recovery.json'))).toBeNull()
    expect(await readIfExists(join(TMP, 'recovery.1.json'))).toBeNull()
  })

  it('tolerates a truncated (empty) primary file', async () => {
    await writeRing(TMP, 'good')
    await writeFile(join(TMP, 'recovery.json'), '')
    const found = await findNewestValid(TMP, (raw) => (raw === 'good' ? raw : null))
    expect(found).toBe('good')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/recoveryRing.test.ts`
Expected: FAIL with "Cannot find module './recoveryRing'".

- [ ] **Step 3: Write the implementation**

Create `src/main/recoveryRing.ts`:

```typescript
import { rename, unlink, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Rotating recovery ring. A single corrupt write can never destroy the prior
// good state: each autosave rotates older snapshots down before writing the
// newest. On recovery, if the primary is missing/corrupt, we walk the ring to
// the newest valid file. Pure over a directory + fixed filename scheme, so it
// is unit-testable in plain Node (no Electron).
//
//   recovery.json      primary (newest)
//   recovery.1.json    one autosave older
//   ...
//   recovery.<N>.json  oldest — drops off when a newer one pushes down
// ---------------------------------------------------------------------------

/** Number of BACKUP slots (excluding the primary). 3 backups + 1 primary. */
export const RING_SLOTS = 3

function slotPath(dir: string, slot: number): string {
  return join(dir, slot === 0 ? 'recovery.json' : `recovery.${slot}.json`)
}

/**
 * Rotate down then atomically write the newest snapshot to the primary slot.
 * Rotation is best-effort per slot (a missing/unlinkable older file is skipped),
 * so a damaged filesystem degrades gracefully instead of throwing.
 */
export async function writeRing(dir: string, json: string): Promise<void> {
  // Drop the oldest slot (falls off the ring).
  const oldest = slotPath(dir, RING_SLOTS)
  if (existsSync(oldest)) {
    try {
      await unlink(oldest)
    } catch {
      /* non-fatal — a stuck file degrades the ring depth, not correctness */
    }
  }
  // Shift every populated slot down by one (N-1 -> N, ... 0 -> 1).
  for (let slot = RING_SLOTS - 1; slot >= 0; slot--) {
    const from = slotPath(dir, slot)
    const to = slotPath(dir, slot + 1)
    if (existsSync(from)) {
      try {
        await rename(from, to)
      } catch {
        /* non-fatal */
      }
    }
  }
  // Atomic write of the newest snapshot into the primary slot.
  const primary = slotPath(dir, 0)
  const tmp = `${primary}.tmp`
  await writeFile(tmp, json, 'utf-8')
  await rename(tmp, primary)
}

/**
 * Walk the ring from the primary (slot 0) down to the oldest, returning the
 * first slot whose contents `validate` accepts (non-null). Returns null when no
 * slot validates. `validate` returns a parsed value or null (for corrupt /
 * empty / unparseable content) so corruption-handling stays in the caller.
 */
export async function findNewestValid<T>(
  dir: string,
  validate: (raw: string) => T | null
): Promise<T | null> {
  for (let slot = 0; slot <= RING_SLOTS; slot++) {
    const p = slotPath(dir, slot)
    if (!existsSync(p)) continue
    let raw: string
    try {
      raw = await readFile(p, 'utf-8')
    } catch {
      continue
    }
    const parsed = validate(raw)
    if (parsed !== null && parsed !== undefined) return parsed
  }
  return null
}

/** Remove every file in the ring (called on explicit Save). Best-effort. */
export async function clearRing(dir: string): Promise<void> {
  for (let slot = 0; slot <= RING_SLOTS; slot++) {
    const p = slotPath(dir, slot)
    if (existsSync(p)) {
      try {
        await unlink(p)
      } catch {
        /* non-fatal */
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/recoveryRing.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/recoveryRing.ts src/main/recoveryRing.test.ts
git commit -m "feat: rotating recovery ring (pure module + tests)"
```

---

## Task 2: Wire the ring into projectStore (replace single-file recovery)

**Files:**
- Modify: `src/main/projectStore.ts`

- [ ] **Step 1: Read the current projectStore.ts to confirm exact handler bodies**

Run: read `src/main/projectStore.ts` (handlers: `project:writeRecovery`, `project:checkRecovery`, `project:clearRecovery`).

- [ ] **Step 2: Replace `writeRecovery` to call `writeRing`**

In `src/main/projectStore.ts`, add the import at the top (after the other `./` imports):

```typescript
import { writeRing, findNewestValid, clearRing } from './recoveryRing'
```

Replace the `project:writeRecovery` handler body (currently writes a single `recoveryFile`) with:

```typescript
  // Autosave the recovery snapshot into the rotating ring (silent, no dialog).
  ipcMain.handle('project:writeRecovery', async (_e, json: string) => {
    try {
      await writeRing(dir, json)
      return true
    } catch {
      return false
    }
  })
```

where `dir` is the `userData` path. Because `recoveryFile`, `pendingFile`, etc. are module-level strings set in `initProjectStore`, introduce a module-level `let recoveryDir = ''` and set it in `initProjectStore`:

```typescript
let recoveryDir = ''

/** Call once after app `ready`, before windows open. */
export function initProjectStore(): void {
  recoveryDir = app.getPath('userData')
  recoveryFile = join(recoveryDir, 'recovery.json')
  sessionLock = join(recoveryDir, 'session.lock')
  pendingFile = join(recoveryDir, 'recovery.pending')

  previousCrash = existsSync(sessionLock)
  try {
    writeFileSync(sessionLock, String(Date.now()))
  } catch {
    /* non-fatal */
  }
}
```

- [ ] **Step 3: Replace `checkRecovery` to walk the ring on corrupt primary**

Replace the `project:checkRecovery` handler body with one that parses via `findNewestValid` and reports whether it came from a backup:

```typescript
  // On launch the renderer asks whether to offer recovery. If the primary
  // recovery file is missing/corrupt, walk the backup ring to the newest valid
  // snapshot so a single bad write can't lose everything.
  ipcMain.handle('project:checkRecovery', async () => {
    try {
      if (!recoveryDir || !existsSync(recoveryFile)) return { available: false }
      if (!previousCrash && !existsSync(pendingFile)) return { available: false }

      let fromBackup = false
      const validate = (raw: string): { json: string; savedPath: string | null; timestamp: number; backup: boolean } | null => {
        try {
          const d = JSON.parse(raw)
          const savedPath = typeof d?.savedPath === 'string' ? d.savedPath : null
          const timestamp = typeof d?.timestamp === 'number' ? d.timestamp : 0
          return { json: raw, savedPath, timestamp, backup: false }
        } catch {
          return null
        }
      }
      // First try the primary.
      let found = validate(await readFile(recoveryFile, 'utf-8').catch(() => ''))
      // Walk the ring on corrupt primary.
      if (!found) {
        found = await findNewestValid(recoveryDir, (raw) => {
          const v = validate(raw)
          if (v) v.backup = true
          return v
        })
      }
      if (!found) return { available: false }
      return {
        available: true,
        json: found.json,
        savedPath: found.savedPath,
        timestamp: found.timestamp,
        fromBackup: found.backup
      }
    } catch {
      return { available: false }
    }
  })
```

- [ ] **Step 4: Make `clearRecovery` also clear the ring**

Replace the `project:clearRecovery` handler body with:

```typescript
  // User recovered or discarded — don't offer again this session. Also clear
  // the backup ring so a discarded session isn't offered next launch.
  ipcMain.handle('project:clearRecovery', async () => {
    try {
      if (existsSync(pendingFile)) await unlink(pendingFile)
      if (recoveryDir) await clearRing(recoveryDir)
    } catch {
      /* non-fatal */
    }
    previousCrash = false
    return true
  })
```

- [ ] **Step 5: Verify typecheck + full test suite still pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (recoveryRing tests included).

- [ ] **Step 6: Commit**

```bash
git add src/main/projectStore.ts
git commit -m "feat: projectStore uses the rotating recovery ring"
```

---

## Task 3: Clear the recovery ring on explicit Save

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/lib/projectIO.ts` (the `markSaved` path)
- Modify: `src/main/projectStore.ts`

- [ ] **Step 1: Add a `clearRecoveryRing` IPC handler (distinct from clearRecovery, which also discards the offer)**

In `src/main/projectStore.ts`, inside `registerProjectIpc`, add after the `project:clearRecovery` handler:

```typescript
  // On explicit Save (Ctrl+S), a saved project needs no recovery offer: clear
  // the ring + pending flag without touching the session lock. Distinct from
  // clearRecovery (which also discards a *crashed* session's offer).
  ipcMain.handle('project:clearRecoveryRing', async () => {
    try {
      if (existsSync(pendingFile)) await unlink(pendingFile)
      if (recoveryDir) await clearRing(recoveryDir)
    } catch {
      /* non-fatal */
    }
    return true
  })
```

- [ ] **Step 2: Expose it on the preload bridge**

In `src/preload/index.ts`, inside the `api` object, after `clearRecovery`:

```typescript
  /** Clear the recovery ring + pending flag (called on explicit Save). */
  clearRecoveryRing: (): Promise<boolean> => ipcRenderer.invoke('project:clearRecoveryRing'),
```

- [ ] **Step 3: Call it from the markSaved path**

In `src/renderer/src/state/store.ts`, find `markSaved` (currently `set((s) => ({ savedProject: s.project, projectFilePath: filePath }))`) and add the ring clear as a side effect. Since store actions should stay pure of IPC, do it in the existing `markSaved` by extending it:

```typescript
  markSaved: (filePath) =>
    set((s) => {
      void window.cutroom?.clearRecoveryRing()
      return { savedProject: s.project, projectFilePath: filePath }
    }),
```

- [ ] **Step 4: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/projectStore.ts src/preload/index.ts src/renderer/src/state/store.ts
git commit -m "feat: clear recovery ring on explicit Save"
```

---

## Task 4: crashFlags — pure crash-decision module

**Files:**
- Create: `src/main/crashFlags.ts`
- Test: `src/main/crashFlags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/crashFlags.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { shouldFlagRecovery } from './crashFlags'

describe('shouldFlagRecovery', () => {
  it('flags a renderer OOM', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'oom' })).toBe(true)
  })
  it('flags a renderer crash', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'crashed' })).toBe(true)
  })
  it('flags a killed renderer', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'killed' })).toBe(true)
  })
  it('does NOT flag a clean renderer exit', () => {
    expect(shouldFlagRecovery({ kind: 'render-process-gone', reason: 'clean-exit' })).toBe(false)
  })
  it('flags a GPU process crash', () => {
    expect(shouldFlagRecovery({ kind: 'gpu-process-crashed' })).toBe(true)
  })
  it('flags an unresponsive renderer', () => {
    expect(shouldFlagRecovery({ kind: 'unresponsive' })).toBe(true)
  })
  it('does not flag an unknown event', () => {
    expect(shouldFlagRecovery({ kind: 'something-else' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/crashFlags.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

Create `src/main/crashFlags.ts`:

```typescript
// ---------------------------------------------------------------------------
// Pure decision: given a process/window event, should we flag recovery pending
// so the next launch offers recovered work? Extracted from the Electron
// event-wiring so the decision is unit-testable without a BrowserWindow.
//
// Only events that imply lost work (a crash, OOM, or hang that the React
// ErrorBoundary likely didn't catch) are flagged. A clean renderer exit is not.
// ---------------------------------------------------------------------------

export type CrashEvent =
  | { kind: 'render-process-gone'; reason: string }
  | { kind: 'gpu-process-crashed' }
  | { kind: 'unresponsive' }
  | { kind: string } // catch-all for unknown events

export function shouldFlagRecovery(e: CrashEvent): boolean {
  if (e.kind === 'render-process-gone') {
    const reason = (e as { reason: string }).reason
    return reason !== 'clean-exit'
  }
  if (e.kind === 'gpu-process-crashed') return true
  if (e.kind === 'unresponsive') return true
  return false
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/crashFlags.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/crashFlags.ts src/main/crashFlags.test.ts
git commit -m "feat: pure crashFlags decision module + tests"
```

---

## Task 5: Wire crash detection into the main process

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/projectStore.ts` (expose a `flagRecoveryPending` for reuse)

- [ ] **Step 1: Export a reusable flag function from projectStore**

In `src/main/projectStore.ts`, add (module-level, exported):

```typescript
/** Write the recovery.pending flag so the next launch offers recovery. */
export async function flagRecoveryPending(): Promise<void> {
  if (!pendingFile) return
  try {
    await writeFile(pendingFile, '1', 'utf-8')
  } catch {
    /* non-fatal */
  }
}
```

And refactor the existing `project:markRecoveryPending` handler to call it:

```typescript
  // The renderer error boundary (or the main crash wiring) flags a crash.
  ipcMain.handle('project:markRecoveryPending', async () => {
    await flagRecoveryPending()
    return true
  })
```

(Add `writeFile` to the existing `fs/promises` import if not already present — it is, per the current file.)

- [ ] **Step 2: Wire the crash signals in index.ts**

In `src/main/index.ts`, add imports near the top:

```typescript
import { shouldFlagRecovery } from './crashFlags'
import { flagRecoveryPending } from './projectStore'
```

In `createWindow()`, after `mainWindow.on('ready-to-show', …)`, add listeners (capture `mainWindow` via the closure):

```typescript
  // Crash detection: flag recovery when the renderer dies abnormally (OOM,
  // native crash, kill) so the next launch offers recovered work. The React
  // ErrorBoundary only catches throws inside its tree; these catch the rest.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (shouldFlagRecovery({ kind: 'render-process-gone', reason: details.reason })) {
      void flagRecoveryPending()
    }
  })
  mainWindow.webContents.on('unresponsive', () => {
    if (shouldFlagRecovery({ kind: 'unresponsive' })) void flagRecoveryPending()
  })
```

After `createWindow()` is called in `app.whenReady().then(...)`, add the GPU handler at the `app` level:

```typescript
app.on('gpu-process-crashed', () => {
  if (shouldFlagRecovery({ kind: 'gpu-process-crashed' })) {
    void flagRecoveryPending()
  }
  // The GPU process restarting is handled by Electron itself; a lost WebGL
  // context is recovered in the compositor (webglcontextlost/restored).
})
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 4: Commit**

```bash
git add src/main/projectStore.ts src/main/index.ts
git commit -m "feat: main-process crash detection (render-gone/gpu/unresponsive)"
```

---

## Task 6: webglRestore — context-loss state machine

**Files:**
- Create: `src/renderer/src/lib/webglRestore.ts`
- Test: `src/renderer/src/lib/webglRestore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/webglRestore.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { RestoreMachine } from './webglRestore'

describe('webglRestore.RestoreMachine', () => {
  it('starts idle', () => {
    const m = new RestoreMachine()
    expect(m.state).toBe('idle')
  })

  it('enters reconnecting on context loss and requests a rebuild on restore', () => {
    const m = new RestoreMachine()
    m.onLost()
    expect(m.state).toBe('reconnecting')
    const needsRebuild = m.onRestored()
    expect(needsRebuild).toBe(true)
    expect(m.state).toBe('idle')
  })

  it('does not request a rebuild when restoring from idle (no loss happened)', () => {
    const m = new RestoreMachine()
    expect(m.onRestored()).toBe(false)
    expect(m.state).toBe('idle')
  })

  it('enters failed after MAX_RETRIES consecutive losses without a stable frame', () => {
    const m = new RestoreMachine()
    for (let i = 0; i < m.maxRetries; i++) {
      m.onLost()
      m.onRestored() // restored but immediately lost again next loop
    }
    m.onLost()
    expect(m.state).toBe('failed')
  })

  it('resets the retry counter after a stable idle period', () => {
    const m = new RestoreMachine()
    m.onLost()
    m.onRestored()
    m.markStable()
    // Now a fresh loss should not carry prior retries.
    m.onLost()
    m.onRestored()
    expect(m.state).toBe('idle')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/lib/webglRestore.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/lib/webglRestore.ts`:

```typescript
// ---------------------------------------------------------------------------
// WebGL context-loss state machine. A lost GPU context must look like
// "reconnecting", not a crash. Pure transitions (no DOM) so it is unit-testable;
// the compositor/Preview own the actual GL rebuild + canvas listeners.
//
//   idle  --onLost-->  reconnecting  --onRestored-->  idle (rebuild once)
//                                   \
//                                    --too many losses-->  failed
// ---------------------------------------------------------------------------

export type RestoreState = 'idle' | 'reconnecting' | 'failed'

export class RestoreMachine {
  state: RestoreState = 'idle'
  /** Max consecutive loss/restore cycles before we give up and surface "failed". */
  readonly maxRetries = 5
  private retries = 0

  /** Call from the webglcontextlost handler. */
  onLost(): void {
    if (this.state === 'failed') return
    this.state = 'reconnecting'
  }

  /**
   * Call from the webglcontextrestored handler. Returns true if the caller must
   * rebuild the GL program/textures now (exactly once per restore). Returns
   * false when no loss happened (spurious restore).
   */
  onRestored(): boolean {
    if (this.state !== 'reconnecting') return false
    this.retries++
    if (this.retries >= this.maxRetries) {
      this.state = 'failed'
      return true // still rebuild this last time; UI surfaces failure after
    }
    this.state = 'idle'
    return true
  }

  /** Call once a restored context has survived a stable render cycle. */
  markStable(): void {
    this.retries = 0
    if (this.state !== 'failed') this.state = 'idle'
  }

  /** Reset to initial (e.g. on a deliberate compositor recreate). */
  reset(): void {
    this.retries = 0
    this.state = 'idle'
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/src/lib/webglRestore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/webglRestore.ts src/renderer/src/lib/webglRestore.test.ts
git commit -m "feat: webglRestore context-loss state machine + tests"
```

---

## Task 7: Compositor — context-loss/restore + rebuild

**Files:**
- Modify: `src/renderer/src/lib/compositor.ts`

- [ ] **Step 1: Read the current Compositor constructor + GL setup**

Confirm the constructor builds `prog`, `quad`, `aPos`, `u` (uniform table) once. These are what a restore must rebuild.

- [ ] **Step 2: Add a `rebuildGL()` method and a `handleContextLoss()` API**

At the top of `compositor.ts`, import the state machine:

```typescript
import { RestoreMachine } from './webglRestore'
```

Add a private field + public accessor on the `Compositor` class (near the other private fields):

```typescript
  private restore = new RestoreMachine()
  /** True while a lost WebGL context is being recovered (drives the overlay). */
  get restoring(): boolean {
    return this.restore.state === 'reconnecting'
  }
  /** True when the context could not be recovered (terminal). */
  get restoreFailed(): boolean {
    return this.restore.state === 'failed'
  }
```

Add the loss/restore handlers (public, called by Preview's canvas listeners):

```typescript
  /** Call from the canvas 'webglcontextlost' listener. */
  handleContextLoss(e: Event): void {
    e.preventDefault()
    this.restore.onLost()
    // Drop cached GL resources — they belong to the dead context.
    this.images.clear()
    this.canvasCache.clear()
    this.videoTextures.clear()
    this.cacheOrder = []
    this.textKeyCache.clear()
    this.clipsByTrackRef = null
  }

  /** Call from the canvas 'webglcontextrestored' listener. */
  handleContextRestore(): void {
    const needsRebuild = this.restore.onRestored()
    if (needsRebuild) this.rebuildGL()
    // The next render() repopulates textures lazily from the content caches.
  }

  /** Re-acquire the GL context and rebuild program/buffers after a restore. */
  private rebuildGL(): void {
    const gl = this.gl
    // Re-link the program (compiles are cached internally by the driver, but the
    // program object is context-bound; rebuild from source to be safe).
    gl.useProgram(null)
    const prog = this.buildProgram(VERT, FRAG)
    this.prog = prog
    gl.useProgram(prog)

    this.quad = gl.createBuffer() as WebGLBuffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

    this.aPos = gl.getAttribLocation(prog, 'aPos')
    for (const name of [
      'uRect', 'uTex', 'uUseTex', 'uColor', 'uOpacity', 'uChroma', 'uKey', 'uSim', 'uSmooth', 'uSpill',
      'uUVMin', 'uUVMax', 'uTrans', 'uScale', 'uRot', 'uAspect', 'uAnchor',
      'uColorOn', 'uExposure', 'uContrast', 'uSaturation', 'uTemp', 'uTint'
    ]) {
      this.u[name] = gl.getUniformLocation(prog, name)
    }
  }
```

- [ ] **Step 3: Make render() a no-op while reconnecting**

At the top of `render(...)`, before the viewport/clear work, add:

```typescript
    if (this.restore.state === 'reconnecting') return // wait for restore
```

- [ ] **Step 4: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass (no behavioral change to existing tests; the GL rebuild path is exercised only on a real context loss).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/compositor.ts
git commit -m "feat: compositor handles WebGL context loss/restore"
```

---

## Task 8: Preview — canvas listeners + reconnecting overlay

**Files:**
- Modify: `src/renderer/src/components/Preview.tsx`

- [ ] **Step 1: Add context-loss listeners + overlay state**

In `src/renderer/src/components/Preview.tsx`, add a state for the restore status and wire the canvas listeners inside the existing `useEffect` (the one that creates the compositor):

```typescript
  const [gpuStatus, setGpuStatus] = useState<'ok' | 'reconnecting' | 'failed'>('ok')
```

Inside the compositor-creation `useEffect` (after `compRef.current = comp`), add:

```typescript
    const onLost = (e: Event): void => {
      comp.handleContextLoss(e)
      setGpuStatus('reconnecting')
    }
    const onRestored = (): void => {
      comp.handleContextRestore()
      setGpuStatus(comp.restoreFailed ? 'failed' : 'ok')
      // Mark stable after a short delay so a flapping context is caught.
      window.setTimeout(() => comp.markStable?.(), 1000)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
```

And extend the cleanup `return` to remove them:

```typescript
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      comp.dispose()
      compRef.current = null
      pool?.dispose()
      audioRef.current = null
    }
```

Also expose `markStable` on the compositor (add to Task 7 if not already — add a thin public method):

> Note: add `markStable(): void { this.restore.markStable() }` to the `Compositor` class if the optional-chain call above isn't resolved. Keep it on the compositor so Preview doesn't reach into internals.

- [ ] **Step 2: Render the overlay**

In the JSX, add an overlay when reconnecting/failed (inside `.monitor-inner`, sibling to the canvas):

```typescript
        {gpuStatus === 'reconnecting' && (
          <div className="monitor-overlay warn">Reconnecting GPU…</div>
        )}
        {gpuStatus === 'failed' && (
          <div className="monitor-overlay warn">
            GPU context lost. <button className="btn small" onClick={() => location.reload()}>Reload</button>
          </div>
        )}
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Preview.tsx src/renderer/src/lib/compositor.ts
git commit -m "feat: Preview recovers WebGL context loss with an overlay"
```

---

## Task 9: In-memory rollback ring in the store

**Files:**
- Modify: `src/renderer/src/state/store.ts`

- [ ] **Step 1: Add the ring fields to EditorState**

In `src/renderer/src/state/store.ts`, add to the `EditorState` interface (near the history fields):

```typescript
  // --- in-memory rollback ring (mid-session catastrophe net) ---
  /** Last few project states kept independent of the undo stack, so a bug that
   *  corrupts past[] can't also lose everything. Fed on the autosave tick. */
  rollback: Project[]
  /** Push the current project onto the rollback ring (capped). */
  pushRollback: () => void
  /** Roll back to the newest rollback entry (or no-op if empty). */
  rollbackOnce: () => void
```

- [ ] **Step 2: Seed + implement them in the store creator**

Near `past: []` in the returned object, add:

```typescript
  rollback: [],
```

And implement the actions (place near `snapshot`/`undo`):

```typescript
  pushRollback: () =>
    set((s) => ({
      rollback: [...s.rollback, s.project].slice(-4) // keep last 4
    })),

  rollbackOnce: () =>
    set((s) => {
      if (s.rollback.length === 0) return {}
      const prev = s.rollback[s.rollback.length - 1]
      return {
        // Keep media (probes aren't part of rollback), like undo does.
        project: { ...prev, media: s.project.media },
        rollback: s.rollback.slice(0, -1)
      }
    }),
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/state/store.ts
git commit -m "feat: in-memory rollback ring (independent of undo stack)"
```

---

## Task 10: Feed the rollback ring + renderer last-resort crash listener

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Feed rollback from the autosave subscription**

In `src/renderer/src/App.tsx`, in `useAutosave()`, extend the subscription so that when the project changes, it also pushes a rollback entry (throttled to the same 1s):

```typescript
function useAutosave(): void {
  useEffect(() => {
    let timer: number | undefined
    const flush = (): void => {
      const st = useEditor.getState()
      st.pushRollback()
      const json = serializeProject(st.project, { savedPath: st.projectFilePath, timestamp: Date.now() })
      void window.cutroom?.writeRecovery(json)
    }
    const unsub = useEditor.subscribe((state, prev) => {
      if (state.project === prev.project) return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(flush, 1000)
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      unsub()
    }
  }, [])
}
```

- [ ] **Step 2: Add a renderer last-resort crash listener**

Add a new hook near the other top-level hooks in `App.tsx`:

```typescript
/**
 * Last-resort crash net BELOW React's ErrorBoundary: a throw outside React's
 * tree (or a promise rejection it didn't catch) still flags recovery pending,
 * so the next launch can offer recovered work. The boundary catches the rest.
 */
function useLastResortCrashNet(): void {
  useEffect(() => {
    const flag = (e: ErrorEvent): void => {
      void window.cutroom?.markRecoveryPending()
      // Best-effort synchronous final flush before the page might die.
      try {
        const st = useEditor.getState()
        const json = serializeProject(st.project, { savedPath: st.projectFilePath, timestamp: Date.now() })
        void window.cutroom?.writeRecovery(json)
      } catch {
        /* if this throws too, we at least flagged pending above */
      }
    }
    const onRejection = (e: PromiseRejectionEvent): void => {
      void window.cutroom?.markRecoveryPending()
    }
    window.addEventListener('error', flag)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', flag)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}
```

And call it in `App()` alongside the other hooks:

```typescript
  usePlaybackClock()
  useShortcuts()
  useMediaProbe()
  useAudioProbe()
  useAutosave()
  useDocumentTitle()
  useLastResortCrashNet()
```

(Ensure `serializeProject` is imported — it already is in App.tsx.)

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: autosave feeds rollback ring + renderer last-resort crash net"
```

---

## Task 11: RecoveryModal — fallback-from-snapshot messaging

**Files:**
- Modify: `src/renderer/src/components/RecoveryModal.tsx`
- Modify: `src/preload/index.ts` (extend `RecoveryResult`)

- [ ] **Step 1: Add `fromBackup` to the RecoveryResult type**

In `src/preload/index.ts`:

```typescript
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
```

- [ ] **Step 2: Surface it in the modal**

In `src/renderer/src/components/RecoveryModal.tsx`, extend the `RecoveryInfo` interface and message:

```typescript
interface RecoveryInfo {
  json: string
  savedPath: string | null
  timestamp: number
  fromBackup: boolean
}
```

In the `.then((r) => …)` block:

```typescript
        if (active && r.available && r.json) {
          setInfo({
            json: r.json,
            savedPath: r.savedPath ?? null,
            timestamp: r.timestamp ?? 0,
            fromBackup: !!r.fromBackup
          })
        }
```

In the body copy, add a note when from a backup:

```typescript
          <p className="modal-note">
            Cutroom didn&apos;t close cleanly last time. There is autosaved work from {when}.
            {info.savedPath ? ` It was based on ${info.savedPath}.` : ''}
            {info.fromBackup && ' The latest snapshot was damaged, so this is a slightly older backup.'}
          </p>
```

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: clean + all pass.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/src/components/RecoveryModal.tsx
git commit -m "feat: RecoveryModal notes when a snapshot came from a backup slot"
```

---

## Task 12: Final verification + push

- [ ] **Step 1: Full typecheck + test run**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; ALL tests pass (original 151 + new ~20).

- [ ] **Step 2: Confirm the working tree is clean**

Run: `git status`
Expected: nothing to commit, working tree clean.

- [ ] **Step 3: Push the branch + open a PR**

```bash
git push -u origin feat/recovery-and-crash-resilience
gh pr create --title "feat: recovery & crash resilience (Phase 1)" --body "..."
```

(PR body summarizing the 5 design pillars; matches the spec at `docs/superpowers/specs/2026-07-01-recovery-and-crash-resilience-design.md`.)

---

## Self-Review

**1. Spec coverage:**
- Rotating ring (§1) → Tasks 1, 2, 3. ✓
- Broadened crash detection (§2) → Tasks 4, 5, 10. ✓
- WebGL/GPU context-loss recovery (§3) → Tasks 6, 7, 8. ✓
- In-memory rollback ring (§4) → Tasks 9, 10. ✓
- Test harness (§5) → Tasks 1, 4, 6 (all pure modules tested). ✓

**2. Placeholder scan:** No "TBD"/"TODO". Every code step has full code. PR body in Task 12 step 3 is "..." — acceptable since it's a `gh pr create --body` that will be filled at execution; the content is described. ✓

**3. Type consistency:** `flagRecoveryPending` (Task 5) used in index.ts (Task 5) — matches. `writeRing`/`findNewestValid`/`clearRing` (Task 1) used in projectStore (Tasks 2, 3) — matches. `RestoreMachine.state` / `onLost`/`onRestored`/`markStable`/`maxRetries` (Task 6) used in compositor (Task 7) and Preview (Task 8) — matches. `pushRollback`/`rollbackOnce` (Task 9) used in App (Task 10) — matches. `RecoveryResult.fromBackup` (Task 11) set in projectStore (Task 2 returns it) — matches. ✓
