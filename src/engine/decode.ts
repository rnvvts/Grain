/**
 * Decoding: compressed bytes -> raw RGBA pixels.
 *
 * Worker-safe. Uses `createImageBitmap` + `OffscreenCanvas`, never `document`
 * or `window`. The WASM decoders are pulled in with dynamic `import()` so their
 * (large) .wasm payloads are only fetched on the browsers that actually need
 * them — typically older Safari, which cannot decode AVIF natively.
 */

import type { SourceFormat } from '../types'

export const UNDECODABLE_MESSAGE =
  "This file isn't a readable PNG/JPEG/WebP/AVIF/SVG image"

export const UNDECODABLE_SVG_MESSAGE =
  "This browser couldn't rasterise this SVG. It may reference external files " +
  '(which are blocked for local files) or be missing a width, height, or viewBox.'

/** Create a canvas and its 2D context together, so the context is never null. */
function createContext(
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext('2d')
  if (ctx === null) {
    throw new Error('This browser could not open a 2D canvas to decode the image')
  }
  return ctx
}

/**
 * Native path. `createImageBitmap` sniffs the bytes itself, so we deliberately
 * do not stamp a MIME type on the Blob — a mislabelled file still decodes.
 */
async function decodeNative(bytes: ArrayBuffer): Promise<ImageData | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes]))
  } catch {
    return null
  }

  try {
    const { width, height } = bitmap
    if (width < 1 || height < 1) return null
    const ctx = createContext(width, height)
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, width, height)
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * SVG source path. There is no WASM SVG rasteriser bundled here — this relies
 * entirely on the browser's own SVG renderer, so the Blob must be stamped with
 * the right MIME type (unlike `decodeNative`, which deliberately leaves raster
 * blobs untyped) or some browsers refuse to treat it as an image at all.
 */
async function decodeSvg(bytes: ArrayBuffer): Promise<ImageData | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/svg+xml' }))
  } catch {
    return null
  }

  try {
    const { width, height } = bitmap
    if (width < 1 || height < 1) return null
    const ctx = createContext(width, height)
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, width, height)
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

/**
 * WASM fallback. Only reached when the browser's own decoder refused the file.
 * Each branch is a lazy dynamic import: nothing is downloaded unless used.
 */
async function decodeWithWasm(
  bytes: ArrayBuffer,
  format: SourceFormat,
): Promise<ImageData | null> {
  try {
    switch (format) {
      case 'avif': {
        const codec = await import('@jsquash/avif')
        return await codec.decode(bytes)
      }
      case 'webp': {
        const codec = await import('@jsquash/webp')
        return await codec.decode(bytes)
      }
      case 'jpeg': {
        const codec = await import('@jsquash/jpeg')
        return await codec.decode(bytes)
      }
      case 'png': {
        const codec = await import('@jsquash/png')
        return await codec.decode(bytes)
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * Decode `bytes` into RGBA pixels.
 *
 * `format` is only used to pick the WASM fallback codec; the fast path ignores
 * it entirely, so a wrong guess still works whenever the browser can decode.
 *
 * @throws a user-facing Error when the file cannot be decoded at all.
 */
export async function decode(
  bytes: ArrayBuffer,
  format: SourceFormat,
): Promise<ImageData> {
  if (bytes.byteLength === 0) {
    throw new Error('This file is empty')
  }

  // SVG has no binary decoder to fall back to (native or WASM) — either the
  // browser's own renderer can draw it, or nothing here can.
  if (format === 'svg') {
    const svg = await decodeSvg(bytes)
    if (svg !== null && svg.width > 0 && svg.height > 0) return svg
    throw new Error(UNDECODABLE_SVG_MESSAGE)
  }

  const native = await decodeNative(bytes)
  if (native !== null && native.width > 0 && native.height > 0) return native

  const wasm = await decodeWithWasm(bytes, format)
  if (wasm !== null && wasm.width > 0 && wasm.height > 0) return wasm

  throw new Error(UNDECODABLE_MESSAGE)
}
