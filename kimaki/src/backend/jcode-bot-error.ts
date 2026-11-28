// The named failure for the opt-in bot seam onto a native Jcode session.
//
// It lives in its own module so the observer-facing seam and the write path can
// both construct it without importing each other. `stage` is the machine-readable
// reason a caller branches on; `reason` is the sentence a human reads. Nothing
// here ever carries a prompt body: a failed turn names the stage, not the text.

import * as errore from 'errore'

export class JcodeBotBackendError extends errore.createTaggedError({
  name: 'JcodeBotBackendError',
  message: 'Jcode bot backend $stage failed: $reason',
}) {}

/**
 * A session-needing operation on a defer-mode bot connection. The bot decided
 * not to resolve or mint its own session at startup; a thread creates its
 * session when that thread binds. This is a decision, not a transport failure.
 */
export class JcodeSessionDeferredError extends errore.createTaggedError({
  name: 'JcodeSessionDeferredError',
  message: 'The jcode bot has no session of its own: $operation needs a session, and one is created when a thread binds',
}) {}

/** A capability the seam cannot supply, recorded rather than faked. */
export type JcodeBotRefusal = {
  name: 'subscribe' | 'durable-dedupe' | 'endpoint'
  reason: string
}

/** True for the named backend failure; used at boundaries that accept `Error`. */
export const isJcodeBotBackendError = (value: unknown): value is JcodeBotBackendError =>
  value instanceof JcodeBotBackendError
