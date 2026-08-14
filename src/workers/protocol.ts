/**
 * The worker's second message type.
 *
 * `src/types.ts` is frozen and defines the request/result pair a conversion is
 * made of: one ConvertRequest in, one ConvertResult out. That is still the
 * contract — a job settles on its ConvertResult and nothing else. This file
 * adds a strictly optional side channel for progress notes posted *while* a job
 * is still running, which the pool forwards and then forgets.
 *
 * It exists for one situation: the first HEIC in a worker has to download a
 * 1.4 MB WASM decoder before it can look at a single pixel, and on a slow
 * connection that is tens of seconds during which a card showing a plain
 * "Converting" is indistinguishable from a stuck one.
 *
 * The two messages are told apart by the presence of `phase`, which no
 * ConvertResult has. Keep it that way: `handleResult` would otherwise settle a
 * job with a progress note as its result.
 */

import type { DecodePhase } from '../engine/decode'

/** Posted worker -> main while `id` is still in flight. Never settles a job. */
export interface ConvertProgress {
  /** The in-flight job this note is about. */
  id: string
  phase: DecodePhase
}

/**
 * Narrow a message that crossed the structured-clone boundary.
 *
 * Deliberately paranoid about shape rather than trusting the MessageEvent's
 * declared type: anything that is not recognisably a progress note falls
 * through to the result path, which has its own validation and its own
 * "malformed message" handling.
 */
export function isProgress(message: unknown): message is ConvertProgress {
  if (typeof message !== 'object' || message === null) return false
  if (!('id' in message) || !('phase' in message)) return false
  return (
    typeof message.id === 'string' &&
    (message.phase === 'loading-decoder' || message.phase === 'decoding')
  )
}
