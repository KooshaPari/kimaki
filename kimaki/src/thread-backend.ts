// Which backend serves a thread (docs/opencode-removal.md step 1.1).
//
// The `thread_sessions.backend` column is the record: a row written before the
// column existed defaults to 'opencode' (src/migrations.ts), a row the bot binds
// today records the configured backend (src/sessions.ts bindThread). Reading it
// here is the only place that decides, so a bot started as jcode never serves an
// OpenCode thread through the jcode seam and never guesses when a row is
// unreadable.
//
// No fallbacks: an unrecorded value, a missing row, or a backend this bot did
// not start is a named error. Serving a thread through the wrong backend would
// look like success while writing to a different store.

import * as errore from 'errore'

import type { BotBackend } from './backend-selection.ts'
import type { Bot } from './bot.ts'
import { ConfigError } from './errors.ts'

/** The backend kinds a thread row may name. Same union as the CLI's --backend. */
export type ThreadBackendKind = BotBackend

/** Every value `thread_sessions.backend` may hold. Mirrors backend-selection.ts. */
export const THREAD_BACKEND_KINDS = ['opencode', 'jcode'] as const satisfies readonly ThreadBackendKind[]

// A row whose backend value is not one of THREAD_BACKEND_KINDS. Kept separate from
// "backend not started" because the fix differs: the row is corrupt, not the bot.
export class UnresolvedThreadBackendError extends errore.createTaggedError({
  name: 'UnresolvedThreadBackendError',
  message: 'Thread $threadId records backend "$backend", which is not a known backend (opencode, jcode)$detail',
}) {}

// The row names a backend this bot did not start (no legacy OpenCode thread at
// startup, so no OpenCode connection exists).
export class ThreadBackendUnavailableError extends errore.createTaggedError({
  name: 'ThreadBackendUnavailableError',
  message: 'Thread $threadId records backend "$backend", which this bot did not start$detail',
}) {}

export function isThreadBackendKind(value: unknown): value is ThreadBackendKind {
  return typeof value === 'string' && (THREAD_BACKEND_KINDS as readonly string[]).includes(value)
}

/** threadId -> the raw recorded value, kept as recorded so an unknown name stays visible. */
export function threadBackendsOf(rows: readonly { thread_id: string; backend: string }[]): Readonly<Record<string, string>> {
  return Object.fromEntries(rows.map((row) => [row.thread_id, row.backend]))
}

/**
 * The backend that must serve a thread, or a named error.
 *
 * `recorded` is the thread's `thread_sessions.backend`. A thread bound before the
 * bot writes its row (a brand new thread mid-creation) is not a case here: the row
 * is written before the first prompt (bindThread), and dispatch resolves the
 * thread from the row in the first place.
 */
export function resolveThreadBackend({
  threadId,
  recorded,
}: {
  threadId: string
  recorded: string | undefined
}): ThreadBackendKind | UnresolvedThreadBackendError {
  if (recorded === undefined) {
    return new UnresolvedThreadBackendError({ threadId, backend: '(no thread_sessions row)', detail: '; no row records a backend for this thread' })
  }
  if (isThreadBackendKind(recorded)) return recorded
  return new UnresolvedThreadBackendError({ threadId, backend: recorded, detail: '' })
}

export type BackendPlan = {
  opencodeThreads: number
  jcodeThreads: number
  // Rows whose recorded backend is not a known kind. Counted, never coerced.
  unresolved: readonly { threadId: string; backend: string }[]
  // Whether the OpenCode connection must be running: the plan step's mitigation
  // ("keep watchOpencode alive read-only when any thread has an OpenCode id").
  needsOpencode: boolean
}

/** What the persisted rows require of one bot start. Pure: no I/O, no defaults. */
export function backendPlan(rows: readonly { thread_id: string; backend: string }[]): BackendPlan {
  let opencodeThreads = 0
  let jcodeThreads = 0
  const unresolved: { threadId: string; backend: string }[] = []
  for (const row of rows) {
    if (row.backend === 'opencode') opencodeThreads++
    else if (row.backend === 'jcode') jcodeThreads++
    else unresolved.push({ threadId: row.thread_id, backend: row.backend })
  }
  return { opencodeThreads, jcodeThreads, unresolved, needsOpencode: opencodeThreads > 0 }
}

/**
 * Whether a legacy OpenCode thread may take new input through the OpenCode
 * connection it resolves to, or only be viewed.
 *
 * docs/opencode-removal.md step 1.1 says "keep watchOpencode alive read-only".
 * `watchOpencode` is only an event subscription, so keeping it alive is
 * read-only at the transport level; but the same connection carries
 * `session.prompt`, so "read-only" does not by itself say whether a legacy
 * thread may be continued. The step requires existing threads to keep
 * "resolving through the OpenCode connection", which a view-only policy would
 * not satisfy. This implements the serving reading and reports the ambiguity;
 * flipping this constant to false is the whole view-only policy.
 */
export const LEGACY_OPENCODE_THREADS_ACCEPT_INPUT = true

export type ThreadBackendResolution =
  | { readonly ok: true; readonly threadId: string; readonly backend: ThreadBackendKind; readonly bot: Bot }
  | { readonly ok: false; readonly error: UnresolvedThreadBackendError | ThreadBackendUnavailableError | ConfigError }

/**
 * A bot view whose `opencode` field is the connection the thread's row names, or a
 * named error. Every downstream `oc(bot, ...)` then speaks to the right backend
 * without knowing this module exists.
 */
export function withThreadBackend(
  bot: Bot,
  threadId: string,
  { acceptLegacyInput = LEGACY_OPENCODE_THREADS_ACCEPT_INPUT }: { acceptLegacyInput?: boolean } = {},
): ThreadBackendResolution {
  const backend = resolveThreadBackend({ threadId, recorded: bot.store.getState().threadBackends[threadId] })
  if (backend instanceof UnresolvedThreadBackendError) return { ok: false, error: backend }
  const connection = backend === 'opencode' ? bot.backends.opencode : bot.backends.jcode
  if (!connection) {
    return {
      ok: false,
      error: new ThreadBackendUnavailableError({
        threadId,
        backend,
        detail: backend === 'opencode' ? ' (no OpenCode thread was persisted when it started, so no OpenCode connection runs)' : '',
      }),
    }
  }
  if (backend === 'jcode') return { ok: true, threadId, backend, bot: { ...bot, opencode: connection } }
  if (acceptLegacyInput) return { ok: true, threadId, backend, bot: { ...bot, opencode: connection } }
  return {
    ok: false,
    error: new ConfigError({ reason: `Thread ${threadId} is an OpenCode thread and this bot only views legacy OpenCode history; it cannot take new input` }),
  }
}
