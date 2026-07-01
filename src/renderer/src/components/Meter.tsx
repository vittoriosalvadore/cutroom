import { useEffect, useRef } from 'react'
import { readMeterPeak } from '../lib/audioMeter'

// Map a linear peak (0..1) to a 0..100% bar on a -60..0 dB scale.
function toPct(peak: number): number {
  if (peak <= 0.0001) return 0
  const db = 20 * Math.log10(peak)
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
}

/** Live master-output level meter with a decaying peak-hold marker. */
export default function Meter() {
  const fillRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    let hold = 0
    let holdUntil = 0
    const tick = (): void => {
      const pct = toPct(readMeterPeak())
      if (fillRef.current) fillRef.current.style.width = `${pct}%`
      const t = performance.now()
      if (pct >= hold) {
        hold = pct
        holdUntil = t + 700
      } else if (t > holdUntil) {
        hold = Math.max(0, hold - 1.2) // slow decay
      }
      if (peakRef.current) peakRef.current.style.left = `${hold}%`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="meter" title="Master output level">
      <div className="meter-fill" ref={fillRef} />
      <div className="meter-peak" ref={peakRef} />
    </div>
  )
}
