import { describe, it, expect } from 'vitest'
import { extensionTier } from './videoTier'

describe('extensionTier', () => {
  it('returns webcodecs for mp4', () => {
    expect(extensionTier('/path/clip.mp4')).toBe('webcodecs')
  })
  it('returns webcodecs for m4v', () => {
    expect(extensionTier('/path/clip.m4v')).toBe('webcodecs')
  })
  it('returns webcodecs for mov', () => {
    expect(extensionTier('/path/clip.mov')).toBe('webcodecs')
  })
  it('returns video-element for mkv', () => {
    expect(extensionTier('/path/clip.mkv')).toBe('video-element')
  })
  it('returns video-element for webm', () => {
    expect(extensionTier('/path/clip.webm')).toBe('video-element')
  })
  it('returns video-element for avi', () => {
    expect(extensionTier('/path/clip.avi')).toBe('video-element')
  })
  it('is case-insensitive', () => {
    expect(extensionTier('/path/CLIP.MP4')).toBe('webcodecs')
  })
  it('returns video-element for an unknown extension', () => {
    expect(extensionTier('/path/clip.xyz')).toBe('video-element')
  })
  it('returns video-element for no extension', () => {
    expect(extensionTier('/path/clip')).toBe('video-element')
  })
})
