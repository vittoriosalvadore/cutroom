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
    await writeRing(TMP, 'better') // so a backup exists at recovery.1.json
    await writeFile(join(TMP, 'recovery.json'), '')
    const found = await findNewestValid(TMP, (raw) => (raw === 'good' ? raw : null))
    expect(found).toBe('good')
  })
})
