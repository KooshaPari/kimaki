// One backend session, many clients.
//
// A hub owns exactly one backend session and is the only writer. Clients attach
// as subscribers with a cursor and receive an ordered event stream, so several
// front ends (CLI, Discord, an agent chat) can watch the same turn while only one
// of them is allowed to prompt at a time.
//
// Durability, when a log path is supplied:
// - every event is appended to a JSONL file before it is handed to subscribers
// - a new hub restores its sequence and replay window from that file
// - a cursor older than the in-memory window replays from the file instead of
//   being silently clipped
// - a lease file keeps two hubs from writing the same session at once
//
// Honest limits, deliberate:
// - Ordering is per hub process, and appends are synchronous, so throughput is
//   local-file bound rather than a database.
// - The lease is advisory. It stops a second hub that honors it, not a foreign
//   process that ignores the file.
// - One prompt is in flight at a time. A second submit is refused, not queued,
//   because Jcode offers no exclusive writer lease of its own.
import fs from 'node:fs'
import path from 'node:path'
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
  durable: boolean
}

export type HubSubscription = {
  /** Next cursor to pass on reconnect. */
  cursor: number
  /** True when the requested cursor predates every source the hub can read. */
  clipped: boolean
  /** Where the replayed events came from. */
  source: 'none' | 'buffer' | 'log'
  unsubscribe(): void
}

export const hubCapabilities = Object.freeze({
  multiClientStream: true,
  singleWriter: true,
  replayBuffer: true,
  durableLog: true,
  writerLease: true,
  crossProcessLog: false,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const parseEvent = (line: string): HubEvent | undefined => {
  try {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value) || typeof value['seq'] !== 'number' || typeof value['type'] !== 'string') return undefined
    return value as HubEvent
  } catch {
    return undefined
  }
}

function readLog(logFile: string): HubEvent[] {
  let text: string
  try {
    text = fs.readFileSync(logFile, 'utf8')
  } catch {
    return []
  }
  const events: HubEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const event = parseEvent(line)
    // A torn or hand-edited line is skipped rather than failing the whole replay.
    if (event) events.push(event)
  }
  return events
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function acquireLease(leaseFile: string): ConfigError | undefined {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  try {
    fs.mkdirSync(path.dirname(leaseFile), { recursive: true })
    fs.writeFileSync(leaseFile, payload, { flag: 'wx' })
    return undefined
  } catch (cause) {
    let holder: unknown
    try {
      holder = JSON.parse(fs.readFileSync(leaseFile, 'utf8'))
    } catch {
      holder = undefined
    }
    const pid = isRecord(holder) && typeof holder['pid'] === 'number' ? holder['pid'] : undefined
    // A live holder always wins, including another hub inside this same process.
    // Only a dead pid, or an unreadable lease file, may be taken over.
    if (pid !== undefined && pidAlive(pid)) {
      return new ConfigError({ reason: `Another hub holds this session lease (pid ${pid})` })
    }
    try {
      fs.writeFileSync(leaseFile, payload)
      return undefined
    } catch (takeoverCause) {
      return new ConfigError({ reason: 'Cannot take over a stale hub lease', cause: takeoverCause ?? cause })
    }
  }
}

export function createSessionHub({
  backend,
  bufferLimit = 500,
  model,
  logFile,
  leaseFile,
}: {
  backend: HubBackend
  bufferLimit?: number
  model?: string
  /** Append-only JSONL event log. Enables durability and resume across restarts. */
  logFile?: string
  /** Advisory writer lease. Defaults to `<logFile>.lock` when a log is configured. */
  leaseFile?: string
}): SessionHub | ConfigError {
  if (!Number.isSafeInteger(bufferLimit) || bufferLimit < 1) {
    return new ConfigError({ reason: 'Hub bufferLimit must be a positive integer' })
  }
  const leasePath = leaseFile ?? (logFile === undefined ? undefined : `${logFile}.lock`)
  if (leasePath !== undefined) {
    const leased = acquireLease(leasePath)
    if (leased instanceof Error) return leased
  }

  const restored = logFile === undefined ? [] : readLog(logFile)
  let seq = restored.length > 0 ? restored[restored.length - 1]!.seq : 0
  const buffer: HubEvent[] = restored.slice(-bufferLimit)
  let started = false
  let busy = false
  let closed = false
  let sessionId: string | null = null
  let selectedModel: string | null = null
  const subscribers = new Set<{ deliver: (event: HubEvent) => void }>()

  // A restored log means the session may already exist; reuse its identity.
  for (const event of restored) {
    if (event.type === 'session.started') {
      started = true
      sessionId = event.sessionId
      selectedModel = event.model
    }
  }

  const persist = (event: HubEvent): void => {
    if (logFile === undefined) return
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${JSON.stringify(event)}\n`)
    } catch {
      // Losing the log must not break a live turn; the stream still flows.
    }
  }

  const publish = (make: (seq: number) => HubEvent): HubEvent => {
    seq += 1
    const event = make(seq)
    persist(event)
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
    durable: logFile !== undefined,
  })

  const subscribe = ({ cursor, onEvent }: { cursor?: number; onEvent: (event: HubEvent) => void }): HubSubscription | Error => {
    if (typeof onEvent !== 'function') return new ConfigError({ reason: 'Hub subscription needs an onEvent callback' })
    const wanted = cursor ?? 0
    if (!Number.isSafeInteger(wanted) || wanted < 0) return new ConfigError({ reason: 'Hub cursor must be a non-negative integer' })
    if (wanted > seq) return new ConfigError({ reason: 'Hub cursor is ahead of the stream' })
    const oldest = buffer.length > 0 ? buffer[0]!.seq : seq + 1
    const needsDisk = wanted + 1 < oldest
    let source: HubSubscription['source'] = 'none'
    let clipped = false

    // Replay oldest first: the log covers what the buffer dropped, then the
    // buffer covers the rest, so subscribers always see ascending sequence
    // numbers. Everything replays before registering, so a slow replay cannot
    // interleave with live events.
    if (needsDisk) {
      if (logFile === undefined) {
        clipped = true
      } else {
        for (const event of readLog(logFile)) {
          if (event.seq > wanted && event.seq < oldest) {
            onEvent(event)
            source = 'log'
          }
        }
      }
    }
    for (const event of buffer) {
      if (event.seq > wanted) {
        onEvent(event)
        if (source === 'none') source = 'buffer'
      }
    }

    const entry = { deliver: onEvent }
    subscribers.add(entry)
    return {
      cursor: seq,
      clipped,
      source,
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
    if (leasePath !== undefined) {
      try {
        fs.rmSync(leasePath, { force: true })
      } catch {
        // A lease we cannot remove is reported by the next hub, not swallowed here.
      }
    }
  }

  return { capabilities: hubCapabilities, start, submit, cancel, subscribe, snapshot, close }
}
