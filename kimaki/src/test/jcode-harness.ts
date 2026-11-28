// Jcode test harness: the counterpart of ./harness.ts for the jcode runtime.
//
// Each handle gets a throwaway data root with its own JCODE_HOME, so a test never
// reads or writes the developer's real ~/.jcode. The handle drives the real
// binary through the same path production uses: createJcodeBackend speaks ACP to
// `jcode acp`, and a SessionHub is the single writer over that backend.
//
// Honesty rule: when the binary is absent the handle still exists, but its
// `skipReason` names the exact reason and every turn method throws it. A harness
// that quietly passed instead would make every test built on it meaningless.
//
// Process ownership: the handle never enumerates processes. The only child is
// the one the ACP transport spawned for this handle, and close() stops it
// through the hub's own backend.close(), so a stray jcode on the host is never
// a candidate for the kill.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { createAcpClient } from '../backend/acp/client.ts'
import type { AcpClient, AcpClientOptions } from '../backend/acp/contracts.ts'
import { createJcodeBackend } from '../backend/jcode.ts'
import { createSessionHub, type HubEvent, type SessionHub } from '../backend/hub.ts'
import { removeTempDirs } from './cleanup.ts'

// Literal, assertable reason. Callers compare identity, not a substring.
export const JCODE_SKIP_NO_BINARY =
  'jcode binary not found at %LOCALAPPDATA%\\jcode\\bin\\jcode.exe (set JCODE_BIN instead)'

export const JCODE_SKIP_BY_OVERRIDE = 'jcode binary was disabled by the caller (binary: null)'

// The real native binary, never a shell wrapper. Same order as
// src/backend/hub.real-launch.test.ts so both lanes locate the same file.
export function findJcodeBinary(): string | null {
  const candidates = [
    process.env['JCODE_BIN'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'jcode', 'bin', 'jcode.exe'),
    path.join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', 'AppData', 'Local', 'jcode', 'bin', 'jcode.exe'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export type JcodeTestHub = {
  /** Throwaway root that holds the home and the project directory. */
  root: string
  /** Fresh JCODE_HOME for this handle, never the developer's ~/.jcode. */
  home: string
  projectDirectory: string
  binary: string | null
  /** Exact reason the handle cannot drive jcode, or null when it can. */
  skipReason: string | null
  /** Null only when skipReason is set. */
  hub: SessionHub | null
  /** Session ID the hub reported at launch, duplicated here for asserting. */
  sessionId: string | null
  /** Every hub event this handle has observed, in order. */
  events: HubEvent[]
  /** Submit one prompt and wait for its terminal event. */
  prompt(text: string): Promise<{ stopReason: string; text: string }>
  close(): Promise<void>
}

export type StartJcodeTestHubInput = {
  /**
   * Binary lookup seam. Omitted means auto-detect; an explicit path pins it;
   * null forces the missing-binary path so a test can assert the skip reason
   * even on a host that has the real binary installed.
   */
  binary?: string | null
  /** Per-prompt deadline handed to the ACP transport. */
  timeoutMs?: number
  /** Bound on waiting for the turn terminal event. */
  turnTimeoutMs?: number
}

const TERMINAL = new Set<HubEvent['type']>(['prompt.finished', 'prompt.failed'])

/**
 * Start a real jcode-backed hub in an isolated temp home.
 *
 * With no binary the returned handle has a non-null `skipReason` and no hub;
 * a launch failure is thrown rather than degraded to a skip, because a binary
 * that exists but cannot start is a real failure, not an absent prerequisite.
 */
export async function startJcodeTestHub(input: StartJcodeTestHubInput = {}): Promise<JcodeTestHub> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-')))
  const home = path.join(root, 'home')
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectDirectory, { recursive: true })

  const realHome = path.join(os.homedir(), '.jcode')
  if (path.resolve(home) === path.resolve(realHome)) {
    throw new Error(`jcode harness refused a temp home that resolves to the developer store (${realHome})`)
  }

  const binary = input.binary === undefined ? findJcodeBinary() : input.binary
  const events: HubEvent[] = []
  const opened: { hub: SessionHub | null; subscription: { unsubscribe(): void } | null } = { hub: null, subscription: null }
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    opened.subscription?.unsubscribe()
    opened.subscription = null
    // Only the child this handle spawned is reachable from here: the hub owns
    // it, and backend.close() stops exactly that transport.
    await opened.hub?.close()
    opened.hub = null
    await removeTempDirs([root])
  }

  if (binary === null) {
    const reason = input.binary === null ? JCODE_SKIP_BY_OVERRIDE : JCODE_SKIP_NO_BINARY
    return {
      root,
      home,
      projectDirectory,
      binary: null,
      skipReason: reason,
      hub: null,
      sessionId: null,
      events,
      prompt: async () => {
        throw new Error(reason)
      },
      close,
    }
  }

  const timeoutMs = input.timeoutMs ?? 120_000
  const turnTimeoutMs = input.turnTimeoutMs ?? 120_000

  // Isolation is enforced at the transport, not merely assumed: inherited
  // JCODE_* variables are dropped, then the temp home is set explicitly.
  const isolatedClient = (options: AcpClientOptions): AcpClient => {
    const inherited = Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(([key]) => !key.startsWith('JCODE_')),
    )
    return createAcpClient({
      ...options,
      env: { ...inherited, JCODE_HOME: home, JCODE_NO_TELEMETRY: '1' },
      timeoutMs: options.timeoutMs ?? timeoutMs,
    })
  }

  const backend = createJcodeBackend({
    binary,
    cwd: projectDirectory,
    store: home,
    profile: 'jcode',
    toolProfile: 'none',
    timeoutMs,
    createClient: isolatedClient,
  })

  const hub = createSessionHub({ backend })
  if (hub instanceof Error) throw hub
  opened.hub = hub
  const subscription = hub.subscribe({ onEvent: (event) => events.push(event) })
  if (subscription instanceof Error) {
    await close()
    throw subscription
  }
  opened.subscription = subscription

  const started = await hub.start()
  if (started instanceof Error) {
    await close()
    throw started
  }
  // The hub, not this handle, is the authority on identity; this only mirrors it.
  const sessionId = hub.snapshot().sessionId
  if (sessionId === null || sessionId !== started.sessionId) {
    await close()
    throw new Error(`jcode hub reported session ${String(sessionId)} but its launch named ${started.sessionId}`)
  }

  const prompt = async (text: string): Promise<{ stopReason: string; text: string }> => {
    if (closed) throw new Error('jcode test hub is closed')
    // Everything this turn produces carries a seq greater than the cursor, so a
    // previous turn's terminal event can never be mistaken for this one.
    const cursor = events.reduce((max, event) => Math.max(max, event.seq), 0)
    const accepted = await hub.submit(text)
    if (accepted instanceof Error) throw accepted
    const deadline = Date.now() + turnTimeoutMs
    while (Date.now() < deadline) {
      const seen = events.filter((event) => event.seq > cursor)
      const finished = [...seen].reverse().find((event) => TERMINAL.has(event.type))
      if (finished?.type === 'prompt.failed') throw new Error(`jcode turn failed: ${finished.reason}`)
      if (finished?.type === 'prompt.finished') {
        const reply = seen
          .filter((event): event is Extract<HubEvent, { type: 'prompt.chunk' }> => event.type === 'prompt.chunk')
          .map((event) => event.text)
          .join('')
        return { stopReason: finished.stopReason, text: reply }
      }
      await sleep(50)
    }
    throw new Error(`jcode turn did not finish within ${turnTimeoutMs}ms`)
  }

  return {
    root,
    home,
    projectDirectory,
    binary,
    skipReason: null,
    hub,
    sessionId,
    events,
    prompt,
    close,
  }
}
