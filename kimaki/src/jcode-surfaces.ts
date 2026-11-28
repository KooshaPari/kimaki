// Which bot surfaces a jcode thread can serve, and the honest answer for the
// ones it cannot.
//
// Every surface here reaches OpenCode through `oc(bot, ...)`, so on a jcode bot
// it used to fail with "OpenCode service not reachable (not connected)": a
// generic transport error that says nothing about the surface, names no missing
// capability, and reads as a bug rather than a decision. This module is the one
// place that decides, so the message a user sees names the surface and why it is
// absent instead of blaming a connection.
//
// Two decisions, and only two:
//
//   routed   a real jcode primitive exists (session/cancel for stop), so the
//            surface runs through it. Abort is the only one today.
//   refused  no jcode equivalent exists. The caller returns a named
//            JcodeSurfaceUnavailableError before it makes any OpenCode call, so
//            nothing is attempted and nothing is reported as done.
//
// `JCODE_SURFACES` is data on purpose: the matrix is read by tests, so a surface
// added without a decision fails rather than silently falling back to the
// generic transport error.
//
// The backend is the thread's, not the bot's default: a jcode bot can still
// serve a legacy OpenCode thread (thread-backend.ts), and that thread's undo must
// keep working through OpenCode. The rows are the same authority dispatch uses.

import * as errore from 'errore'

import type { Bot } from './bot.ts'
import { JcodeBotBackendError } from './backend/jcode-bot-error.ts'
import type { JcodeBotConnection } from './backend/jcode-bot-backend.ts'

/** Every surface that assumes an OpenCode connection and is decided here. */
export const JCODE_SURFACE_NAMES = [
  'abort',
  'queue',
  'clear-queue',
  'undo',
  'redo',
  'shell',
  'command',
  'model',
  'agent',
  'btw',
  'fork',
  'compact',
] as const

export type JcodeSurfaceName = (typeof JCODE_SURFACE_NAMES)[number]

export type JcodeSurfaceDecision = 'routed' | 'refused'

export type JcodeSurface = {
  readonly surface: JcodeSurfaceName
  /** The handler this decision applies to (file:line at the time of writing). */
  readonly site: string
  /** What the surface does on an OpenCode thread. */
  readonly opencode: string
  readonly decision: JcodeSurfaceDecision
  /** What happens on a jcode thread. For a refusal, this is the sentence a user reads. */
  readonly jcode: string
}

/**
 * The surface matrix. `site` is documentation, not a test anchor: it moves with
 * the handler, and the decision it names is asserted below instead.
 */
export const JCODE_SURFACES: Readonly<Record<JcodeSurfaceName, JcodeSurface>> = {
  abort: {
    surface: 'abort',
    site: 'kimaki/src/prompt.ts abort()',
    opencode: 'stops the run, clears the inbox queue, rejects pending forms/permissions and kills running shells',
    decision: 'routed',
    jcode: 'stops the running turn over the seam\'s session/cancel. A queue clear, a pending-form reject and a shell kill have no jcode equivalent and are reported as not applicable instead of being attempted',
  },
  queue: {
    surface: 'queue',
    site: 'kimaki/src/prompt.ts prompt()',
    opencode: 'parks the message in the session inbox and runs it after the current turn',
    decision: 'refused',
    jcode: 'jcode\'s ACP seam has no inbox, so a queued message has nowhere to wait',
  },
  'clear-queue': {
    surface: 'clear-queue',
    site: 'kimaki/src/prompt.ts clearQueue()',
    opencode: 'lists the session inbox and cancels queued items',
    decision: 'refused',
    jcode: 'jcode\'s ACP seam has no inbox, so there is no queued message to cancel',
  },
  undo: {
    surface: 'undo',
    site: 'kimaki/src/prompt.ts undo()',
    opencode: 'stages a revert at a user message; file changes are kept',
    decision: 'refused',
    jcode: 'jcode keeps no revert history over ACP, so there is no turn to stage back',
  },
  redo: {
    surface: 'redo',
    site: 'kimaki/src/prompt.ts redo()',
    opencode: 'moves the staged revert forward one turn, or clears it',
    decision: 'refused',
    jcode: 'nothing on jcode records an undone turn, so there is nothing to restore',
  },
  shell: {
    surface: 'shell',
    site: 'kimaki/src/prompt.ts shell()',
    opencode: 'runs `!cmd` as a native session shell and streams its output',
    decision: 'refused',
    jcode: 'jcode\'s ACP seam has no shell primitive, so the command would run nowhere',
  },
  command: {
    surface: 'command',
    site: 'kimaki/src/prompt.ts command()',
    opencode: 'resolves `/name args` against the project\'s command catalog and runs it in the session',
    decision: 'refused',
    jcode: 'jcode publishes no command catalog over ACP, so the command cannot be resolved',
  },
  model: {
    surface: 'model',
    site: 'kimaki/src/commands/preference-commands.ts /model',
    opencode: 'lists providers/models and switches the session model from the next step',
    decision: 'refused',
    jcode: 'jcode publishes no model catalog over ACP, so there is no model to pick',
  },
  agent: {
    surface: 'agent',
    site: 'kimaki/src/sessions.ts agentSelection()',
    opencode: 'lists primary agents and switches the session agent',
    decision: 'refused',
    jcode: 'jcode publishes no agent catalog over ACP, so there is no agent to switch to',
  },
  btw: {
    surface: 'btw',
    site: 'kimaki/src/sessions.ts forkBtw()',
    opencode: 'forks the session into a side thread that answers one question',
    decision: 'refused',
    jcode: 'jcode\'s ACP seam cannot fork a session, so the side thread has nothing to continue from',
  },
  fork: {
    surface: 'fork',
    site: 'kimaki/src/sessions.ts fork()',
    opencode: 'forks the session into a new thread, optionally moved into a worktree',
    decision: 'refused',
    jcode: 'jcode\'s ACP seam cannot fork a session, so there is no history to branch into a new thread',
  },
  compact: {
    surface: 'compact',
    site: 'kimaki/src/commands/thread-commands.ts compactCommand()',
    opencode: 'asks the session to compact its context',
    decision: 'refused',
    jcode: 'jcode\'s ACP seam exposes no compaction call',
  },
}

/**
 * A surface this backend cannot serve. `surface` and `reason` are separate
 * fields so a caller can branch on the surface without parsing the sentence.
 */
export class JcodeSurfaceUnavailableError extends errore.createTaggedError({
  name: 'JcodeSurfaceUnavailableError',
  message: '$surface is unavailable on the jcode backend: $reason',
}) {}

/**
 * The backend that serves a conversation: its `thread_sessions` row when one
 * exists, otherwise the connection this bot reaches. Reading the row first is
 * what keeps a legacy OpenCode thread on a jcode bot on OpenCode.
 */
export function conversationBackendKind(
  bot: Pick<Bot, 'opencode' | 'store'>,
  threadId: string,
): 'opencode' | 'jcode' {
  const recorded = bot.store.getState().threadBackends[threadId]
  if (recorded === 'opencode' || recorded === 'jcode') return recorded
  return bot.opencode.kind
}

/** The named refusal for a surface on the bot's own connection, or null when it runs. */
export function jcodeConnectionRefusal(
  bot: Pick<Bot, 'opencode'>,
  surface: JcodeSurfaceName,
): JcodeSurfaceUnavailableError | null {
  const row = JCODE_SURFACES[surface]
  if (row.decision === 'routed') return null
  if (bot.opencode.kind !== 'jcode') return null
  return new JcodeSurfaceUnavailableError({ surface: row.surface, reason: row.jcode })
}

/** The named refusal for a surface on a jcode conversation, or null when the surface runs. */
export function jcodeSurfaceRefusal(
  bot: Pick<Bot, 'opencode' | 'store'>,
  threadId: string,
  surface: JcodeSurfaceName,
): JcodeSurfaceUnavailableError | null {
  const row = JCODE_SURFACES[surface]
  // A routed surface is never refused: the caller runs its primitive.
  if (row.decision === 'routed') return null
  if (conversationBackendKind(bot, threadId) !== 'jcode') return null
  return new JcodeSurfaceUnavailableError({ surface: row.surface, reason: row.jcode })
}

/** True for the named surface refusal; the one type callers return to a user. */
export const isJcodeSurfaceUnavailableError = (value: unknown): value is JcodeSurfaceUnavailableError =>
  value instanceof JcodeSurfaceUnavailableError

/**
 * The bot's live jcode connection, or null when this bot started none. Used by
 * routed surfaces: a thread row can name jcode while `opencode` holds another
 * connection, so the connection is looked up by kind, never cast.
 */
export function jcodeConnectionOf(
  bot: Pick<Bot, 'opencode' | 'backends'>,
): JcodeBotConnection | null {
  if (bot.backends.jcode) return bot.backends.jcode
  return bot.opencode.kind === 'jcode' ? bot.opencode : null
}

/** What an abort could and could not do on jcode; `note` says what was skipped. */
export type JcodeAbortOutcome = { cleared: number; note?: string }

/**
 * Abort on a jcode thread: one `session/cancel` over the seam's own connection.
 *
 * Nothing else in `abort` has a jcode counterpart, so the outcome says so in
 * `note` rather than reporting a queue as cleared. A cancel with no turn on the
 * wire is not an error: the user asked for nothing to be running, and nothing is.
 */
export async function abortJcode(connection: Pick<JcodeBotConnection, 'cancel'>): Promise<Error | JcodeAbortOutcome> {
  const outcome = await connection.cancel()
  const note = 'no queue, forms or shells to clear on the jcode backend'
  if (outcome instanceof Error) {
    // Nothing running: the post-condition the user asked for already holds.
    if (outcome instanceof JcodeBotBackendError && outcome.stage === 'cancel-not-running') return { cleared: 0, note }
    return outcome
  }
  return { cleared: 0, note }
}
