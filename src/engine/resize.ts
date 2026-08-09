/**
 * Resampling: raw RGBA pixels -> raw RGBA pixels at new dimensions.
 *
 * Synchronous and worker-safe. Everything runs on OffscreenCanvas with
 * high-quality smoothing enabled.
 */

import type { ResizeOptions } from '../types'

/**
 * Every engine caps canvas dimensions somewhere between 16k and 32k px, and
 * exceeding the cap throws or silently yields a blank canvas. Clamping here
 * turns an absurd request into a merely large image instead of a failure.
 */
const MAX_DIMENSION = 16384

interface Size {
  width: number
  height: number
}

function isPositiveNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Round to a whole pixel, never below 1, never above the canvas cap. */
function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(value)))
}

/**
 * Work out the target dimensions for a resize request. Requests that are
 * missing their required fields fall back to the original size rather than
 * throwing — a half-filled form should not fail a conversion.
 */
function targetSize(source: Size, resize: ResizeOptions): Size {
  const { width: sourceWidth, height: sourceHeight } = source

  switch (resize.mode) {
    case 'exact': {
      if (!isPositiveNumber(resize.width) || !isPositiveNumber(resize.height)) {
        return source
      }
      // Aspect ratio is deliberately ignored here.
      return {
        width: clampDimension(resize.width),
        height: clampDimension(resize.height),
      }
    }

    case 'fit': {
      if (!isPositiveNumber(resize.width) || !isPositiveNumber(resize.height)) {
        return source
      }
      // The trailing 1 is what makes 'fit' downscale-only.
      const ratio = Math.min(
        resize.width / sourceWidth,
        resize.height / sourceHeight,
        1,
      )
      if (ratio >= 1) return source
      return {
        width: clampDimension(sourceWidth * ratio),
        height: clampDimension(sourceHeight * ratio),
      }
    }

    case 'scale': {
      if (!isPositiveNumber(resize.scale)) return source
      const factor = resize.scale / 100
      return {
        width: clampDimension(sourceWidth * factor),
        height: clampDimension(sourceHeight * factor),
      }
    }

    case 'none':
    default:
      return source
  }
}

function createCanvas(
  width: number,
  height: number,
): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    throw new Error('This browser could not open a 2D canvas to resize the image')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

function canvasFromImageData(img: ImageData): OffscreenCanvas {
  const { canvas, ctx } = createCanvas(img.width, img.height)
  ctx.putImageData(img, 0, 0)
  return canvas
}

function scaleCanvas(
  source: OffscreenCanvas,
  width: number,
  height: number,
): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const surface = createCanvas(width, height)
  surface.ctx.drawImage(source, 0, 0, width, height)
  return surface
}

/**
 * Resize `img` according to `resize`. Returns the original ImageData untouched
 * when the request is a no-op, so a 'none' conversion costs nothing.
 */
export function applyResize(img: ImageData, resize: ResizeOptions): ImageData {
  const target = targetSize({ width: img.width, height: img.height }, resize)
  if (target.width === img.width && target.height === img.height) return img

  let source = canvasFromImageData(img)
  let currentWidth = img.width
  let currentHeight = img.height

  // A single bilinear step below ~50% drops detail and aliases badly, so halve
  // repeatedly until one final step lands on the target.
  while (currentWidth > target.width * 2 && currentHeight > target.height * 2) {
    const nextWidth = Math.max(target.width, Math.floor(currentWidth / 2))
    const nextHeight = Math.max(target.height, Math.floor(currentHeight / 2))
    source = scaleCanvas(source, nextWidth, nextHeight).canvas
    currentWidth = nextWidth
    currentHeight = nextHeight
  }

  const { ctx } = scaleCanvas(source, target.width, target.height)
  return ctx.getImageData(0, 0, target.width, target.height)
}
