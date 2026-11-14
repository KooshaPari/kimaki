// One backend session, many clients.
//
// A hub owns exactly one backend session and is the only writer. Clients attach
// as subscribers with a cursor and receive an ordered event stream, so several
// front ends (CLI, Discord, an agent chat) can watch the same turn while only one
// of them is allowed to prompt at a time. This is the smallest real step toward
// the fan-out described in docs/research/2026-11-13-session-fabric-fanout.md.
//
// Honest limits, deliberate:
// - Ordering is per hub process. There is no cross-process log.
// - The replay buffer is bounded, so a cursor older than the buffer is reported
//   as clipped rather than silently skipped.
// - One prompt is in flight at a time. A second submit is refused, not queued,
//   because Jcode offers no exclusive writer lease to fall back on.
import { ConfigError } from '../errors.js'

export type HubEvent =
  | { seq: number; type: 'session.started'; sessionId: string; model: string | null }
  | { seq: number; type: 'prompt.started'; characters: number }
  | { seq: number; type: 'prompt.chunk'; text: string }
  | { seq: number; type: 'prompt.finished'; stopReason: string; characters: number }
  | { seq: number; type: 'prompt.failed'; reason: string }

/** The slice of a backend the hub needs. JcodeBackend satisfies it. */
export type HubBackend = {
  start(input?: { model?: string }): Promise<{ sessionId: string; model: string | null } | Error>
  prompt(text: string, onChunk?: (text: string) => void): Promise<{ stopReason: string; text: string; updateCount: number } | Error>
  cancel(): Promise<Error | undefined>
  close(): Promise<void>
}

export type HubSnapshot = {
  sessionId: string | null
  model: string | null
  busy: boolean
  seq: number
  subscribers: number
}

export type HubSubscription = {
  /** Next cursor to pass on reconnect. */
  cursor: number
  /** True when the requested cursor predates the replay buffer. */
  clipped: boolean
  unsubscribe(): void
}

export const hubCapabilities = Object.freeze({
  multiClientStream: true,
  singleWriter: true,
  replayBuffer: true,
  crossProcessLog: false,
  exclusiveLease: false,
} as const)

export type SessionHub = {
  capabilities: typeof hubCapabilities
  start(): Promise<{ sessionId: string; model: string | null } | Error>
  submit(text: string): Promise<{ accepted: true; characters: number } | Error>
  cancel(): Promise<Error | undefined>
  subscribe(input: { cursor?: number; onEvent: (event: HubEvent) => void }): HubSubscription | Error
  snapshot(): HubSnapshot
  close(): Promise<void>
}

export function createSessionHub({
  backend,
  bufferLimit = 500,
  model,
}: {
  backend: HubBackend
  bufferLimit?: number
  model?: string
}): SessionHub | ConfigError {
  if (!Number.isSafeInteger(bufferLimit) || bufferLimit < 1) {
    return new ConfigError({ reason: 'Hub bufferLimit must be a positive integer' })
  }
  let seq = 0
  let started = false
  let busy = false
  let closed = false
  let sessionId: string | null = null
  let selectedModel: string | null = null
  const buffer: HubEvent[] = []
  const subscribers = new Set<{ deliver: (event: HubEvent) => void }>()

  const publish = (make: (seq: number) => HubEvent): HubEvent => {
    seq += 1
    const event = make(seq)
    buffer.push(event)
    while (buffer.length > bufferLimit) buffer.shift()
    for (const subscriber of subscribers) {
      try {
        subscriber.deliver(event)
      } catch {
        // A broken client must not stop the turn or the other clients.
        subscribers.delete(subscriber)
      }
    }
    return event
  }

  const start = async (): Promise<{ sessionId: string; model: string | null } | Error> => {
    if (closed) return new ConfigError({ reason: 'Hub is closed' })
    if (started && sessionId) return { sessionId, model: selectedModel }
    const result = await backend.start(model === undefined ? undefined : { model })
    if (result instanceof Error) return result
    started = true
    sessionId = result.sessionId
    selectedModel = result.model
    publish((value) => ({ seq: value, type: 'session.started', sessionId: result.sessionId, model: result.model }))
    return result
  }

  const snapshot = (): HubSnapshot => ({
    sessionId,
    model: selectedModel,
    busy,
    seq,
    subscribers: subscribers.size,
  })

  const subscribe = ({ cursor, onEvent }: { cursor?: number; onEvent: (event: HubEvent) => void }): HubSubscription | Error => {
    if (typeof onEvent !== 'function') return new ConfigError({ reason: 'Hub subscription needs an onEvent callback' })
    const wanted = cursor ?? 0
    if (!Number.isSafeInteger(wanted) || wanted < 0) return new ConfigError({ reason: 'Hub cursor must be a non-negative integer' })
    if (wanted > seq) return new ConfigError({ reason: 'Hub cursor is ahead of the stream' })
    const oldest = buffer.length > 0 ? buffer[0]!.seq : seq + 1
    const clipped = wanted + 1 < oldest
    const entry = { deliver: onEvent }
    // Replay before registering, so a slow replay cannot interleave with live events.
    for (const event of buffer) {
      if (event.seq > wanted) onEvent(event)
    }
    subscribers.add(entry)
    return {
      cursor: seq,
      clipped,
      unsubscribe: () => {
        subscribers.delete(entry)
      },
    }
  }

  const submit = async (text: string): Promise<{ accepted: true; characters: number } | Error> => {
    if (closed) return new ConfigError({ reason: 'Hub is closed' })
    if (typeof text !== 'string' || !text.trim()) return new ConfigError({ reason: 'Hub prompt text must be non-empty' })
    if (busy) return new ConfigError({ reason: 'A prompt is already running in this session' })
    const ready = await start()
    if (ready instanceof Error) return ready
    busy = true
    publish((value) => ({ seq: value, type: 'prompt.started', characters: text.length }))
    // The turn runs detached so callers can return immediately and watch events.
    void (async () => {
      try {
        const result = await backend.prompt(text, (chunk) => {
          publish((value) => ({ seq: value, type: 'prompt.chunk', text: chunk }))
        })
        if (result instanceof Error) {
          publish((value) => ({ seq: value, type: 'prompt.failed', reason: result.message }))
        } else {
          publish((value) => ({ seq: value, type: 'prompt.finished', stopReason: result.stopReason, characters: result.text.length }))
        }
      } finally {
        busy = false
      }
    })()
    return { accepted: true, characters: text.length }
  }

  const cancel = async (): Promise<Error | undefined> => {
    if (closed) return new ConfigError({ reason: 'Hub is closed' })
    if (!busy) return undefined
    return backend.cancel()
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    subscribers.clear()
    await backend.close()
  }

  return { capabilities: hubCapabilities, start, submit, cancel, subscribe, snapshot, close }
}
