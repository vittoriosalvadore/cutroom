import type { Clip, ClipTransform, Effects, MediaItem, Project, TextProps } from '../types'
import { defaultEffects, isNeutralColor } from '../types'
import { sampleOpacity, sampleTransform } from './keyframes'
import { mediaUrl } from './media'
import { VideoPool } from './videoPool'
import { roundRectPath } from './canvas'
import { RestoreMachine } from './webglRestore'
import type { FrameSource } from './videoSource'

// ---------------------------------------------------------------------------
// WebGL preview compositor.
//
// Each render walks the video tracks bottom-to-top and draws the clip active at
// the playhead as a textured quad. Layers are alpha-blended, so titles and
// keyed footage stack correctly. A single shader handles everything; the chroma
// key (green/blue screen) lives in the fragment shader so it runs on the GPU at
// full frame rate.
//
// Sources:
//   • images  -> texture loaded from the cutroom:// protocol, fit "contain"
//   • text    -> rendered to a 2D canvas, uploaded as a full-frame texture
//   • video / sourceless -> labelled placeholder panel (real frame decode is
//     the next milestone; chroma key already works on images today)
// ---------------------------------------------------------------------------

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
uniform vec4 uRect;    // cropped content rect (x, y, w, h) in 0..1 frame space (y down)
uniform vec2 uUVMin;   // texture crop window
uniform vec2 uUVMax;
uniform vec2 uTrans;   // position offset in frame fractions
uniform float uScale;  // uniform scale about the anchor
uniform float uRot;    // radians, clockwise on screen
uniform float uAspect; // frame W/H, so rotation is not sheared
uniform vec2 uAnchor;  // pivot in 0..1 frame space (original content centre)
void main() {
  vUV = mix(uUVMin, uUVMax, aPos);
  vec2 base = uRect.xy + aPos * uRect.zw;
  vec2 rel = base - uAnchor;
  rel.x *= uAspect;                 // into square space
  rel *= uScale;
  float c = cos(uRot);
  float s = sin(uRot);
  rel = vec2(rel.x * c - rel.y * s, rel.x * s + rel.y * c);
  rel.x /= uAspect;                 // back to frame space
  vec2 p = uAnchor + rel + uTrans;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}
`

const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform int uUseTex;
uniform vec4 uColor;
uniform float uOpacity;
uniform int uChroma;
uniform vec3 uKey;
uniform float uSim;
uniform float uSmooth;
uniform float uSpill;
uniform int uColorOn;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemp;
uniform float uTint;

// Project to the chroma plane (Cb/Cr-ish) so the key ignores brightness.
vec2 chromaCoords(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec2((c.b - y) * 0.565, (c.r - y) * 0.713);
}

void main() {
  vec4 src = (uUseTex == 1) ? texture2D(uTex, vUV) : uColor;
  vec3 rgb = src.rgb;
  float a = src.a;

  if (uChroma == 1) {
    float dist = distance(chromaCoords(rgb), chromaCoords(uKey));
    float threshold = uSim * 0.5;
    float mask = smoothstep(threshold, threshold + uSmooth * 0.4 + 0.001, dist);
    a *= mask;
    // Suppress leftover screen-color spill on the kept fringe.
    if (uSpill > 0.0) {
      float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
      rgb = mix(rgb, vec3(luma), (1.0 - mask) * uSpill);
    }
  }

  // Primary colour grade (after the key, so it grades the composited result):
  // exposure -> white balance -> contrast -> saturation.
  if (uColorOn == 1) {
    rgb *= exp2(uExposure);
    rgb += vec3(uTemp, uTint, -uTemp) * 0.18;
    rgb = (rgb - 0.5) * uContrast + 0.5;
    float gl = dot(rgb, vec3(0.299, 0.587, 0.114));
    rgb = mix(vec3(gl), rgb, uSaturation);
    rgb = clamp(rgb, 0.0, 1.0);
  }

  gl_FragColor = vec4(rgb, a * uOpacity);
}
`

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(v || '000000', 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function hexToCss(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb01(hex)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`
}


/** Draw a title/subtitle onto a transparent full-frame canvas. */
function renderTextCanvas(text: TextProps, W: number, H: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const fontPx = (text.fontSizePct / 100) * H
  const weight = text.bold ? '700' : '400'
  const italic = text.italic ? 'italic ' : ''
  ctx.font = `${italic}${weight} ${fontPx}px ${text.fontFamily}`
  ctx.textBaseline = 'middle'

  const lines = text.content.split('\n')
  const lineHeight = fontPx * 1.25
  let maxW = 0
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width)
  const blockH = lineHeight * lines.length
  const cx = (text.xPct / 100) * W
  const cy = (text.yPct / 100) * H

  if (text.boxOpacity > 0) {
    const padX = fontPx * 0.45
    const padY = fontPx * 0.25
    ctx.fillStyle = hexToCss(text.boxColor, text.boxOpacity)
    roundRectPath(ctx, cx - maxW / 2 - padX, cy - blockH / 2 - padY, maxW + padX * 2, blockH + padY * 2, fontPx * 0.15)
    ctx.fill()
  }

  ctx.textAlign = text.align
  const ax = text.align === 'center' ? cx : text.align === 'left' ? cx - maxW / 2 : cx + maxW / 2
  const strokeW = (text.strokeWidthPct / 100) * fontPx
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  lines.forEach((ln, i) => {
    const y = cy - blockH / 2 + lineHeight * (i + 0.5)
    if (strokeW > 0) {
      ctx.lineWidth = strokeW
      ctx.strokeStyle = text.strokeColor
      ctx.strokeText(ln, ax, y)
    }
    ctx.fillStyle = text.color
    ctx.fillText(ln, ax, y)
  })

  return canvas
}

/** Placeholder card for clips we cannot decode to pixels yet (video/no source). */
function renderPanelCanvas(label: string, sub: string, W: number, H: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#2b3550')
  g.addColorStop(1, '#1b2236')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = `600 ${H * 0.055}px system-ui, sans-serif`
  ctx.fillText(label, W / 2, H / 2 - H * 0.03)
  ctx.fillStyle = 'rgba(255,255,255,0.4)'
  ctx.font = `400 ${H * 0.028}px system-ui, sans-serif`
  ctx.fillText(sub, W / 2, H / 2 + H * 0.05)

  return canvas
}

/** Centered "contain" rect (normalized 0..1) for an image inside the frame. */
function containRect(iw: number, ih: number, W: number, H: number): { x: number; y: number; w: number; h: number } {
  if (iw <= 0 || ih <= 0) return { x: 0, y: 0, w: 1, h: 1 }
  const scale = Math.min(W / iw, H / ih)
  const w = (iw * scale) / W
  const h = (ih * scale) / H
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

type CachedTex = { tex: WebGLTexture; w: number; h: number }
type ImageEntry = {
  tex: WebGLTexture | null
  w: number
  h: number
  status: 'loading' | 'ready' | 'error'
  /** Resolves once the image has loaded (or failed); used to preload for export. */
  ready: Promise<void>
}

export class Compositor {
  private gl: WebGLRenderingContext
  // Assigned by buildGLResources() (shared by constructor + context restore),
  // not inline — the `!` satisfies definite-assignment since it can't be read
  // before the constructor calls that method.
  private prog!: WebGLProgram
  private quad!: WebGLBuffer
  private needsRender: () => void

  private aPos = 0
  private u: Record<string, WebGLUniformLocation | null> = {}

  private W = 1920
  private H = 1080

  private images = new Map<string, ImageEntry>()
  private canvasCache = new Map<string, CachedTex>()
  private cacheOrder: string[] = []
  private videos: VideoPool
  private videoTextures = new Map<string, WebGLTexture>()
  private playing = false
  private hidePlaceholders = false

  // render()/renderExact() re-group clips by trackId on every call (every
  // animation frame during playback). project.clips is replaced wholesale on
  // any real edit (store.ts's immutable-update convention), so caching the
  // grouping by that object's identity is safe and skips the regroup on the
  // common case: playhead-only ticks, where `clips` is the same reference
  // frame after frame.
  private clipsByTrackRef: Project['clips'] | null = null
  private clipsByTrack = new Map<string, Clip[]>()

  private groupClipsByTrack(clips: Project['clips']): Map<string, Clip[]> {
    if (this.clipsByTrackRef === clips) return this.clipsByTrack
    const map = new Map<string, Clip[]>()
    for (const clip of Object.values(clips)) {
      let arr = map.get(clip.trackId)
      if (!arr) {
        arr = []
        map.set(clip.trackId, arr)
      }
      arr.push(clip)
    }
    this.clipsByTrackRef = clips
    this.clipsByTrack = map
    return map
  }

  // Per-clip cache key for title/subtitle text, avoiding a JSON.stringify of
  // the whole TextProps object every frame (drawClip runs once per visible
  // title/subtitle clip per frame). Valid as long as the SAME object reference
  // is still current (store.ts replaces clip.text wholesale on any real edit,
  // same immutable-update convention as clips/tracks) and the render size
  // hasn't changed; otherwise mint a fresh key so cachedCanvas() correctly
  // misses and re-rasterizes. Capped like canvasCache so creating/deleting
  // many title clips over a long session can't grow this map unboundedly.
  private textKeyCache = new Map<string, { ref: TextProps; w: number; h: number; key: string }>()
  private textKeyCounter = 0

  private textCacheKey(clipId: string, text: TextProps): string {
    const cached = this.textKeyCache.get(clipId)
    if (cached && cached.ref === text && cached.w === this.W && cached.h === this.H) return cached.key
    const key = `text:${this.W}x${this.H}:${clipId}:${this.textKeyCounter++}`
    this.textKeyCache.set(clipId, { ref: text, w: this.W, h: this.H, key })
    if (this.textKeyCache.size > 64) {
      const oldest = this.textKeyCache.keys().next().value
      if (oldest !== undefined) this.textKeyCache.delete(oldest)
    }
    return key
  }

  // WebGL context-loss recovery. A lost GPU context must restore (rebuild GL
  // resources) instead of black-screening — the exact "looks like a crash"
  // symptom we want to avoid. State machine is pure (webglRestore.ts); this
  // class owns the rebuild side-effects.
  private restore = new RestoreMachine()
  /** True while a lost WebGL context is being recovered (drives the overlay). */
  get restoring(): boolean {
    return this.restore.state === 'reconnecting'
  }
  /** True when the context could not be recovered after repeated losses. */
  get restoreFailed(): boolean {
    return this.restore.state === 'failed'
  }

  constructor(
    canvas: HTMLCanvasElement,
    needsRender: () => void,
    opts: { preserveDrawingBuffer?: boolean } = {}
  ) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: true,
      // Export reads pixels back via toBlob, which needs the buffer preserved.
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false
    })
    if (!gl) throw new Error('WebGL is not available in this renderer')
    this.gl = gl
    this.needsRender = needsRender
    this.videos = new VideoPool(needsRender)

    this.buildGLResources()

    canvas.width = this.W
    canvas.height = this.H
  }

  /** Build (or rebuild after a context loss) the program, quad buffer, and
   *  uniform/attribute locations. Shared by the constructor and restore path. */
  private buildGLResources(): void {
    const gl = this.gl
    this.prog = this.buildProgram(VERT, FRAG)
    gl.useProgram(this.prog)

    this.quad = gl.createBuffer() as WebGLBuffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)

    this.aPos = gl.getAttribLocation(this.prog, 'aPos')
    for (const name of [
      'uRect', 'uTex', 'uUseTex', 'uColor', 'uOpacity', 'uChroma', 'uKey', 'uSim', 'uSmooth', 'uSpill',
      'uUVMin', 'uUVMax', 'uTrans', 'uScale', 'uRot', 'uAspect', 'uAnchor',
      'uColorOn', 'uExposure', 'uContrast', 'uSaturation', 'uTemp', 'uTint'
    ]) {
      this.u[name] = gl.getUniformLocation(this.prog, name)
    }
  }

  private buildProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type) as WebGLShader
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh)
        gl.deleteShader(sh)
        throw new Error(`Shader compile failed: ${log}`)
      }
      return sh
    }
    const prog = gl.createProgram() as WebGLProgram
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`)
    }
    return prog
  }

  setSize(w: number, h: number): void {
    if (w === this.W && h === this.H) return
    this.W = w
    this.H = h
    this.gl.canvas.width = w
    this.gl.canvas.height = h
    // Text/panel textures are baked at the old resolution; drop them.
    for (const key of this.cacheOrder) {
      const e = this.canvasCache.get(key)
      if (e) this.gl.deleteTexture(e.tex)
    }
    this.canvasCache.clear()
    this.cacheOrder = []
  }

  private uploadTexture(source: TexImageSource): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    return tex
  }

  private cachedCanvas(key: string, draw: () => HTMLCanvasElement): CachedTex {
    let entry = this.canvasCache.get(key)
    if (entry) return entry
    const canvas = draw()
    entry = { tex: this.uploadTexture(canvas), w: canvas.width, h: canvas.height }
    this.canvasCache.set(key, entry)
    this.cacheOrder.push(key)
    while (this.cacheOrder.length > 24) {
      const old = this.cacheOrder.shift() as string
      const oe = this.canvasCache.get(old)
      if (oe) {
        this.gl.deleteTexture(oe.tex)
        this.canvasCache.delete(old)
      }
    }
    return entry
  }

  private imageTexture(media: MediaItem): ImageEntry {
    const existing = this.images.get(media.id)
    if (existing) return existing

    let resolveReady: () => void = () => undefined
    const ready = new Promise<void>((res) => {
      resolveReady = res
    })
    const entry: ImageEntry = { tex: null, w: 0, h: 0, status: 'loading', ready }
    this.images.set(media.id, entry)

    const img = new Image()
    img.onload = () => {
      entry.tex = this.uploadTexture(img)
      entry.w = img.naturalWidth
      entry.h = img.naturalHeight
      entry.status = 'ready'
      resolveReady()
      this.needsRender()
    }
    img.onerror = () => {
      entry.status = 'error'
      resolveReady()
      this.needsRender()
    }
    img.src = mediaUrl(media.path)
    return entry
  }

  private drawQuad(
    baseRect: { x: number; y: number; w: number; h: number },
    tex: WebGLTexture | null,
    color: [number, number, number, number] | null,
    effects: Effects,
    tf: ClipTransform,
    opacity: number
  ): void {
    const gl = this.gl
    const u = this.u
    const cr = tf.crop
    // Crop insets BOTH the geometry rect and the UV window by equal fractions,
    // so content is cut (not squished) and what remains keeps its position/scale.
    gl.uniform4f(
      u.uRect,
      baseRect.x + baseRect.w * cr.left,
      baseRect.y + baseRect.h * cr.top,
      baseRect.w * (1 - cr.left - cr.right),
      baseRect.h * (1 - cr.top - cr.bottom)
    )
    gl.uniform2f(u.uUVMin, cr.left, cr.top)
    gl.uniform2f(u.uUVMax, 1 - cr.right, 1 - cr.bottom)
    gl.uniform2f(u.uTrans, tf.posX, tf.posY)
    gl.uniform1f(u.uScale, tf.scale)
    gl.uniform1f(u.uRot, (tf.rotationDeg * Math.PI) / 180)
    gl.uniform1f(u.uAspect, this.W / this.H)
    // Pivot is the ORIGINAL (uncropped) content centre, so a keyframed crop
    // pivots in place instead of swimming.
    gl.uniform2f(u.uAnchor, baseRect.x + baseRect.w * 0.5, baseRect.y + baseRect.h * 0.5)
    if (tex) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(u.uTex, 0)
      gl.uniform1i(u.uUseTex, 1)
    } else {
      gl.uniform1i(u.uUseTex, 0)
      const c = color ?? [0, 0, 0, 1]
      gl.uniform4f(u.uColor, c[0], c[1], c[2], c[3])
    }
    gl.uniform1f(u.uOpacity, opacity)
    const ck = effects.chroma
    gl.uniform1i(u.uChroma, ck.enabled ? 1 : 0)
    if (ck.enabled) {
      const [r, g, b] = hexToRgb01(ck.color)
      gl.uniform3f(u.uKey, r, g, b)
      gl.uniform1f(u.uSim, ck.similarity)
      gl.uniform1f(u.uSmooth, ck.smoothness)
      gl.uniform1f(u.uSpill, ck.spill)
    }
    const cc = effects.color
    const colorOn = !isNeutralColor(cc)
    gl.uniform1i(u.uColorOn, colorOn ? 1 : 0)
    if (colorOn && cc) {
      gl.uniform1f(u.uExposure, cc.exposure)
      gl.uniform1f(u.uContrast, cc.contrast)
      gl.uniform1f(u.uSaturation, cc.saturation)
      gl.uniform1f(u.uTemp, cc.temperature)
      gl.uniform1f(u.uTint, cc.tint)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** (Re)upload the current frame (a <video> OR a WebCodecs VideoFrame) into
   *  its reused texture. Both are valid texImage2D sources. */
  private uploadVideoFrame(id: string, video: FrameSource): WebGLTexture {
    const gl = this.gl
    let tex = this.videoTextures.get(id)
    if (!tex) {
      tex = gl.createTexture() as WebGLTexture
      this.videoTextures.set(id, tex)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex)
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    return tex
  }

  private drawClip(project: Project, clip: Clip, playheadSec: number): void {
    const effects = clip.effects ?? defaultEffects()
    // Sample transform + opacity once at clip-relative time; the SAME values feed
    // preview and export (renderExact -> render -> drawClip), so they animate alike.
    const tRel = playheadSec - clip.startSec
    const tf = sampleTransform(clip, tRel)
    const opacity = sampleOpacity(clip, effects.opacity, tRel)

    if (clip.role === 'title' || clip.role === 'subtitle') {
      if (!clip.text || !clip.text.content.trim()) return
      const key = this.textCacheKey(clip.id, clip.text)
      const tex = this.cachedCanvas(key, () => renderTextCanvas(clip.text as TextProps, this.W, this.H))
      this.drawQuad({ x: 0, y: 0, w: 1, h: 1 }, tex.tex, null, effects, tf, opacity)
      return
    }

    const media = clip.mediaId ? project.media[clip.mediaId] : undefined

    if (media && media.kind === 'video' && media.path) {
      const speed = clip.speed ?? 1
      const srcTime = clip.inSec + (playheadSec - clip.startSec) * speed
      const frame = this.videos.want(media.id, media.path, srcTime, this.playing, speed)
      if (frame && frame.width > 0 && frame.height > 0) {
        const tex = this.uploadVideoFrame(media.id, frame.source)
        this.drawQuad(containRect(frame.width, frame.height, this.W, this.H), tex, null, effects, tf, opacity)
        return
      }
      if (this.hidePlaceholders) return
      const key = `panel:${this.W}x${this.H}:${media.id}:buffering`
      const tex = this.cachedCanvas(key, () => renderPanelCanvas(media.name, 'buffering…', this.W, this.H))
      this.drawQuad({ x: 0, y: 0, w: 1, h: 1 }, tex.tex, null, effects, tf, opacity)
      return
    }

    if (media && media.kind === 'image' && media.path) {
      const entry = this.imageTexture(media)
      if (entry.status === 'ready' && entry.tex) {
        this.drawQuad(containRect(entry.w, entry.h, this.W, this.H), entry.tex, null, effects, tf, opacity)
        return
      }
      if (this.hidePlaceholders) return
      const note = entry.status === 'error' ? 'could not load image' : 'loading…'
      const key = `panel:${this.W}x${this.H}:${media.id}:${note}`
      const tex = this.cachedCanvas(key, () => renderPanelCanvas(media.name, note, this.W, this.H))
      this.drawQuad({ x: 0, y: 0, w: 1, h: 1 }, tex.tex, null, effects, tf, opacity)
      return
    }

    // Sourceless clip (e.g. the built-in sample): labelled placeholder card.
    if (this.hidePlaceholders) return
    const label = media ? media.name : 'Clip'
    const sub = 'no source file'
    const key = `panel:${this.W}x${this.H}:${media?.id ?? clip.id}:${label}:${sub}`
    const tex = this.cachedCanvas(key, () => renderPanelCanvas(label, sub, this.W, this.H))
    this.drawQuad({ x: 0, y: 0, w: 1, h: 1 }, tex.tex, null, effects, tf, opacity)
  }

  render(
    project: Project,
    playheadSec: number,
    playing = false,
    opts: { hidePlaceholders?: boolean } = {}
  ): void {
    // While a lost context is being recovered, drawing would hit a dead GL
    // context. Skip silently — the overlay tells the user what's happening.
    if (this.restore.state === 'reconnecting') return
    this.setSize(project.width, project.height)
    this.playing = playing
    this.hidePlaceholders = opts.hidePlaceholders ?? false
    const gl = this.gl

    gl.viewport(0, 0, this.W, this.H)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(this.aPos)
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const t = playheadSec
    const byTrack = this.groupClipsByTrack(project.clips)

    // Bottom track first so the topmost track ends up on top of the stack.
    for (let ti = project.tracks.length - 1; ti >= 0; ti--) {
      const track = project.tracks[ti]
      if (track.kind !== 'video' || track.hidden) continue
      const clips = byTrack.get(track.id)
      if (!clips) continue
      for (const clip of clips) {
        if (t < clip.startSec || t >= clip.startSec + clip.durationSec) continue
        this.drawClip(project, clip, t)
      }
    }

    // Pause any video elements no longer under the playhead.
    this.videos.endFrame()
  }

  /** Ensure every image used by the project is decoded. For export preflight. */
  async preload(project: Project): Promise<void> {
    const seen = new Set<string>()
    const waits: Promise<void>[] = []
    for (const clip of Object.values(project.clips)) {
      if (!clip.mediaId) continue
      const media = project.media[clip.mediaId]
      if (media && media.kind === 'image' && media.path && !seen.has(media.id)) {
        seen.add(media.id)
        waits.push(this.imageTexture(media).ready)
      }
    }
    await Promise.all(waits)
  }

  /**
   * Deterministic render for export: seek every active video to its exact source
   * time and WAIT for the frame before compositing, so each output frame is the
   * right one. Placeholders are suppressed so empty lanes export as transparent.
   */
  async renderExact(project: Project, t: number): Promise<void> {
    const seeks: Promise<void>[] = []
    const byTrack = this.groupClipsByTrack(project.clips)
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue
      const clips = byTrack.get(track.id)
      if (!clips) continue
      for (const clip of clips) {
        if (t < clip.startSec || t >= clip.startSec + clip.durationSec) continue
        if (!clip.mediaId) continue
        const media = project.media[clip.mediaId]
        if (media && media.kind === 'video' && media.path) {
          seeks.push(this.videos.seekTo(media.id, media.path, clip.inSec + (t - clip.startSec) * (clip.speed ?? 1)))
        }
      }
    }
    await Promise.all(seeks)
    this.render(project, t, false, { hidePlaceholders: true })
  }

  /** The video pool, so the audio engine can tap video-element audio. */
  getVideoPool(): VideoPool {
    return this.videos
  }

  /** Call from the canvas 'webglcontextlost' listener. preventDefault signals
   *  we'll restore; cached GL resources belong to the dead context and are
   *  dropped so the next render repopulates them from content caches. */
  handleContextLoss(e: Event): void {
    e.preventDefault()
    this.restore.onLost()
    this.images.clear()
    this.canvasCache.clear()
    this.videoTextures.clear()
    this.cacheOrder = []
  }

  /** Call from the canvas 'webglcontextrestored' listener. Rebuilds the GL
   *  program/buffers exactly once; textures repopulate lazily on next render. */
  handleContextRestore(): void {
    if (this.restore.onRestored()) this.buildGLResources()
  }

  /** Call once a restored context has survived a stable render cycle, so a
   *  later, unrelated loss doesn't count against this recovery's retry budget. */
  markStable(): void {
    this.restore.markStable()
  }

  dispose(): void {
    const gl = this.gl
    for (const e of this.images.values()) if (e.tex) gl.deleteTexture(e.tex)
    for (const e of this.canvasCache.values()) gl.deleteTexture(e.tex)
    for (const tex of this.videoTextures.values()) gl.deleteTexture(tex)
    this.images.clear()
    this.canvasCache.clear()
    this.videoTextures.clear()
    this.cacheOrder = []
    this.textKeyCache.clear()
    this.clipsByTrackRef = null
    this.clipsByTrack.clear()
    this.videos.dispose()
    gl.deleteBuffer(this.quad)
    gl.deleteProgram(this.prog)
  }
}
