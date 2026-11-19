// Bot-facing turn observation over a persisted Jcode session.
//
// Jcode does not stream another client's turn: ACP routes `session/update` only
// to the connection that owns the active prompt, and `session/load` replays
// history rather than following new writes (`src/backend/acp/client.ts`). The
// shipped way to follow native input is polling (`kimaki ops jcode watch`). This
// module is that poller for the bot: it reads the session record the same way
// `observe()` in `src/ops/runtime/jcode.ts` does and emits the turn events the
// bot's reducer already understands.
//
// Contract, stated plainly:
//   * read-only: nothing here writes to the Jcode store or attaches as a writer.
//   * polling, not streaming: a turn is visible at most one poll interval plus
//     the consistency confirmation after the writer persists it. `latency`
//     exposes the bound so a user can be told nothing is streaming.
//   * deduplicated by the durable message ids Jcode writes, so a restart with
//     the same cursor re-emits nothing that was already delivered.
//   * a missing record or a torn read is a named health state, never a partial
//     turn. The consistency rule is imported, not reimplemented, from the
//     runtime observer.
//
// The emitted payload mirrors four OpenCode V2 envelopes (same field names the
// reducer reads) without importing its branded id types, so the bot can hand
// them straight to `reduce()`: `session.execution.started` (the last user
// message before the assistant reply is the only visible turn start),
// `session.text.ended`, `session.step.ended` (only when the record reports
// `token_usage`) and `session.execution.succeeded`. User prompts the bot did not
// send are never replayed as text; they are only the start marker.

import fs from 'node:fs'
import nodePath from 'node:path'

import { ConfigError } from '../errors.ts'
import {
  JCODE_CONSISTENCY_CONFIRM_DELAYS_MS,
  readConsistentRecord,
  type JcodeTransientReason,
} from '../ops/runtime/jcode.ts'

// Same field names as the V2 event the reducer consumes; `durable` carries the
// dedupe identity so a consumer can persist it verbatim if it wants to.
type JcodeEventDurable = { aggregateID: string; seq: number; version: 1 }

export type JcodeTurnEvent =
  | {
      type: 'session.execution.started'
      id: string
      durable: JcodeEventDurable
      created: number
      data: { sessionID: string }
    }
  | {
      type: 'session.text.ended'
      id: string
      durable: JcodeEventDurable
      created: number
      data: { sessionID: string; assistantMessageID: string; ordinal: number; text: string }
    }
  | {
      type: 'session.step.ended'
      id: string
      durable: JcodeEventDurable
      created: number
      data: {
        sessionID: string
        assistantMessageID: string
        finish: 'unknown'
        cost: 0
        tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
      }
    }
  | {
      type: 'session.execution.succeeded'
      id: string
      durable: JcodeEventDurable
      created: number
      data: { sessionID: string }
    }

// Named observation states. `consistent` only says the last read was provably
// settled; `transient` and `missing` say the observer claims nothing about the
// session right now and emitted no turn from that read.
export type JcodeTurnHealth =
  | { state: 'consistent'; lastPollAt: number; lastTurnId: string | null }
  | { state: 'transient'; reason: JcodeTransientReason; since: number; lastPollAt: number }
  | { state: 'missing'; since: number; lastPollAt: number }
  | { state: 'stopped'; lastPollAt: number }

// What the caller can tell a user about "nothing is streaming yet".
export type JcodeObservationLatency = {
  pollIntervalMs: number
  minPollIntervalMs: number
  maxPollIntervalMs: number
  // Extra time the consistency confirmation adds to every poll.
  confirmMs: number
}

export type JcodeTurnObserver = {
  readonly intervalMs: number
  readonly latency: JcodeObservationLatency
  health: () => JcodeTurnHealth
  delivered: () => string[]
  // One consistency-checked read. Exposed for deterministic callers and tests;
  // the scheduler calls it on its own boundary.
  poll: () => Promise<void>
  start: () => void
  stop: () => void
  done: Promise<void>
  error: () => Error | null
}

const CURSOR_VERSION = 1
// Bounds the durable cursor; old ids cannot be re-delivered by a poll anyway.
const MAX_DELIVERED = 5_000
const MIN_INTERVAL_MS = 25
const MAX_INTERVAL_MS = 3_600_000

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

// The usage the record reports for one assistant message. Zero for a key the
// provider did not report: the V2 token shape has no "absent".
type NativeUsage = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
type NativeMessage = { id: string; role: string; text: string; createdAt: number; usage: NativeUsage | null }

const firstNumber = (source: Record<string, unknown>, keys: readonly string[]): number => {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

// `token_usage` is a per-message object written by jcode; the key names are the
// ones measured on 0.99.1227 (`input_tokens`, `prompt_tokens`, ...). An absent
// object is not zero usage: it is no report at all, so no step is emitted.
const parseUsage = (entry: unknown): NativeUsage | null => {
  if (!record(entry)) return null
  return {
    input: firstNumber(entry, ['input_tokens', 'prompt_tokens']),
    output: firstNumber(entry, ['output_tokens']),
    reasoning: firstNumber(entry, ['reasoning_tokens']),
    cacheRead: firstNumber(entry, ['cache_read_input_tokens']),
    cacheWrite: firstNumber(entry, ['cache_creation_input_tokens', 'cache_write_input_tokens']),
  }
}
type NativeTurnRecord = { sessionId: string; messages: NativeMessage[] }

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => (record(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : []))
    .join('\n\n')
}

// Parse a session record into the ordered messages it holds. The id is checked
// by the consistency helper's `accept`, so a record for another session is
// `mismatch`, never a turn.
const parseRecord = (raw: string): NativeTurnRecord | undefined => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!record(value) || typeof value['id'] !== 'string' || !Array.isArray(value['messages'])) return undefined
  const messages: NativeMessage[] = []
  for (const entry of value['messages']) {
    if (!record(entry) || typeof entry['id'] !== 'string' || !entry['id']) continue
    const timestamp = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : Number.NaN
    messages.push({
      id: entry['id'],
      role: typeof entry['role'] === 'string' ? entry['role'] : '',
      text: textOf(entry['content']),
      createdAt: Number.isFinite(timestamp) ? timestamp : 0,
      usage: parseUsage(entry['token_usage']),
    })
  }
  return { sessionId: value['id'], messages }
}

const inside = (parent: string, child: string): boolean => {
  const relative = nodePath.relative(nodePath.resolve(parent), nodePath.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative))
}

export function createJcodeTurnObserver(options: {
  // Jcode home (`$JCODE_HOME`) or its sessions store's parent.
  store: string
  sessionId: string
  // Base poll interval. Jitter moves each delay inside ±jitterRatio of it.
  intervalMs?: number
  jitterRatio?: number
  // Durable delivered-id cursor. Must live outside the Jcode store so this
  // never writes into the session directory it reads. Without it, dedupe lasts
  // only for the life of this observer.
  cursorFile?: string
  // Ids already delivered by an earlier observer (merged with the cursor file).
  delivered?: Iterable<string>
  // Emit history present at the first poll. Default true: the bot must see a
  // turn another client started; the cursor is what stops a restart re-emitting.
  emitExisting?: boolean
  // Start polling immediately. Tests set false and call poll() themselves.
  autoStart?: boolean
  readFile?: (path: string) => Promise<string>
  signal?: AbortSignal
  random?: () => number
  now?: () => number
  onEvent: (event: JcodeTurnEvent) => Promise<void> | void
  onHealth?: (health: JcodeTurnHealth) => void
}): JcodeTurnObserver | ConfigError {
  const store = (options.store ?? '').trim()
  if (!store) return new ConfigError({ reason: 'Jcode turn observation needs an explicit store path' })
  const sessionId = (options.sessionId ?? '').trim()
  if (!sessionId) return new ConfigError({ reason: 'Jcode turn observation needs a session id' })
  const intervalMs = options.intervalMs ?? 2_000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return new ConfigError({ reason: `Jcode turn observation interval must be an integer between ${MIN_INTERVAL_MS}ms and ${MAX_INTERVAL_MS}ms` })
  }
  const jitterRatio = options.jitterRatio ?? 0.2
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.9) {
    return new ConfigError({ reason: 'Jcode turn observation jitter must be between 0 and 0.9' })
  }
  const cursorFile = options.cursorFile?.trim()
  if (cursorFile && inside(store, cursorFile)) {
    return new ConfigError({ reason: `Jcode delivered-id cursor must live outside the Jcode store (${cursorFile} is inside ${store}); the observer never writes into the store it reads` })
  }
  const readFile = options.readFile ?? ((file: string) => fs.promises.readFile(file, 'utf8'))
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const emitExisting = options.emitExisting ?? true
  const sessionsDir = `${store.replace(/[\\/]+$/, '')}/sessions`
  const file = `${sessionsDir}/${sessionId}.json`
  const confirmMs = JCODE_CONSISTENCY_CONFIRM_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)

  // Durable delivery ids. A cursor for another session is a refusal: reusing it
  // would either suppress real turns or replay delivered ones.
  const delivered = new Set<string>(options.delivered ?? [])
  if (cursorFile) {
    if (!fs.existsSync(cursorFile)) {
      // First run: nothing delivered yet.
    } else {
      let value: unknown
      try {
        value = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
      } catch (cause) {
        return new ConfigError({ reason: `Jcode delivered-id cursor ${cursorFile} is unreadable; refusing to re-emit or suppress turns blindly`, cause })
      }
      if (!record(value) || value['version'] !== CURSOR_VERSION || typeof value['sessionId'] !== 'string' || !Array.isArray(value['delivered'])) {
        return new ConfigError({ reason: `Jcode delivered-id cursor ${cursorFile} has an unknown shape` })
      }
      if (value['sessionId'] !== sessionId) {
        return new ConfigError({ reason: `Jcode delivered-id cursor ${cursorFile} belongs to session ${value['sessionId']}, not ${sessionId}` })
      }
      for (const id of value['delivered']) if (typeof id === 'string') delivered.add(id)
    }
  }

  const latency: JcodeObservationLatency = {
    pollIntervalMs: intervalMs,
    minPollIntervalMs: Math.max(1, Math.round(intervalMs * (1 - jitterRatio))),
    maxPollIntervalMs: Math.max(1, Math.round(intervalMs * (1 + jitterRatio))),
    confirmMs,
  }

  let health: JcodeTurnHealth = { state: 'consistent', lastPollAt: 0, lastTurnId: null }
  const emitHealth = (next: JcodeTurnHealth) => {
    health = next
    options.onHealth?.(next)
  }

  let stopped = false
  let started = false
  let primed = false
  let failure: Error | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const persist = (): void => {
    if (!cursorFile) return
    const trimmed = [...delivered].slice(-MAX_DELIVERED)
    // Sorted ids make the file reviewable and stable across runs.
    const body = JSON.stringify({ version: CURSOR_VERSION, sessionId, delivered: [...new Set(trimmed)].sort() })
    const temp = `${cursorFile}.${process.pid}.tmp`
    try {
      fs.mkdirSync(nodePath.dirname(cursorFile), { recursive: true })
      fs.writeFileSync(temp, body)
      fs.renameSync(temp, cursorFile)
    } catch (error) {
      // A cursor failure must not lose a turn already delivered; it only costs
      // a possible re-emit after a restart. Report through the health surface.
      fs.rmSync(temp, { force: true })
      process.stderr.write(`jcode observe: cannot persist cursor ${cursorFile}: ${String(error)}\n`)
    }
  }

  const plan = (recordValue: NativeTurnRecord): JcodeTurnEvent[] => {
    const events: JcodeTurnEvent[] = []
    // Events this pass already planned. readOnce marks them delivered only after
    // each one is emitted, so a duplicated record row needs its own guard.
    const planned = new Set<string>()
    let ordinal = 0
    // The turn start a record can prove: the last user message before the reply.
    let lastUser: { id: string; ordinal: number; createdAt: number } | null = null
    for (const message of recordValue.messages) {
      ordinal += 1
      if (message.role === 'user') {
        lastUser = { id: message.id, ordinal, createdAt: message.createdAt }
        continue
      }
      const text = message.text.trim()
      if (message.role !== 'assistant' || !text) continue
      // One start per user prompt, placed before the reply it produced. A record
      // with no user message (a handcrafted or truncated one) proves no start,
      // so no start is invented for it.
      if (lastUser !== null) {
        const startedKey = `${sessionId}/${lastUser.id}:started`
        if (!delivered.has(startedKey) && !planned.has(startedKey)) {
          planned.add(startedKey)
          events.push({
            type: 'session.execution.started',
            id: `${lastUser.id}:started`,
            durable: { aggregateID: sessionId, seq: lastUser.ordinal, version: 1 },
            created: lastUser.createdAt,
            data: { sessionID: sessionId },
          })
        }
      }
      const textKey = `${sessionId}/${message.id}:text`
      if (!delivered.has(textKey)) {
        events.push({
          type: 'session.text.ended',
          id: `${message.id}:text`,
          durable: { aggregateID: sessionId, seq: ordinal, version: 1 },
          created: message.createdAt,
          data: { sessionID: sessionId, assistantMessageID: message.id, ordinal, text },
        })
      }
      // Only when the record reports usage. Its presence is the evidence that a
      // step ran; an absent object is not a zero-token step.
      if (message.usage !== null) {
        const stepKey = `${sessionId}/${message.id}:step`
        if (!delivered.has(stepKey) && !planned.has(stepKey)) {
          planned.add(stepKey)
          events.push({
            type: 'session.step.ended',
            id: `${message.id}:step`,
            durable: { aggregateID: sessionId, seq: ordinal, version: 1 },
            created: message.createdAt,
            data: {
              sessionID: sessionId,
              assistantMessageID: message.id,
              finish: 'unknown',
              cost: 0,
              tokens: {
                input: message.usage.input,
                output: message.usage.output,
                reasoning: message.usage.reasoning,
                cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
              },
            },
          })
        }
      }
      const doneKey = `${sessionId}/${message.id}:done`
      if (!delivered.has(doneKey)) {
        events.push({
          type: 'session.execution.succeeded',
          id: `${message.id}:done`,
          durable: { aggregateID: sessionId, seq: ordinal, version: 1 },
          created: message.createdAt,
          data: { sessionID: sessionId },
        })
      }
    }
    return events
  }

  const readOnce = async (): Promise<void> => {
    if (stopped) return
    const read = await readConsistentRecord<NativeTurnRecord>({
      file,
      readFile,
      parse: parseRecord,
      accept: (value) => value.sessionId === sessionId,
    })
    const at = now()
    if (read.health === 'missing') {
      emitHealth({ state: 'missing', since: health.state === 'missing' ? health.since : at, lastPollAt: at })
      return
    }
    if (read.health === 'transient') {
      // A torn record is never a turn: nothing is emitted and the observer
      // claims nothing about the session until a settled read returns.
      emitHealth({ state: 'transient', reason: read.reason, since: health.state === 'transient' ? health.since : at, lastPollAt: at })
      return
    }
    const events = plan(read.value)
    if (!primed && !emitExisting) {
      for (const event of events) delivered.add(`${sessionId}/${event.id}`)
      primed = true
      persist()
      emitHealth({ state: 'consistent', lastPollAt: at, lastTurnId: null })
      return
    }
    primed = true
    let lastTurnId = health.state === 'consistent' ? health.lastTurnId : null
    let emitted = false
    for (const event of events) {
      if (stopped) return
      await options.onEvent(event)
      delivered.add(`${sessionId}/${event.id}`)
      emitted = true
      if (event.type === 'session.text.ended') lastTurnId = `${sessionId}/${event.id}`
    }
    if (emitted) persist()
    emitHealth({ state: 'consistent', lastPollAt: at, lastTurnId })
  }

  const poll = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = readOnce().finally(() => { inFlight = null })
    return inFlight
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    emitHealth({ state: 'stopped', lastPollAt: health.lastPollAt })
    resolveDone()
  }

  const nextDelay = (): number => {
    const spread = Math.round(intervalMs * jitterRatio * (random() * 2 - 1))
    return Math.min(latency.maxPollIntervalMs, Math.max(latency.minPollIntervalMs, intervalMs + spread))
  }

  const cycle = (): void => {
    timer = null
    void poll()
      .catch((error) => {
        failure = error instanceof Error ? error : new Error(String(error))
        stop()
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(cycle, nextDelay())
      })
  }

  const start = (): void => {
    if (started || stopped) return
    started = true
    cycle()
  }

  if (options.signal) {
    if (options.signal.aborted) stop()
    else options.signal.addEventListener('abort', stop, { once: true })
  }
  if (options.autoStart ?? true) start()

  return {
    intervalMs,
    latency,
    health: () => health,
    delivered: () => [...delivered].sort(),
    poll,
    start,
    stop,
    done,
    error: () => failure,
  }
}
