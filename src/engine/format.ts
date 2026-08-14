/**
 * Format identification and output naming.
 *
 * Everything here is pure and synchronous: no DOM, no canvas, no WASM. Safe to
 * call from the main thread (to classify a dropped file) or from a worker.
 */

import type { ImageFormat, SourceFormat } from '../types'
import { EXTENSION } from '../types'

/** PNG signature: \x89 P N G \r \n \x1a \n */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** ISO-BMFF brands that mean "the payload is AV1 image data". */
const AVIF_BRANDS = new Set(['avif', 'avis', 'av01', 'avio'])

/**
 * Generic HEIF container brands. These say "this is an ISO image container"
 * without saying which codec, so the compatible-brand list decides.
 */
const HEIF_CONTAINER_BRANDS = new Set(['mif1', 'msf1', 'miaf', 'mA1A', 'mA1B'])

/** HEVC brands. Same container family as AVIF but a codec no browser decodes. */
const HEVC_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
])

/**
 * Read `length` bytes at `offset` as ASCII. Returns '' when the read would run
 * past the end of the buffer, which callers treat as "no match".
 */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return ''
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i])
  }
  return out
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false
  }
  return true
}

/**
 * Classify an ISO-BMFF image container, which starts with an `ftyp` box:
 * [size:4]["ftyp"][major:4][minor:4] then a list of 4-byte compatible brands.
 *
 * AVIF and HEIC are the SAME container family distinguished only by the codec
 * their brands advertise — AV1 for AVIF, HEVC for HEIC. That is why one
 * function decides both: a lone `isAvif` predicate could only ever answer
 * "not AVIF" for a HEIC, throwing away the very bit that identifies it.
 */
function classifyIsoBmff(bytes: Uint8Array): 'avif' | 'heic' | null {
  if (ascii(bytes, 4, 4) !== 'ftyp') return null

  const major = ascii(bytes, 8, 4)
  if (AVIF_BRANDS.has(major)) return 'avif'
  if (HEVC_BRANDS.has(major)) return 'heic'
  if (!HEIF_CONTAINER_BRANDS.has(major)) return null

  // Generic container brand (e.g. 'mif1'): scan the compatible-brand list,
  // which lives between the end of the minor version and the end of the box.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxSize = bytes.length >= 4 ? view.getUint32(0) : 0
  const end = Math.min(boxSize > 16 ? boxSize : bytes.length, bytes.length)
  let sawHevc = false
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = ascii(bytes, offset, 4)
    if (AVIF_BRANDS.has(brand)) return 'avif'
    if (HEVC_BRANDS.has(brand)) sawHevc = true
  }
  if (sawHevc) return 'heic'
  // A bare 'mif1' container advertising no codec at all: treat as AVIF, which
  // is what the browser's own decoder will most likely make of it too.
  return 'avif'
}

/**
 * SVG is XML text, not a fixed binary signature, and real-world files often
 * lead with a BOM, an `<?xml ?>` prolog, a `<!DOCTYPE svg ...>` (Illustrator
 * and Inkscape both emit one, and it can run to several hundred bytes with an
 * inline entity list), and/or comments before the actual `<svg` tag.
 */
const SVG_PATTERN = new RegExp(
  '^\\uFEFF?\\s*(<\\?xml[^>]*\\?>\\s*)?(<!--[\\s\\S]*?-->\\s*)*' +
    '(<!DOCTYPE[^>]*(\\[[\\s\\S]*?\\])?\\s*>\\s*)?(<!--[\\s\\S]*?-->\\s*)*<svg[\\s/>]',
  'i',
)

function isSvg(head: Uint8Array): boolean {
  // Decoded leniently (no `fatal`): a truncated multi-byte sequence at the end
  // of `head` becomes a harmless replacement character, not a thrown error,
  // and the pattern only ever looks at the front of the text anyway.
  return SVG_PATTERN.test(new TextDecoder().decode(head))
}

/**
 * Identify an image by its magic bytes. Filenames lie — a `.png` that is
 * really a JPEG must still convert — so nothing here looks at the name.
 *
 * Returns `null` when the bytes are not a format we can read.
 */
export function sniffFormat(bytes: ArrayBuffer): SourceFormat | null {
  // 4096 bytes comfortably covers every binary signature we look at (including
  // an ISO-BMFF ftyp box with a long compatible-brand list) and also gives the
  // text-based SVG check enough room to see past a real-world DOCTYPE.
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4096))

  if (startsWith(head, PNG_SIGNATURE)) return 'png'

  // JPEG: SOI marker FF D8 followed by any marker start FF.
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg'
  }

  // WebP: "RIFF" [size:4] "WEBP"
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp'

  // AVIF and HEIC share the ISO-BMFF container; one pass decides between them.
  const isoBmff = classifyIsoBmff(head)
  if (isoBmff !== null) return isoBmff

  if (isSvg(head)) return 'svg'

  return null
}

/** Extensions short and alphanumeric enough to be a real file extension. */
const EXTENSION_PATTERN = /^[A-Za-z0-9]{1,8}$/

/**
 * Swap the extension of `inputName` for the canonical one of `target`.
 *
 *   outputName('photo.JPEG', 'webp')       -> 'photo.webp'
 *   outputName('my.photo.v2.png', 'avif')  -> 'my.photo.v2.avif'
 *   outputName('screenshot', 'jpeg')       -> 'screenshot.jpg'
 *
 * Names with no extension get one appended rather than losing part of the stem.
 */
export function outputName(inputName: string, target: ImageFormat): string {
  const extension = EXTENSION[target]
  const trimmed = inputName.trim()
  if (trimmed.length === 0) return `image.${extension}`

  // Keep any directory prefix intact (File.webkitRelativePath can carry one).
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const directory = separator >= 0 ? trimmed.slice(0, separator + 1) : ''
  const base = separator >= 0 ? trimmed.slice(separator + 1) : trimmed
  if (base.length === 0) return `${directory}image.${extension}`

  const dot = base.lastIndexOf('.')
  // dot > 0 so a dotfile like '.gitignore' keeps its whole name.
  const hasExtension = dot > 0 && EXTENSION_PATTERN.test(base.slice(dot + 1))
  const stem = hasExtension ? base.slice(0, dot) : base
  const cleaned = stem.replace(/\.+$/, '') || 'image'

  return `${directory}${cleaned}.${extension}`
}
