/**
 * The conversion pipeline: sniff -> decode -> resize -> encode.
 *
 * This is the whole engine's public entry point and the only thing a worker
 * needs to import. It is deliberately total: every failure mode comes back as
 * a ConvertFailure with a message a human can read, so a single bad file in a
 * batch can never take down the worker.
 */

import type { ConvertRequest, ConvertResult, SourceFormat } from '../types'
import { decode, type PhaseReporter } from './decode'
import { encode } from './encode'
import { applyResize } from './resize'
import { outputName, sniffFormat } from './format'

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message
  }
  if (typeof cause === 'string' && cause.trim().length > 0) return cause
  return 'Something went wrong while converting this image'
}

/**
 * Convert one image. Never rejects — failures resolve to a ConvertFailure.
 *
 * The source format is re-detected from the bytes rather than trusted from the
 * request, because the request's `sourceFormat` was usually guessed from a
 * filename and filenames lie.
 *
 * `report`, when given, is called as the decode moves between phases the user
 * can feel. Today only HEIC ever calls it, and only on the first HEIC a worker
 * sees: that is the one conversion that stops for a 1.4 MB download before any
 * pixel work begins.
 */
export async function convertImage(
  req: ConvertRequest,
  report?: PhaseReporter,
): Promise<ConvertResult> {
  const startedAt = performance.now()

  try {
    const inputBytes = req.originalBytes ?? req.bytes.byteLength
    const target = req.options.target
    const format: SourceFormat = sniffFormat(req.bytes) ?? req.sourceFormat

    const decoded = await decode(req.bytes, format, report)
    const resized = applyResize(decoded, req.options.resize)
    const bytes = await encode(resized, req.options)

    return {
      id: req.id,
      ok: true,
      bytes,
      outName: outputName(req.fileName, target),
      outFormat: target,
      width: resized.width,
      height: resized.height,
      inputBytes,
      outputBytes: bytes.byteLength,
      durationMs: performance.now() - startedAt,
    }
  } catch (cause) {
    return {
      id: req.id,
      ok: false,
      error: errorMessage(cause),
    }
  }
}

/* Barrel: the rest of the app should only ever import from here. */
export { decode, UNDECODABLE_MESSAGE } from './decode'
export { encode } from './encode'
export { applyResize } from './resize'
export { outputName, sniffFormat } from './format'
