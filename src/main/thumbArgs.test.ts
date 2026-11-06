import { describe, it, expect } from 'vitest'
import { buildThumbStripArgs, isThumbFileName, MAX_TILES, MIN_TILES, thumbFileName, tileCount, tileTimes } from './thumbArgs'

describe('thumbnail strip helpers', () => {
  it('scales the tile count with duration, within bounds', () => {
    expect(tileCount(0)).toBe(MIN_TILES)
    expect(tileCount(30)).toBe(15)
    expect(tileCount(3600)).toBe(MAX_TILES)
  })

  it('samples the middle of each equal share', () => {
    expect(tileTimes(10, 5)).toEqual([1, 3, 5, 7, 9])
  })

  it('names cache files by content identity and recognises them', () => {
    const a = thumbFileName('/v/a.mp4', 100, 5, 10)
    expect(a).toMatch(/^[0-9a-f]{32}\.jpg$/)
    expect(thumbFileName('/v/a.mp4', 101, 5, 10)).not.toBe(a)
    expect(isThumbFileName(a)).toBe(true)
    expect(isThumbFileName('../evil.jpg')).toBe(false)
  })

  it('one fast seek per tile, hstacked into a single JPEG', () => {
    const args = buildThumbStripArgs('/v/a b.mp4', '/c/x.partial', [1, 3])
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
    expect(args[args.indexOf('-ss') + 1]).toBe('1.000')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('hstack=inputs=2[out]')
    expect(args.slice(-1)).toEqual(['/c/x.partial'])
    expect(buildThumbStripArgs('/v/a.mp4', '/c/y', [2])[buildThumbStripArgs('/v/a.mp4', '/c/y', [2]).indexOf('-filter_complex') + 1]).not.toContain('hstack')
  })
})
