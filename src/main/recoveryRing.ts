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
