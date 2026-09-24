import { describe, it, expect } from 'vitest'
import {
  buildEncodeArgs,
  buildProbeArgs,
  parseEncoderList,
  resolveEncodeConfig,
  videoEncoderArgs,
  type RawStartOptions
} from './encodeArgs'

const base: RawStartOptions = { width: 1920, height: 1080, fps: 30, outputPath: '/tmp/cutroom-1-silent.mp4' }

function after(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}

describe('resolveEncodeConfig', () => {
  it('omitted preset fields keep the original x264 / project-size / CRF export', () => {
    const c = resolveEncodeConfig({ ...base, preset: 'slow', crf: 18 }, [])!
    expect(buildEncodeArgs(c)).toEqual([
      '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '30', '-i', 'pipe:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '18',
      '-movflags', '+faststart', '-f', 'mp4', '/tmp/cutroom-1-silent.mp4'
    ])
  })

  it('rejects a missing output path or frame size', () => {
    expect(resolveEncodeConfig({ ...base, outputPath: '' }, [])).toBeNull()
    expect(resolveEncodeConfig({ ...base, outputPath: 42 }, [])).toBeNull()
    expect(resolveEncodeConfig({ ...base, width: 'wide' }, [])).toBeNull()
  })

  it('whitelists enums and clamps numbers (never trusts the renderer)', () => {
    const c = resolveEncodeConfig(
      {
        ...base,
        fps: 1e9,
        preset: 'ludicrous; rm -rf /',
        crf: -40,
        format: 'avi',
        resolution: '99999p',
        encoder: 'evil_enc'
      },
      []
    )!
    expect(c.fps).toBe(240)
    expect(c.preset).toBe('medium')
    expect(c.quality).toEqual({ mode: 'crf', crf: 0 })
    expect(c.container).toBe('mp4')
    expect(c.scale).toBeNull()
    expect(c.encoder).toBe('libx264')
    const bitrate = resolveEncodeConfig({ ...base, qualityMode: 'bitrate', bitrateMbps: 1e6 }, [])!
    expect(bitrate.quality).toEqual({ mode: 'bitrate', mbps: 200 })
  })

  it('computes the scale in main from the resolution key', () => {
    const c = resolveEncodeConfig({ ...base, resolution: '720', format: 'mp4-hevc' }, [])!
    expect(c.scale).toEqual({ width: 1280, height: 720 })
    const args = buildEncodeArgs(c)
    expect(after(args, '-vf')).toBe('scale=1280:720:flags=lanczos,setsar=1')
    expect(args).toContain('libx265')
    // scale filter sits after the input, before the encoder
    expect(args.indexOf('-vf')).toBeGreaterThan(args.indexOf('pipe:0'))
    expect(args.indexOf('-vf')).toBeLessThan(args.lastIndexOf('-c:v'))
  })

  it('omits the scale filter when the preset equals the project size', () => {
    const c = resolveEncodeConfig({ ...base, resolution: '1080' }, [])!
    expect(c.scale).toBeNull()
    expect(buildEncodeArgs(c)).not.toContain('-vf')
  })

  it('only uses hardware encoders the probe verified', () => {
    const none = resolveEncodeConfig({ ...base, encoder: 'nvenc' }, [])!
    expect(none).toMatchObject({ encoder: 'libx264', hardware: false })
    const nv = resolveEncodeConfig({ ...base, encoder: 'auto' }, ['h264_nvenc', 'not_a_real_one'])!
    expect(nv).toMatchObject({ encoder: 'h264_nvenc', hardware: true })
    const bogus = resolveEncodeConfig({ ...base, encoder: 'auto' }, ['bogus_nvenc'])!
    expect(bogus.encoder).toBe('libx264')
  })

  it('WebM writes a webm container without faststart', () => {
    const c = resolveEncodeConfig({ ...base, format: 'webm-vp9', outputPath: '/tmp/cutroom-1-silent.webm' }, ['h264_nvenc'])!
    const args = buildEncodeArgs(c)
    expect(c.encoder).toBe('libvpx-vp9')
    expect(args).not.toContain('-movflags')
    expect(args.slice(-3)).toEqual(['-f', 'webm', '/tmp/cutroom-1-silent.webm'])
  })
})

describe('videoEncoderArgs', () => {
  const crf = { mode: 'crf' as const, crf: 20 }
  const br = { mode: 'bitrate' as const, mbps: 8 }

  it('x264 / x265 bitrate mode uses VBV', () => {
    const a = videoEncoderArgs({ encoder: 'libx264', preset: 'medium', quality: br })
    expect(after(a, '-b:v')).toBe('8000k')
    expect(after(a, '-maxrate')).toBe('12000k')
    expect(after(a, '-bufsize')).toBe('16000k')
    expect(a).not.toContain('-crf')
  })

  it('x265 shifts CRF and tags hvc1', () => {
    const a = videoEncoderArgs({ encoder: 'libx265', preset: 'fast', quality: crf })
    expect(after(a, '-crf')).toBe('24')
    expect(after(a, '-tag:v')).toBe('hvc1')
    expect(after(a, '-preset')).toBe('fast')
  })

  it('VP9 uses constant quality with -b:v 0 and a cpu-used speed', () => {
    const a = videoEncoderArgs({ encoder: 'libvpx-vp9', preset: 'medium', quality: crf })
    expect(after(a, '-crf')).toBe('31')
    expect(after(a, '-b:v')).toBe('0')
    expect(after(a, '-cpu-used')).toBe('2')
    const fast = videoEncoderArgs({ encoder: 'libvpx-vp9', preset: 'ultrafast', quality: br })
    expect(after(fast, '-cpu-used')).toBe('5')
    expect(after(fast, '-b:v')).toBe('8000k')
  })

  it('NVENC maps the preset to p1..p7 and CRF to -cq', () => {
    expect(after(videoEncoderArgs({ encoder: 'h264_nvenc', preset: 'ultrafast', quality: crf }), '-preset')).toBe('p1')
    expect(after(videoEncoderArgs({ encoder: 'h264_nvenc', preset: 'veryslow', quality: crf }), '-preset')).toBe('p7')
    const a = videoEncoderArgs({ encoder: 'hevc_nvenc', preset: 'medium', quality: crf })
    expect(after(a, '-preset')).toBe('p5')
    expect(after(a, '-cq')).toBe('20')
    expect(after(a, '-rc')).toBe('vbr')
    expect(after(a, '-tag:v')).toBe('hvc1')
    const b = videoEncoderArgs({ encoder: 'h264_nvenc', preset: 'medium', quality: br })
    expect(after(b, '-b:v')).toBe('8000k')
    expect(b).not.toContain('-cq')
  })

  it('QSV uses -global_quality, nv12 and QSV preset names', () => {
    const a = videoEncoderArgs({ encoder: 'h264_qsv', preset: 'ultrafast', quality: crf })
    expect(after(a, '-global_quality')).toBe('20')
    expect(after(a, '-pix_fmt')).toBe('nv12')
    expect(after(a, '-preset')).toBe('veryfast')
    expect(after(videoEncoderArgs({ encoder: 'hevc_qsv', preset: 'medium', quality: br }), '-b:v')).toBe('8000k')
  })

  it('AMF uses -quality and CQP (no qp_b for HEVC) or peak-VBR', () => {
    const h = videoEncoderArgs({ encoder: 'h264_amf', preset: 'slow', quality: crf })
    expect(after(h, '-quality')).toBe('quality')
    expect(after(h, '-rc')).toBe('cqp')
    expect(after(h, '-qp_i')).toBe('20')
    expect(after(h, '-qp_p')).toBe('22')
    expect(after(h, '-qp_b')).toBe('24')
    const x = videoEncoderArgs({ encoder: 'hevc_amf', preset: 'veryfast', quality: crf })
    expect(after(x, '-quality')).toBe('speed')
    expect(x).not.toContain('-qp_b')
    const b = videoEncoderArgs({ encoder: 'h264_amf', preset: 'medium', quality: br })
    expect(after(b, '-rc')).toBe('vbr_peak')
    expect(after(b, '-quality')).toBe('balanced')
  })

  it('VideoToolbox maps CRF to -q:v (higher = better) or uses -b:v', () => {
    expect(after(videoEncoderArgs({ encoder: 'h264_videotoolbox', preset: 'medium', quality: crf }), '-q:v')).toBe('65')
    expect(after(videoEncoderArgs({ encoder: 'h264_videotoolbox', preset: 'medium', quality: { mode: 'crf', crf: 14 } }), '-q:v')).toBe('80')
    const b = videoEncoderArgs({ encoder: 'hevc_videotoolbox', preset: 'medium', quality: br })
    expect(after(b, '-b:v')).toBe('8000k')
    expect(after(b, '-tag:v')).toBe('hvc1')
  })

  it('an unknown encoder name falls back to x264', () => {
    expect(after(videoEncoderArgs({ encoder: 'rm -rf', preset: 'medium', quality: crf }), '-c:v')).toBe('libx264')
  })
})

describe('hardware probe helpers', () => {
  it('parses `ffmpeg -encoders` output', () => {
    const out = [
      'Encoders:',
      ' V..... = Video',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC',
      ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
      ' A....D aac                  AAC (Advanced Audio Coding)'
    ].join('\n')
    const names = parseEncoderList(out)
    expect(names.has('libx264')).toBe(true)
    expect(names.has('h264_nvenc')).toBe(true)
    expect(names.has('aac')).toBe(true)
    expect(names.has('=')).toBe(false)
    expect(names.has('------')).toBe(false)
  })

  it('test-encodes with the same per-encoder args to the null muxer', () => {
    const a = buildProbeArgs('hevc_nvenc')
    expect(after(a, '-f')).toBe('lavfi')
    expect(after(a, '-i')).toBe('color=s=256x256:d=0.1')
    expect(after(a, '-c:v')).toBe('hevc_nvenc')
    expect(a.slice(-3)).toEqual(['-f', 'null', '-'])
  })
})
