import { describe, it, expect } from 'vitest'
import { buildMuxArgs, panGains, speedFilter, type MuxClip } from './muxArgs'

const base = { silentPath: '/tmp/silent.mp4', outputPath: '/tmp/out.mp4', sampleRate: 48000 }

function clip(over: Partial<MuxClip>): MuxClip {
  return {
    path: '/a.wav',
    startSec: 0,
    durationSec: 5,
    inSec: 0,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    trackGainDb: 0,
    pan: 0,
    speed: 1,
    trackId: 't0',
    ...over
  }
}

function graphOf(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1]
}

describe('buildMuxArgs', () => {
  it('single clip skips amix and feeds the limiter directly', () => {
    const args = buildMuxArgs({ ...base, clips: [clip({})] })
    const g = graphOf(args)
    expect(g).toContain('[a0]alimiter=limit=0.97,apad[aout]')
    expect(g).not.toContain('amix')
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
    expect(args).toContain('-shortest')
    expect(args[args.length - 1]).toBe('/tmp/out.mp4')
  })

  it('positions, trims, gains and fades each clip; mixes with normalize=0', () => {
    const args = buildMuxArgs({
      ...base,
      clips: [
        clip({ startSec: 1, durationSec: 4, inSec: 0.5, volume: 0.5, fadeInSec: 1, fadeOutSec: 2 }),
        clip({ path: '/b.wav', startSec: 0, durationSec: 3 })
      ]
    })
    const g = graphOf(args)
    expect(g).toContain('[1:a]aresample=48000')
    expect(g).toContain('atrim=start=0.500:end=4.500')
    expect(g).toContain('volume=0.5000')
    expect(g).toContain('afade=t=in:st=0:d=1.000')
    expect(g).toContain('afade=t=out:st=2.000:d=2.000')
    expect(g).toContain('adelay=1000:all=1[a0]')
    expect(g).toContain('[a0][a1]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.97,apad[aout]')
  })

  it('folds track gain (dB) into the linear volume', () => {
    const args = buildMuxArgs({ ...base, clips: [clip({ volume: 1, trackGainDb: -6 })] })
    // -6 dB ~= 0.5012 linear
    expect(graphOf(args)).toContain('volume=0.5012')
  })

  it('omits afade clauses when fades are zero', () => {
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({})] }))
    expect(g).not.toContain('afade')
  })

  it('clamps overlapping fades (fi+fo > duration) to match the preview envelope', () => {
    // fade in 3 + fade out 3 over a 4s clip -> scaled by 4/6 -> 2s each
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ durationSec: 4, fadeInSec: 3, fadeOutSec: 3 })] }))
    expect(g).toContain('afade=t=in:st=0:d=2.000')
    expect(g).toContain('afade=t=out:st=2.000:d=2.000')
  })

  it('emits an equal-power pan filter only when panned', () => {
    expect(graphOf(buildMuxArgs({ ...base, clips: [clip({ pan: 0 })] }))).not.toContain('pan=stereo')
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ pan: -1 })] }))
    // full left: left gain 1, right gain 0
    expect(g).toContain('aformat=channel_layouts=stereo')
    expect(g).toContain('pan=stereo|c0=1.00000*c0|c1=0.00000*c1')
  })
})

describe('buildMuxArgs FX path (gate / duck)', () => {
  const gate = { thresholdDb: -45, rangeDb: -60, ratio: 2, attackMs: 5, releaseMs: 120 }

  it('keeps the flat path byte-identical when no track uses gate/duck', () => {
    const noFx = graphOf(buildMuxArgs({ ...base, clips: [clip({}), clip({ path: '/b.wav' })] }))
    expect(noFx).toContain('[a0][a1]amix=inputs=2:normalize=0:duration=longest')
    expect(noFx).not.toContain('[bus_')
  })

  it('builds a per-track bus with agate when a track is gated', () => {
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ trackGainDb: -6, gate })] }))
    // per-clip carries only the clip volume; trackGain is NOT folded in here...
    expect(g).toContain('volume=1.0000,adelay=0:all=1[c0]')
    // ...it moves to the bus (-6 dB ~= 0.5012), followed by agate, then the bus label
    expect(g).toContain('[c0]volume=0.5012,agate=threshold=0.005623:range=0.001000:ratio=2:attack=5:release=120:detection=rms[bus_0]')
    // bus then terminal then single-track limiter
    expect(g).toContain('[t_0]alimiter=limit=0.97,apad[aout]')
    expect(g).not.toContain('[a0]') // not the flat path
  })

  it('ducks one track by another: asplit key (pre-duck) + padded sidechaincompress', () => {
    const g = graphOf(
      buildMuxArgs({
        ...base,
        clips: [
          clip({ trackId: 'tA', path: '/music.wav' }),
          clip({
            trackId: 'tB',
            path: '/vo.wav',
            duck: { triggerTrackId: 'tA', thresholdDb: -30, ratio: 50, attackMs: 15, releaseMs: 250 }
          })
        ]
      })
    )
    // trigger (tA = track 0) split into a main + one key, taken BEFORE any duck
    expect(g).toContain('[bus_0]asplit=2[main_0][key_0_1]')
    // key padded + stereo so a short trigger can't truncate the ducked track
    expect(g).toContain('[key_0_1]aformat=channel_layouts=stereo,apad[kp_0_1]')
    // ducked track (tB = track 1) sidechain-compressed; ratio clamped to 20
    expect(g).toContain('[md_1][kp_0_1]sidechaincompress=threshold=0.031623:ratio=20:attack=15:release=250[dk_1]')
  })

  it('emits EQ (bass/equalizer/treble) + acompressor on the per-track bus', () => {
    const g = graphOf(
      buildMuxArgs({
        ...base,
        clips: [
          clip({
            eq: { lowDb: 3, midDb: -2, highDb: 4 },
            comp: { thresholdDb: -18, ratio: 4, attackMs: 20, releaseMs: 200, makeupDb: 6 }
          })
        ]
      })
    )
    expect(g).toContain('bass=g=3:f=120,equalizer=f=1000:t=q:w=1:g=-2,treble=g=4:f=8000')
    expect(g).toContain('acompressor=threshold=0.125893:ratio=4:attack=20:release=200:makeup=1.9953')
    expect(g).not.toContain('[a0]') // EQ/comp trigger the per-track FX path
  })

  it('degrades to passthrough when the duck trigger has no audible clips', () => {
    const g = graphOf(
      buildMuxArgs({
        ...base,
        clips: [
          clip({
            trackId: 'tB',
            duck: { triggerTrackId: 'tGhost', thresholdDb: -30, ratio: 8, attackMs: 15, releaseMs: 250 }
          })
        ]
      })
    )
    expect(g).not.toContain('sidechaincompress')
    expect(g).toContain('[t_0]alimiter=limit=0.97,apad[aout]')
  })
})

describe('speed', () => {
  it('speedFilter is empty at 1x and pitches via asetrate otherwise', () => {
    expect(speedFilter(1, 48000)).toBe('')
    expect(speedFilter(2, 48000)).toBe('asetrate=96000,aresample=48000,asetpts=PTS-STARTPTS,')
    expect(speedFilter(0.5, 48000)).toBe('asetrate=24000,aresample=48000,asetpts=PTS-STARTPTS,')
  })
  it('a 1x clip keeps the original (byte-identical) atrim + no speed filter', () => {
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ inSec: 0.5, durationSec: 4 })] }))
    expect(g).toContain('atrim=start=0.500:end=4.500')
    expect(g).not.toContain('asetrate')
  })
  it('a sped clip trims dur*speed of source and inserts the speed filter', () => {
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ inSec: 0.5, durationSec: 4, speed: 2 })] }))
    // source span = 4 * 2 = 8, so atrim end = 0.5 + 8 = 8.5
    expect(g).toContain('atrim=start=0.500:end=8.500')
    expect(g).toContain('asetpts=PTS-STARTPTS,asetrate=96000,aresample=48000,asetpts=PTS-STARTPTS,volume=')
  })
})

describe('panGains', () => {
  it('is equal-power: centre = -3 dB, edges fully one side', () => {
    const c = panGains(0)
    expect(c.left).toBeCloseTo(Math.SQRT1_2)
    expect(c.right).toBeCloseTo(Math.SQRT1_2)
    const l = panGains(-1)
    expect(l.left).toBeCloseTo(1)
    expect(l.right).toBeCloseTo(0)
    const r = panGains(1)
    expect(r.left).toBeCloseTo(0)
    expect(r.right).toBeCloseTo(1)
  })
  it('clamps out-of-range pan', () => {
    expect(panGains(-5).left).toBeCloseTo(1)
    expect(panGains(5).right).toBeCloseTo(1)
  })
})
