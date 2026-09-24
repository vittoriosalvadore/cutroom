import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { isPackaged: false } }))
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }))

import { scrubAudioArgs, SCRUB_AUDIO_RATE } from './scrubAudio'

describe('scrubAudioArgs', () => {
  it('extracts the first audio stream as light mono PCM WAV', () => {
    const args = scrubAudioArgs('/v/clip one.mp4', '/tmp/cutroom-1-scrub.wav')
    expect(args[args.indexOf('-i') + 1]).toBe('/v/clip one.mp4')
    expect(args[args.indexOf('-map') + 1]).toBe('0:a:0')
    expect(args[args.indexOf('-ac') + 1]).toBe('1')
    expect(args[args.indexOf('-ar') + 1]).toBe(String(SCRUB_AUDIO_RATE))
    expect(args.slice(-3)).toEqual(['-f', 'wav', '/tmp/cutroom-1-scrub.wav'])
  })
})
