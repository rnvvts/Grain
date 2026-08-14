/**
 * Decoding: compressed bytes -> raw RGBA pixels.
 *
 * Worker-safe. Uses `createImageBitmap` + `OffscreenCanvas`, never `document`
 * or `window`. The WASM decoders are pulled in with dynamic `import()` so their
 * (large) payloads are only fetched on the browsers that actually need them —
 * typically older Safari, which cannot decode AVIF natively, and every
 * non-Apple browser for HEIC.
 *
 * HEIC is an input format only. Its payload is HEVC, whose encoder is
 * patent-encumbered, so the WASM build of libheif carries a decoder and nothing
 * else; that asymmetry is why `SourceFormat` is wider than `ImageFormat`. This
 * module reads HEIC and no module anywhere writes it.
 *
 * One hard constraint worth knowing before moving any of this: the HEIC path
 * cannot run on the main thread. libheif's bundle compiles its WASM with
 * `new WebAssembly.Module()` and offers no async alternative, and browsers
 * reject synchronous compilation of anything over 4 KB off-worker. SVG is the
 * mirror image — it needs the main thread, because rasterising it wants a DOM.
 */

import type {
  HeifDecoder,
  HeifImage,
  HeifRgbaImage,
} from 'libheif-js/libheif-wasm/libheif-bundle.mjs'
import type { SourceFormat } from '../types'
import { sniffFormat } from './format'

export const UNDECODABLE_MESSAGE =
  "This file isn't a readable PNG/JPEG/WebP/AVIF/HEIC/SVG image"

export const UNDECODABLE_SVG_MESSAGE =
  "This browser couldn't rasterise this SVG. It may reference external files " +
  '(which are blocked for local files) or be missing a width, height, or viewBox.'

/**
 * libheif could not parse the container at all.
 *
 * This is the branch that actually fires in the field, and the wording has to
 * match what libheif is really complaining about ("No 'ftyp' box", "Cannot read
 * full meta box"): the bytes stopped making sense before any image was found.
 * A photo that arrived truncated from a share sheet lands here, so the message
 * has to give the user a reason to re-copy the file. It also has to leave room
 * for "this was never a HEIC", because a file can reach this path on the
 * strength of its extension alone.
 */
export const UNREADABLE_HEIC_MESSAGE =
  "This file couldn't be read as a HEIC. It may be incomplete or damaged (a " +
  'partial download or a failed transfer), or it may not be a HEIC at all.'

/**
 * The container parsed and held an image, but that image yielded no pixels.
 *
 * Narrow on purpose. It must NOT claim that bursts and Live Photos are
 * unsupported — `decodeHeic` converts the first frame of those perfectly well
 * — only that an image carrying no displayable picture (a depth map or another
 * auxiliary-only image, stored as the primary) has nothing to convert.
 */
export const PICTURELESS_HEIC_MESSAGE =
  "This HEIC's image holds no displayable picture. Depth maps and other " +
  'auxiliary-only images have no pixels to convert — only ordinary photo ' +
  'HEICs do.'

/**
 * The decoder itself never arrived. Separate from a decode failure: nothing is
 * wrong with the file, so retrying it is worth suggesting.
 *
 * Retrying only works because the pool throws this worker away when it sees
 * this message (see ConverterPool.handleResult): a failed dynamic `import()` is
 * remembered by the worker's module map for the life of that realm, so the same
 * worker could never re-fetch the chunk however many times the user pressed
 * Convert. Changing this string means changing it there too.
 */
export const HEIC_DECODER_UNAVAILABLE_MESSAGE =
  "The HEIC decoder (a 1.4 MB download) couldn't be loaded. Check your " +
  'connection and try this file again.'

/**
 * What the decode is doing right now, for the UI.
 *
 * Only HEIC ever reports anything: it is the one path that can stop for a
 * multi-second network fetch before any pixel work starts, and a card showing a
 * plain "Converting" for the length of a 1.4 MB download on a slow connection
 * is indistinguishable from a stuck one.
 */
export type DecodePhase = 'loading-decoder' | 'decoding'

export type PhaseReporter = (phase: DecodePhase) => void

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

/** Did a decode attempt produce pixels we can actually use? */
function isUsable(image: ImageData | null): image is ImageData {
  return image !== null && image.width > 0 && image.height > 0
}

/**
 * Native path: hand the bytes to the browser's own image decoder.
 *
 * `type` is the MIME stamped on the Blob, and the default of *none* is the
 * deliberate choice for ordinary raster files: `createImageBitmap` sniffs the
 * bytes itself, so an unstamped Blob decodes even a mislabelled file. Pass a
 * type only where the browser needs the hint instead — an SVG is parsed as a
 * document rather than sniffed, and HEIC is routed through the platform image
 * stack on some engines, which an unlabelled blob never reaches.
 */
async function decodeNative(bytes: ArrayBuffer, type?: string): Promise<ImageData | null> {
  let bitmap: ImageBitmap
  try {
    const blob = type === undefined ? new Blob([bytes]) : new Blob([bytes], { type })
    bitmap = await createImageBitmap(blob)
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

// ------------------------------------------------------------------- HEIC

/**
 * libheif, cached for the lifetime of this worker.
 *
 * Two separate reasons to hold on to this, and it is worth keeping them apart.
 *
 * The *module* is cached for cost: instantiating it means a 1.4 MB download
 * plus a WASM compile, and a fifty-photo batch must pay that once rather than
 * fifty times. (Each worker in the pool has its own module scope and therefore
 * its own heap. That is unavoidable, and is part of why MAX_POOL_SIZE exists.)
 *
 * The *decoder* is cached for memory, and this one is not a guess. A decoder
 * frees the HEIF context left over from its own previous call and at no other
 * time — the wrapper exposes no way to release one otherwise — so a fresh
 * decoder per photo strands every context it ever made. Counting the calls over
 * a 50-file run: a fresh decoder each time allocates 50 contexts and frees
 * none, while one reused decoder allocates 50 and frees 49. Each stranded
 * context holds a full copy of that file's compressed bytes (the wrapper reads
 * with the copying variant), which for iPhone photos is a few megabytes apiece
 * — hundreds of megabytes across a batch, in a heap that never shrinks.
 * Reusing one decoder keeps exactly one context alive, which is the lifecycle
 * the wrapper was written for.
 */
let decoderPromise: Promise<HeifDecoder> | null = null

function loadDecoder(report?: PhaseReporter): Promise<HeifDecoder> {
  if (decoderPromise !== null) return decoderPromise

  // Nothing is cached, so this call is the one that pays for the download.
  // Reported before the import starts and never after: only the first HEIC in a
  // worker can ever see this, which is exactly the honest story.
  report?.('loading-decoder')

  // Dynamic, and it must stay dynamic: a static import would put 1.4 MB of
  // decoder in the main bundle for every visitor who never touches a HEIC.
  //
  // `default()` returns the ready module synchronously in this build rather
  // than a promise, hence the `await` folded into the chain — it costs nothing
  // and survives a future build that instantiates asynchronously.
  const pending = import('libheif-js/libheif-wasm/libheif-bundle.mjs')
    .then((module) => module.default())
    .then((libheif) => new libheif.HeifDecoder())

  decoderPromise = pending

  pending.then(
    () => report?.('decoding'),
    () => {
      // Drop the cache so a later HEIC re-enters this function rather than
      // re-awaiting a settled rejection. That is NOT enough on its own: the
      // failed `import()` is recorded in this realm's module map, so the retry
      // resolves to the same error without touching the network. Only a fresh
      // worker clears it, which is why the pool replaces any worker that
      // reports HEIC_DECODER_UNAVAILABLE_MESSAGE. Callers still see this
      // rejection through `pending` itself.
      if (decoderPromise === pending) decoderPromise = null
    },
  )

  return pending
}

/** Tail of the queue below. Never rejects, so the chain can never stall. */
let heicQueue: Promise<unknown> = Promise.resolve()

/**
 * Run `task` with exclusive use of the shared decoder.
 *
 * Sharing one decoder is what bounds memory (see above), but it means a second
 * `decode` frees the HEIF context the first one is still working from. The
 * image handles do outlive that free — they keep their own reference to the
 * pixel data, and a small file decodes fine straight through it — which is
 * precisely what makes it worth guarding: it is a use-after-free that usually
 * looks like it worked. A worker only ever runs one job at a time, so queueing
 * costs nothing here and settles the question rather than leaving it to luck.
 */
function withDecoder<T>(
  task: (decoder: HeifDecoder) => Promise<T>,
  report?: PhaseReporter,
): Promise<T> {
  const run = heicQueue.then(async (): Promise<T> => {
    let decoder: HeifDecoder
    try {
      decoder = await loadDecoder(report)
    } catch {
      throw new Error(HEIC_DECODER_UNAVAILABLE_MESSAGE)
    }
    return await task(decoder)
  })

  // Swallow the outcome: one failed file must not reject the queue and take the
  // next file down with it.
  heicQueue = run.then(
    () => undefined,
    () => undefined,
  )

  return run
}

/** Pull the RGBA pixels out of one decoded HEIC image. */
async function toImageData(image: HeifImage): Promise<ImageData> {
  const width = image.get_width()
  const height = image.get_height()
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(PICTURELESS_HEIC_MESSAGE)
  }

  let data: Uint8ClampedArray<ArrayBuffer>
  try {
    data = new Uint8ClampedArray(width * height * 4)
  } catch {
    // A phone camera HEIC is 12 MP, which is ~48 MB of RGBA before the encoder
    // has allocated anything. Say so, rather than letting a bare
    // "Invalid typed array length" reach the user.
    throw new Error(`This HEIC is too large to decode in this browser (${width}x${height})`)
  }

  const filled = await new Promise<HeifRgbaImage>((resolve, reject) => {
    image.display({ width, height, data }, (result) => {
      // Truthiness, not `=== null`: the contract is "calls back with something
      // falsy on failure". Every path out of here must settle the promise — a
      // pending one would leave the file stuck on "Converting" for good.
      if (result) resolve(result)
      else reject(new Error(PICTURELESS_HEIC_MESSAGE))
    })
  })

  // ImageData wraps this buffer instead of copying it, which matters at these
  // sizes: we want one 48 MB array, not two.
  return new ImageData(filled.data, width, height)
}

/**
 * WASM fallback for HEIC, via libheif.
 *
 * Unlike the other WASM paths this throws instead of returning null, so the
 * caller can tell "libheif refused these bytes" apart from "this browser has no
 * decoder". Which message the user finally sees is decided in `decode`, which
 * is the only place that knows whether the bytes really sniffed as HEIC or
 * whether the filename merely claimed they had.
 *
 * @throws a user-facing Error when the file cannot be decoded.
 */
export function decodeHeic(bytes: ArrayBuffer, report?: PhaseReporter): Promise<ImageData> {
  return withDecoder(async (decoder) => {
    const images = decoder.decode(new Uint8Array(bytes))

    // `decode` reports failure by returning an empty array — it logs its own
    // diagnostic to the console and never throws. Checking the length is what
    // stops a bad file from surfacing as "cannot read properties of undefined
    // (reading 'get_width')", which tells the user nothing.
    //
    // Everything that fails to PARSE lands here: a truncated photo, a corrupted
    // one, a file that was never a HEIC. Nothing about the number of images in
    // a valid file reaches this branch, which is why the message must not
    // mention bursts or Live Photos — see just below, where they decode fine.
    if (images.length === 0) throw new Error(UNREADABLE_HEIC_MESSAGE)

    try {
      // A HEIC container can hold several top-level images: the frames of a
      // burst, the still of a Live Photo alongside its cover, a depth map. We
      // take the first — the primary image, the one Photos shows — and
      // DELIBERATELY DISCARD the rest. Grain's contract is one file in, one
      // file out; exporting every frame would need a naming scheme and a UI to
      // go with it, which is a feature of its own rather than a silent side
      // effect of this one. A burst or Live Photo therefore converts, as its
      // first frame; it is not an error and must never be reported as one.
      return await toImageData(images[0])
    } finally {
      // Every handle, not just the one we read: each is a live allocation in
      // the WASM heap, and a burst holds a lot of them.
      for (const image of images) image.free()
    }
  }, report)
}

// ------------------------------------------------------------------- dispatch

/**
 * WASM fallback. Only reached when the browser's own decoder refused the file.
 * Each branch is a lazy dynamic import: nothing is downloaded unless used.
 *
 * `svg` and `heic` never arrive here — `decode` routes both before this point —
 * so they fall through to `default`.
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
 * For the ordinary raster formats `format` only picks the WASM fallback codec;
 * the fast path ignores it entirely, so a wrong guess still works whenever the
 * browser can decode. `svg` and `heic` are the exceptions — each needs its own
 * route and its own failure message.
 *
 * @throws a user-facing Error when the file cannot be decoded at all.
 */
export async function decode(
  bytes: ArrayBuffer,
  format: SourceFormat,
  report?: PhaseReporter,
): Promise<ImageData> {
  if (bytes.byteLength === 0) {
    throw new Error('This file is empty')
  }

  // SVG has no binary decoder to fall back to (native or WASM) — either the
  // browser's own renderer can draw it, or nothing here can.
  if (format === 'svg') {
    const svg = await decodeNative(bytes, 'image/svg+xml')
    if (isUsable(svg)) return svg
    throw new Error(UNDECODABLE_SVG_MESSAGE)
  }

  // HEIC also needs its own route, but unlike SVG it stays in the worker:
  // libheif is WASM and touches no DOM.
  if (format === 'heic') {
    // Native first, and this is not a long shot. HEIC is what iPhones shoot,
    // and Safari on macOS/iOS decodes it through the OS codecs — so the people
    // most likely to have these files are exactly the ones who can skip the
    // 1.4 MB download entirely.
    const native = await decodeNative(bytes)
    if (isUsable(native)) return native

    // Then again with the MIME spelled out, before paying for WASM: sniffing an
    // unlabelled blob is not enough on every engine that supports HEIC.
    const labelled = await decodeNative(bytes, 'image/heic')
    if (isUsable(labelled)) return labelled

    // Everywhere else, libheif.
    //
    // Whether its failure is allowed to *say* "HEIC" depends on where the
    // format came from. `convertImage` falls back to the caller's guess when
    // the bytes sniff as nothing at all (`sniffFormat(bytes) ?? sourceFormat`),
    // so a text file named notes.heic arrives here as 'heic' on the strength of
    // its extension. Telling that user about depth maps and auxiliary images
    // would be a confident, specific, false diagnosis of a file that is not a
    // HEIC. Only bytes that really are ISO-BMFF-with-an-HEVC-brand earn the
    // HEIC-specific wording; everything else falls back to the generic
    // "not a readable image", exactly as the same file named .png already does.
    const reallyHeic = sniffFormat(bytes) === 'heic'
    try {
      return await decodeHeic(bytes, report)
    } catch (cause) {
      if (reallyHeic) throw cause
      const message = cause instanceof Error ? cause.message : ''
      // Only the two file-blaming messages are rewritten. A missing decoder or
      // an out-of-memory decode is about the environment, not the file, and is
      // just as true for a misnamed one.
      if (message === UNREADABLE_HEIC_MESSAGE || message === PICTURELESS_HEIC_MESSAGE) {
        throw new Error(UNDECODABLE_MESSAGE)
      }
      throw cause
    }
  }

  const native = await decodeNative(bytes)
  if (isUsable(native)) return native

  const wasm = await decodeWithWasm(bytes, format)
  if (isUsable(wasm)) return wasm

  throw new Error(UNDECODABLE_MESSAGE)
}
