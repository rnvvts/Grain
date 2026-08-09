/**
 * Encoding: raw RGBA pixels -> compressed bytes.
 *
 * Worker-safe. PNG/JPEG/WebP go through the browser's native canvas encoder,
 * which is fast and adds nothing to the bundle. AVIF has no native encoder in
 * any browser, so it always goes through the bundled WASM codec.
 *
 * Every native result is verified: some Safari builds silently hand back a PNG
 * when asked for WebP, and shipping a .webp file that is really a PNG is worse
 * than taking the slow path.
 */

import type { ConvertOptions, ImageFormat } from '../types'
import { LOSSLESS_FORMATS, MIME, OPAQUE_FORMATS } from '../types'

const LABEL: Record<ImageFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  svg: 'SVG',
}

/** Base64 alphabet, RFC 4648 §4. Hand-rolled so this never depends on `btoa`
 * (not guaranteed on every worker global scope) and never builds one giant
 * intermediate string via `String.fromCharCode(...bytes)`, which blows the
 * call-stack argument limit on multi-megabyte images. */
const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    chunks.push(
      BASE64_CHARS[b0 >> 2],
      BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)],
      b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)],
      b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f],
    )
  }
  return chunks.join('')
}

/** Escape the handful of characters XML cares about inside an attribute value. */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * PNG bytes for embedding inside an SVG wrapper. Always lossless, regardless
 * of the caller's quality setting — a vector wrapper around a lossily
 * re-encoded raster would be a worse image with none of the size benefit
 * lossy encoding is normally for.
 */
async function pngBytesForEmbed(img: ImageData): Promise<ArrayBuffer> {
  const native = await encodeNative(img, 'png', 1)
  if (native !== null) return native
  const codec = await import('@jsquash/png')
  return await codec.encode(img)
}

/**
 * Wrap a PNG's bytes in a minimal SVG document. This is the only thing
 * "convert to SVG" can honestly mean for a photo: there is no encoder here (or
 * anywhere shipped in a browser) that traces raster pixels into real vector
 * paths, so the pixels travel along for the ride, base64-encoded, inside an
 * `<image>` element sized to match. The output scales like a vector as far as
 * layout is concerned, but it is exactly as sharp as the PNG inside it.
 */
async function encodeSvg(img: ImageData): Promise<ArrayBuffer> {
  const pngBytes = await pngBytesForEmbed(img)
  const href = `data:image/png;base64,${toBase64(pngBytes)}`
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${img.width}" height="${img.height}" viewBox="0 0 ${img.width} ${img.height}">\n` +
    `  <image width="${img.width}" height="${img.height}" href="${escapeXmlAttr(href)}" ` +
    `xlink:href="${escapeXmlAttr(href)}" />\n` +
    '</svg>\n'
  return new TextEncoder().encode(xml).buffer
}

/** Used when `options.background` is not a colour the canvas can parse. */
const FALLBACK_BACKGROUND = '#ffffff'

function createContext(
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext('2d')
  if (ctx === null) {
    throw new Error('This browser could not open a 2D canvas to encode the image')
  }
  return ctx
}

/** Our quality is 1-100; the canvas API wants 0-1. */
function toCanvasQuality(quality: number): number {
  return clampQuality(quality) / 100
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 80
  return Math.min(100, Math.max(1, Math.round(quality)))
}

/** AVIF effort is 0 (fastest) - 9 (smallest). */
function clampEffort(effort: number): number {
  if (!Number.isFinite(effort)) return 4
  return Math.min(9, Math.max(0, Math.round(effort)))
}

/**
 * Assigning an unparseable colour to `fillStyle` is silently ignored, leaving
 * whatever was there before — which would quietly matte transparency onto
 * black. Assign the candidate against two different priors: if both land on the
 * same value it parsed, otherwise it did not.
 */
function resolveBackground(
  ctx: OffscreenCanvasRenderingContext2D,
  requested: string,
): string {
  const candidate = requested.trim()
  if (candidate.length === 0) return FALLBACK_BACKGROUND

  ctx.fillStyle = '#000000'
  ctx.fillStyle = candidate
  const afterBlack = ctx.fillStyle

  ctx.fillStyle = '#ffffff'
  ctx.fillStyle = candidate
  const afterWhite = ctx.fillStyle

  return afterBlack === afterWhite ? candidate : FALLBACK_BACKGROUND
}

/**
 * Composite `img` over `background`. Required before encoding to a format in
 * OPAQUE_FORMATS: JPEG drops the alpha channel, and unflattened transparent
 * pixels come out black.
 */
function flattenOntoBackground(img: ImageData, background: string): ImageData {
  const ctx = createContext(img.width, img.height)
  ctx.putImageData(img, 0, 0)

  // 'destination-over' paints the matte *underneath* what is already there, so
  // one fillRect does the whole composite without a second canvas.
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = resolveBackground(ctx, background)
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.globalCompositeOperation = 'source-over'

  return ctx.getImageData(0, 0, img.width, img.height)
}

/**
 * Native canvas encode. Returns null (rather than throwing) whenever the
 * browser could not produce bytes in the format we actually asked for, which
 * is the caller's signal to fall back to WASM.
 */
async function encodeNative(
  img: ImageData,
  target: ImageFormat,
  quality: number,
): Promise<ArrayBuffer | null> {
  try {
    const ctx = createContext(img.width, img.height)
    ctx.putImageData(img, 0, 0)

    // PNG is lossless: passing a quality would be meaningless, and some
    // engines treat its presence as a request for a different codec path.
    const options: ImageEncodeOptions = LOSSLESS_FORMATS.includes(target)
      ? { type: MIME[target] }
      : { type: MIME[target], quality }

    const blob = await ctx.canvas.convertToBlob(options)
    if (blob.type.toLowerCase() !== MIME[target]) return null

    const buffer = await blob.arrayBuffer()
    return buffer.byteLength > 0 ? buffer : null
  } catch {
    return null
  }
}

/**
 * WASM encode. Always used for AVIF, and used as the fallback for the other
 * three when the browser's encoder is missing or lied about the output type.
 * Imports are dynamic so a codec is only downloaded when it is actually run.
 */
async function encodeWithWasm(
  img: ImageData,
  opts: ConvertOptions,
): Promise<ArrayBuffer> {
  const quality = clampQuality(opts.quality)

  switch (opts.target) {
    case 'avif': {
      const codec = await import('@jsquash/avif')
      const effort = clampEffort(opts.effort)
      // Assigned to a variable first so the extra legacy keys are allowed
      // through: @jsquash/avif v1 took cqLevel/effort, v2 takes quality/speed.
      // Sending both keeps this correct across either codec build.
      const avifOptions = {
        // v2 API: 0-100, higher is better.
        quality,
        // v2 API: 0 (slowest, smallest) - 10 (fastest). Inverse of effort.
        speed: 10 - effort,
        // v1 API: 0 (best) - 63 (worst). Inverted relative to our quality.
        cqLevel: Math.round(63 - ((quality - 1) / 99) * 63),
        effort,
      }
      return await codec.encode(img, avifOptions)
    }

    case 'webp': {
      const codec = await import('@jsquash/webp')
      return await codec.encode(img, { quality })
    }

    case 'jpeg': {
      const codec = await import('@jsquash/jpeg')
      return await codec.encode(img, { quality })
    }

    case 'png': {
      const codec = await import('@jsquash/png')
      return await codec.encode(img)
    }

    default:
      throw new Error('Unsupported output format')
  }
}

/**
 * Encode `img` to `opts.target`.
 *
 * @throws a user-facing Error when no encoder could produce the format.
 */
export async function encode(
  img: ImageData,
  opts: ConvertOptions,
): Promise<ArrayBuffer> {
  if (img.width < 1 || img.height < 1) {
    throw new Error('There are no pixels left to encode')
  }

  const target = opts.target

  // SVG has no native or WASM raster encoder to fall through to below — it is
  // always the wrapper path, regardless of quality/effort/background.
  if (target === 'svg') {
    let encoded: ArrayBuffer
    try {
      encoded = await encodeSvg(img)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`Could not encode this image as ${LABEL.svg}: ${detail}`)
    }
    if (encoded.byteLength === 0) {
      throw new Error(`Encoding to ${LABEL.svg} produced an empty file`)
    }
    return encoded
  }

  const pixels = OPAQUE_FORMATS.includes(target)
    ? flattenOntoBackground(img, opts.background)
    : img

  // No browser implements canvas AVIF encoding, so skip straight to WASM.
  if (target !== 'avif') {
    const native = await encodeNative(pixels, target, toCanvasQuality(opts.quality))
    if (native !== null) return native
  }

  let encoded: ArrayBuffer
  try {
    encoded = await encodeWithWasm(pixels, opts)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Could not encode this image as ${LABEL[target]}: ${detail}`)
  }

  if (encoded.byteLength === 0) {
    throw new Error(`Encoding to ${LABEL[target]} produced an empty file`)
  }
  return encoded
}
