/**
 * Typings for the self-contained WASM build of libheif.
 *
 * `libheif-js` ships no declarations for this entry point. The `libheif.d.ts`
 * sitting next to the bundle describes the raw emscripten module only, and the
 * two classes we actually use — `HeifDecoder` and `HeifImage` — are hand-written
 * JavaScript stapled onto that module at the bottom of the bundle
 * (`r.HeifImage = ..., r.HeifDecoder = ...`), so they appear in no generated
 * typing at all.
 *
 * Hence this file. Without it, importing the bundle is a hard error under
 * `strict` (TS7016, "implicitly has an 'any' type"), and the declaration cannot
 * be moved into decode.ts: an ambient declaration inside a module file is read
 * as an augmentation, and augmenting an untyped JS module is TS2665.
 *
 * Only the members Grain calls are declared, and each one was read off
 * node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs at version 1.19.8
 * rather than guessed — including the two failure conventions (empty array,
 * falsy callback argument) that the types cannot express but callers must
 * honour.
 *
 * Note what is NOT here: `HeifEncoder`. The WASM build ships no HEVC encoder —
 * the codec is patent-encumbered — which is why `heic` lives in `SourceFormat`
 * and never in `ImageFormat`. HEIC is readable here and unwritable, forever.
 */
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  /**
   * An interleaved RGBA surface. The caller allocates one, hands it to
   * `HeifImage.display`, and receives the same object back once it is filled.
   * `data.length` must be exactly `width * height * 4`.
   */
  export interface HeifRgbaImage {
    width: number
    height: number
    /**
     * Pinned to `ArrayBuffer` rather than the default `ArrayBufferLike`: the
     * buffer is handed straight to the `ImageData` constructor, which refuses a
     * view that might be backed by a `SharedArrayBuffer`.
     */
    data: Uint8ClampedArray<ArrayBuffer>
  }

  /** One top-level image inside a HEIC container. */
  export interface HeifImage {
    get_width(): number
    get_height(): number
    /**
     * Decode this image into `target`.
     *
     * Asynchronous (the wrapper defers the work with `setTimeout`) and it never
     * throws: failure is signalled by calling `done` with a falsy value. A
     * caller that promisifies this MUST reject on that branch, or the promise
     * stays pending forever.
     */
    display(target: HeifRgbaImage, done: (result: HeifRgbaImage | null) => void): void
    /** Release the underlying image handle. Idempotent. */
    free(): void
  }

  export interface HeifDecoder {
    /**
     * Parse a HEIC/HEIF file and return every top-level image in it — a burst
     * or Live Photo sequence yields more than one.
     *
     * Failure is an EMPTY ARRAY, not an exception: the wrapper logs its own
     * diagnostic to the console and returns `[]`.
     *
     * Each call first frees the HEIF context left behind by the previous call
     * on the same decoder, which invalidates every `HeifImage` that call
     * returned. Two overlapping decodes on one decoder therefore corrupt each
     * other.
     */
    decode(data: Uint8Array): HeifImage[]
  }

  export interface LibheifModule {
    HeifDecoder: new () => HeifDecoder
  }

  /**
   * Instantiate libheif. The WASM binary is inlined in this bundle as base64,
   * so nothing is fetched relative to the page — which is what makes it safe
   * under a GitHub Pages subpath.
   *
   * WORKER ONLY. This build compiles the binary with `new WebAssembly.Module()`
   * and has no asynchronous instantiation path at all, and browsers refuse
   * synchronous WASM compilation of anything over 4 KB on the main thread. At
   * 1.4 MB, calling this outside a worker throws.
   *
   * The return type is a union because of that same sync compilation: this
   * build hands back a ready module directly rather than a promise (verified
   * against 1.19.8). Callers should `await` it regardless — that costs nothing,
   * and keeps working if a later build restores async instantiation.
   */
  export default function createLibheif(
    options?: Record<string, unknown>,
  ): LibheifModule | PromiseLike<LibheifModule>
}
