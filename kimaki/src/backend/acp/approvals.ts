// Server-initiated approval requests on the ACP transport.
//
// ACP inverts the permission direction: the agent sends a
// `session/request_permission` *request* to the client and waits for a result.
// Without a handler this module keeps the transport's historical behaviour and
// drops the frame, so an agent that asks stalls on its own timeout. With a
// handler the request is held here, surfaced with its payload exactly as it
// arrived, and answered exactly once.
//
// Every refusal resolves an Error instead of throwing (the errore convention
// used across kimaki), and each one is named so an operator can tell a replay
// from a stale id or a request for another connection's session.

import * as errore from 'errore'
import type { AcpServerAnswerInput, AcpServerRequest, AcpServerRequestHandler } from './contracts.ts'

// Approval refusals are user-facing: the reason has to survive into the message,
// because "the prompt failed" cannot tell whether an answer was a replay, an
// unknown id, a foreign session, or a missing handler.
export class AcpApprovalError extends errore.createTaggedError({
  name: 'AcpApprovalError',
  message: 'Approval request $requestId refused: $reason',
}) {}

/** Server-initiated methods this channel can hold. */
export const ACP_PERMISSION_METHODS = ['session/request_permission'] as const

/** Capability key declared only when a handler is supplied. */
export const ACP_SERVER_REQUESTS_CAPABILITY = 'serverRequests'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const permissionOptions = (params: Record<string, unknown>): Array<Record<string, unknown>> => {
  const options = Array.isArray(params.options) ? params.options : []
  const entries: Array<Record<string, unknown>> = []
  for (const option of options) {
    const entry = record(option)
    if (entry) entries.push(entry)
  }
  return entries
}

export type ApprovalChannel = {
  /**
   * Client capabilities to send in `initialize`. Empty unless a handler was
   * supplied, so a peer is never told this client answers requests it cannot.
   */
  clientCapabilities: Record<string, unknown>
  /** Holds or refuses one inbound server-initiated request. */
  handle: (requestId: number | string, method: string, params: Record<string, unknown>) => void
  answer: (input: AcpServerAnswerInput) => { requestId: number | string } | Error
  pending: () => AcpServerRequest[]
  close: () => void
}

export const createApprovalChannel = (input: {
  onRequest?: AcpServerRequestHandler
  /** Writes one frame to the agent; false when the child is gone. */
  send: (frame: Record<string, unknown>) => boolean
  /** Whether a session id belongs to this connection. */
  ownsSession: (sessionId: string) => boolean
}): ApprovalChannel => {
  const enabled = typeof input.onRequest === 'function'
  const open = new Map<number | string, AcpServerRequest>()
  // A settled id is what makes a replay visible: a second answer reports that
  // the request was already answered instead of looking like an id that never
  // existed. The runtime allocates ids and does not reuse them per connection.
  const settled = new Set<number | string>()
  const order: Array<number | string> = []

  const refuseToAgent = (requestId: number | string, code: number, message: string) => {
    open.delete(requestId)
    if (order.includes(requestId)) order.splice(order.indexOf(requestId), 1)
    settled.add(requestId)
    input.send({ jsonrpc: '2.0', id: requestId, error: { code, message } })
  }

  const handle = (requestId: number | string, method: string, params: Record<string, unknown>) => {
    // Historical behaviour: with no handler an inbound request is dropped and
    // the agent's own timeout decides. Nothing existing changes.
    if (!enabled) return
    if (!(ACP_PERMISSION_METHODS as readonly string[]).includes(method)) {
      // Fail closed rather than leave the agent waiting on a method this client
      // has no answer for.
      refuseToAgent(requestId, -32601, `Server-initiated request ${method} is not supported`)
      return
    }
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
    if (sessionId === null || !input.ownsSession(sessionId)) {
      // A request for a session this connection never opened is not this
      // connection's to answer: refusing names the session and fails closed.
      refuseToAgent(
        requestId,
        -32602,
        `Permission request names session '${sessionId ?? '(none)'}', which is not this connection's`,
      )
      return
    }
    const request: AcpServerRequest = {
      requestId,
      method,
      sessionId,
      params,
      toolCall: record(params.toolCall),
      options: permissionOptions(params),
    }
    open.set(requestId, request)
    order.push(requestId)
    try {
      input.onRequest!(request)
    } catch (cause) {
      // A handler that throws must not leave the agent waiting: answer once with
      // an error so the turn fails closed instead of stalling.
      if (!open.has(requestId)) return
      const detail = cause instanceof Error && cause.message ? cause.message : 'unknown error'
      refuseToAgent(requestId, -32603, `The server-request handler threw, so the request was refused: ${detail}`)
    }
  }

  const answer = (input_: AcpServerAnswerInput): { requestId: number | string } | Error => {
    const requestId = input_?.requestId
    if (typeof requestId !== 'number' && typeof requestId !== 'string') {
      return new AcpApprovalError({ requestId: String(requestId), reason: 'a request id is required' })
    }
    if (!enabled) {
      return new AcpApprovalError({
        requestId: String(requestId),
        reason: 'this client was started without a server-request handler, so nothing can be answered',
      })
    }
    const hasResult = input_.result !== undefined
    const hasError = input_.error !== undefined
    if (hasResult === hasError) {
      return new AcpApprovalError({ requestId: String(requestId), reason: 'exactly one of result or error must be supplied' })
    }
    if (hasError && !record(input_.error)) {
      return new AcpApprovalError({ requestId: String(requestId), reason: 'the error answer is not an object' })
    }
    const pending = open.get(requestId)
    if (!pending) {
      return settled.has(requestId)
        ? new AcpApprovalError({
            requestId: String(requestId),
            reason: 'it was already answered, so a repeated answer cannot change the outcome',
          })
        : new AcpApprovalError({ requestId: String(requestId), reason: 'no server-initiated request with this id is open' })
    }
    // An answer may name the session it believes it is answering for. It must
    // be this connection's, and the request must belong to that same session.
    if (input_.sessionId !== undefined) {
      if (typeof input_.sessionId !== 'string' || !input_.sessionId) {
        return new AcpApprovalError({ requestId: String(requestId), reason: 'the supplied session id is not a nonblank string' })
      }
      if (!input.ownsSession(input_.sessionId)) {
        return new AcpApprovalError({
          requestId: String(requestId),
          reason: `the answer names session '${input_.sessionId}', which is not this connection's`,
        })
      }
      if (input_.sessionId !== pending.sessionId) {
        return new AcpApprovalError({
          requestId: String(requestId),
          reason: `the answer names session '${input_.sessionId}', but the request belongs to '${pending.sessionId}'`,
        })
      }
    }
    const frame = hasResult
      ? { jsonrpc: '2.0', id: requestId, result: input_.result }
      : { jsonrpc: '2.0', id: requestId, error: input_.error! }
    if (!input.send(frame)) {
      open.delete(requestId)
      settled.add(requestId)
      return new AcpApprovalError({ requestId: String(requestId), reason: 'the ACP agent process no longer had this request open' })
    }
    open.delete(requestId)
    if (order.includes(requestId)) order.splice(order.indexOf(requestId), 1)
    settled.add(requestId)
    return { requestId }
  }

  return {
    // Only a client that can actually answer advertises the capability.
    clientCapabilities: enabled
      ? { [ACP_SERVER_REQUESTS_CAPABILITY]: { requestPermission: true } }
      : {},
    handle,
    answer,
    pending: () => order.flatMap((requestId) => {
      const request = open.get(requestId)
      return request ? [request] : []
    }),
    close: () => {
      open.clear()
      order.length = 0
    },
  }
}
