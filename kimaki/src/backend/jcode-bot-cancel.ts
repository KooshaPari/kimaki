// The cancel primitive for a native Jcode turn.
//
// `session/cancel` is the ACP call that stops a running turn (the same method
// named in docs/jcode-caller-mapping.md). This module is deliberately isolated
// and transport-agnostic: it never creates an ACP client, so calling it cannot
// spawn a child. A pure observer therefore stays childless, and a caller that
// only observes never reaches this module at all.
//
// It also never emits an event. The poller remains the single emitter for a turn,
// exactly as on the prompt path: a cancelled turn reaches the bot when the
// observer next reads the persisted record, not from this function.
//
// Every refusal is a named JcodeBotBackendError stage, never a fallback:
//   cancel-closed         the seam was stopped
//   cancel-no-connection  there is no live ACP connection to cancel over
//   cancel-not-running    no turn is on the wire, so there is nothing to cancel
//   cancel-session        the target has no session id
//   cancel-rejected       the ACP client refused to write/forward the cancel
//   cancel-threw          the ACP client threw instead of resolving an Error
//
// The connection is owned by the caller (the prompt writer or the seam). This
// module neither closes it nor waits for the child: closing while the prompt
// request is still on the wire would destroy the very turn being cancelled.

import type { AcpClient } from './acp/contracts.ts'
import { JcodeBotBackendError } from './jcode-bot-error.ts'

/** What a successful cancel proves. It is a value, never an event. */
export type JcodeCancelOutcome = {
  sessionId: string
  cancelled: true
}

export type JcodeCancelTarget = {
  sessionId: string
  /**
   * The live ACP connection that owns the turn. `null` means there is none:
   * cancelling must not create one, so this is a named refusal instead.
   */
  client: AcpClient | null
  /**
   * True while a prompt is on the wire. Accepts a live predicate so a caller can
   * pass the writer's `busy` without sampling it too early.
   */
  running: boolean | (() => boolean)
  /** True once the seam stopped. Accepts a live predicate for the same reason. */
  closed?: boolean | (() => boolean)
}

const evaluate = (value: boolean | (() => boolean) | undefined): boolean =>
  typeof value === 'function' ? value() : value === true

const fail = (stage: string, reason: string, cause?: unknown): JcodeBotBackendError =>
  cause === undefined ? new JcodeBotBackendError({ stage, reason }) : new JcodeBotBackendError({ stage, reason, cause })

/**
 * Cancel the running turn on `target`, if there is one.
 *
 * Checks run in this order: closed, no connection, not running, empty session.
 * The no-connection check comes before the running check because a caller with
 * no transport has nothing to cancel over even if its stale flag says otherwise,
 * and because a pure observer must be refused without spawning anything.
 */
export async function cancelJcodeTurn(
  target: JcodeCancelTarget | null | undefined,
): Promise<JcodeCancelOutcome | JcodeBotBackendError> {
  if (evaluate(target?.closed)) {
    return fail('cancel-closed', 'the seam was stopped, so its turn can no longer be cancelled over ACP')
  }
  if (target === null || target === undefined || target.client === null) {
    return fail('cancel-no-connection', 'no live ACP connection was supplied; cancelling never starts one, so there is nothing to cancel over')
  }
  if (!evaluate(target.running)) {
    return fail('cancel-not-running', `no turn is running on ${target.sessionId || '(no session)'}; a cancel with nothing on the wire is refused rather than reported as success`)
  }
  const sessionId = (target.sessionId ?? '').trim()
  if (sessionId === '') {
    return fail('cancel-session', 'the cancel target has no session id; the ACP peer needs one to route session/cancel')
  }
  let result: Error | undefined
  try {
    // The transport writes `session/cancel` as a notification. It resolves an
    // Error instead of throwing for its own refusals.
    result = await target.client.cancel({ sessionId })
  } catch (cause) {
    return fail('cancel-threw', `the ACP client threw while cancelling ${sessionId}`, cause)
  }
  if (result instanceof Error) {
    // A closed transport is the specific case the client reports by name; map it
    // to the same stage this module uses so callers branch on one vocabulary.
    if (/closed/i.test(result.message)) {
      return fail('cancel-closed', `the ACP connection closed before ${sessionId} could be cancelled`, result)
    }
    return fail('cancel-rejected', `the ACP client refused to cancel ${sessionId}`, result)
  }
  // No emit, no fabricated stop reason: the running prompt resolves the turn and
  // the poller reports it once from the persisted record.
  return { sessionId, cancelled: true }
}
