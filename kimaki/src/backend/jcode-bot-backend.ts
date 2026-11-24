// The bot seam onto a native Jcode session, deliberately narrow.
//
// What this is: the object startBot hands to the event loop in place of
// `watchOpencode`. It projects four observer envelopes into the V2 event shape
// the reducer already consumes: the start of a turn (the user message before the
// reply), the end of the assistant message, the token_usage that message
// reported, and the end of the execution that produced it. Nothing else is
// invented: the observer reads a persisted record, and a persisted record
// carries no separate execution-start marker, no tool calls, no reasoning, no
// permissions and no forms. Those are named refusals here (see
// JCODE_BOT_NOT_PROJECTED), never plausible-looking filler events.
//
// What construction guarantees: the returned value is either a connection or a
// named Error. A missing binary, a binary that cannot answer `--version`, a
// store with no persisted session, an ambiguous store (several sessions and no
// explicit id), or a first read that is not settled all fail closed here. There
// is no fallback to OpenCode anywhere in this module, by design: a silent
// fallback would make a jcode test pass while exercising the OpenCode path.
//
// Dedupe is the observer's durable cursor, one file per session under an
// explicit `cursorDir` outside the Jcode store. Without that directory the seam
// still works within one process and records a named `durable-dedupe` refusal,
// because a restart would then re-emit turns.
//
// Approvals are the one thing a persisted record cannot carry: ACP asks the
// client driving the turn and waits. This seam owns an ACP connection only when
// the caller supplies a handler; without one it starts no child and keeps the
// historical drop. An approval is not a turn, so it is never a V2 event.
//
// Creation (`follow: 'create'`) is the one way in that does not start from an
// existing record. It mints a session over ACP on a home-pinned socket, then
// primes the record with one first turn (`createPrompt`), because the binary
// writes no session record until a turn runs. Only after that record settles
// does construction continue down the same path a follower takes: approvals
// attach, one settled read, the durable cursor. The priming turn is suppressed
// from the event stream, and a failed creation is a named error rather than a
// fallback to following some other session.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { OpenCodeClient, V2Event } from '@opencode/client'

import type { Backend, OpencodeEndpoint } from '../opencode-server.ts'
import { createAcpClient } from './acp/client.ts'
import type { AcpClient, AcpServerAnswerInput, AcpServerRequest, AcpServerRequestHandler, CreateAcpClient } from './acp/contracts.ts'
import { cancelJcodeTurn, type JcodeCancelOutcome } from './jcode-bot-cancel.ts'
import { JcodeBotBackendError, type JcodeBotRefusal } from './jcode-bot-error.ts'
import { botSocketPath, createJcodeBotWriter, type JcodeBotPromptInput, type JcodeBotPromptOutcome } from './jcode-bot-prompt.ts'
import { readConsistentRecord } from '../ops/runtime/jcode.ts'
import { createJcodeTurnObserver, recordAssistantTexts, type JcodeObservationLatency, type JcodeTurnEvent, type JcodeTurnHealth } from './jcode-observe.ts'

// The named failure and the refusal record live in their own module so the write
// path can construct the same error; they stay exported from here unchanged.
export { JcodeBotBackendError, type JcodeBotRefusal } from './jcode-bot-error.ts'
export { JCODE_BOT_NOT_PROJECTED, JCODE_BOT_NOT_PROJECTED_REASON, JCODE_BOT_PROJECTED_EVENTS } from './jcode-bot-not-projected.ts'
export type { JcodeBotPromptInput, JcodeBotPromptOutcome } from './jcode-bot-prompt.ts'

/** How long a `--version` probe may take before the binary counts as unstartable. */
const PROBE_TIMEOUT_MS = 20_000

/** How long a created session's record may take to appear before creation fails. */
const CREATE_PERSIST_TIMEOUT_MS = 60_000

/**
 * The backend part of StartBotOptions. One bot follows one persisted session.
 * `sessionId` may be omitted only when the store holds exactly one session.
 */
export type JcodeBotBackendSpec = {
  kind: 'jcode'
  binary?: string
  home?: string
  sessionId?: string
}

/** Construction and runtime knobs for one bot following one persisted session. */
export type JcodeBotBackendInput = {
  binary?: string
  /** Jcode home (`$JCODE_HOME`) or the parent of its `sessions` store. */
  home?: string
  /** Explicit native session id. Omitted: the store must hold exactly one. Refused with `follow: 'create'`. */
  sessionId?: string
  /**
   * How the seam obtains its session. `existing` (the default) follows a
   * persisted record exactly as before. `create` mints a new session over ACP
   * and primes its record with one first turn, because jcode writes no session
   * record until a turn runs (measured; see `createPrompt`).
   */
  follow?: 'existing' | 'create'
  /**
   * Text of the first turn a `follow: 'create'` construction runs. Required for
   * creation: ACP `session/new` mints an id but persists no record, and this
   * seam refuses to start a bot that follows nothing, so creation must prime
   * the record with a real turn. This turn is never emitted as an event.
   */
  createPrompt?: string
  /** Bound for a created session's record to settle. Default 60s. */
  createTimeoutMs?: number
  /** Durable cursor directory, outside the Jcode store. One file per session. */
  cursorDir?: string
  intervalMs?: number
  /** The bot's sink. Feeds the same callback watchOpencode uses. */
  onEvent: (event: V2Event) => void
  /** Surfaces permission requests over an ACP connection to `sessionId`; omitting it starts no child. */
  onApproval?: AcpServerRequestHandler
  /** Working directory for the session/load that attaches the approval connection. Required with `onApproval`. */
  cwd?: string
  approvalTimeoutMs?: number
  /** Provider for the write path's ACP connection; omitted keeps the agent's own config. */
  provider?: string
  /** Model for the write path's ACP connection; omitted keeps the agent's own config. */
  model?: string
  /** Tool profile for the write path. `none` keeps a turn text-only. */
  toolProfile?: 'none' | 'minimal' | 'full'
  /** Per-turn deadline for the write path. */
  promptTimeoutMs?: number
  /** Test seam: replace the ACP client factory used for the approval connection. */
  createApprovalClient?: CreateAcpClient
  /** Test seam: replace the ACP client factory used for the write path. */
  createPromptClient?: CreateAcpClient
  /** Test seam: replace the ACP client factory used by the creation path. */
  createCreateClient?: CreateAcpClient
  /** Test seams; production uses the real filesystem, clock and child process. */
  readFile?: (file: string) => Promise<string>
  now?: () => number
  random?: () => number
  probe?: (binary: string) => Promise<Error | void>
}

/** Approval surface of an owned ACP connection; absent without a handler. */
export type JcodeBotApprovals = {
  pending: () => AcpServerRequest[]
  /** The first answer wins; a repeat is refused by name. */
  answer: (input: AcpServerAnswerInput) => { requestId: number | string } | Error
}

/**
 * Structurally an OpencodeConnection, because that is what main.ts threads
 * through the bot. The OpenCode-only members are present but refuse: there is no
 * OpenCode endpoint behind a Jcode session.
 */
export type JcodeBotConnection = Backend & {
  readonly kind: 'jcode'
  readonly sessionId: string
  /**
   * The assistant text a `follow: 'create'` primer turn produced; null when
   * following, and null when the turn produced no text. The primer is suppressed
   * from the event stream, so this is the only way that reply reaches a caller.
   */
  readonly primerReply: string | null
  readonly connected: boolean
  readonly endpoint: OpencodeEndpoint | null
  readonly ready: Promise<Error | OpencodeEndpoint>
  subscribe: (listener: (event: V2Event) => void) => () => void
  stop: () => void
  health: () => JcodeTurnHealth
  latency: JcodeObservationLatency
  refusals: () => readonly JcodeBotRefusal[]
  /**
   * Run one turn over ACP. Returns what the agent reported and never emits: the
   * poller is the only emitter, so the turn reaches the bot exactly once.
   */
  prompt: (input: string | JcodeBotPromptInput) => Promise<JcodeBotPromptOutcome | Error>
  /** One deterministic observer read, so a caller can surface a just-finished turn. */
  flush: () => Promise<void>
  /**
   * Cancel the running turn over the seam's own ACP connection. Returns the
   * primitive's outcome or a named refusal; never emits an event.
   */
  cancel: () => Promise<JcodeCancelOutcome | JcodeBotBackendError>
  /** Present only when an approval handler was supplied. Surfaced to the caller, never emitted as an event. */
  approvals?: JcodeBotApprovals
}

const binaryCandidates = (explicit: string | undefined): string[] => {
  const candidates = [
    explicit,
    process.env['JCODE_BIN'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'jcode', 'bin', 'jcode.exe'),
    path.join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', 'AppData', 'Local', 'jcode', 'bin', 'jcode.exe'),
  ]
  return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
}

/**
 * The Jcode home a seam write is pinned to. Exported so a later turn on a thread
 * (jcode-thread.ts) reads the same store this backend was started with instead of
 * re-deriving a default that might name another one.
 */
export const resolveJcodeHome = (explicit: string | undefined): string =>
  (explicit ?? process.env['JCODE_HOME'] ?? path.join(os.homedir(), '.jcode')).trim()

/**
 * A binary exists and starts, or the reason is named. An explicit path that is
 * missing is an error, not a cue to look elsewhere: the caller asked for that
 * file. Exported so a turn on a thread resolves the same executable this backend
 * probed at start, rather than a bare `jcode` from PATH.
 */
export const resolveJcodeBinary = (explicit: string | undefined): string | JcodeBotBackendError => {
  // An explicit path is the caller's decision: a missing file is the answer, not
  // a cue to look for another runtime on the host.
  if (explicit !== undefined && explicit.trim() !== '') {
    return fs.existsSync(explicit)
      ? explicit
      : new JcodeBotBackendError({ stage: 'binary', reason: `no Jcode binary at ${explicit}` })
  }
  const candidates = binaryCandidates(explicit)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return new JcodeBotBackendError({
    stage: 'binary',
    reason: `no Jcode binary found; looked at ${candidates.length === 0 ? '(no candidates: set JCODE_BIN)' : candidates.join(', ')}`,
  })
}

const probeBinary = (binary: string): Promise<Error | void> =>
  new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: 'ignore', windowsHide: true })
    let settled = false
    const finish = (result: Error | void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      // Only the child this call spawned: never a process-name kill.
      child.kill('SIGKILL')
      finish(new JcodeBotBackendError({ stage: 'start', reason: `${binary} did not answer --version within ${PROBE_TIMEOUT_MS}ms` }))
    }, PROBE_TIMEOUT_MS)
    child.once('error', (cause) => {
      finish(new JcodeBotBackendError({ stage: 'start', reason: `${binary} could not be started`, cause }))
    })
    child.once('exit', (code) => {
      finish(code === 0 ? undefined : new JcodeBotBackendError({ stage: 'start', reason: `${binary} --version exited ${String(code)}` }))
    })
  })

/** Sessions the binary has persisted under `home/sessions`. */
const persistedSessions = (home: string): string[] => {
  const dir = path.join(home, 'sessions')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

const resolveSession = ({
  home,
  explicit,
}: {
  home: string
  explicit: string | undefined
}): string | JcodeBotBackendError => {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const sessions = persistedSessions(home)
  if (sessions.length === 1) return sessions[0]!
  if (sessions.length === 0) {
    return new JcodeBotBackendError({
      stage: 'session',
      reason: `no persisted session under ${path.join(home, 'sessions')}; the poller would await persistence forever, so this seam refuses to start`,
    })
  }
  return new JcodeBotBackendError({
    stage: 'session',
    reason: `${sessions.length} persisted sessions under ${path.join(home, 'sessions')} (${sessions.slice(0, 5).join(', ')}); pass an explicit sessionId instead of guessing`,
  })
}

// One consistency-checked read of a just-created record. `settled: true` also
// carries the assistant text the primer turn produced (the last assistant
// message, which for a freshly created session is the only one), or null when
// the turn produced none: the caller relays an answer only when there is text.
type SettledCreatedRecord = { settled: false } | { settled: true; primerReply: string | null }

const createdRecord = async (home: string, sessionId: string): Promise<SettledCreatedRecord> => {
  const file = path.join(home, 'sessions', `${sessionId}.json`)
  const read = await readConsistentRecord<{ sessionId: string; texts: { id: string; text: string }[] }>({
    file,
    readFile: (target) => fs.promises.readFile(target, 'utf8'),
    parse: (raw) => recordAssistantTexts(raw),
    accept: (value) => value.sessionId === sessionId,
  })
  if (read.health !== 'consistent') return { settled: false }
  const last = read.value.texts.at(-1)
  return { settled: true, primerReply: last === undefined ? null : last.text }
}

/**
 * Mint a new native session and prime its record with one first turn.
 *
 * Two measured facts shape this, both against the real binary:
 * * ACP `session/new` mints an id but writes nothing under `home/sessions`; the
 *   record appears only once a turn runs. So creation cannot perform the
 *   existing path's first settled read without that turn, and `createPrompt`
 *   is required rather than defaulted (a hidden model call is not a default).
 * * The daemon's store is the one its socket belongs to. Without `--socket` the
 *   session lands in the host's shared `~/.jcode` store, which this seam's
 *   observer (pointed at `home`) can never see. The socket is pinned outside
 *   `home` for the same reason the write path pins it: a socket inside the
 *   store was measured to keep turns from reaching `home/sessions/<id>.json`.
 *
 * The settled read also returns the primer turn's assistant text. The turn is
 * suppressed from the event stream, so without carrying its text out of this
 * function it would be lost: the caller has nothing else to relay to the user
 * who asked the question the primer is.
 */
const createSession = async (
  input: JcodeBotBackendInput,
  binary: string,
  home: string,
): Promise<{ sessionId: string; primerReply: string | null } | JcodeBotBackendError> => {
  const cwd = (input.cwd ?? '').trim()
  if (cwd === '') {
    return new JcodeBotBackendError({
      stage: 'create-cwd',
      reason: 'follow: create needs a cwd; ACP session/new is created in a working directory',
    })
  }
  if (input.sessionId !== undefined && input.sessionId.trim() !== '') {
    return new JcodeBotBackendError({
      stage: 'create-with-session',
      reason: `follow: create mints its own session, but an explicit sessionId (${input.sessionId}) was supplied; pass sessionId only with follow: existing`,
    })
  }
  const primer = (input.createPrompt ?? '').trim()
  if (primer === '') {
    return new JcodeBotBackendError({
      stage: 'create-primer',
      reason: `follow: create needs createPrompt: the binary mints a session id on ACP session/new but persists no record until a turn runs, and this seam refuses to start a bot that follows nothing`,
    })
  }

  let client: AcpClient
  try {
    client = (input.createCreateClient ?? createAcpClient)({
      command: binary,
      args: [
        'acp',
        '--tool-profile', 'none',
        '--socket', botSocketPath(home),
        ...(input.provider === undefined || input.provider.trim() === '' ? [] : ['-p', input.provider]),
        ...(input.model === undefined || input.model.trim() === '' ? [] : ['-m', input.model]),
      ],
      cwd,
    })
  } catch (cause) {
    return new JcodeBotBackendError({
      stage: 'create',
      reason: `could not create the ACP connection that mints a session in ${home}`,
      cause,
    })
  }

  let created: string
  try {
    const initialized = await client.initialize()
    if (initialized instanceof Error) {
      return new JcodeBotBackendError({
        stage: 'create-initialize',
        reason: `the ACP connection to ${binary} failed its initialize while minting a session`,
        cause: initialized,
      })
    }
    const session = await client.newSession({ cwd })
    if (session instanceof Error) {
      return new JcodeBotBackendError({
        stage: 'create-session',
        reason: `ACP session/new failed for ${cwd}`,
        cause: session,
      })
    }
    if (!session.sessionId?.trim()) {
      return new JcodeBotBackendError({ stage: 'create-session', reason: `ACP session/new returned an empty session id for ${cwd}` })
    }
    created = session.sessionId
    const turn = await client.prompt({
      sessionId: created,
      text: primer,
      ...(input.promptTimeoutMs === undefined ? {} : { timeoutMs: input.promptTimeoutMs }),
    })
    if (turn instanceof Error) {
      return new JcodeBotBackendError({
        stage: 'create-prompt',
        reason: `the first turn on created session ${created} did not complete, so it has no persisted record`,
        cause: turn,
      })
    }
  } finally {
    // The turn reaches `home/sessions/<id>.json` when the connection ends, not
    // when `session/prompt` answers (measured on the write path as well).
    await client.close()
  }

  const deadline = Date.now() + (input.createTimeoutMs ?? CREATE_PERSIST_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const read = await createdRecord(home, created)
    if (read.settled) return { sessionId: created, primerReply: read.primerReply }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  return new JcodeBotBackendError({
    stage: 'create-persist',
    reason: `created session ${created} never settled a record at ${path.join(home, 'sessions', `${created}.json`)}; the daemon's store is not the one this home names`,
  })
}

// The marker's client refuses every call. It is reachable only if a caller
// ignores `endpoint === null`; the refusal names the seam instead of reaching a
// real OpenCode service.
const refusingClient = (): OpenCodeClient =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (property === 'then') return undefined
      return () => {
        throw new JcodeBotBackendError({
          stage: 'endpoint',
          reason: `a Jcode session has no OpenCode endpoint; ${String(property)} is not available through this seam`,
        })
      }
    },
  }) as unknown as OpenCodeClient

// The ACP connection that carries approvals, owned only when a handler is
// supplied: the observer reads a persisted record and has no transport, so this
// seam must own one for an agent to have somewhere to ask. Initialize declares
// `serverRequests`; session/load makes the session this connection's to answer for.
const attachApprovals = async (input: JcodeBotBackendInput, binary: string, home: string, sessionId: string): Promise<{ client: AcpClient; approvals: JcodeBotApprovals } | JcodeBotBackendError> => {
  const workdir = (input.cwd ?? '').trim()
  if (workdir === '') return new JcodeBotBackendError({ stage: 'approvals', reason: 'an approval handler was supplied without a cwd; the ACP connection that carries approvals loads the session in a working directory' })
  let client: AcpClient
  try {
    client = (input.createApprovalClient ?? createAcpClient)({
      command: binary,
      // Same home-pinned socket as the write path, so approvals are asked by the
      // server that owns this session's store rather than the host's default daemon.
      args: ['acp', '--tool-profile', 'none', '--socket', path.join(home, 'bot-acp.sock')],
      cwd: workdir,
      ...(input.approvalTimeoutMs === undefined ? {} : { timeoutMs: input.approvalTimeoutMs }),
      serverRequests: { onRequest: input.onApproval! },
    })
  } catch (cause) {
    return new JcodeBotBackendError({ stage: 'approvals', reason: `could not create the ACP connection that carries approvals for ${sessionId}`, cause })
  }
  const initialized = await client.initialize()
  if (initialized instanceof Error) {
    await client.close()
    return new JcodeBotBackendError({ stage: 'approvals', reason: `the approval connection to ${binary} failed its ACP initialize`, cause: initialized })
  }
  const loaded = await client.loadSession({ sessionId, cwd: workdir })
  if (loaded instanceof Error) {
    await client.close()
    return new JcodeBotBackendError({ stage: 'approvals', reason: `the approval connection could not load session ${sessionId}`, cause: loaded })
  }
  return { client, approvals: { pending: () => client.pendingServerRequests(), answer: (answer) => client.answerServerRequest(answer) } }
}

/**
 * Build the bot's connection onto one persisted Jcode session.
 *
 * Resolves only after the first consistency-checked read proved the record
 * exists and is settled, so a bot that owns this connection always has a
 * session to follow. Every failure is a named JcodeBotBackendError.
 */
export async function createJcodeBotBackend(input: JcodeBotBackendInput): Promise<Error | JcodeBotConnection> {
  const home = resolveJcodeHome(input.home)
  if (home === '') return new JcodeBotBackendError({ stage: 'home', reason: 'Jcode home resolved to an empty path' })

  const binary = resolveJcodeBinary(input.binary)
  if (binary instanceof Error) return binary
  const probe = input.probe ?? probeBinary
  const started = await probe(binary)
  if (started instanceof Error) return started

  const mode = input.follow ?? 'existing'
  if (mode !== 'existing' && mode !== 'create') {
    return new JcodeBotBackendError({ stage: 'follow', reason: `unknown follow mode '${String(mode)}'; expected 'existing' or 'create'` })
  }
  // Creation mints its own session; following resolves or refuses one. The two
  // never mix: a create that failed must not quietly adopt an existing session.
  let sessionId: string
  // Only creation has one: a followed session's history belongs to whoever ran it.
  let primerReply: string | null = null
  if (mode === 'create') {
    const created = await createSession(input, binary, home)
    if (created instanceof Error) return created
    sessionId = created.sessionId
    primerReply = created.primerReply
  } else {
    const resolved = resolveSession({ home, explicit: input.sessionId })
    if (resolved instanceof Error) return resolved
    sessionId = resolved
  }

  const refusals: JcodeBotRefusal[] = []
  if (input.cursorDir === undefined) {
    refusals.push({
      name: 'durable-dedupe',
      reason: 'no cursorDir was supplied; a restart with the same session can re-emit turns it already delivered',
    })
  }
  const cursorFile = input.cursorDir === undefined ? undefined : path.join(input.cursorDir, `${sessionId}.json`)

  const emit = (event: JcodeTurnEvent): void => {
    // Both envelope types were written to mirror the V2 fields the reducer
    // reads. The cast is the boundary between the two id brands (EventID,
    // SessionID) and the observer's plain strings; it changes no value.
    input.onEvent(event as unknown as V2Event)
  }
  const project = (event: JcodeTurnEvent): void => {
    switch (event.type) {
      case 'session.text.ended':
      case 'session.step.ended':
      case 'session.execution.started':
      case 'session.execution.succeeded':
        emit(event)
        return
      default:
        // Unreachable for the observer's closed union. If it ever widens, refuse
        // the envelope instead of dropping it silently.
        throw new JcodeBotBackendError({
          stage: 'projection',
          reason: `the observer emitted ${(event as JcodeTurnEvent).type}, which this seam does not project`,
        })
    }
  }

  const observer = createJcodeTurnObserver({
    store: home,
    sessionId,
    intervalMs: input.intervalMs ?? 1_000,
    ...(cursorFile === undefined ? {} : { cursorFile }),
    // A created session's first turn was written by this construction, so it is
    // not news: the observer starts with existing history suppressed and the
    // durable cursor primed, exactly so a created bot does not re-post its own
    // priming turn.
    ...(mode === 'create' ? { emitExisting: false } : {}),
    autoStart: false,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.random === undefined ? {} : { random: input.random }),
    onEvent: project,
  })
  if (observer instanceof Error) return observer

  // One deterministic read before start: construction must not return a
  // connection whose session is not persisted yet.
  try {
    await observer.poll()
  } catch (cause) {
    observer.stop()
    return cause instanceof Error
      ? cause
      : new JcodeBotBackendError({ stage: 'session', reason: `the first read of ${sessionId} failed`, cause })
  }
  const health = observer.health()
  if (health.state === 'missing') {
    observer.stop()
    return new JcodeBotBackendError({
      stage: 'session-awaiting-persist',
      reason: `session ${sessionId} has no record at ${path.join(home, 'sessions', `${sessionId}.json`)} yet; the seam refuses to start a bot that follows nothing`,
    })
  }
  if (health.state !== 'consistent') {
    observer.stop()
    return new JcodeBotBackendError({
      stage: 'session',
      reason: `the first read of ${sessionId} was not settled (${health.state === 'transient' ? health.reason : health.state})`,
    })
  }
  if (observer.error()) {
    observer.stop()
    return observer.error()!
  }

  // No handler: no ACP child and the old shape. With one, the connection owns it.
  let approvalClient: AcpClient | null = null; let approvals: JcodeBotApprovals | undefined
  if (input.onApproval !== undefined) {
    const attached = await attachApprovals(input, binary, home, sessionId)
    if (attached instanceof Error) {
      observer.stop()
      return attached
    }
    approvalClient = attached.client
    approvals = attached.approvals
  }
  observer.start()

  // The write path is lazy: a caller that only observes reaches no ACP child. When
  // an approval child exists it is already initialized and loaded, so the turn
  // runs over it and its permission requests reach the same handler.
  let stopped = false
  let promptClient: AcpClient | null = approvalClient
  const writer = createJcodeBotWriter({
    home,
    sessionId,
    ...(approvalClient === null ? {} : { client: approvalClient }),
    binary,
    cwd: (input.cwd ?? '').trim(),
    ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.promptTimeoutMs === undefined ? {} : { timeoutMs: input.promptTimeoutMs }),
    ...(approvalClient === null
      ? {
          createClient: (options) => {
            const client = (input.createPromptClient ?? createAcpClient)(options)
            promptClient = client
            return client
          },
        }
      : input.createPromptClient === undefined
        ? {}
        : { createClient: input.createPromptClient }),
    closed: () => stopped,
  })

  const marker: OpencodeEndpoint = { client: refusingClient(), url: `jcode://${sessionId}`, version: 'jcode' }
  const refusalsOf = (): readonly JcodeBotRefusal[] => [...refusals]

  return {
    kind: 'jcode',
    sessionId,
    primerReply,
    get connected() {
      return observer.health().state !== 'stopped'
    },
    endpoint: null,
    // Resolves as soon as construction did; startBot's readiness join needs a
    // value, and the marker's client refuses every call.
    ready: Promise.resolve(marker),
    subscribe: () => {
      refusals.push({
        name: 'subscribe',
        reason:
          'catalog hints (agent/command/skill/model/provider updates) are not observable through a persisted session record; the listener is never invoked by this seam',
      })
      return () => undefined
    },
    stop: () => {
      stopped = true
      writer.close()
      observer.stop()
      // Closing the child ends every held request; an answer after this is gone.
      if (approvalClient) void approvalClient.close()
    },
    health: () => observer.health(),
    latency: observer.latency,
    refusals: refusalsOf,
    prompt: (turn) => writer.prompt(typeof turn === 'string' ? { text: turn } : turn),
    flush: () => observer.poll(),
    cancel: () =>
      cancelJcodeTurn({
        sessionId,
        client: approvalClient ?? promptClient,
        running: () => writer.busy(),
        closed: () => stopped,
      }),
    ...(approvals === undefined ? {} : { approvals }),
  }
}
