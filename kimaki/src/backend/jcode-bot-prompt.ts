// The write path onto a native Jcode session.
//
// The observer seam reads a persisted record and has no transport. This module
// owns the one ACP connection that can actually run a turn: `session/prompt`,
// which is the ACP call that correlates with a persisted turn (the observer later
// reads the same record the daemon writes for it). `session/load` replays an
// existing session's history and `session/new` mints a fresh id; neither writes a
// turn, so neither is the write path.
//
// It is constructed lazily. A caller that only observes never reaches this module,
// so a pure observer still starts no child. It also never emits an event: the
// poller is the single emitter, which is what keeps a prompt-then-observe cycle at
// exactly one emission of the completed turn.
//
// Every refusal is a named JcodeBotBackendError stage, never a fallback:
//   prompt-closed        the seam was stopped
//   prompt-in-flight     a prompt is already running on this connection
//   prompt-cwd           no working directory was configured for the connection
//   prompt-session       the session is not persisted, so the observer cannot follow it
//   prompt-binary        there is no executable to speak ACP to
//   prompt-initialize    initialize failed or the peer reported no session support
//   prompt-load          session/load was refused
//   prompt-instruction   the session instruction is over the bound
//   prompt-rejected      the agent refused or failed the turn

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { createAcpClient } from './acp/client.ts'
import type { AcpClient, AcpPromptResult, CreateAcpClient } from './acp/contracts.ts'
import { JcodeBotBackendError } from './jcode-bot-error.ts'
import { applyInstruction, INSTRUCTION_MARKER, planInstruction, type InstructionPlan } from './instructions.ts'

export type JcodeBotPromptInput = {
  text: string
  /**
   * The per-session instruction, delivered once as a labelled prefix on the first
   * prompt. Reuses instructions.ts: same normalisation, same digest, same bound.
   */
  instruction?: string
  /** Per-turn deadline handed to the ACP transport. */
  timeoutMs?: number
}

/** The turn as the agent reported it. Never an event: the poller owns emission. */
export type JcodeBotPromptOutcome = {
  sessionId: string
  stopReason: string
  text: string
  updateCount: number
  /** What happened to the instruction on this prompt, for the caller's report. */
  instruction: { kind: InstructionPlan['kind']; digest: string | null }
}

export type JcodeBotWriterOptions = {
  home: string
  sessionId: string
  /** An already-initialized client whose session is loaded (the approvals child). */
  client?: AcpClient
  binary: string
  cwd: string
  toolProfile?: 'none' | 'minimal' | 'full'
  provider?: string
  model?: string
  timeoutMs?: number
  /** Test seam: replace the ACP client factory for the prompt connection. */
  createClient?: CreateAcpClient
  /** True once the seam stopped; checked before and after every await. */
  closed: () => boolean
}

export type JcodeBotWriter = {
  prompt: (input: JcodeBotPromptInput) => Promise<JcodeBotPromptOutcome | Error>
  /** True while a prompt is on the wire; the second prompt is refused by name. */
  busy: () => boolean
  close: () => void
}

const DIGEST_IN_HISTORY = new RegExp(`${INSTRUCTION_MARKER} sha256=([0-9a-f]{16})`)

/**
 * The digest already injected into this session, read back from the history
 * `session/load` replayed. A delivery is durable because the transcript carries
 * the marker, not because this process remembers it.
 */
export function deliveredInstructionDigest(history: Array<{ role: string; text: string }>): string | null {
  for (const message of history) {
    if (message.role !== 'user') continue
    const match = DIGEST_IN_HISTORY.exec(message.text)
    if (match) return match[1]!
  }
  return null
}

/**
 * A socket path outside the Jcode store. It must not live inside `home`: the
 * server scans that directory, and a socket there was measured to keep the
 * prompt's turn from reaching `home/sessions/<id>.json`.
 */
export const botSocketPath = (home: string): string =>
  path.join(os.tmpdir(), `jcode-bot-acp-${crypto.createHash('sha1').update(path.resolve(home)).digest('hex').slice(0, 12)}.sock`)

const acpArgs = (options: JcodeBotWriterOptions): string[] => {
  // Pin the server socket to this home. Without it `jcode acp` dials the host's
  // default daemon, which owns a different store: the turn would run, but in a
  // session the observer following `home/sessions/<id>.json` can never see.
  const args = ['acp', '--tool-profile', options.toolProfile ?? 'none', '--socket', botSocketPath(options.home)]
  if (options.provider !== undefined && options.provider.trim() !== '') args.push('-p', options.provider)
  if (options.model !== undefined && options.model.trim() !== '') args.push('-m', options.model)
  return args
}

const sessionFile = (home: string, sessionId: string): string => path.join(home, 'sessions', `${sessionId}.json`)

/**
 * Own the one connection that can run a turn. Returns a writer; a caller that
 * never calls `prompt` never spawns a child.
 */
export function createJcodeBotWriter(options: JcodeBotWriterOptions): JcodeBotWriter {
  const shared = options.client
  let own: AcpClient | null = null
  let initialized = shared !== undefined
  let inFlight = false
  let closed = false
  // Seeded from history on the first own load; kept across turns thereafter.
  let deliveredDigest: string | null = null

  const fail = (stage: string, reason: string, cause?: unknown): JcodeBotBackendError =>
    cause === undefined ? new JcodeBotBackendError({ stage, reason }) : new JcodeBotBackendError({ stage, reason, cause })

  const ensureClient = async (): Promise<AcpClient | JcodeBotBackendError> => {
    if (shared) return shared
    if (own) return own
    if (options.binary.trim() === '') return fail('prompt-binary', 'no Jcode executable was resolved for the write path')
    if (!fs.existsSync(options.binary)) return fail('prompt-binary', `no Jcode executable at ${options.binary}`)
    const factory = options.createClient ?? createAcpClient
    let client: AcpClient
    try {
      client = factory({
        command: options.binary,
        args: acpArgs(options),
        cwd: options.cwd,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    } catch (cause) {
      return fail('prompt-initialize', `could not create the ACP connection for ${options.sessionId}`, cause)
    }
    own = client
    return client
  }

  const load = async (client: AcpClient): Promise<JcodeBotBackendError | void> => {
    if (initialized) return
    const start = await client.initialize()
    if (start instanceof Error) return fail('prompt-initialize', `the ACP connection to ${options.binary} failed its initialize`, start)
    const loaded = await client.loadSession({ sessionId: options.sessionId, cwd: options.cwd })
    if (loaded instanceof Error) return fail('prompt-load', `the ACP peer refused to load session ${options.sessionId}`, loaded)
    if (loaded.sessionId !== options.sessionId) {
      return fail('prompt-load', `the ACP peer loaded ${loaded.sessionId}, not the persisted ${options.sessionId}`)
    }
    if (loaded.history.length === 0) {
      // A load that replays nothing did not attach: the following prompt would run
      // in a fresh session the observer can never see. Refuse instead.
      return fail('prompt-load', `the ACP peer replayed no history for ${options.sessionId}, so it did not attach to the persisted session`)
    }
    deliveredDigest = deliveredInstructionDigest(loaded.history)
    initialized = true
  }

  const prompt = async (input: JcodeBotPromptInput): Promise<JcodeBotPromptOutcome | Error> => {
    if (closed || options.closed()) return fail('prompt-closed', 'the seam was stopped; the write path holds no connection')
    if (inFlight) return fail('prompt-in-flight', `a prompt is already running on ${options.sessionId}; this seam runs one turn at a time`)
    if (options.cwd.trim() === '') return fail('prompt-cwd', 'no working directory was configured for the turn')
    if (!fs.existsSync(sessionFile(options.home, options.sessionId))) {
      return fail('prompt-session', `session ${options.sessionId} is not persisted under ${sessionFile(options.home, options.sessionId)}; a turn it cannot follow would be invisible to the observer`)
    }
    inFlight = true
    try {
      const client = await ensureClient()
      if (client instanceof Error) return client
      const ready = await load(client)
      if (ready instanceof Error) return ready
      if (closed || options.closed()) return fail('prompt-closed', 'the seam was stopped while the write path was attaching')

      const plan = planInstruction({ instruction: input.instruction ?? '', deliveredDigest })
      if (plan.kind === 'rejected') return fail('prompt-instruction', plan.reason)
      const text = applyInstruction(plan, input.text)
      let result: AcpPromptResult | Error
      try {
        result = await client.prompt({
          sessionId: options.sessionId,
          text,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        })
      } catch (cause) {
        return fail('prompt-rejected', `the ACP peer threw while running a turn on ${options.sessionId}`, cause)
      }
      if (result instanceof Error) {
        if (closed || options.closed()) return fail('prompt-closed', 'the seam was stopped while a turn was running', result)
        return fail('prompt-rejected', `the ACP peer refused or failed the turn on ${options.sessionId}`, result)
      }
      if (plan.kind === 'prefix') deliveredDigest = plan.digest
      // Deliberately no emit: the poller is the one emitter, so this turn reaches
      // the bot exactly once, when the persisted record settles.
      // Measured on jcode 0.99.1227: the turn reaches `home/sessions/<id>.json`
      // when the connection ends, not when `session/prompt` answers. Close the
      // child we own and wait for it, so the poller sees the turn next read.
      // A client owned by the seam (which also carries approvals) is left alone.
      await releaseOwn()
      return {
        sessionId: options.sessionId,
        stopReason: result.stopReason,
        text: result.text,
        updateCount: result.updateCount,
        instruction: { kind: plan.kind, digest: plan.digest },
      }
    } finally {
      inFlight = false
    }
  }

  const releaseOwn = async (): Promise<void> => {
    const client = own
    own = null
    initialized = shared !== undefined
    if (client === null) return
    try {
      await client.close()
    } catch {
      // A close failure must not turn a completed turn into an error: the turn
      // already ran. Persistence is the poller's read on the next cycle.
    }
  }

  return {
    prompt,
    busy: () => inFlight,
    close: () => {
      if (closed) return
      closed = true
      // A shared client belongs to the seam (it also carries approvals); only a
      // connection created here is closed here.
      const client = own
      own = null
      if (client) void client.close()
    },
  }
}
