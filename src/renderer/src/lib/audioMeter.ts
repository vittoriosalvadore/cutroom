// Module-level tap on the master output so a standalone Meter component can read
// the live level without holding a reference to the AudioPool. The AudioPool
// registers its AnalyserNode here on construction and clears it on dispose.

let analyser: AnalyserNode | null = null
let buffer: Float32Array<ArrayBuffer> | null = null

export function setMeterAnalyser(node: AnalyserNode | null): void {
  analyser = node
  buffer = node ? new Float32Array(node.fftSize) : null
}

/** Current output peak amplitude (0..1), or 0 when nothing is wired/playing. */
export function readMeterPeak(): number {
  if (!analyser || !buffer) return 0
  analyser.getFloatTimeDomainData(buffer)
  let peak = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = Math.abs(buffer[i])
    if (v > peak) peak = v
  }
  return peak
}
