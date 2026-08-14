/**
 * useConverter — the single owner of application state.
 *
 * Everything here runs in the browser tab. There is no server: files are read
 * with the File API, handed to a worker pool as transferable ArrayBuffers, and
 * handed back as bytes we wrap in object URLs. Nothing is ever uploaded.
 *
 * Three invariants worth protecting when editing this file:
 *   1. Exactly ONE ConverterPool per mounted hook. It lives in a ref and is
 *      terminated on unmount. A pool per render leaks a worker per render.
 *   2. Every URL.createObjectURL call registers its URL in `urlsRef` so the
 *      unmount/remove paths can revoke it. A hundred un-revoked photo previews
 *      pins hundreds of megabytes for the lifetime of the tab.
 *   3. A file's identity is its `relativePath`, never its bare `file.name`.
 *      `a/logo.png` and `b/logo.png` are two different files; the ZIP has to
 *      contain both, in their own folders, under their original names. Every
 *      name here therefore travels as a path and is only ever split with the
 *      helpers in `utils/path`, which preserve names verbatim.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { zip } from 'fflate'
import { ConverterPool } from '../workers/pool'
import { sniffFormat } from '../engine/format'
import { UNDECODABLE_SVG_MESSAGE, type DecodePhase } from '../engine/decode'
import {
  DEFAULT_OPTIONS,
  EXTENSION,
  MIME,
  SOURCE_EXTENSIONS,
  SOURCE_FORMATS,
  SOURCE_LABEL,
  SOURCE_MIME,
} from '../types'
import {
  commonRootFolder,
  sanitizeRelativePath,
  splitPath,
  uniquePath,
  withBase,
} from '../utils/path'
import { createLimiter } from '../utils/limit'
import type {
  ConvertOptions,
  ConvertRequest,
  ConvertResult,
  ConvertSuccess,
  Job,
  PickedFile,
  SourceFormat,
} from '../types'

/* ------------------------------------------------------------------ *
 * Public shape
 * ------------------------------------------------------------------ */

/**
 * How loudly a notice should read.
 *
 * Re-dropping a folder you already added is ordinary and harmless, so the
 * files it skips are reported neutrally. A file we could not read at all is a
 * genuine warning. Rendering both in the same amber box made an everyday
 * action look like an error.
 */
export type NoticeTone = 'warn' | 'info'

/** A file we refused to queue, plus the reason, surfaced to the user. */
export interface Notice {
  name: string
  reason: string
  tone: NoticeTone
}

export interface ConverterSummary {
  total: number
  queued: number
  running: number
  done: number
  error: number
  /** Jobs that a "Convert all" press would act on (queued + retryable errors). */
  pending: number
  /** Total bytes of every source file currently in the list. */
  inputBytes: number
  /** Source bytes of the jobs that actually finished — the denominator for savings. */
  convertedInputBytes: number
  /** Encoded bytes produced so far. */
  outputBytes: number
  /** convertedInputBytes - outputBytes. Negative when the target format is bigger. */
  savedBytes: number
  /** savedBytes as a percentage of convertedInputBytes. 0 when nothing is done. */
  savedPercent: number
}

export interface ConverterApi {
  jobs: Job[]
  options: ConvertOptions
  summary: ConverterSummary
  isConverting: boolean
  isZipping: boolean
  notices: Notice[]
  /**
   * The folder every queued file came from, or '' when they came from
   * different roots or arrived loose.
   *
   * Derived here rather than in the view because it is O(n) in paths and must
   * NOT be recomputed on every commit: a batch of 5000 files produces
   * thousands of status updates, and re-splitting 5000 paths on each of them
   * is most of a quadratic freeze. It only changes when the list's membership
   * does, which is exactly when the cache below is invalidated.
   */
  rootFolder: string
  /**
   * Ids of jobs stalled on the one-off HEIC decoder download.
   *
   * Kept beside `jobs` rather than inside them because `Job` is part of the
   * frozen contract in types.ts, and because this is not part of a job's
   * lifecycle: it is a transient note about *why* a running job is taking so
   * long, and it is dropped the moment the job settles. Empty for every session
   * that never converts a HEIC, and for every HEIC after the first in a worker.
   */
  decoderFetchIds: ReadonlySet<string>
  /**
   * Takes files *with their folder paths*, so the export can mirror the upload.
   * Resolves once every file has been sniffed and committed, so the caller can
   * keep a busy affordance up for the whole ingest.
   */
  addFiles: (picked: PickedFile[]) => Promise<void>
  updateOptions: (patch: Partial<ConvertOptions>) => void
  setOverride: (id: string, patch: Partial<ConvertOptions> | null) => void
  convertAll: () => void
  cancelAll: () => void
  downloadOne: (id: string) => void
  downloadAllZip: () => void
  removeJob: (id: string) => void
  clearAll: () => void
  /** Clears one tone's notices, or all of them when called with no argument. */
  dismissNotices: (tone?: NoticeTone) => void
}

/* ------------------------------------------------------------------ *
 * Pure helpers (exported where the UI needs them)
 * ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Keep the numbers the encoders receive inside their documented ranges. */
function normalize(options: ConvertOptions): ConvertOptions {
  return {
    ...options,
    quality: Math.round(clamp(options.quality, 1, 100)),
    effort: Math.round(clamp(options.effort, 0, 9)),
  }
}

/**
 * Global options with a job's per-file overrides layered on top.
 * `resize` is a nested object, so it is replaced wholesale rather than merged —
 * a partial resize (mode without dimensions) would be meaningless.
 */
export function mergeOptions(
  base: ConvertOptions,
  overrides: Partial<ConvertOptions> | null,
): ConvertOptions {
  if (!overrides) return normalize(base)
  return normalize({
    ...base,
    ...overrides,
    resize: overrides.resize ? { ...overrides.resize } : base.resize,
  })
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string' && err.length > 0) return err
  return 'Conversion failed'
}

/** Crypto.randomUUID needs a secure context; keep a boring fallback for file:// runs. */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/* ---- source-format sniffing ---------------------------------------- */

// SVG needs room for a BOM, an XML prolog, and a real-world DOCTYPE (which can
// run to several hundred bytes) before the actual `<svg` tag appears.
const HEAD_BYTES = 4096

/**
 * Invert one of the per-format hint tables in `types.ts` into a flat
 * hint -> format lookup.
 *
 * Built from those tables rather than hand-listed here: the two maps this
 * replaces were a second copy of the same knowledge, and a copy is exactly how
 * a newly readable format ends up recognised by the picker but rejected by the
 * ingest. A format is now added in one place, `types.ts`, and both ends follow.
 */
function indexHints(
  table: Record<SourceFormat, readonly string[]>,
): Record<string, SourceFormat> {
  const index: Record<string, SourceFormat> = {}
  for (const format of SOURCE_FORMATS) {
    for (const hint of table[format]) index[hint.toLowerCase()] = format
  }
  return index
}

const MIME_TO_FORMAT: Record<string, SourceFormat> = indexHints(SOURCE_MIME)

const EXT_TO_FORMAT: Record<string, SourceFormat> = indexHints(SOURCE_EXTENSIONS)

/** "PNG, JPEG, WebP, AVIF, SVG or HEIC" — everything we can read, in prose. */
function readableFormatList(): string {
  const labels = SOURCE_FORMATS.map((format) => SOURCE_LABEL[format])
  if (labels.length < 2) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`
}

const UNSUPPORTED_REASON = `not a ${readableFormatList()}`

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Magic-byte detection, delegated to the engine's own sniffer rather than
 * duplicating it — a second hand-rolled copy here is exactly how the SVG
 * pattern or a brand list would quietly drift out of sync with the one that
 * actually runs the conversion. File.type is authoritative only as a last
 * resort: it's empty for a lot of drag sources and outright wrong for files
 * renamed by hand.
 *
 * Bytes first matters most for HEIC. It shares its ISO-BMFF container with
 * AVIF, so only the `ftyp` brand tells them apart, and the hints are unusually
 * unreliable for it — an iPhone photo routinely arrives with no MIME type at
 * all, and a `.heic` that is really a JPEG (renamed, or re-encoded by a share
 * sheet) has to convert as the JPEG it is. Both fall out of asking the bytes
 * before asking the name.
 */
async function detectFormat(file: File): Promise<SourceFormat | null> {
  try {
    const head = await file.slice(0, HEAD_BYTES).arrayBuffer()
    const sniffed = sniffFormat(head)
    if (sniffed) return sniffed
  } catch {
    // Unreadable slice (permissions, file moved on disk). Fall through to hints.
  }
  const byMime = MIME_TO_FORMAT[file.type.toLowerCase()]
  if (byMime) return byMime
  return EXT_TO_FORMAT[extensionOf(file.name)] ?? null
}

/**
 * Rasterise an SVG to PNG bytes on the MAIN THREAD, not in a worker.
 *
 * `createImageBitmap()` on an `image/svg+xml` Blob throws
 * "The source image could not be decoded" in every Chromium build tested —
 * Chromium simply does not implement SVG there, even for the most trivial
 * SVG. `<img>` + canvas does work, but `Image` and `document.createElement`
 * don't exist inside a worker, so this step structurally cannot move off the
 * main thread the way every other format's decode does. It runs once, before
 * the (already-rasterised) bytes are handed to the worker pool.
 */
function decodeSvgOnMainThread(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }))
    const img = new Image()
    const cleanup = () => URL.revokeObjectURL(url)

    img.onload = () => {
      try {
        const width = img.naturalWidth || img.width
        const height = img.naturalHeight || img.height
        if (width < 1 || height < 1) {
          reject(new Error(UNDECODABLE_SVG_MESSAGE))
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('This browser could not open a 2D canvas to rasterise the SVG'))
          return
        }
        ctx.drawImage(img, 0, 0, width, height)
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error(UNDECODABLE_SVG_MESSAGE))
            return
          }
          blob.arrayBuffer().then(resolve, reject)
        }, 'image/png')
      } catch (cause) {
        // A SecurityError here means the SVG referenced an external resource
        // (e.g. an <image href="https://...">) and tainted the canvas — that
        // is a real, unavoidable limitation, not a bug to swallow silently.
        reject(cause instanceof Error ? cause : new Error(UNDECODABLE_SVG_MESSAGE))
      } finally {
        cleanup()
      }
    }
    img.onerror = () => {
      cleanup()
      reject(new Error(UNDECODABLE_SVG_MESSAGE))
    }
    img.src = url
  })
}

/** Decode just far enough to learn the intrinsic size for the preview caption. */
function probeDimensions(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/* ---- naming -------------------------------------------------------- */

/**
 * Naming rule for the whole file: the output keeps the user's own filename,
 * verbatim, and only its extension changes. Nothing here lowercases, trims,
 * slugifies or substitutes characters — see `utils/path` for why.
 */

/** Extensions short and alphanumeric enough to be a real file extension. */
const EXTENSION_PATTERN = /^[A-Za-z0-9]{1,8}$/

/**
 * The output *filename* for a finished job, with no directory part: the user's
 * own filename with its extension swapped, and nothing else touched.
 *
 * The new extension comes from `success.outFormat` — the TARGET — and never
 * from `job.sourceFormat`. That is not a stylistic preference: a source format
 * need not have any output representation at all. HEIC is decode-only (its
 * payload is HEVC, which no free encoder will ever produce here), so it is a
 * `SourceFormat` and not an `ImageFormat`, and `EXTENSION`/`MIME` are keyed by
 * `ImageFormat` precisely so that naming a file after where it came from cannot
 * compile. A HEIC in, a WebP out, named `.webp`.
 *
 * The stem is read from the job's `relativePath`, NOT from `success.outName`.
 * The engine's `outputName` normalises what it is handed — it trims surrounding
 * whitespace and strips trailing dots from the stem — which is harmless when
 * naming a single download but breaks the promise this feature exists to keep:
 * a file the user has on disk as ` leading.png` has to come back as
 * ` leading.webp`, not `leading.webp`. `outName` cannot carry the folder
 * either, which is why the directory was already taken from `relativePath`
 * (see `outputPathOf`); taking the stem from the same place leaves exactly one
 * source of truth for a file's name.
 */
export function outputBaseOf(job: Job, success: ConvertSuccess): string {
  const base = splitPath(job.relativePath).base
  const dot = base.lastIndexOf('.')
  // `dot > 0` keeps a dotfile like `.gitignore` whole; the pattern keeps a name
  // like `photo.jpeg copy` whole rather than amputating the ` copy` that is the
  // only thing telling it apart from `photo.jpeg`.
  const hasExtension = dot > 0 && EXTENSION_PATTERN.test(base.slice(dot + 1))
  const stem = hasExtension ? base.slice(0, dot) : base
  return `${stem}.${EXTENSION[success.outFormat]}`
}

/**
 * Where a finished job belongs inside the archive: its original folder, its
 * original filename, and the new extension. This is the whole promise of the
 * feature in one line — `photos/2024/Beach Day.PNG` comes back as
 * `photos/2024/Beach Day.webp`, same folder, same spelling.
 *
 * Exported because it is also the only correct thing to *say* about a finished
 * job. `success.outName` is the engine's normalised name and disagrees with
 * what actually gets written (it trims a leading space, strips a trailing
 * dot), so it must never reach a label the user can read.
 */
export function outputPathOf(job: Job, success: ConvertSuccess): string {
  return withBase(job.relativePath, outputBaseOf(job, success))
}

/**
 * The duplicate key for ingest. Keyed on the *path*, because a folder tree is
 * full of files that share a name: `icons/light/logo.png` and
 * `icons/dark/logo.png` are two different images, and keying on `file.name`
 * would throw the second one away as a duplicate. Size and mtime stay in the
 * key so re-dropping a folder after editing a file inside it brings in the new
 * version rather than being rejected as already present.
 */
function dedupeKey(relativePath: string, file: File): string {
  return `${relativePath}|${file.size}|${file.lastModified}`
}

/* ---- browser plumbing ---------------------------------------------- */

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * fflate's async zip runs the deflate on its own thread. Level 0 (store) is
 * deliberate: PNG/JPEG/WebP/AVIF payloads are already entropy-coded, so
 * deflating them buys ~1% at a large CPU cost across a 200-file batch.
 */
function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (err, data) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(data)
    })
  })
}

/**
 * Re-view a typed array over a definitely-non-shared ArrayBuffer.
 *
 * fflate types its output as `Uint8Array<ArrayBufferLike>`, and `ArrayBufferLike`
 * includes `SharedArrayBuffer`, which is not a valid `BlobPart`. fflate never
 * allocates shared memory, so the first branch always wins and costs nothing —
 * it re-views the same bytes rather than copying them. The copy is only a
 * correctness backstop.
 */
function toBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = data.buffer
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, data.byteOffset, data.byteLength)
  }
  return new Uint8Array(data)
}

function successOf(job: Job): ConvertSuccess | null {
  return job.result !== null && job.result.ok ? job.result : null
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

/**
 * How many files are sniffed in parallel before the batch is committed.
 *
 * Small enough that the first cards appear within ~100 ms of a drop, large
 * enough that a few thousand files cost a few dozen commits instead of a few
 * thousand. Sniffing serially and committing once at the end left a 1.75 s
 * window (measured, 1200 files) with no cards and no spinner.
 */
const INGEST_BATCH = 32

/** Simultaneous `Image` decodes for the dimension probe. */
const PROBE_CONCURRENCY = 8

/**
 * How long probe results accumulate before one commit drains them.
 *
 * Each probe resolves on its own `img.onload` macrotask, so React cannot batch
 * them: committing per file is one O(n) re-render per file — quadratic, and
 * measured at ~86 s of pure state work for 5000 files. Buffering turns the
 * whole batch into a handful of commits.
 */
const PROBE_FLUSH_MS = 100

export function useConverter(): ConverterApi {
  const [jobs, setJobs] = useState<Job[]>([])
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS)
  const [notices, setNotices] = useState<Notice[]>([])
  const [isConverting, setIsConverting] = useState(false)
  const [isZipping, setIsZipping] = useState(false)
  /** See ConverterApi.decoderFetchIds. */
  const [decoderFetchIds, setDecoderFetchIds] = useState<ReadonlySet<string>>(new Set())

  /**
   * jobId -> relativePath, replaced only when the list's *membership* changes.
   * `relativePath` is immutable for the life of a job, so this map is a stable
   * dependency for the (expensive) root-folder derivation, where `jobs` — whose
   * identity changes on every status tick — is not.
   */
  const [pathIndex, setPathIndex] = useState<ReadonlyMap<string, string>>(new Map())

  /** Post-commit mirror of `jobs`, so async loops can read the live list. */
  const jobsRef = useRef<Job[]>([])
  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  /** Every live object URL, so unmount can revoke all of them in one pass. */
  const urlsRef = useRef<Set<string>>(new Set())
  /** jobId -> download URL, created lazily on first download. */
  const downloadUrlsRef = useRef<Map<string, string>>(new Map())

  const poolRef = useRef<ConverterPool | null>(null)
  /** Bumped to invalidate an in-flight batch (cancel, clear, unmount). */
  const runTokenRef = useRef(0)
  const runningRef = useRef(false)

  /** Caps how many `Image` decoders exist at once during a folder ingest. */
  const probeLimitRef = useRef(createLimiter(PROBE_CONCURRENCY))
  /** Probe results waiting for the next flush. */
  const probeBufferRef = useRef<Map<string, { width: number; height: number }>>(new Map())
  const probeTimerRef = useRef<number | null>(null)

  const createUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob)
    urlsRef.current.add(url)
    return url
  }, [])

  const revokeUrl = useCallback((url: string | undefined): void => {
    if (!url) return
    URL.revokeObjectURL(url)
    urlsRef.current.delete(url)
  }, [])

  const releaseDownloadUrl = useCallback(
    (id: string): void => {
      const url = downloadUrlsRef.current.get(id)
      if (url) {
        revokeUrl(url)
        downloadUrlsRef.current.delete(id)
      }
    },
    [revokeUrl],
  )

  /** Lazily built so StrictMode's dev mount/unmount/mount never spawns workers. */
  const getPool = useCallback((): ConverterPool => {
    if (!poolRef.current) poolRef.current = new ConverterPool()
    return poolRef.current
  }, [])

  /* ---- teardown ---------------------------------------------------- */

  useEffect(() => {
    const urls = urlsRef.current
    const downloads = downloadUrlsRef.current
    return () => {
      runTokenRef.current += 1
      runningRef.current = false
      if (probeTimerRef.current !== null) {
        window.clearTimeout(probeTimerRef.current)
        probeTimerRef.current = null
      }
      probeBufferRef.current.clear()
      if (poolRef.current) {
        poolRef.current.terminate()
        poolRef.current = null
      }
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
      // Download URLs are object URLs too — clearing the map without revoking
      // them would strand their blobs for the lifetime of the document.
      for (const url of downloads.values()) URL.revokeObjectURL(url)
      downloads.clear()
    }
  }, [])

  /* ---- ingest ------------------------------------------------------ */

  /** Drain the probe buffer into exactly one commit. */
  const flushProbes = useCallback((): void => {
    probeTimerRef.current = null
    const sizes = probeBufferRef.current
    if (sizes.size === 0) return
    probeBufferRef.current = new Map()

    setJobs((prev) => {
      let touched = false
      const next = prev.map((job) => {
        const size = sizes.get(job.id)
        if (!size) return job
        touched = true
        return { ...job, sourceWidth: size.width, sourceHeight: size.height }
      })
      return touched ? next : prev
    })
  }, [])

  /**
   * Measure each new job's intrinsic size, at most PROBE_CONCURRENCY decoders
   * at a time, and fold the answers into a single periodic commit.
   */
  const probeAll = useCallback(
    (newJobs: readonly Job[]): void => {
      const limit = probeLimitRef.current
      for (const job of newJobs) {
        void limit(async () => {
          const size = await probeDimensions(job.previewUrl)
          if (!size) return
          probeBufferRef.current.set(job.id, size)
          if (probeTimerRef.current === null) {
            probeTimerRef.current = window.setTimeout(flushProbes, PROBE_FLUSH_MS)
          }
        })
      }
    },
    [flushProbes],
  )

  const addFiles = useCallback(
    async (picked: PickedFile[]): Promise<void> => {
      if (picked.length === 0) return

      // A new drop supersedes the last one's report. Without this, a warning
      // from an unrelated earlier drop sits on the page next to the Dropzone's
      // own fresh banner, showing two different counts for two different events.
      setNotices([])

      const seen = new Set(jobsRef.current.map((j) => dedupeKey(j.relativePath, j.file)))
      const rejected: Notice[] = []
      /** Survived the cheap checks; still needs its header read. */
      const candidates: { file: File; path: string }[] = []

      for (const { file, relativePath } of picked) {
        // A loose file dropped outside any folder has no path of its own; its
        // name *is* its path, at the root of the archive.
        const path = sanitizeRelativePath(relativePath || file.name)

        const key = dedupeKey(path, file)
        if (seen.has(key)) {
          rejected.push({ name: path, reason: 'already in the list', tone: 'info' })
          continue
        }
        seen.add(key)

        if (file.size === 0) {
          rejected.push({ name: path, reason: 'empty file', tone: 'warn' })
          continue
        }

        candidates.push({ file, path })
      }

      // Sniff in parallel chunks and commit each chunk as it lands, so cards
      // start appearing almost immediately and keep appearing. Sniffing is a
      // real disk read per file; serialising it across a photo library is
      // seconds of a page that looks like it ignored the drop.
      for (let start = 0; start < candidates.length; start += INGEST_BATCH) {
        const batch = candidates.slice(start, start + INGEST_BATCH)
        const formats = await Promise.all(batch.map(({ file }) => detectFormat(file)))

        const chunk: Job[] = []
        for (let i = 0; i < batch.length; i += 1) {
          const { file, path } = batch[i]
          const sourceFormat = formats[i]
          if (!sourceFormat) {
            rejected.push({ name: path, reason: UNSUPPORTED_REASON, tone: 'warn' })
            continue
          }
          chunk.push({
            id: newId(),
            file,
            relativePath: path,
            sourceFormat,
            sourceWidth: null,
            sourceHeight: null,
            previewUrl: createUrl(file),
            status: 'queued',
            overrides: null,
            result: null,
          })
        }

        if (chunk.length === 0) continue

        // Show the cards immediately; dimensions stream in behind them.
        setJobs((prev) => [...prev, ...chunk])
        setPathIndex((prev) => {
          const next = new Map(prev)
          for (const job of chunk) next.set(job.id, job.relativePath)
          return next
        })
        probeAll(chunk)
      }

      if (rejected.length > 0) setNotices((prev) => [...prev, ...rejected])
    },
    [createUrl, probeAll],
  )

  /* ---- options ----------------------------------------------------- */

  /**
   * A finished result is only valid for the settings that produced it. Once
   * those change the card would otherwise keep showing the old output — and
   * offer it for download under the *new* format's name, handing the user an
   * AVIF file labelled JPEG. Send affected jobs back to the queue instead, so
   * "Convert" re-enables and re-running produces what the UI is promising.
   */
  const invalidateDone = useCallback(
    (changed: readonly (keyof ConvertOptions)[]): void => {
      if (changed.length === 0) return
      setJobs((prev) => {
        let touched = false
        const next = prev.map((job) => {
          if (job.status !== 'done') return job
          // A per-file override pins that key, so a global change cannot reach it.
          if (changed.every((key) => job.overrides?.[key] !== undefined)) return job
          touched = true
          return { ...job, status: 'queued' as const, result: null }
        })
        return touched ? next : prev
      })
    },
    [],
  )

  const updateOptions = useCallback(
    (patch: Partial<ConvertOptions>): void => {
      setOptions((prev) =>
        normalize({
          ...prev,
          ...patch,
          resize: patch.resize ? { ...patch.resize } : prev.resize,
        }),
      )
      invalidateDone(Object.keys(patch) as (keyof ConvertOptions)[])
    },
    [invalidateDone],
  )

  const setOverride = useCallback(
    (id: string, patch: Partial<ConvertOptions> | null): void => {
      setJobs((prev) =>
        prev.map((job) => {
          if (job.id !== id) return job

          // Changing (or clearing) an override changes this job's effective
          // options, so any finished result for it is now stale.
          const requeued =
            job.status === 'done'
              ? { status: 'queued' as const, result: null }
              : null

          if (patch === null) return { ...job, ...requeued, overrides: null }
          const next: Partial<ConvertOptions> = { ...(job.overrides ?? {}), ...patch }
          if (patch.resize) next.resize = { ...patch.resize }
          return { ...job, ...requeued, overrides: next }
        }),
      )
    },
    [],
  )

  /* ---- conversion -------------------------------------------------- */

  /**
   * Record (or clear) "this job is waiting on the decoder download".
   *
   * Returns the previous set unchanged when nothing moved, so the common case —
   * every non-HEIC job, and every HEIC after the first — costs no commit at all.
   */
  const setDecoderFetching = useCallback((id: string, fetching: boolean): void => {
    setDecoderFetchIds((prev) => {
      if (prev.has(id) === fetching) return prev
      const next = new Set(prev)
      if (fetching) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const runJob = useCallback(
    async (pool: ConverterPool, job: Job, batchOptions: ConvertOptions, token: number) => {
      const stale = () => runTokenRef.current !== token

      // A re-run replaces the previous output; drop the URL pointing at the old bytes.
      releaseDownloadUrl(job.id)
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, status: 'running', result: null } : j)),
      )

      try {
        // Read lazily, one job at a time, so a 200-photo batch never holds 200
        // decoded ArrayBuffers in memory at once.
        const fileBytes = await job.file.arrayBuffer()
        if (stale()) return

        // SVG can only be rasterised on the main thread (see
        // decodeSvgOnMainThread) — do it before the bytes ever reach a
        // worker, and keep the *original* file size for reporting so
        // "input size" reflects the .svg the user dropped in, not the PNG it
        // became.
        //
        // SVG is the ONLY format that takes this detour, and the test is an
        // equality against 'svg' rather than "is this format unusual", so HEIC
        // cannot drift into it: HEIC sniffs as 'heic' and goes to the worker
        // like every raster format. That is where it belongs — its decoder is
        // a 1.4 MB WASM bundle pulled in on demand, and running it here would
        // freeze the UI for the length of every HEIC in the batch.
        const isSvgSource = sniffFormat(fileBytes) === 'svg'
        const bytes = isSvgSource ? await decodeSvgOnMainThread(fileBytes) : fileBytes
        if (stale()) return

        const request: ConvertRequest = {
          id: job.id,
          fileName: job.file.name,
          bytes,
          originalBytes: fileBytes.byteLength,
          sourceFormat: job.sourceFormat,
          options: mergeOptions(batchOptions, job.overrides),
        }

        const result = await pool.run(request, (phase: DecodePhase) => {
          if (stale()) return
          setDecoderFetching(job.id, phase === 'loading-decoder')
        })
        if (stale()) return

        setJobs((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, status: result.ok ? 'done' : 'error', result } : j,
          ),
        )
      } catch (err) {
        if (stale()) return
        const failure: ConvertResult = { id: job.id, ok: false, error: errorMessage(err) }
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, status: 'error', result: failure } : j)),
        )
      } finally {
        // Every exit — settled, failed, or abandoned as stale — clears the note.
        // A job that leaves "fetching the decoder" on screen after it has
        // stopped running is worse than never having said it.
        setDecoderFetching(job.id, false)
      }
    },
    [releaseDownloadUrl, setDecoderFetching],
  )

  const convertAll = useCallback(async (): Promise<void> => {
    if (runningRef.current) return

    const queue = jobsRef.current
      .filter((job) => job.status === 'queued' || job.status === 'error')
      .map((job) => job.id)
    if (queue.length === 0) return

    const token = runTokenRef.current + 1
    runTokenRef.current = token
    runningRef.current = true
    setIsConverting(true)

    const batchOptions = options
    const pool = getPool()
    const cores = navigator.hardwareConcurrency || 4
    const lanes = Math.max(1, Math.min(8, queue.length, cores))

    // Each lane pulls the next id off the shared queue and updates that job's
    // status on its own, so finished files appear in the list as they land
    // instead of all at once when the batch ends.
    const lane = async (): Promise<void> => {
      for (;;) {
        if (runTokenRef.current !== token) return
        const id = queue.shift()
        if (id === undefined) return
        const job = jobsRef.current.find((j) => j.id === id)
        if (!job) continue // removed while the batch was running
        await runJob(pool, job, batchOptions, token)
      }
    }

    try {
      await Promise.all(Array.from({ length: lanes }, () => lane()))
    } finally {
      if (runTokenRef.current === token) {
        runningRef.current = false
        setIsConverting(false)
      }
    }
  }, [getPool, options, runJob])

  const cancelAll = useCallback((): void => {
    runTokenRef.current += 1
    runningRef.current = false
    poolRef.current?.cancelAll()
    setIsConverting(false)
    setDecoderFetchIds(new Set())
    setJobs((prev) => prev.map((j) => (j.status === 'running' ? { ...j, status: 'queued' } : j)))
  }, [])

  /* ---- output ------------------------------------------------------ */

  const downloadOne = useCallback(
    (id: string): void => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job) return
      const success = successOf(job)
      if (!success) return

      let url = downloadUrlsRef.current.get(id)
      if (!url) {
        url = createUrl(new Blob([success.bytes], { type: MIME[success.outFormat] }))
        downloadUrlsRef.current.set(id, url)
      }
      // Deliberately flat: a browser download writes one file into the
      // downloads folder and cannot create directories, and an `a.download`
      // containing '/' is either sanitised into one long name or ignored
      // outright. Folder structure is the ZIP's job; a single file keeps just
      // its own name.
      triggerDownload(url, outputBaseOf(job, success))
    },
    [createUrl],
  )

  const downloadAllZip = useCallback(async (): Promise<void> => {
    // Pair each result with its job: the bytes come from the result, but the
    // folder it belongs in is only known to the job.
    const finished = jobsRef.current
      .map((job) => {
        const success = successOf(job)
        return success === null ? null : { job, success }
      })
      .filter((entry): entry is { job: Job; success: ConvertSuccess } => entry !== null)
    if (finished.length === 0) return

    setIsZipping(true)
    try {
      // Two passes, so a suffix minted for one file can never steal the real
      // name of another. Claiming greedily in one pass is order-dependent:
      // `a.png`, `a.jpg`, `a-1.png` -> the third file, which collided with
      // nothing, came back as `a-1-1.webp` because `a.jpg` had already taken
      // `a-1.webp`. Reserving every name that occurs exactly once first means
      // only genuine duplicates are ever renamed.
      const desired = finished.map(({ job, success }) => outputPathOf(job, success))

      const occurrences = new Map<string, number>()
      for (const path of desired) {
        const key = path.toLowerCase()
        occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
      }

      /** Index -> the entry path it has been granted. */
      const claimed = new Map<number, string>()
      const used = new Set<string>()

      // Pass 1: every name exactly one file wants is reserved verbatim, before
      // any suffix is minted, so a suffix can never consume it.
      for (let i = 0; i < desired.length; i += 1) {
        const key = desired[i].toLowerCase()
        if (occurrences.get(key) !== 1) continue
        used.add(key)
        claimed.set(i, desired[i])
      }

      // Pass 2: inside a colliding group, the file the user *already* had under
      // that exact name has the strongest claim to it — converting a folder of
      // `p.png`, `p.jpg`, `p.webp` to WebP must not hand `p.webp` to `p.png`
      // and give the original `p.webp` a suffix.
      for (let i = 0; i < desired.length; i += 1) {
        if (claimed.has(i)) continue
        const uploaded = sanitizeRelativePath(finished[i].job.relativePath)
        if (uploaded.toLowerCase() === desired[i].toLowerCase()) {
          claimed.set(i, uniquePath(desired[i], used))
        }
      }

      // Pass 3: the remaining true duplicates take suffixes, skipping every
      // name reserved above.
      const entries: Record<string, Uint8Array> = {}
      for (let i = 0; i < finished.length; i += 1) {
        // fflate treats '/' in a key as a directory separator, so a nested
        // path is all that's needed to rebuild the tree — no explicit folder
        // entries, no extra API.
        const entryPath = claimed.get(i) ?? uniquePath(desired[i], used)
        entries[entryPath] = new Uint8Array(finished[i].success.bytes)
      }

      const archive = await zipAsync(entries)
      const url = createUrl(new Blob([toBlobPart(archive)], { type: 'application/zip' }))
      // Name the archive after the folder that was dropped, so it unpacks to
      // something recognisable. Falls back to a count when the files came from
      // different roots or were loose.
      const root = commonRootFolder(finished.map(({ job }) => job.relativePath))
      const zipName =
        root.length > 0 ? `${root}-converted.zip` : `converted-${finished.length}-images.zip`
      triggerDownload(url, zipName)
      // Revoking immediately can abort the download in some browsers; give it a
      // grace period, and let unmount catch it if the user leaves first.
      window.setTimeout(() => revokeUrl(url), 60_000)
    } catch (err) {
      setNotices((prev) => [
        ...prev,
        { name: 'ZIP archive', reason: errorMessage(err), tone: 'warn' },
      ])
    } finally {
      setIsZipping(false)
    }
  }, [createUrl, revokeUrl])

  /* ---- list management --------------------------------------------- */

  const removeJob = useCallback(
    (id: string): void => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (job) revokeUrl(job.previewUrl)
      releaseDownloadUrl(id)
      setDecoderFetching(id, false)
      setJobs((prev) => prev.filter((j) => j.id !== id))
      setPathIndex((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    },
    [releaseDownloadUrl, revokeUrl, setDecoderFetching],
  )

  const clearAll = useCallback((): void => {
    runTokenRef.current += 1
    runningRef.current = false
    poolRef.current?.cancelAll()
    setIsConverting(false)

    for (const job of jobsRef.current) revokeUrl(job.previewUrl)
    for (const url of downloadUrlsRef.current.values()) revokeUrl(url)
    downloadUrlsRef.current.clear()

    setJobs([])
    setPathIndex(new Map())
    setNotices([])
    setDecoderFetchIds(new Set())
  }, [revokeUrl])

  const dismissNotices = useCallback((tone?: NoticeTone): void => {
    setNotices((prev) => (tone ? prev.filter((notice) => notice.tone !== tone) : []))
  }, [])

  /* ---- derived ----------------------------------------------------- */

  /**
   * Keyed on `pathIndex`, NOT on `jobs`: paths are immutable per job, so this
   * only has to run when a file is added or removed. Keying it on `jobs` made
   * every status tick re-split every path in the list.
   */
  const rootFolder = useMemo(
    () => commonRootFolder(Array.from(pathIndex.values())),
    [pathIndex],
  )

  const summary = useMemo<ConverterSummary>(() => {
    let queued = 0
    let running = 0
    let done = 0
    let error = 0
    let inputBytes = 0
    let convertedInputBytes = 0
    let outputBytes = 0

    for (const job of jobs) {
      inputBytes += job.file.size
      if (job.status === 'queued') queued += 1
      else if (job.status === 'running') running += 1
      else if (job.status === 'error') error += 1
      else if (job.status === 'done') {
        done += 1
        const success = successOf(job)
        if (success) {
          convertedInputBytes += success.inputBytes
          outputBytes += success.outputBytes
        }
      }
    }

    const savedBytes = convertedInputBytes - outputBytes
    return {
      total: jobs.length,
      queued,
      running,
      done,
      error,
      pending: queued + error,
      inputBytes,
      convertedInputBytes,
      outputBytes,
      savedBytes,
      savedPercent: convertedInputBytes > 0 ? (savedBytes / convertedInputBytes) * 100 : 0,
    }
  }, [jobs])

  return {
    jobs,
    options,
    summary,
    isConverting,
    isZipping,
    notices,
    rootFolder,
    decoderFetchIds,
    addFiles,
    updateOptions,
    setOverride,
    convertAll,
    cancelAll,
    downloadOne,
    downloadAllZip,
    removeJob,
    clearAll,
    dismissNotices,
  }
}
