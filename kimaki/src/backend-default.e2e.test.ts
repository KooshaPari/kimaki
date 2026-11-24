// Step 1.1 of docs/opencode-removal.md: a thread keeps resolving through the backend
// recorded in its `thread_sessions.backend` row, while new threads use the configured
// default. This file proves both halves against one bot's connections.
//
// What is end-to-end here: the row, the plan, the connection selection (startBot's own
// `startBotConnections`), and the per-thread resolution that `dispatch` now performs
// before its first OpenCode call. The jcode half drives the REAL binary through
// createJcodeBotBackend when one is installed.
//
// What is structural, and why: the OpenCode half cannot start the OpenCode test twin on
// this host — `node_modules/@opencode/cli/bin/opencode.exe` answers "cannot execute:
// required file not found" (missing loader), so `startOpencodeTestServer` cannot boot.
// The OpenCode connection is therefore a fake connection that records the calls made
// through it. That proves WHICH connection a legacy thread routes to and that the call
// reaches it; it does not prove that a real OpenCode service answers. The assertion is
// named `structural` in the test titles so a reader is never misled.

import { afterAll, expect, test } from 'vitest'

import type { Bot } from './bot.ts'
import { oc } from './bot.ts'
import { openDb } from './db.ts'
import { createBotStore } from './store.ts'
import type { BotConnectionCallbacks, BotConnections } from './main.ts'
import { startBotConnections } from './main.ts'
import type { JcodeBotConnection } from './backend/jcode-bot-backend.ts'
import { createJcodeBotBackend } from './backend/jcode-bot-backend.ts'
import type { OpenCodeClient, OpencodeConnection, OpencodeEndpoint } from './opencode-server.ts'
import {
  ThreadBackendUnavailableError,
  UnresolvedThreadBackendError,
  backendPlan,
  resolveThreadBackend,
  threadBackendsOf,
  withThreadBackend,
} from './thread-backend.ts'
import { removeDataDir } from './test/cleanup.ts'
import { findJcodeBinary } from './test/jcode-harness.ts'
import { seedJcodeSession, type SeededJcodeSession } from './test/jcode-seed.ts'
import { tempDataDir } from './test/harness.ts'

const dirs: string[] = []
const stopFns: (() => unknown)[] = []

afterAll(async () => {
  for (const stop of stopFns) await stop()
  for (const dir of dirs) await removeDataDir(dir)
})

// A deep callable proxy: every `client.a.b.c(x)` records "a.b.c" and resolves.
function recordingClient(calls: string[], pathParts: string[] = []): unknown {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === 'then') return undefined
      return recordingClient(calls, [...pathParts, String(property)])
    },
    apply: () => {
      calls.push(pathParts.join('.'))
      return Promise.resolve({ ok: true })
    },
  })
}

function fakeOpencodeConnection(calls: string[]): OpencodeConnection {
  const endpoint: OpencodeEndpoint = {
    client: recordingClient(calls) as OpenCodeClient,
    url: 'http://127.0.0.1:0',
    version: 'fake-structural',
  }
  return {
    kind: 'opencode',
    connected: true,
    endpoint,
    ready: Promise.resolve(endpoint),
    subscribe: () => () => {},
    stop: () => {},
  }
}

const noCallbacks = {
  ensure: false,
  onConnect: async () => {},
  onEvent: () => {},
  onDisconnect: () => {},
} as unknown as BotConnectionCallbacks

// A bot-shaped context: the resolver reads `store.threadBackends` and `backends` only.
function botContext({ backends, rows }: { backends: BotConnections['backends']; rows: { thread_id: string; backend: string }[] }): Bot {
  const store = createBotStore()
  store.setState({ threadBackends: threadBackendsOf(rows) })
  return { store, backends } as unknown as Bot
}

test('a persisted OpenCode row and a jcode default resolve to their own backends (structural: OpenCode twin cannot start on this host)', async () => {
  const calls: string[] = []
  const fakeOpencode = fakeOpencodeConnection(calls)
  let opencodeStarts = 0
  let jcodeStarts = 0
  const fakeJcode = { kind: 'jcode' as const } as unknown as JcodeBotConnection

  const connections = await startBotConnections(
    { backend: { kind: 'jcode' }, callbacks: noCallbacks, legacyOpencodeThreads: true },
    () => {
      opencodeStarts++
      return fakeOpencode
    },
    async () => {
      jcodeStarts++
      return fakeJcode
    },
  )
  if (connections instanceof Error) throw connections
  expect({ opencodeStarts, jcodeStarts }).toEqual({ opencodeStarts: 1, jcodeStarts: 1 })
  // The configured backend stays the primary, so OpenCode-only operations refuse by name.
  expect(connections.backends.jcode).toBe(fakeJcode)
  expect(connections.backends.opencode).toBe(fakeOpencode)

  // One bot, two threads: the legacy row was written before the column existed (its
  // default is 'opencode'), the new row is what bindThread writes for a jcode bot.
  const legacy = { thread_id: 'legacy-thread', backend: 'opencode' }
  const created = { thread_id: 'new-thread', backend: 'jcode' }
  const bot = botContext({ backends: connections.backends, rows: [legacy, created] })

  const legacyServed = withThreadBackend(bot, legacy.thread_id)
  expect(legacyServed.ok).toBe(true)
  if (!legacyServed.ok) throw legacyServed.error
  expect(legacyServed.backend).toBe('opencode')
  expect(legacyServed.bot.opencode).toBe(fakeOpencode)

  const newServed = withThreadBackend(bot, created.thread_id)
  expect(newServed.ok).toBe(true)
  if (!newServed.ok) throw newServed.error
  expect(newServed.backend).toBe('jcode')
  expect(newServed.bot.opencode).toBe(fakeJcode)

  // The routing is not just an identity: a call made through the served bot reaches the
  // OpenCode connection and not the jcode one.
  const answered = await oc(legacyServed.bot, 'session.prompt', (client) => (client as unknown as { session: { prompt: (input: unknown) => Promise<unknown> } }).session.prompt({ sessionID: 'ses_legacy' }))
  expect(answered).toBeDefined()
  expect(calls).toEqual(['session.prompt'])
})

test('a jcode-only bot starts no OpenCode connection and refuses a legacy row by name', async () => {
  let opencodeStarts = 0
  const fakeJcode = { kind: 'jcode' as const } as unknown as JcodeBotConnection
  const connections = await startBotConnections(
    { backend: { kind: 'jcode' }, callbacks: noCallbacks, legacyOpencodeThreads: false },
    () => {
      opencodeStarts++
      return fakeOpencodeConnection([])
    },
    async () => fakeJcode,
  )
  if (connections instanceof Error) throw connections
  expect(opencodeStarts).toBe(0)
  expect(connections.backends.opencode).toBe(null)

  const bot = botContext({ backends: connections.backends, rows: [{ thread_id: 'legacy-thread', backend: 'opencode' }, { thread_id: 'new-thread', backend: 'jcode' }] })
  const legacy = withThreadBackend(bot, 'legacy-thread')
  expect(legacy.ok).toBe(false)
  if (legacy.ok) throw new Error('a legacy row must not resolve without an OpenCode connection')
  expect(legacy.error).toBeInstanceOf(ThreadBackendUnavailableError)
  expect(legacy.error.message).toContain('did not start')

  const created = withThreadBackend(bot, 'new-thread')
  expect(created.ok && created.backend).toBe('jcode')
})

test('an unreadable row is a named error, never another backend', () => {
  const unknown = resolveThreadBackend({ threadId: 't', recorded: 'codex' })
  expect(unknown).toBeInstanceOf(UnresolvedThreadBackendError)
  expect((unknown as Error).message).toContain('"codex"')

  const missing = resolveThreadBackend({ threadId: 't2', recorded: undefined })
  expect(missing).toBeInstanceOf(UnresolvedThreadBackendError)

  const plan = backendPlan([
    { thread_id: 'a', backend: 'opencode' },
    { thread_id: 'b', backend: 'jcode' },
    { thread_id: 'c', backend: 'codex' },
  ])
  expect(plan).toMatchObject({ opencodeThreads: 1, jcodeThreads: 1, needsOpencode: true })
  expect(plan.unresolved).toEqual([{ threadId: 'c', backend: 'codex' }])
  expect(backendPlan([{ thread_id: 'b', backend: 'jcode' }]).needsOpencode).toBe(false)
})

test('a real database keeps a legacy row opencode and a bound row jcode', async () => {
  const dataDir = tempDataDir()
  dirs.push(dataDir)
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  try {
    // The shape a pre-column row has: no backend named, so the column default applies.
    opened.client.execute(`INSERT INTO thread_sessions (thread_id, session_id, source) VALUES ('legacy-thread', 'ses_1', 'kimaki')`)
    // The shape bindThread writes for a jcode bot.
    await opened.db.insert((await import('./schema.ts')).thread_sessions).values({ thread_id: 'new-thread', session_id: 'ses_2', source: 'kimaki', backend: 'jcode' })
    const rows = await opened.db.query.thread_sessions.findMany({ columns: { thread_id: true, backend: true } })
    expect(threadBackendsOf(rows)).toEqual({ 'legacy-thread': 'opencode', 'new-thread': 'jcode' })
    expect(backendPlan(rows).needsOpencode).toBe(true)
  } finally {
    opened.close()
  }
})

// The jcode half drives the real binary. Without one the resolution is still proven
// above; this test only adds "the connection the resolver returns is the real one".
const binary = findJcodeBinary()
const jcodeTest = binary === null ? test.skip : test

jcodeTest('the jcode connection a jcode row resolves to is the real one (end-to-end on the jcode side)', async () => {
  const seeded: SeededJcodeSession = await seedJcodeSession({ binary: binary as string, prompt: 'seed' })
  let created: Error | JcodeBotConnection | undefined
  try {
    created = await createJcodeBotBackend({
      binary: binary as string,
      home: seeded.home,
      sessionId: seeded.nativeId,
      onEvent: () => {},
    })
    if (created instanceof Error) throw created
    stopFns.push(() => (created as JcodeBotConnection).stop())
    const bot = botContext({ backends: { opencode: null, jcode: created }, rows: [{ thread_id: 'new-thread', backend: 'jcode' }] })
    const served = withThreadBackend(bot, 'new-thread')
    expect(served.ok).toBe(true)
    if (!served.ok) throw served.error
    expect(served.bot.opencode).toBe(created)
    expect(served.backend).toBe('jcode')
    // The jcode seam has no OpenCode endpoint: an OpenCode-only call fails by name
    // rather than being silently served by another backend.
    const refused = await oc(served.bot, 'session.get', (client) => client.session.get({ sessionID: seeded.nativeId }))
    expect(refused).toBeInstanceOf(Error)
  } finally {
    seeded.cleanup()
  }
}, 180_000)
