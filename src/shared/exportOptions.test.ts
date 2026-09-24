import { describe, it, expect } from 'vitest'
import {
  HW_ENCODERS,
  NAMED_PRESETS,
  availableFamilies,
  formatInfo,
  matchPreset,
  outputSize,
  resolutionsFor,
  resolveEncoder
} from './exportOptions'

describe('outputSize', () => {
  it('keeps the project size for "project"', () => {
    expect(outputSize(1920, 1080, 'project')).toEqual({ width: 1920, height: 1080 })
  })

  it('fits a 16:9 project into each p-size box', () => {
    expect(outputSize(1920, 1080, '2160')).toEqual({ width: 3840, height: 2160 })
    expect(outputSize(1920, 1080, '720')).toEqual({ width: 1280, height: 720 })
    expect(outputSize(1920, 1080, '480')).toEqual({ width: 854, height: 480 })
  })

  it('preserves aspect for non-16:9 projects, with even dimensions', () => {
    // 4:3 at 720p fits by height: 960x720
    expect(outputSize(1440, 1080, '720')).toEqual({ width: 960, height: 720 })
    // 2.39:1 scope fits by width
    const s = outputSize(2048, 858, '1080')
    expect(s.width).toBe(1920)
    expect(s.height % 2).toBe(0)
    expect(s.height).toBe(804)
    // odd results round to even
    const o = outputSize(1000, 999, '480')
    expect(o.width % 2).toBe(0)
    expect(o.height % 2).toBe(0)
  })

  it('turns the box for vertical projects (1080p vertical is 1080 wide)', () => {
    expect(outputSize(1080, 1920, '1080')).toEqual({ width: 1080, height: 1920 })
    expect(outputSize(1080, 1920, '720')).toEqual({ width: 720, height: 1280 })
    expect(outputSize(2160, 3840, 'vertical1080')).toEqual({ width: 1080, height: 1920 })
    // 4:5 vertical fits inside 1080x1920 by width
    expect(outputSize(1080, 1350, 'vertical1080')).toEqual({ width: 1080, height: 1350 })
  })

  it('ignores the vertical box on a landscape project', () => {
    expect(outputSize(1920, 1080, 'vertical1080')).toEqual({ width: 1920, height: 1080 })
  })

  it('offers the vertical resolution only for vertical projects', () => {
    expect(resolutionsFor(1920, 1080)).not.toContain('vertical1080')
    expect(resolutionsFor(1080, 1920)).toContain('vertical1080')
  })
})

describe('resolveEncoder', () => {
  it('uses software when nothing works', () => {
    expect(resolveEncoder('mp4-h264', 'auto', [])).toEqual({ encoder: 'libx264', hardware: false })
    expect(resolveEncoder('mp4-hevc', 'auto', [])).toEqual({ encoder: 'libx265', hardware: false })
    expect(resolveEncoder('webm-vp9', 'auto', [])).toEqual({ encoder: 'libvpx-vp9', hardware: false })
  })

  it('auto picks the first working family in preference order', () => {
    expect(resolveEncoder('mp4-h264', 'auto', ['h264_amf', 'h264_nvenc']).encoder).toBe('h264_nvenc')
    expect(resolveEncoder('mp4-hevc', 'auto', ['h264_nvenc', 'hevc_qsv'])).toEqual({ encoder: 'hevc_qsv', hardware: true })
  })

  it('software choice ignores working hardware', () => {
    expect(resolveEncoder('mp4-h264', 'software', ['h264_nvenc']).encoder).toBe('libx264')
  })

  it('a hardware choice missing for this codec degrades to software', () => {
    expect(resolveEncoder('mp4-hevc', 'nvenc', ['h264_nvenc']).encoder).toBe('libx265')
    expect(resolveEncoder('mp4-h264', 'videotoolbox', []).encoder).toBe('libx264')
    // VP9 WebM is always software
    expect(resolveEncoder('webm-vp9', 'nvenc', HW_ENCODERS).encoder).toBe('libvpx-vp9')
  })

  it('lists families with at least one working encoder', () => {
    expect(availableFamilies([])).toEqual([])
    expect(availableFamilies(['hevc_amf', 'h264_nvenc'])).toEqual(['nvenc', 'amf'])
  })
})

describe('formats + presets', () => {
  it('maps formats to container/extension', () => {
    expect(formatInfo('mp4-h264')).toMatchObject({ codec: 'h264', container: 'mp4', ext: 'mp4' })
    expect(formatInfo('mp4-hevc')).toMatchObject({ codec: 'hevc', container: 'mp4' })
    expect(formatInfo('webm-vp9')).toMatchObject({ codec: 'vp9', container: 'webm', ext: 'webm' })
  })

  it('every named preset matches itself and nothing else', () => {
    for (const p of NAMED_PRESETS) expect(matchPreset(p)?.id).toBe(p.id)
    expect(matchPreset({ format: 'webm-vp9', resolution: '480', qualityMode: 'crf', bitrateMbps: 8 })).toBeUndefined()
  })
})
