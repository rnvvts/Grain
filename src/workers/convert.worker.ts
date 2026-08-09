/**
 * Conversion worker.
 *
 * Runs entirely in the browser (this site is static — there is no server), one
 * instance per pool slot. It owns a WASM heap for the jSquash codecs, which is
 * exactly why the work lives off the main thread: an AVIF encode at high effort
 * will happily block a tab for several seconds.
 *
 * Protocol (see src/types.ts, which is frozen):
 *   main -> worker : ConvertRequest   (`bytes` transferred in by the pool)
 *   worker -> main : ConvertResult    (`bytes` transferred out on success)
 */

import { convertImage } from '../engine/convert'
import type { ConvertFailure, ConvertRequest, ConvertResult } from '../types'

/**
 * Minimal shape of the dedicated-worker global.
 *
 * The project's tsconfig loads `DOM` but not `WebWorker` (the two libs declare
 * conflicting globals and the app code needs `DOM`), so `DedicatedWorkerGlobalScope`
 * is not in scope here. This local interface gives us the two members we use
 * with full type-safety and no `any`.
 */
interface DedicatedWorkerScope {
  onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null
  postMessage(message: ConvertResult, transfer?: Transferable[]): void
}

const ctx = self as unknown as DedicatedWorkerScope

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name
  }
  if (typeof error === 'string') return error
  try {
    // `String()` can itself throw (null-prototype objects, Symbol.toPrimitive
    // traps), so even the fallback is guarded.
    return String(error)
  } catch {
    return 'Unknown error'
  }
}

function fail(id: string, error: string): ConvertFailure {
  return { id, ok: false, error }
}

async function handle(request: ConvertRequest): Promise<void> {
  try {
    const result = await convertImage(request)

    if (result.ok) {
      // Transfer the encoded bytes rather than structured-cloning them. These
      // buffers are routinely multi-megabyte and a copy would double peak
      // memory for the duration of the postMessage. Transferring detaches
      // `result.bytes` here, which is fine: this worker is done with the job.
      ctx.postMessage(result, [result.bytes])
    } else {
      ctx.postMessage(result)
    }
  } catch (error: unknown) {
    // A worker that throws and says nothing leaves the UI spinning forever, so
    // every failure path still posts a ConvertFailure carrying the job id.
    ctx.postMessage(fail(request.id, toMessage(error)))
  }
}

ctx.onmessage = (event: MessageEvent<ConvertRequest>): void => {
  // `event.data` is typed, but it crosses a structured-clone boundary, so treat
  // it as untrusted: a malformed payload must not throw synchronously out of
  // the message handler (nothing would ever be posted back).
  const request: ConvertRequest | null | undefined = event.data

  if (request === null || request === undefined || typeof request.id !== 'string') {
    ctx.postMessage(fail('', 'Worker received a malformed ConvertRequest'))
    return
  }

  void handle(request)
}
