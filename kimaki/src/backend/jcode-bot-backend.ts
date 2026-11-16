// The bot seam onto a native Jcode session, deliberately narrow.
//
// What this is: the object startBot hands to the event loop in place of
// `watchOpencode`. It projects exactly two observer envelopes - the end of an
// assistant message and the end of the execution that produced it - into the
// V2 event shape the reducer already consumes. Nothing else is invented: the
// observer reads a persisted record, and a persisted record carries no
// execution-start marker, no tool calls, no reasoning, no permissions and no
// forms. Those are named refusals here (see JCODE_BOT_NOT_PROJECTED), never
// plausible-looking filler events.
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

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as errore from 'errore'
import type { OpenCodeClient, V2Event } from '@opencode/client'

import type { OpencodeEndpoint } from '../opencode-server.ts'
import { createJcodeTurnObserver, type JcodeObservationLatency, type JcodeTurnEvent, type JcodeTurnHealth } from './jcode-observe.ts'

/** How long a `--version` probe may take before the binary counts as unstartable. */
const PROBE_TIMEOUT_MS = 20_000

export class JcodeBotBackendError extends errore.createTaggedError({
  name: 'JcodeBotBackendError',
  message: 'Jcode bot backend $stage failed: $reason',
}) {}

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

/** A capability the observer cannot supply, recorded rather than faked. */
export type JcodeBotRefusal = {
  name: 'subscribe' | 'durable-dedupe' | 'endpoint'
  reason: string
}

/**
 * Every V2 event type this seam does NOT project. The list is exhaustive for the
 * client's union except the two projected above; it is exported so a caller can
 * state the gap instead of discovering it from missing output.
 */
export const JCODE_BOT_PROJECTED_EVENTS = ['session.text.ended', 'session.execution.succeeded'] as const

export const JCODE_BOT_NOT_PROJECTED = [
  'location.shutdown',
  'models.dev.refreshed',
  'credential.updated',
  'credential.switched',
  'integration.updated',
  'provider.updated',
  'model.updated',
  'agent.updated',
  'session.created',
  'session.agent.selected',
  'session.model.selected',
  'session.moved',
  'session.renamed',
  'session.metadata.updated',
  'session.permissions',
  'session.viewed',
  'session.usage.updated',
  'session.deleted',
  'session.forked',
  'session.inbox.delivered',
  'session.inbox.enqueued',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.execution.started',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.instructions.updated',
  'session.synthetic',
  'session.skill.activated',
  'session.shell.started',
  'session.shell.ended',
  'session.step.started',
  'session.step.streamed',
  'session.step.ended',
  'session.step.failed',
  'session.text.started',
  'session.text.delta',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.retry.scheduled',
  'session.compaction.started',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'filesystem.changed',
  'reference.updated',
  'permission.asked',
  'permission.replied',
  'plugin.updated',
  'project.updated',
  'worktree.updated',
  'worktree.resolved',
  'command.updated',
  'config.updated',
  'skill.updated',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'persistent.pty.added',
  'persistent.pty.removed',
  'shell.created',
  'shell.exited',
  'shell.deleted',
  'form.created',
  'form.replied',
  'form.cancelled',
  'websearch.updated',
  'session.status.updated',
  'session.idle',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'tui.session.select',
  'installation.updated',
  'installation.update.available',
  'vcs.branch.updated',
  'mcp.status.changed',
  'mcp.resources.changed',
  'server.connected',
] as const

/** Why exactly these types are absent, in one place for the report. */
export const JCODE_BOT_NOT_PROJECTED_REASON =
  'A persisted Jcode record holds messages only. It carries no execution-start marker, no tool/reasoning/step records, no permission or form requests and no catalog hints, so this seam emits nothing for those types rather than synthesizing them.'

export type JcodeBotBackendInput = {
  binary?: string
  /** Jcode home (`$JCODE_HOME`) or the parent of its `sessions` store. */
  home?: string
  /** Explicit native session id. Omitted: the store must hold exactly one. */
  sessionId?: string
  /** Durable cursor directory, outside the Jcode store. One file per session. */
  cursorDir?: string
  intervalMs?: number
  /** The bot's sink. Feeds the same callback watchOpencode uses. */
  onEvent: (event: V2Event) => void
  /** Test seams; production uses the real filesystem, clock and child process. */
  readFile?: (file: string) => Promise<string>
  now?: () => number
  random?: () => number
  probe?: (binary: string) => Promise<Error | void>
}

/**
 * Structurally an OpencodeConnection, because that is what main.ts threads
 * through the bot. The OpenCode-only members are present but refuse: there is no
 * OpenCode endpoint behind a Jcode session.
 */
export type JcodeBotConnection = {
  readonly kind: 'jcode'
  readonly sessionId: string
  readonly connected: boolean
  readonly endpoint: OpencodeEndpoint | null
  readonly ready: Promise<Error | OpencodeEndpoint>
  subscribe: (listener: (event: V2Event) => void) => () => void
  stop: () => void
  health: () => JcodeTurnHealth
  latency: JcodeObservationLatency
  refusals: () => readonly JcodeBotRefusal[]
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
 * A binary exists and starts, or the reason is named. An explicit path that is
 * missing is an error, not a cue to look elsewhere: the caller asked for that
 * file.
 */
const resolveBinary = (explicit: string | undefined): string | JcodeBotBackendError => {
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

/**
 * Build the bot's connection onto one persisted Jcode session.
 *
 * Resolves only after the first consistency-checked read proved the record
 * exists and is settled, so a bot that owns this connection always has a
 * session to follow. Every failure is a named JcodeBotBackendError.
 */
export async function createJcodeBotBackend(input: JcodeBotBackendInput): Promise<Error | JcodeBotConnection> {
  const home = (input.home ?? process.env['JCODE_HOME'] ?? path.join(os.homedir(), '.jcode')).trim()
  if (home === '') return new JcodeBotBackendError({ stage: 'home', reason: 'Jcode home resolved to an empty path' })

  const binary = resolveBinary(input.binary)
  if (binary instanceof Error) return binary
  const probe = input.probe ?? probeBinary
  const started = await probe(binary)
  if (started instanceof Error) return started

  const sessionId = resolveSession({ home, explicit: input.sessionId })
  if (sessionId instanceof Error) return sessionId

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
  observer.start()

  const marker: OpencodeEndpoint = { client: refusingClient(), url: `jcode://${sessionId}`, version: 'jcode' }
  const refusalsOf = (): readonly JcodeBotRefusal[] => [...refusals]

  return {
    kind: 'jcode',
    sessionId,
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
    stop: () => observer.stop(),
    health: () => observer.health(),
    latency: observer.latency,
    refusals: refusalsOf,
  }
}
