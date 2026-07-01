// Bridges a local file path to a URL the renderer can actually load. The main
// process serves these via the privileged `cutroom://` protocol (see
// src/main/index.ts). Use for <img>/<video> src and fetch().
export function mediaUrl(absPath: string): string {
  return `cutroom://media/?path=${encodeURIComponent(absPath)}`
}
