/**
 * Bounded concurrency for async work.
 *
 * Two callers need the same thing for different reasons: the folder walk must
 * not open thousands of filesystem handles at once, and the dimension probe
 * must not construct thousands of `Image` decoders at once. Sharing one
 * implementation keeps the fix for either from silently regressing the other.
 *
 * `release` hands its slot straight to the next waiter instead of freeing it,
 * because a caller arriving between a waiter's wake-up and its actual
 * resumption would otherwise see a free slot and push the count over the cap.
 *
 * The queue is drained with a head index, never `Array.prototype.shift()`.
 * `shift()` memmoves the whole queue on every release, so a directory of N
 * files costs O(N^2): measured at 30 s of pure queue churn for 100k tasks —
 * the very ceiling `MAX_ENTRIES_PER_DIR` says we intend to tolerate — against
 * 0.3 s for the head-index form below.
 */

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

export function createLimiter(limit: number): Limiter {
  const max = Math.max(1, Math.floor(limit))
  let active = 0
  /** Parked resolvers, FIFO. Consumed slots are nulled so their closures can be collected. */
  const waiting: Array<(() => void) | undefined> = []
  let head = 0

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  }

  const release = (): void => {
    while (head < waiting.length) {
      const next = waiting[head]
      waiting[head] = undefined
      head += 1
      if (next) {
        next()
        return
      }
    }
    active -= 1
    // Fully drained: reclaim the array, since the head index alone would keep
    // every consumed slot alive for the lifetime of the limiter.
    waiting.length = 0
    head = 0
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}
