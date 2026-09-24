import { describe, it, expect } from 'vitest'
import { buildMuxArgs, buildMuxGraph, panGains, planReverbs, speedFilter, stereoPanFilter, type MuxClip } from './muxArgs'
import { reverbIRLength, reverbMixGains } from '../shared/reverb'

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

describe('buildMuxArgs input planning + safety', () => {
  it('opens a source once and fans it out with asplit when several clips share it', () => {
    const args = buildMuxArgs({
      ...base,
      clips: [clip({ startSec: 0 }), clip({ startSec: 5 }), clip({ path: '/b.wav', startSec: 10 })]
    })
    // silent video + 2 unique sources, not 3
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    const g = graphOf(args)
    expect(g.startsWith('[1:a]asplit=2[s1_0][s1_1];')).toBe(true)
    expect(g).toContain('[s1_0]aresample=48000')
    expect(g).toContain('[s1_1]aresample=48000')
    expect(g).toContain('[2:a]aresample=48000')
  })

  it('passes the graph as a script file when asked', () => {
    const args = buildMuxArgs({ ...base, clips: [clip({})], filterScriptPath: '/tmp/g.txt' })
    expect(args).not.toContain('-filter_complex')
    expect(args[args.indexOf('-filter_complex_script') + 1]).toBe('/tmp/g.txt')
  })

  it('clamps dynamics options into FFmpeg ranges (attack 0 would abort the mux)', () => {
    const g = graphOf(
      buildMuxArgs({
        ...base,
        clips: [
          clip({
            gate: { thresholdDb: -200, rangeDb: 20, ratio: 0, attackMs: 0, releaseMs: 0 },
            comp: { thresholdDb: -40, ratio: 100, attackMs: 0, releaseMs: 99999, makeupDb: 80 }
          })
        ]
      })
    )
    expect(g).toContain('agate=threshold=0.000977:range=1.000000:ratio=1:attack=0.01:release=0.01')
    expect(g).toContain('acompressor=threshold=0.010000:ratio=20:attack=0.01:release=9000:makeup=64.0000')
  })

  it('caps the padded soundtrack at the video length', () => {
    const args = buildMuxArgs({ ...base, clips: [clip({})], durationSec: 8 })
    expect(args[args.indexOf('-t') + 1]).toBe('8.000')
    expect(buildMuxArgs({ ...base, clips: [clip({})] })).not.toContain('-t')
  })

  it('names the muxer explicitly so the output may use a temp extension', () => {
    const args = buildMuxArgs({ ...base, clips: [clip({})] })
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/tmp/out.mp4'])
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args).toContain('+faststart')
  })

  it('WebM muxes Opus at 48 kHz (Opus has no 44.1k) and forces -f webm', () => {
    const args = buildMuxArgs({
      ...base,
      sampleRate: 44100,
      outputPath: '/tmp/out.webm.part',
      container: 'webm',
      clips: [clip({})],
      durationSec: 8
    })
    expect(args[args.indexOf('-c:a') + 1]).toBe('libopus')
    expect(args[args.indexOf('-ar') + 1]).toBe('48000')
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy')
    expect(args[args.indexOf('-t') + 1]).toBe('8.000')
    expect(args).not.toContain('-movflags')
    expect(args.slice(-3)).toEqual(['-f', 'webm', '/tmp/out.webm.part'])
    // the filtergraph still mixes at the project rate
    expect(graphOf(args)).toContain('aresample=44100')
  })
})

describe('buildMuxArgs reverb', () => {
  const reverb = { mix: 0.3, decaySec: 1.5, preDelayMs: 20, tone: 0.5 }

  it('adds one IR input per reverb track, after the sources, in planReverbs order', () => {
    const clips = [
      clip({ trackId: 'tA', path: '/a.wav' }),
      clip({ trackId: 'tB', path: '/b.wav', reverb }),
      clip({ trackId: 'tB', path: '/b.wav', startSec: 6, reverb }),
      clip({ trackId: 'tC', path: '/c.wav', reverb: { ...reverb, decaySec: 3 } })
    ]
    expect(planReverbs(clips).map((r) => r.trackId)).toEqual(['tB', 'tC'])
    const args = buildMuxArgs({ ...base, clips, irPaths: ['/tmp/irB.wav', '/tmp/irC.wav'] })
    const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []))
    expect(inputs).toEqual(['/tmp/silent.mp4', '/a.wav', '/b.wav', '/c.wav', '/tmp/irB.wav', '/tmp/irC.wav'])
    const g = graphOf(args)
    // tB is track 1 -> IR input 4; tC is track 2 -> IR input 5
    expect(g).toContain('[rx_1][4:a]afir=irnorm=-1:irgain=1')
    expect(g).toContain('[rx_2][5:a]afir=irnorm=-1:irgain=1')
    expect(g).not.toContain('[rx_0]') // tA has no reverb
    expect(g).toContain('[bus_0]anull[t_0]')
  })

  it('splits dry/wet with the shared equal-power gains, pads the wet by the IR length', () => {
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ reverb })], irPaths: ['/tmp/ir.wav'] }))
    const { dry, wet } = reverbMixGains(0.3)
    const pad = (reverbIRLength(reverb, 48000) / 48000).toFixed(3)
    expect(g).toContain('[bus_0]asplit=2[rd_0][rw_0]')
    // wet: unity upmix (mono FC -> both sides at full level, as WebAudio does), pad, convolve, gain
    expect(g).toContain(`[rw_0]pan=stereo|FL=FL+FC|FR=FR+FC,apad=pad_dur=${pad}[rx_0]`)
    expect(g).toContain(`[rx_0][2:a]afir=irnorm=-1:irgain=1,volume=${wet.toFixed(6)}[rwo_0]`)
    // dry: the no-reverb terminal's gains (mono FC -> -3 dB each side, stereo as-is),
    // via pan — an aformat here would upmix the bus before the asplit, wet included
    expect(g).toContain(`[rd_0]volume=${dry.toFixed(6)},pan=stereo|FL=1.00000*FL+0.70711*FC|FR=1.00000*FR+0.70711*FC[rdo_0]`)
    expect(g).not.toMatch(/aformat=channel_layouts=stereo\[rdo_0\]/)
    expect(g).toContain('[rdo_0][rwo_0]amix=inputs=2:normalize=0:duration=longest[t_0]')
    expect(g).toContain('[t_0]alimiter=limit=0.97,apad[aout]')
  })

  it('pans the dry and wet branches separately (like the preview’s two panners)', () => {
    const g = graphOf(buildMuxArgs({ ...base, clips: [clip({ reverb, pan: -0.5 })], irPaths: ['/tmp/ir.wav'] }))
    const { left, right } = panGains(-0.5)
    // wet (always stereo): WebAudio's exact stereo-input pan law
    expect(g).toContain(`afir=irnorm=-1:irgain=1,volume=${reverbMixGains(0.3).wet.toFixed(6)},${stereoPanFilter(-0.5)}[rwo_0]`)
    // dry: the same gains the no-reverb terminal applies after its -3 dB mono upmix
    const l = left.toFixed(5)
    const r = right.toFixed(5)
    const lc = (left * Math.SQRT1_2).toFixed(5)
    const rc = (right * Math.SQRT1_2).toFixed(5)
    expect(g).toContain(`,pan=stereo|FL=${l}*FL+${lc}*FC|FR=${r}*FR+${rc}*FC[rdo_0]`)
  })

  it('stereoPanFilter mirrors StereoPannerNode for stereo input (identity at centre)', () => {
    expect(stereoPanFilter(0)).toBe('pan=stereo|c0=c0+0.00000*c1|c1=1.00000*c1')
    // hard left folds R into L; hard right folds L into R
    expect(stereoPanFilter(-1)).toBe('pan=stereo|c0=c0+1.00000*c1|c1=0.00000*c1')
    expect(stereoPanFilter(1)).toBe('pan=stereo|c0=0.00000*c0|c1=c1+1.00000*c0')
    expect(stereoPanFilter(0.5)).toBe('pan=stereo|c0=0.70711*c0|c1=c1+0.70711*c0')
    expect(stereoPanFilter(9)).toBe(stereoPanFilter(1))
  })

  it('sits after the duck and before the pan on the track terminal', () => {
    const g = buildMuxGraph(
      [
        clip({ trackId: 'tA', path: '/vo.wav' }),
        clip({
          trackId: 'tB',
          path: '/music.wav',
          duck: { triggerTrackId: 'tA', thresholdDb: -30, ratio: 8, attackMs: 15, releaseMs: 250 },
          reverb
        })
      ],
      48000
    )
    expect(g).toContain('[dk_1]asplit=2[rd_1][rw_1]')
    // the duck key is still taken from the trigger's pre-reverb bus
    expect(g).toContain('[bus_0]asplit=2[main_0][key_0_1]')
  })

  it('clamps settings in main and treats a zero mix as no reverb', () => {
    const wild = { mix: 7, decaySec: 500, preDelayMs: -3, tone: 9 }
    expect(planReverbs([clip({ reverb: wild })])[0].reverb).toEqual({ mix: 1, decaySec: 10, preDelayMs: 0, tone: 1 })
    const g = buildMuxGraph([clip({ reverb: wild })], 48000)
    expect(g).toContain('apad=pad_dur=10.000')
    expect(g).toContain(`[rd_0]volume=${reverbMixGains(1).dry.toFixed(6)},pan=`)
    expect(planReverbs([clip({ reverb: { ...reverb, mix: 0 } })])).toEqual([])
    const off = buildMuxGraph([clip({ reverb: { ...reverb, mix: 0 } })], 48000)
    expect(off).not.toContain('afir')
  })
})
