// One shared AudioContext for the whole app: used both to decode media (in
// audioCache) and to play it back (in audioPool), so decoded AudioBuffers and
// playback live on the same clock/sample-rate. Created lazily; starts suspended
// under the browser autoplay policy and is resumed on the first user gesture.

let ctx: AudioContext | null = null

export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

export function resumeAudioContext(): void {
  const c = ctx
  if (c && c.state === 'suspended') void c.resume()
}
