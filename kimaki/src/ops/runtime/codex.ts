// Two surfaces, both over a caller-owned initialized app-server connection:
// passive metadata reads and an explicit turn control surface. Neither the
// observer nor the controller launches a process, reads credentials, or
// resumes a historical thread. Streaming requires the caller to forward the
// transport's notification stream; see `createCodexController`.
import * as errore from 'errore'
import { ConfigError } from '../../errors.js'
import type { SessionKey } from '../contracts.js'
import { passiveCapabilities, sessionKeyId } from '../registry.js'

export class CodexRuntimeError extends errore.createTaggedError({
  name: 'CodexRuntimeError',
  message: 'Codex app-server request $operation failed',
}) {}

type Request = (method: 'thread/list' | 'thread/read', params: Record<string, unknown>) => Promise<unknown>
type NativeThread = Record<string, unknown> & { id: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const thread = (value: unknown): value is NativeThread => record(value) && typeof value.id === 'string' && value.id.trim().length > 0

// Exact request methods accepted by `codex app-server` (Codex 0.167.2),
// taken from `codex app-server generate-json-schema`/`generate-ts`:
//   thread/start    -> { cwd?, model?, approvalPolicy?, sandbox? } => { thread: { id } }
//   turn/start      -> { threadId, input: UserInput[] }           => { turn: { id } }
//   turn/interrupt  -> { threadId, turnId }                       => {}
// Streamed server notifications used here:
//   item/agentMessage/delta -> { threadId, turnId, itemId, delta }
//   turn/completed          -> { threadId, turn: { id, status, items, error } }
// Server-initiated approval requests (item/commandExecution/requestApproval,
// item/fileChange/requestApproval, item/tool/requestUserInput, ...) are NOT
// answered by this client, so `answerApproval` stays unsupported.
export type CodexControlMethod = 'thread/start' | 'thread/resume' | 'thread/read' | 'turn/start' | 'turn/interrupt'
export type CodexControlRequest = (method: CodexControlMethod, params: Record<string, unknown>) => Promise<unknown>
export type CodexNotification = { method: string; params?: unknown; id?: number }
export type CodexNotificationListener = (notification: CodexNotification) => void
export type CodexSubscribe = (listener: CodexNotificationListener) => (() => void) | Error

export type CodexCapability = { kind: 'supported' } | { kind: 'unsupported'; reason: string }
export type CodexControlCapabilities = {
  version: 1
  discovery: { kind: 'supported' }
  streaming: CodexCapability
  control: {
    create: CodexCapability
    submit: CodexCapability
    interrupt: CodexCapability
    answerApproval: CodexCapability
  }
}

export const codexControlCapabilities = {
  version: 1,
  discovery: { kind: 'supported' },
  streaming: { kind: 'supported' },
  control: {
    create: { kind: 'supported' },
    submit: { kind: 'supported' },
    interrupt: { kind: 'supported' },
    answerApproval: {
      kind: 'unsupported',
      reason: 'Server-initiated approval requests are answered with a JSON-RPC error, so an approval-gated action fails instead of being granted',
    },
  },
} as const satisfies CodexControlCapabilities

export type CodexTurnDelta = { threadId: string; turnId: string; itemId: string; text: string }
export type CodexTurnResult = { threadId: string; turnId: string; status: 'completed' | 'interrupted'; text: string }
type TurnSettlement = CodexTurnResult | Error

type PendingTurn = {
  state: {
    turnId: string | null
    provisionalTurnId: string | null
    text: string
    onDelta: ((delta: CodexTurnDelta) => void) | undefined
  }
  settle: (settlement: TurnSettlement) => void
}

const malformed = (operation: CodexControlMethod) =>
  new CodexRuntimeError({ operation, cause: new Error('Malformed response') })

// Resolves an Error instead of throwing or hanging. The losing branch of the
// race keeps its handler attached, so a late rejection is never unhandled.
async function bounded(
  operation: CodexControlMethod,
  timeoutMs: number,
  start: () => Promise<unknown>,
  unwrap: (value: unknown) => unknown,
): Promise<unknown | Error> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new CodexRuntimeError({ operation, cause: new Error(`Timed out after ${timeoutMs}ms`) })),
      timeoutMs,
    )
  })
  try {
    const attempt = Promise.resolve().then(start).then(
      (value) => unwrap(value),
      (cause) => new CodexRuntimeError({ operation, cause }),
    )
    return await Promise.race([attempt, expiry])
  } finally {
    clearTimeout(timer)
  }
}

export function createCodexController({
  hostId,
  endpointId,
  request,
  subscribe,
  timeoutMs = 30_000,
  turnTimeoutMs = 600_000,
}: {
  hostId: string
  endpointId: string
  request: CodexControlRequest
  subscribe: CodexSubscribe
  timeoutMs?: number
  turnTimeoutMs?: number
}) {
  const valid = sessionKeyId({ hostId, endpointId, backendKind: 'codex', nativeSessionId: 'validation' })
  if (valid instanceof Error) return valid
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return new ConfigError({ reason: 'timeoutMs must be a positive number' })
  if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) return new ConfigError({ reason: 'turnTimeoutMs must be a positive number' })
  const source = Object.freeze({ hostId, endpointId, backendKind: 'codex' as const })
  const keyFor = (nativeSessionId: string): SessionKey => ({ ...source, nativeSessionId })
  const pending = new Map<string, PendingTurn>()

  const onNotification = (notification: CodexNotification) => {
    if (!record(notification) || typeof notification.method !== 'string') return
    const params = notification.params
    if (!record(params) || typeof params.threadId !== 'string') return
    const entry = pending.get(params.threadId)
    if (!entry) return
    const { state } = entry
    const eventTurnId = typeof params.turnId === 'string' && params.turnId ? params.turnId : null
    // Without the authoritative turn id yet, adopt the first one seen and
    // reject a second, different one instead of mixing turns.
    if (state.turnId === null && eventTurnId !== null) {
      if (state.provisionalTurnId === null) state.provisionalTurnId = eventTurnId
      else if (state.provisionalTurnId !== eventTurnId) return
    }
    if (state.turnId !== null && eventTurnId !== null && eventTurnId !== state.turnId) return

    if (notification.method === 'item/agentMessage/delta') {
      if (typeof params.delta !== 'string') return
      state.text += params.delta
      if (typeof params.itemId === 'string' && state.onDelta) {
        try {
          state.onDelta({ threadId: params.threadId, turnId: eventTurnId ?? state.turnId ?? '', itemId: params.itemId, text: params.delta })
        } catch {
          // A consumer callback must not break the stream.
        }
      }
      return
    }
    if (notification.method !== 'turn/completed') return

    const turn = record(params.turn) ? params.turn : null
    const status = turn && typeof turn.status === 'string' ? turn.status : null
    const turnId = turn && typeof turn.id === 'string' && turn.id ? turn.id : eventTurnId ?? state.turnId ?? state.provisionalTurnId
    if (turnId === null || turnId === '') {
      pending.delete(params.threadId)
      entry.settle(new CodexRuntimeError({ operation: 'turn/start', cause: new Error('Turn completion carried no turn id') }))
      return
    }
    const text = state.text || completedAgentText(turn)
    pending.delete(params.threadId)
    if (status === 'completed' || status === 'interrupted') entry.settle({ threadId: params.threadId, turnId, status, text })
    else if (status === 'failed') {
      const message = turn && record(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : 'Turn failed'
      entry.settle(new CodexRuntimeError({ operation: 'turn/start', cause: new Error(message) }))
    } else entry.settle(new CodexRuntimeError({ operation: 'turn/start', cause: new Error('Turn completed without a recognised status') }))
  }

  let unsubscribe: (() => void) | null = null
  try {
    const subscription = subscribe(onNotification)
    if (subscription instanceof Error) return subscription
    unsubscribe = subscription
  } catch (cause) {
    return new CodexRuntimeError({ operation: 'turn/start', cause })
  }

  const close = () => {
    for (const [threadId, entry] of pending) {
      pending.delete(threadId)
      entry.settle(new ConfigError({ reason: 'Codex controller closed before the turn completed' }))
    }
    unsubscribe?.()
    unsubscribe = null
  }

  const validateThreadId = (threadId: unknown): string | ConfigError => {
    if (typeof threadId !== 'string' || !threadId.trim()) return new ConfigError({ reason: 'Thread id must be a nonblank string' })
    const checked = sessionKeyId(keyFor(threadId))
    return checked instanceof Error ? checked : threadId
  }

  return {
    capabilities: codexControlCapabilities,
    source,
    keyFor,
    async startThread(input: { cwd?: string } = {}) {
      if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
        return new ConfigError({ reason: 'Thread cwd must be a nonblank string' })
      }
      const result = await bounded(
        'thread/start',
        timeoutMs,
        () => request('thread/start', input.cwd === undefined ? {} : { cwd: input.cwd }),
        (value) => value,
      )
      if (result instanceof Error) return result
      if (!record(result) || !thread(result.thread)) return malformed('thread/start')
      return { threadId: result.thread.id, key: keyFor(result.thread.id) }
    },
    // A thread lives on disk but not in a fresh app-server process, so a second
    // process must resume it before turn/start will accept the id.
    async resumeThread(input: { threadId: string; cwd?: string }) {
      const checked = validateThreadId(input.threadId)
      if (checked instanceof Error) return checked
      if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
        return new ConfigError({ reason: 'Thread cwd must be a nonblank string' })
      }
      const params: Record<string, unknown> = { threadId: input.threadId }
      if (input.cwd !== undefined) params['cwd'] = input.cwd
      const result = await bounded(
        'thread/resume',
        timeoutMs,
        () => request('thread/resume', params),
        (value) => value,
      )
      if (result instanceof Error) return result
      if (!record(result) || !thread(result.thread)) return malformed('thread/resume')
      if (result.thread.id !== input.threadId) return new ConfigError({ reason: 'The agent resumed a different thread than the one requested' })
      return { threadId: result.thread.id, key: keyFor(result.thread.id) }
    },
    // The only read surface codex offers for a thread this process did not start.
    // Shapes verified against codex 0.169: userMessage content is an array of
    // { type: 'text', text }, agentMessage text is a plain string.
    async readThread(input: { threadId: string; includeTurns?: boolean }) {
      const checked = validateThreadId(input.threadId)
      if (checked instanceof Error) return checked
      const params: Record<string, unknown> = { threadId: input.threadId, includeTurns: input.includeTurns !== false }
      const result = await bounded(
        'thread/read',
        timeoutMs,
        () => request('thread/read', params),
        (value) => value,
      )
      if (result instanceof Error) return result
      if (!record(result) || !record(result.thread)) return malformed('thread/read')
      const readThread = result.thread
      if (typeof readThread.id !== 'string' || readThread.id !== input.threadId) return malformed('thread/read')
      const turns: Array<{ id: string; status: string; messages: Array<{ role: 'user' | 'agent'; text: string }> }> = []
      const rawTurns = Array.isArray(readThread.turns) ? readThread.turns : []
      for (const rawTurn of rawTurns) {
        if (!record(rawTurn) || typeof rawTurn.id !== 'string') continue
        const messages: Array<{ role: 'user' | 'agent'; text: string }> = []
        for (const rawItem of Array.isArray(rawTurn.items) ? rawTurn.items : []) {
          if (!record(rawItem)) continue
          if (rawItem.type === 'userMessage') {
            const parts = Array.isArray(rawItem.content) ? rawItem.content : []
            let text = ''
            for (const part of parts) {
              if (record(part) && part.type === 'text' && typeof part.text === 'string') text += part.text
            }
            if (text) messages.push({ role: 'user', text })
          } else if (rawItem.type === 'agentMessage' && typeof rawItem.text === 'string' && rawItem.text) {
            messages.push({ role: 'agent', text: rawItem.text })
          }
        }
        turns.push({ id: rawTurn.id, status: typeof rawTurn.status === 'string' ? rawTurn.status : 'unknown', messages })
      }
      return { threadId: readThread.id, turns, key: keyFor(readThread.id) }
    },
    async sendTurn({ threadId, text, onDelta }: { threadId: string; text: string; onDelta?: (delta: CodexTurnDelta) => void }) {
      const checked = validateThreadId(threadId)
      if (checked instanceof Error) return checked
      if (typeof text !== 'string' || !text.trim()) return new ConfigError({ reason: 'Turn text must be a nonblank string' })
      if (onDelta !== undefined && typeof onDelta !== 'function') return new ConfigError({ reason: 'Turn onDelta must be a function' })
      if (pending.has(threadId)) return new ConfigError({ reason: `Thread ${threadId} already has an active turn` })

      let settle!: (settlement: TurnSettlement) => void
      const completion = new Promise<TurnSettlement>((resolve) => { settle = resolve })
      pending.set(threadId, {
        state: { turnId: null, provisionalTurnId: null, text: '', onDelta },
        settle: (settlement) => { pending.delete(threadId); settle(settlement) },
      })

      const started = await bounded(
        'turn/start',
        timeoutMs,
        () => request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] }),
        (value) => value,
      )
      if (started instanceof Error) {
        pending.delete(threadId)
        return started
      }
      if (!record(started) || !thread(started.turn)) {
        pending.delete(threadId)
        return malformed('turn/start')
      }
      const entry = pending.get(threadId)
      if (!entry) return new ConfigError({ reason: 'Turn settled before it started' })
      entry.state.turnId = started.turn.id
      // Events buffered before the id was known belong to a different turn.
      if (entry.state.provisionalTurnId !== null && entry.state.provisionalTurnId !== started.turn.id) entry.state.text = ''

      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<Error>((resolve) => {
        timer = setTimeout(() => {
          pending.delete(threadId)
          resolve(new CodexRuntimeError({ operation: 'turn/start', cause: new Error(`Timed out after ${turnTimeoutMs}ms`) }))
        }, turnTimeoutMs)
      })
      try {
        return await Promise.race([completion, expiry])
      } finally {
        clearTimeout(timer)
        pending.delete(threadId)
      }
    },
    async cancel({ threadId, turnId }: { threadId: string; turnId?: string }) {
      const checked = validateThreadId(threadId)
      if (checked instanceof Error) return checked
      if (turnId !== undefined && (typeof turnId !== 'string' || !turnId.trim())) {
        return new ConfigError({ reason: 'Turn id must be a nonblank string' })
      }
      const entry = pending.get(threadId)
      const resolvedTurnId = turnId ?? entry?.state.turnId ?? entry?.state.provisionalTurnId ?? null
      if (resolvedTurnId === null) return new ConfigError({ reason: `No active turn for thread ${threadId}` })
      const result = await bounded(
        'turn/interrupt',
        timeoutMs,
        () => request('turn/interrupt', { threadId, turnId: resolvedTurnId }),
        (value) => value,
      )
      if (result instanceof Error) return result
      if (!record(result)) return malformed('turn/interrupt')
      return { threadId, turnId: resolvedTurnId }
    },
    close,
  }
}

// Fallback text source when a completion arrives without delta notifications.
function completedAgentText(turn: Record<string, unknown> | null): string {
  if (!turn || !Array.isArray(turn.items)) return ''
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const item = turn.items[index]
    if (record(item) && item.type === 'agentMessage' && typeof item.text === 'string') return item.text
  }
  return ''
}

export function createCodexObserver({ hostId, endpointId, request }: { hostId: string; endpointId: string; request: Request }) {
  const valid = sessionKeyId({ hostId, endpointId, backendKind: 'codex', nativeSessionId: 'validation' })
  if (valid instanceof Error) return valid
  const source = Object.freeze({ hostId, endpointId, backendKind: 'codex' as const })
  const keyFor = (nativeSessionId: string): SessionKey => ({ ...source, nativeSessionId })
  const call = (operation: 'thread/list' | 'thread/read', params: Record<string, unknown>) =>
    Promise.resolve().then(() => request(operation, params)).catch((cause) => new CodexRuntimeError({ operation, cause }))
  return {
    capabilities: {
      ...passiveCapabilities,
      snapshot: { kind: 'supported' as const },
      observe: { kind: 'unsupported' as const, reason: 'thread/read polls a live thread without blocking its writer, but no notification stream is offered and thread/resume takes the writer lock, so this is a poll-based read surface rather than an observe subscription' },
      replay: { kind: 'unsupported' as const, reason: 'Metadata reads do not provide a durable event cursor' },
      exclusiveControl: { kind: 'unsupported' as const, reason: 'No exclusive writer lease is established' },
    },
    async discover(input: { cursor?: string; limit?: number } = {}) {
      const result = await call('thread/list', { ...input, useStateDbOnly: true })
      if (result instanceof Error) return result
      if (!record(result) || !Array.isArray(result.data) || !result.data.every(thread) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) {
        return new CodexRuntimeError({ operation: 'thread/list', cause: new Error('Malformed response') })
      }
      return { source, sessions: result.data.map((native) => ({ key: keyFor(native.id), native: { id: native.id } })), cursor: result.nextCursor }
    },
    async readSnapshot({ key }: { key: SessionKey }) {
      const valid = sessionKeyId(key)
      if (valid instanceof Error) return valid
      if (key.hostId !== hostId || key.endpointId !== endpointId || key.backendKind !== 'codex') return new ConfigError({ reason: 'Session identity does not match this Codex endpoint' })
      const scopedKey = Object.freeze({ hostId, endpointId, backendKind: 'codex' as const, nativeSessionId: key.nativeSessionId })
      const result = await call('thread/read', { threadId: scopedKey.nativeSessionId, includeTurns: false })
      if (result instanceof Error) return result
      if (!record(result) || !thread(result.thread) || result.thread.id !== scopedKey.nativeSessionId) return new CodexRuntimeError({ operation: 'thread/read', cause: new Error('Malformed or mismatched thread identity') })
      return { key: scopedKey, source, session: { id: result.thread.id } }
    },
  }
}
