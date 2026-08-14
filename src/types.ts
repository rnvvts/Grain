/**
 * Shared contract for the conversion engine.
 *
 * This file is the single source of truth that the engine, the worker pool and
 * the UI all code against. Treat it as frozen: changing a field here means
 * changing it in three places at once.
 */

/**
 * Canonical output formats. Note `jpeg` covers both .jpg and .jpeg.
 *
 * `svg` is not a real raster codec: there is no browser or WASM encoder that
 * *vectorises* a photo. "Converting to SVG" here means embedding a losslessly
 * encoded PNG inside an `<svg><image></svg>` wrapper — useful when some other
 * tool insists on a `.svg` file, not a way to shrink a photo or get real vector
 * art. Decoding an SVG *source*, by contrast, is a real rasterisation (the
 * browser's own SVG renderer draws it to a canvas), so that direction behaves
 * like every other format.
 */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'svg'

/**
 * Everything we can READ. A strict superset of ImageFormat.
 *
 * HEIC is the reason this split finally exists. It is decode-only and always
 * will be: the payload is HEVC, whose encoder is patent-encumbered, and the
 * WASM build of libheif ships no `HeifEncoder` at all. Nothing can be
 * converted *to* HEIC here, so it must never appear in the target picker —
 * which is exactly what keeping it out of `ImageFormat` guarantees at the type
 * level rather than by convention.
 */
export type SourceFormat = ImageFormat | 'heic'

/** Formats offered as conversion TARGETS. Drives the format picker. */
export const FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp', 'avif', 'svg']

/** Formats accepted as INPUT. */
export const SOURCE_FORMATS: readonly SourceFormat[] = [...FORMATS, 'heic']

/** Readable at input, impossible to produce at output. */
export const SOURCE_ONLY_FORMATS: readonly SourceFormat[] = ['heic']

export function isSourceOnly(format: SourceFormat): boolean {
  return SOURCE_ONLY_FORMATS.includes(format)
}

/** Display label for any format, source or target. */
export const SOURCE_LABEL: Record<SourceFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  svg: 'SVG',
  heic: 'HEIC',
}

/**
 * MIME types seen in the wild for each input format, for the picker's `accept`
 * attribute and for File.type hints. HEIC has two spellings and iOS sometimes
 * reports neither, which is why magic-byte sniffing stays authoritative.
 */
export const SOURCE_MIME: Record<SourceFormat, readonly string[]> = {
  png: ['image/png'],
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  webp: ['image/webp'],
  avif: ['image/avif'],
  svg: ['image/svg+xml'],
  heic: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'],
}

/** Filename extensions per input format, lowercase and without the dot. */
export const SOURCE_EXTENSIONS: Record<SourceFormat, readonly string[]> = {
  png: ['png'],
  jpeg: ['jpg', 'jpeg', 'jpe', 'jfif'],
  webp: ['webp'],
  avif: ['avif'],
  svg: ['svg'],
  heic: ['heic', 'heif', 'hif'],
}

/** Canonical file extension written for each output format. */
export const EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  svg: 'svg',
}

export const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

/** Formats that discard alpha and therefore need a matte colour. */
export const OPAQUE_FORMATS: readonly ImageFormat[] = ['jpeg']

/** Formats where the `quality` slider is meaningless (lossless only). */
export const LOSSLESS_FORMATS: readonly ImageFormat[] = ['png', 'svg']

export type ResizeMode =
  /** Keep original pixel dimensions. */
  | 'none'
  /** Scale down to fit inside width x height, preserving aspect ratio. Never upscales. */
  | 'fit'
  /** Force exact width x height, ignoring aspect ratio. */
  | 'exact'
  /** Scale by a percentage of the original. */
  | 'scale'

export interface ResizeOptions {
  mode: ResizeMode
  /** Required when mode is 'fit' or 'exact'. */
  width?: number
  /** Required when mode is 'fit' or 'exact'. */
  height?: number
  /** Percent, e.g. 50 means half size. Required when mode is 'scale'. */
  scale?: number
}

export interface ConvertOptions {
  target: ImageFormat
  /** 1-100. Ignored for formats in LOSSLESS_FORMATS. */
  quality: number
  resize: ResizeOptions
  /** Hex colour (e.g. '#ffffff') composited under transparency for opaque targets. */
  background: string
  /** AVIF encoder effort, 0 (fastest) - 9 (smallest). Ignored by other formats. */
  effort: number
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  target: 'webp',
  quality: 82,
  resize: { mode: 'none' },
  background: '#ffffff',
  effort: 4,
}

/** A job handed to a worker. `bytes` is transferred, not copied. */
export interface ConvertRequest {
  id: string
  fileName: string
  bytes: ArrayBuffer
  sourceFormat: SourceFormat
  options: ConvertOptions
  /**
   * True source-file size in bytes, when it differs from `bytes.byteLength`.
   * SVG sources are rasterised to PNG on the main thread before `bytes` ever
   * reaches a worker (workers have no `Image`/`document` to decode SVG with),
   * so `bytes` is already the *rasterised* payload by the time a worker sees
   * it. Without this, the reported "input size" would be the re-rasterised
   * PNG's size instead of the .svg file the user actually dropped in.
   */
  originalBytes?: number
}

export interface ConvertSuccess {
  id: string
  ok: true
  bytes: ArrayBuffer
  outName: string
  outFormat: ImageFormat
  width: number
  height: number
  inputBytes: number
  outputBytes: number
  durationMs: number
}

export interface ConvertFailure {
  id: string
  ok: false
  error: string
}

export type ConvertResult = ConvertSuccess | ConvertFailure

/**
 * A file the user supplied, together with where it sat in the folder they
 * dropped.
 *
 * `File` cannot carry this on its own: `webkitRelativePath` is populated by the
 * directory *picker* but is always empty for drag-and-drop, and the property is
 * read-only so it cannot be back-filled. Pairing the two in one object is the
 * only way a folder's shape survives the trip from the drop handler to the ZIP.
 */
export interface PickedFile {
  file: File
  /**
   * POSIX-style path relative to the dropped root, e.g. `photos/2024/a.png`.
   * Never absolute, never contains `..`, and is exactly `file.name` for a
   * loose file that arrived outside any folder.
   */
  relativePath: string
}

/** Lifecycle of one file in the UI. */
export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  file: File
  /** See PickedFile.relativePath. Drives the output path inside the ZIP. */
  relativePath: string
  sourceFormat: SourceFormat
  /** null until probed. */
  sourceWidth: number | null
  sourceHeight: number | null
  /** Object URL for the thumbnail preview. Revoke on removal. */
  previewUrl: string
  status: JobStatus
  /** Per-file override. When null the job uses the global options. */
  overrides: Partial<ConvertOptions> | null
  result: ConvertResult | null
}
