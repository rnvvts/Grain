/**
 * Why the quality slider is inert for a given target.
 *
 * Worded per-format, since "lossless" means something different for a real
 * codec (PNG) than for a wrapper that merely carries one (SVG). Shared by the
 * global options panel and the per-file override panel so the two can never
 * disagree — the override panel used to hardcode PNG's sentence and then show
 * it while the target was SVG.
 */

import type { ImageFormat } from '../types'

const LOSSLESS_NOTE: Partial<Record<ImageFormat, string>> = {
  png: 'PNG is lossless — every pixel is preserved, so quality has no effect on the output.',
  svg: 'The image is embedded losslessly inside the SVG wrapper, so quality has no effect on the output.',
}

export function losslessNote(target: ImageFormat): string {
  return (
    LOSSLESS_NOTE[target] ?? 'This format is lossless, so quality has no effect on the output.'
  )
}
