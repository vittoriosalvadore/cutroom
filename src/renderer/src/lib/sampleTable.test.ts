import { describe, it, expect } from 'vitest'
import { findKeyframeBefore, type SampleEntry } from './sampleTable'

// A toy sample table: keyframes at samples 0 and 10 (each sample = 1/30s).
const samples: SampleEntry[] = Array.from({ length: 25 }, (_, i) => ({
  // samples 0 and 10 are keyframes (isSync true)
  isSync: i === 0 || i === 10,
  offset: i * 1000, // bytes
  size: 800,
  // timestamp in seconds; 30fps
  time: i / 30,
  duration: 1 / 30
}))

describe('findKeyframeBefore', () => {
  it('returns the sample at the exact time when it is a keyframe', () => {
    const k = findKeyframeBefore(samples, 10 / 30)
    expect(k).toBe(10)
  })
  it('returns the preceding keyframe for a time between keyframes', () => {
    // 0.4s is sample 12; preceding keyframe is sample 10
    const k = findKeyframeBefore(samples, 0.4)
    expect(k).toBe(10)
  })
  it('returns the first sample for a time before the first keyframe', () => {
    const k = findKeyframeBefore(samples, 0)
    expect(k).toBe(0)
  })
  it('clamps to the last keyframe for a time past the end', () => {
    const k = findKeyframeBefore(samples, 100)
    expect(k).toBe(10) // last keyframe in this toy table
  })
})
