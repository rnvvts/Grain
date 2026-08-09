/**
 * Fixed-size pool of conversion workers.
 *
 * Everything here runs in the browser — the site is a static bundle on GitHub
 * Pages, so the pool is the only "backend" there is. It hands ConvertRequests
 * to module workers, queues the overflow, and routes each ConvertResult back to
 * the promise that asked for it.
 */

import type { ConvertFailure, ConvertRequest, ConvertResult } from '../types'

/**
 * Hard cap on concurrent workers.
 *
 * Each worker carries its own WASM heap, and AVIF encoding is the memory-hungry
 * one: on a 16-core machine an uncapped pool would allocate sixteen codec heaps
 * and OOM a laptop halfway through a large batch. Six is plenty to saturate
 * throughput — the encoders are CPU-bound, not latency-bound.
 */
const MAX_POOL_SIZE = 6

/** Fallback when `navigator.hardwareConcurrency` is unavailable or nonsense. */
const FALLBACK_CORES = 4

/** `Math.max(1, Math.min(navigator.hardwareConcurrency ?? 4, 6))`, defensively. */
export function defaultPoolSize(): number {
  const reported =
    typeof navigator === 'undefined' ? FALLBACK_CORES : Number(navigator.hardwareConcurrency)
  const cores = Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : FALLBACK_CORES
  return Math.max(1, Math.min(cores, MAX_POOL_SIZE))
}

function fail(id: string, error: string): ConvertFailure {
  return { id, ok: false, error }
}

interface PendingJob {
  readonly request: ConvertRequest
  readonly resolve: (result: ConvertResult) => void
  settled: boolean
}

interface WorkerSlot {
  /** Mutable: a crashed worker is replaced in place so listeners keep their slot. */
  worker: Worker
  /** Id of the job currently in flight on this worker, or null when idle. */
  jobId: string | null
}

interface InFlight {
  readonly job: PendingJob
  readonly slot: WorkerSlot
}

export class ConverterPool {
  /** Maximum number of workers this pool will ever run at once. */
  readonly size: number

  private readonly slots: WorkerSlot[] = []
  private readonly queue: PendingJob[] = []
  private readonly inFlight = new Map<string, InFlight>()
  /** Ids that are queued or running, so duplicates can be rejected cheaply. */
  private readonly pendingIds = new Set<string>()
  private disposed = false

  constructor(size: number = defaultPoolSize()) {
    const requested = Number.isFinite(size) ? Math.floor(size) : FALLBACK_CORES
    this.size = Math.max(1, Math.min(requested, MAX_POOL_SIZE))
  }

  /** Jobs queued or in flight right now. */
  get pending(): number {
    return this.queue.length + this.inFlight.size
  }

  /** Workers currently alive. The pool grows lazily up to `size`. */
  get workerCount(): number {
    return this.slots.length
  }

  /**
   * Queue a conversion and resolve when it finishes.
   *
   * IMPORTANT — `request.bytes` is TRANSFERRED into the worker, which NEUTERS
   * the caller's ArrayBuffer: once this method has dispatched the job, that
   * buffer is detached and reads from it will throw or come back empty. The
   * caller must hand over ownership and never touch (or re-submit) the same
   * ArrayBuffer again. Re-reading the original File, or `.slice()`-ing a fresh
   * copy before calling, is the way to convert the same source twice.
   *
   * The returned promise never rejects: failures arrive as a ConvertFailure so
   * a batch can be driven with `Promise.all` without one bad file killing it.
   */
  run(request: ConvertRequest): Promise<ConvertResult> {
    if (this.disposed) {
      return Promise.resolve(fail(request.id, 'Converter pool has been terminated'))
    }
    if (this.pendingIds.has(request.id)) {
      return Promise.resolve(fail(request.id, `Duplicate job id: ${request.id}`))
    }

    return new Promise<ConvertResult>((resolve) => {
      const job: PendingJob = { request, resolve, settled: false }
      this.pendingIds.add(request.id)
      this.queue.push(job)
      this.pump()
    })
  }

  /**
   * Drop every queued job and abandon everything in flight.
   *
   * Running jobs are settled as ConvertFailure('Cancelled') and their workers
   * are hard-terminated — a long AVIF encode cannot be interrupted any other
   * way — then immediately replaced so the pool stays usable afterwards.
   */
  cancelAll(): void {
    this.failQueued('Cancelled')

    const running = Array.from(this.inFlight.values())
    this.inFlight.clear()
    for (const entry of running) {
      this.settle(entry.job, fail(entry.job.request.id, 'Cancelled'))
      this.replaceWorker(entry.slot)
    }
  }

  /**
   * Kill every worker and release their WASM heaps. Pending work is settled as
   * ConvertFailure. The pool is dead afterwards: further `run` calls resolve
   * immediately with a failure.
   */
  terminate(): void {
    if (this.disposed) return
    // Set first: replaceWorker() must not respawn anything from here on.
    this.disposed = true

    const reason = 'Converter pool has been terminated'
    this.failQueued(reason)

    const running = Array.from(this.inFlight.values())
    this.inFlight.clear()
    for (const entry of running) {
      this.settle(entry.job, fail(entry.job.request.id, reason))
    }

    for (const slot of this.slots) {
      slot.jobId = null
      slot.worker.terminate()
    }
    this.slots.length = 0
    this.pendingIds.clear()
  }

  // ---------------------------------------------------------------- internals

  private settle(job: PendingJob, result: ConvertResult): void {
    if (job.settled) return
    job.settled = true
    this.pendingIds.delete(job.request.id)
    job.resolve(result)
  }

  /** Dispatch queued jobs to idle workers until one side runs out. */
  private pump(): void {
    while (!this.disposed && this.queue.length > 0) {
      let slot: WorkerSlot | null = null
      try {
        slot = this.acquireSlot()
      } catch (error: unknown) {
        const reason = describe(error, 'Could not start a conversion worker')
        if (this.slots.length === 0) {
          // No worker was ever created — the environment cannot run them at
          // all, so nothing in the queue can ever succeed. Fail it now rather
          // than leave the UI spinning.
          this.failQueued(reason)
        }
        // Otherwise a live worker will free up and pump again.
        return
      }
      if (slot === null) return

      const job = this.queue.shift()
      if (job === undefined) return

      this.dispatch(slot, job)
    }
  }

  private failQueued(reason: string): void {
    const queued = this.queue.splice(0, this.queue.length)
    for (const job of queued) {
      this.settle(job, fail(job.request.id, reason))
    }
  }

  /** An idle worker, spawning a new one if the pool has not reached `size`. */
  private acquireSlot(): WorkerSlot | null {
    for (const slot of this.slots) {
      if (slot.jobId === null) return slot
    }
    if (this.slots.length < this.size) {
      // Grow lazily: converting a single file should not pay for six WASM heaps.
      const slot: WorkerSlot = { worker: this.createWorker(), jobId: null }
      this.attach(slot)
      this.slots.push(slot)
      return slot
    }
    return null
  }

  private dispatch(slot: WorkerSlot, job: PendingJob): void {
    slot.jobId = job.request.id
    this.inFlight.set(job.request.id, { job, slot })

    try {
      // Transfer the source bytes instead of cloning them. This detaches the
      // caller's ArrayBuffer (documented on `run`) and keeps peak memory at one
      // copy of the image rather than two.
      slot.worker.postMessage(job.request, [job.request.bytes])
    } catch (error: unknown) {
      // Almost always an already-detached buffer (the caller re-submitted one
      // it had handed over). Settle the job and keep the worker in rotation.
      this.inFlight.delete(job.request.id)
      slot.jobId = null
      this.settle(job, fail(job.request.id, describe(error, 'Could not hand the job to a worker')))
      this.pump()
    }
  }

  /**
   * Vite-canonical worker construction. The `new URL(..., import.meta.url)`
   * literal is what lets the bundler find, compile and fingerprint the worker
   * and emit a base-relative URL. Building this string dynamically would make
   * the worker un-analysable and it would 404 on GitHub Pages.
   */
  private createWorker(): Worker {
    return new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' })
  }

  private attach(slot: WorkerSlot): void {
    const worker = slot.worker

    worker.addEventListener('message', (event: MessageEvent<ConvertResult>) => {
      // Ignore anything arriving from a worker this slot has already replaced.
      if (slot.worker !== worker) return
      this.handleResult(slot, event.data)
    })

    worker.addEventListener('error', (event) => {
      if (slot.worker !== worker) return
      event.preventDefault()
      this.handleCrash(slot, describe(event.message, 'Worker crashed'))
    })

    worker.addEventListener('messageerror', () => {
      if (slot.worker !== worker) return
      this.handleCrash(slot, 'Worker sent a result that could not be deserialised')
    })
  }

  private handleResult(slot: WorkerSlot, result: ConvertResult | null | undefined): void {
    if (result === null || result === undefined || typeof result.id !== 'string') {
      this.handleCrash(slot, 'Worker sent a malformed ConvertResult')
      return
    }

    const entry = this.inFlight.get(result.id)
    if (entry === undefined || entry.slot !== slot) {
      // Late result for a cancelled/unknown job. Free the worker and move on.
      if (slot.jobId === result.id) slot.jobId = null
      this.pump()
      return
    }

    this.inFlight.delete(result.id)
    slot.jobId = null
    this.settle(entry.job, result)
    this.pump()
  }

  /**
   * A worker died. Settle whatever it was carrying as a failure and stand up a
   * replacement so the rest of the batch still completes.
   */
  private handleCrash(slot: WorkerSlot, reason: string): void {
    const jobId = slot.jobId
    if (jobId !== null) {
      const entry = this.inFlight.get(jobId)
      this.inFlight.delete(jobId)
      if (entry !== undefined) {
        this.settle(entry.job, fail(jobId, reason))
      }
    }

    this.replaceWorker(slot)
    this.pump()
  }

  private replaceWorker(slot: WorkerSlot): void {
    slot.jobId = null
    slot.worker.terminate()

    if (this.disposed) return
    slot.worker = this.createWorker()
    this.attach(slot)
  }
}

function describe(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.length > 0) return value.message
  if (typeof value === 'string' && value.length > 0) return value
  return fallback
}
