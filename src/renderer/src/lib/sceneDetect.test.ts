import { describe, it, expect } from 'vitest'
import {
  bisectCut,
  clipFrameSpan,
  coarseFrames,
  computeHistogram,
  findCuts,
  frameSourceTime,
  histogramDistance,
  type Histogram
} from './sceneDetect'
import { JobCancelled } from './workerJob'

function fakeImage(pixels: number[][]): { data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  })
  return { data }
}

const solid = (r: number, g: number, b: number): Histogram => computeHistogram(fakeImage([[r, g, b]]))

/** Weighted blend of two histograms (still normalized): a gradual change. */
function mix(a: Histogram, b: Histogram, w: number): Histogram {
  return a.map((v, i) => v * (1 - w) + b[i] * w)
}

const BLACK = solid(0, 0, 0)
const WHITE = solid(255, 255, 255)
const YELLOW = solid(250, 250, 10)
const BLUE = solid(10, 10, 250)

/** A fake "video" of hard cuts: the shot index for frame k, and how often histAt ran. */
function shots(cutFrames: number[], looks: Histogram[]) {
  let calls = 0
  const histAt = async (k: number): Promise<Histogram> => {
    calls++
    return looks[cutFrames.filter((c) => k >= c).length]
  }
  return { histAt, calls: () => calls }
}

describe('computeHistogram', () => {
  it('puts all mass in one bin per channel for a solid-color image', () => {
    const hist = computeHistogram(fakeImage([[10, 10, 10], [10, 10, 10], [10, 10, 10]]))
    // 16 bins over 0..255: value 10 -> bin (10*16)>>8 = 0.
    expect(hist[0]).toBeCloseTo(1)
    expect(hist[16]).toBeCloseTo(1) // G channel's bin 0
    expect(hist[32]).toBeCloseTo(1) // B channel's bin 0
  })

  it('normalizes each channel to sum to 1 regardless of pixel count', () => {
    const hist = computeHistogram(fakeImage([[0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255]]))
    let rSum = 0
    for (let i = 0; i < 16; i++) rSum += hist[i]
    expect(rSum).toBeCloseTo(1)
    expect(hist[15]).toBeCloseTo(0.5) // 255 lands in the top bin, never past it
  })
})

describe('histogramDistance', () => {
  it('is zero for identical histograms', () => {
    const hist = computeHistogram(fakeImage([[50, 50, 50], [50, 50, 50]]))
    expect(histogramDistance(hist, hist)).toBeCloseTo(0)
  })

  it('is (close to) 1 for a hard cut between opposite colors', () => {
    expect(histogramDistance(BLACK, WHITE)).toBeCloseTo(1)
  })

  it('grows with how much of the frame actually changed', () => {
    const base = Array.from({ length: 100 }, () => [100, 100, 100])
    const partial = [...base]
    partial[0] = [250, 250, 250] // 1 of 100 pixels changes drastically
    const total = base.map(() => [250, 250, 250]) // every pixel changes

    const distPartial = histogramDistance(computeHistogram(fakeImage(base)), computeHistogram(fakeImage(partial)))
    const distTotal = histogramDistance(computeHistogram(fakeImage(base)), computeHistogram(fakeImage(total)))

    expect(distPartial).toBeGreaterThan(0)
    expect(distPartial).toBeLessThan(distTotal)
  })
})

describe('frame addressing', () => {
  it('spans the timeline frames the compositor draws the clip on (start <= t < end)', () => {
    expect(clipFrameSpan({ startSec: 2, durationSec: 4 }, 30)).toEqual({ first: 60, last: 179 })
    // Off-grid edges: the first frame at/after the start, the last one before the end.
    expect(clipFrameSpan({ startSec: 1.01, durationSec: 1 }, 30)).toEqual({ first: 31, last: 60 })
    expect(clipFrameSpan({ startSec: 0, durationSec: 0.04 }, 30)).toEqual({ first: 0, last: 1 })
    expect(clipFrameSpan({ startSec: 0, durationSec: 0.03 }, 30)).toBeNull() // a single frame
  })

  it('reads each timeline frame from the speed-scaled source time, just past the boundary', () => {
    const clip = { startSec: 10, durationSec: 4, inSec: 1, speed: 2 }
    expect(frameSourceTime(clip, 30, 300)).toBeCloseTo(1.0001, 9) // clip head = in-point
    expect(frameSourceTime(clip, 30, 345)).toBeCloseTo(4.0001, 9) // 1.5s in, at 2x
    expect(frameSourceTime({ startSec: 0, durationSec: 4, inSec: 0 }, 30, 60)).toBeGreaterThan(2)
  })

  it('coarse frames step evenly, always end on the last frame, and are capped', () => {
    expect(coarseFrames(0, 40, 15, 600)).toEqual([0, 15, 30, 40])
    expect(coarseFrames(10, 12, 0.3, 600)).toEqual([10, 11, 12]) // never below one frame
    const capped = coarseFrames(0, 10_000, 1, 101)
    expect(capped.length).toBeLessThanOrEqual(101)
    expect(capped[capped.length - 1]).toBe(10_000)
  })
})

describe('bisectCut', () => {
  it('pins the cut to the first frame of the new shot in log2(window) reads', async () => {
    const v = shots([37], [BLACK, WHITE])
    const cut = await bisectCut(30, BLACK, 45, WHITE, v.histAt)
    expect(cut.frame).toBe(37)
    expect(cut.score).toBeCloseTo(1)
    expect(v.calls()).toBeLessThanOrEqual(4) // window of 15 frames
  })

  it('handles a cut right after the window start and on its end', async () => {
    expect((await bisectCut(30, BLACK, 45, WHITE, shots([31], [BLACK, WHITE]).histAt)).frame).toBe(31)
    expect((await bisectCut(30, BLACK, 45, WHITE, shots([45], [BLACK, WHITE]).histAt)).frame).toBe(45)
  })
})

describe('findCuts', () => {
  const coarse = coarseFrames(0, 240, 15, 600) // 8s at 30 fps, one sample every 0.5s

  it('finds every hard cut, frame-exact, with few reads', async () => {
    const v = shots([61, 120, 133], [BLACK, YELLOW, BLUE, WHITE]) // incl. a cut ON a coarse sample (120)
    const cuts = await findCuts(coarse, 0.35, v.histAt)
    expect(cuts.map((c) => c.frame)).toEqual([61, 120, 133])
    for (const c of cuts) expect(c.score).toBeGreaterThan(0.35)
    // 17 coarse reads + at most 4 bisection reads per flagged window.
    expect(v.calls()).toBeLessThanOrEqual(coarse.length + 3 * 4)
  })

  it('ignores a change below the threshold', async () => {
    const dim = mix(BLACK, WHITE, 0.2) // a fifth of the frame changes
    expect(histogramDistance(BLACK, dim)).toBeLessThan(0.35)
    expect(await findCuts(coarse, 0.35, shots([100], [BLACK, dim]).histAt)).toEqual([])
  })

  it('drops a gradual change that crossed the threshold between coarse samples', async () => {
    // A 2s fade from black to white: 0.5s apart the histograms differ a lot,
    // but no two ADJACENT frames do — not a hard cut.
    const fade = async (k: number): Promise<Histogram> => mix(BLACK, WHITE, Math.min(1, Math.max(0, (k - 60) / 60)))
    expect(histogramDistance(await fade(75), await fade(90))).toBeGreaterThan(0.2)
    expect(await findCuts(coarse, 0.2, fade)).toEqual([])
  })

  it('maps through clip speed: a source cut lands on the first TIMELINE frame that shows it', async () => {
    // 30 fps footage at 2x in a 30 fps sequence: timeline frame k shows source
    // frame 2k, so a cut AT source frame 61 is first seen on timeline frame 31
    // (source 62) — splitting at 30 would start the new shot on an old frame.
    const clip = { startSec: 0, durationSec: 4, inSec: 0, speed: 2 }
    const sourceFrame = (k: number): number => Math.floor(frameSourceTime(clip, 30, k) * 30)
    const histAt = async (k: number): Promise<Histogram> => (sourceFrame(k) >= 61 ? WHITE : BLACK)
    const span = clipFrameSpan(clip, 30)!
    const cuts = await findCuts(coarseFrames(span.first, span.last, 7.5, 600), 0.35, histAt)
    expect(cuts.map((c) => c.frame)).toEqual([31])
  })

  it('reports progress per stage and stops on cancel', async () => {
    const stages: string[] = []
    await findCuts(coarse, 0.35, shots([61], [BLACK, WHITE]).histAt, (p) => stages.push(p.stage))
    expect(stages[0]).toBe('sampling')
    expect(stages[stages.length - 1]).toBe('refining')

    let reads = 0
    const histAt = async (k: number): Promise<Histogram> => {
      reads++
      return k >= 61 ? WHITE : BLACK
    }
    await expect(findCuts(coarse, 0.35, histAt, undefined, () => reads >= 5)).rejects.toBeInstanceOf(JobCancelled)
    expect(reads).toBe(5)
  })
})
