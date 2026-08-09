/**
 * useConverter — the single owner of application state.
 *
 * Everything here runs in the browser tab. There is no server: files are read
 * with the File API, handed to a worker pool as transferable ArrayBuffers, and
 * handed back as bytes we wrap in object URLs. Nothing is ever uploaded.
 *
 * Two invariants worth protecting when editing this file:
 *   1. Exactly ONE ConverterPool per mounted hook. It lives in a ref and is
 *      terminated on unmount. A pool per render leaks a worker per render.
 *   2. Every URL.createObjectURL call registers its URL in `urlsRef` so the
 *      unmount/remove paths can revoke it. A hundred un-revoked photo previews
 *      pins hundreds of megabytes for the lifetime of the tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { zip } from 'fflate'
import { ConverterPool } from '../workers/pool'
import { sniffFormat } from '../engine/format'
import { UNDECODABLE_SVG_MESSAGE } from '../engine/decode'
import { DEFAULT_OPTIONS, EXTENSION, MIME } from '../types'
import type {
  ConvertOptions,
  ConvertRequest,
  ConvertResult,
  ConvertSuccess,
  ImageFormat,
  Job,
  SourceFormat,
} from '../types'

/* ------------------------------------------------------------------ *
 * Public shape
 * ------------------------------------------------------------------ */

/** A file we refused to queue, plus the reason, surfaced to the user. */
export interface Notice {
  name: string
  reason: string
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
  addFiles: (files: File[]) => void
  updateOptions: (patch: Partial<ConvertOptions>) => void
  setOverride: (id: string, patch: Partial<ConvertOptions> | null) => void
  convertAll: () => void
  cancelAll: () => void
  downloadOne: (id: string) => void
  downloadAllZip: () => void
  removeJob: (id: string) => void
  clearAll: () => void
  dismissNotices: () => void
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

const MIME_TO_FORMAT: Record<string, SourceFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
}

const EXT_TO_FORMAT: Record<string, SourceFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  webp: 'webp',
  avif: 'avif',
  svg: 'svg',
}

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

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'image'
}

/** Only appends when the engine handed back a bare stem; never doubles up. */
function ensureExtension(name: string, format: ImageFormat): string {
  const dot = name.lastIndexOf('.')
  const hasPlausibleExtension = dot > 0 && name.length - dot <= 6
  return hasPlausibleExtension ? name : `${name}.${EXTENSION[format]}`
}

/**
 * a.png and a.jpg both targeting webp both want "a.webp". The second one
 * becomes "a-1.webp" so the archive keeps every file instead of silently
 * overwriting entries.
 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let n = 1
  let candidate = `${stem}-${n}${ext}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${stem}-${n}${ext}`
  }
  used.add(candidate)
  return candidate
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

export function useConverter(): ConverterApi {
  const [jobs, setJobs] = useState<Job[]>([])
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS)
  const [notices, setNotices] = useState<Notice[]>([])
  const [isConverting, setIsConverting] = useState(false)
  const [isZipping, setIsZipping] = useState(false)

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

  const addFiles = useCallback(
    (files: File[]): void => {
      if (files.length === 0) return

      void (async () => {
        const seen = new Set(
          jobsRef.current.map((j) => `${j.file.name}|${j.file.size}|${j.file.lastModified}`),
        )
        const accepted: Job[] = []
        const rejected: Notice[] = []

        for (const file of files) {
          const key = `${file.name}|${file.size}|${file.lastModified}`
          if (seen.has(key)) {
            rejected.push({ name: file.name, reason: 'already in the list' })
            continue
          }
          seen.add(key)

          if (file.size === 0) {
            rejected.push({ name: file.name, reason: 'empty file' })
            continue
          }

          const sourceFormat = await detectFormat(file)
          if (!sourceFormat) {
            rejected.push({ name: file.name, reason: 'not a PNG, JPEG, WebP, AVIF or SVG' })
            continue
          }

          accepted.push({
            id: newId(),
            file,
            sourceFormat,
            sourceWidth: null,
            sourceHeight: null,
            previewUrl: createUrl(file),
            status: 'queued',
            overrides: null,
            result: null,
          })
        }

        if (rejected.length > 0) setNotices((prev) => [...prev, ...rejected])
        if (accepted.length === 0) return

        // Show the cards immediately; dimensions stream in behind them.
        setJobs((prev) => [...prev, ...accepted])

        for (const job of accepted) {
          void probeDimensions(job.previewUrl).then((size) => {
            if (!size) return
            setJobs((prev) =>
              prev.map((j) =>
                j.id === job.id
                  ? { ...j, sourceWidth: size.width, sourceHeight: size.height }
                  : j,
              ),
            )
          })
        }
      })()
    },
    [createUrl],
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

        const result = await pool.run(request)
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
      }
    },
    [releaseDownloadUrl],
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
      triggerDownload(url, sanitizeName(ensureExtension(success.outName, success.outFormat)))
    },
    [createUrl],
  )

  const downloadAllZip = useCallback(async (): Promise<void> => {
    const finished = jobsRef.current
      .map((job) => successOf(job))
      .filter((r): r is ConvertSuccess => r !== null)
    if (finished.length === 0) return

    setIsZipping(true)
    try {
      const used = new Set<string>()
      const entries: Record<string, Uint8Array> = {}
      for (const success of finished) {
        const name = uniqueName(
          sanitizeName(ensureExtension(success.outName, success.outFormat)),
          used,
        )
        entries[name] = new Uint8Array(success.bytes)
      }

      const archive = await zipAsync(entries)
      const url = createUrl(new Blob([toBlobPart(archive)], { type: 'application/zip' }))
      triggerDownload(url, `converted-${finished.length}-images.zip`)
      // Revoking immediately can abort the download in some browsers; give it a
      // grace period, and let unmount catch it if the user leaves first.
      window.setTimeout(() => revokeUrl(url), 60_000)
    } catch (err) {
      setNotices((prev) => [...prev, { name: 'ZIP archive', reason: errorMessage(err) }])
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
      setJobs((prev) => prev.filter((j) => j.id !== id))
    },
    [releaseDownloadUrl, revokeUrl],
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
    setNotices([])
  }, [revokeUrl])

  const dismissNotices = useCallback((): void => setNotices([]), [])

  /* ---- derived ----------------------------------------------------- */

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
