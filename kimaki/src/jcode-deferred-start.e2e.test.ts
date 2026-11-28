// Acceptance for the cold-install deferral (docs/opencode-removal.md, 1.1 residual).
//
// Five claims, each against the real code path:
//   1. an empty data dir and empty jcode home boot through `startBotConnections`
//      (the same function `startBot` calls), with no OpenCode connection and a
//      visible deferred notice;
//   2. a bot-connection operation that needs a session returns the named
//      `JcodeSessionDeferredError`, not a silent no-op;
//   3. after `bindJcodeSession` binds a thread, a real turn on that thread is
//      served (harness reused from jcode-thread.e2e.test.ts);
//   4. a home with one persisted session is still followed by that id;
//   5. an explicit id with no record still refuses with the current message.
//
// Cases 1 and 2 need no binary: defer is the "no binary, no session" path. Cases
// 3 and 4 drive the real jcode binary through the same harness the thread suite
// uses and skip when it is absent (case 5 needs the binary's --version probe).
// The fake OpenCode connection in case 1 is the seam's own structural twin; it
// records calls so the assertion can prove OpenCode was never started or used.

import fs from 'node:fs'
import path from 'node:path'

import type { OpenCodeClient, OpencodeConnection, OpencodeEndpoint } from './opencode-server.ts'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Bot } from './bot.ts'
import { JcodeBotBackendError, JcodeSessionDeferredError, createJcodeBotBackend, type JcodeBotConnection } from './backend/jcode-bot-backend.ts'
import { openDb, type OpenedDb } from './db.ts'
import { bindJcodeSession, serveJcodeTurn } from './jcode-thread.ts'
import { startBotConnections, type BotConnectionCallbacks } from './main.ts'
import { createBotStore } from './store.ts'
import { removeTempDir } from './test/cleanup.ts'
import { findJcodeBinary } from './test/jcode-harness.ts'
import { seedJcodeSession, startMockProvider, type MockProvider, type SeededJcodeSession } from './test/jcode-seed.ts'
import { withThreadBackend } from './thread-backend.ts'

const binary = findJcodeBinary()
const jcodeTest = binary === null ? test.skip : test

const roots: string[] = []
const stopped: JcodeBotConnection[] = []
afterAll(async () => {
  for (const connection of stopped) connection.stop()
  for (const root of roots) await removeTempDir(root).catch(() => {})
})

const noCallbacks = {
  ensure: false,
  onConnect: async () => {},
  onEvent: () => {},
  onDisconnect: () => {},
} as unknown as BotConnectionCallbacks

// A structural OpenCode twin: if any code starts or uses it, the counters show it.
function fakeOpencode(starts: { count: number }, calls: string[]): OpencodeConnection {
  starts.count += 1
  const client = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (property === 'then') return undefined
      return () => {
        calls.push(String(property))
        return Promise.resolve({ ok: true })
      }
    },
  })
  const endpoint: OpencodeEndpoint = { client: client as OpenCodeClient, url: 'http://127.0.0.1:0', version: 'fake' }
  return { kind: 'opencode', connected: true, endpoint, ready: Promise.resolve(endpoint), subscribe: () => () => {}, stop: () => {} }
}

test('(a) an empty data dir and empty jcode home boot deferred, with no OpenCode connection', async () => {
  const root = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'kimaki-deferred-start-'))
  roots.push(root)
  const home = path.join(root, 'empty-home')
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  expect(await opened.db.query.thread_sessions.findMany()).toEqual([])
  expect(fs.existsSync(path.join(home, 'sessions'))).toBe(false)
  const starts = { count: 0 }
  const calls: string[] = []
  // The real decision function and the real backend factory are used; only the
  // OpenCode twin is injected, to prove the cold start never reaches it.
  const connections = await startBotConnections(
    {
      backend: { kind: 'jcode', home },
      callbacks: noCallbacks,
      legacyOpencodeThreads: false,
      persistedSessions: [],
    },
    () => fakeOpencode(starts, calls),
  )
  if (connections instanceof Error) throw connections
  stopped.push(connections.primary as JcodeBotConnection)
  expect(starts.count).toBe(0)
  expect(calls).toEqual([])
  expect(connections.backendKind).toBe('jcode')
  expect(connections.backends.opencode).toBe(null)
  expect(connections.primary.kind).toBe('jcode')
  expect((connections.primary as JcodeBotConnection).sessionId).toBe(null)
  expect(connections.startupNotice).toMatch(/no persisted session/)
  expect(connections.startupNotice).toMatch(/thread creates its own session/)
  // The marker resolves: startBot's readiness join must not hang on a bot that
  // has deliberately no session.
  await expect(connections.primary.ready).resolves.toMatchObject({ url: 'jcode://deferred' })
}, 120_000)

test('(b) a session-needing connection call refuses by name with the reason', async () => {
  const root = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'kimaki-deferred-refusal-'))
  roots.push(root)
  const connection = await createJcodeBotBackend({ follow: 'defer', home: path.join(root, 'unused'), onEvent: () => {} })
  if (connection instanceof Error) throw connection
  stopped.push(connection)
  expect(connection.sessionId).toBe(null)
  expect(connection.endpoint).toBe(null)
  for (const [name, result] of [
    ['prompt', await connection.prompt('hello')],
    ['cancel', await connection.cancel()],
    ['flush', await connection.flush()],
  ] as const) {
    expect(result, name).toBeInstanceOf(JcodeSessionDeferredError)
    expect((result as Error).message, name).toMatch(/no session of its own/)
    expect((result as Error).message, name).toMatch(/thread binds|thread creates/)
  }
  const refused = connection.refusals()
  expect(refused.map((row) => row.name)).toContain('subscribe')
  expect(refused.map((row) => row.name)).toContain('endpoint')
  expect(refused.every((row) => row.reason.length > 0)).toBe(true)
})

describe('real-binary regression cases', () => {
  let root = ''
  let cwd = ''
  let dataDir = ''
  let opened: OpenedDb | null = null
  let seeded: SeededJcodeSession | null = null
  let mock: MockProvider | null = null
  let saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    mock = await startMockProvider()
    saved = {
      JCODE_HOME: process.env['JCODE_HOME'],
      JCODE_MODEL: process.env['JCODE_MODEL'],
      JCODE_PROVIDER: process.env['JCODE_PROVIDER'],
      JCODE_NO_TELEMETRY: process.env['JCODE_NO_TELEMETRY'],
      OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
      OPENAI_API_BASE: process.env['OPENAI_API_BASE'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    }
    root = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'kimaki-deferred-real-'))
    roots.push(root)
    cwd = path.join(root, 'cwd')
    fs.mkdirSync(cwd, { recursive: true })
    dataDir = path.join(root, 'data')
    const handle = await openDb({ dataDir, migrate: true })
    if (handle instanceof Error) throw handle
    opened = handle
    process.env['JCODE_HOME'] = path.join(root, 'env-home')
    delete process.env['JCODE_MODEL']
    delete process.env['JCODE_PROVIDER']
    process.env['OPENAI_BASE_URL'] = `${mock.url}/v1`
    process.env['OPENAI_API_BASE'] = `${mock.url}/v1`
    process.env['OPENAI_API_KEY'] = 'kimaki-deferred-test-key'
    process.env['JCODE_NO_TELEMETRY'] = '1'
  }, 120_000)

  afterAll(async () => {
    opened?.close()
    seeded?.cleanup()
    try {
      await mock?.close()
    } catch {
      /* provider connections are already destroyed */
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60_000)

  function bot(home: string, db: OpenedDb['db']): Bot {
    const store = createBotStore()
    store.setState({ roots: {}, threadBackends: {}, sessionThreads: {}, threads: {} })
    return {
      db,
      dataDir,
      backendKind: 'jcode' as const,
      jcodeStore: { binary, home },
      autoWorktrees: false,
      discord: { user: { id: 'bot-user' } },
      analytics: { track: () => {} },
      effects: { run: () => {} },
      store,
      eventLoop: { bind: async () => {} },
    } as unknown as Bot
  }

  jcodeTest('(c) after bindJcodeSession binds a thread, that thread\'s turn is served', async () => {
    const home = path.join(root, 'cold-home')
    fs.mkdirSync(home, { recursive: true })
    process.env['JCODE_HOME'] = home
    const bound = await bindJcodeSession(bot(home, opened!.db), {
      threadId: 'deferred-thread',
      channelId: 'deferred-channel',
      directory: cwd,
      primer: 'Reply with only: ok',
    })
    if (bound instanceof Error) throw bound
    expect(bound.reused).toBe(false)
    expect(bound.sessionId).toMatch(/^session_/)
    expect(fs.existsSync(path.join(home, 'sessions', `${bound.sessionId}.json`))).toBe(true)
    const row = await opened!.db.query.thread_sessions.findFirst({ where: { thread_id: 'deferred-thread' } })
    expect(row).toMatchObject({ session_id: bound.sessionId, backend: 'jcode' })

    // The bound thread resolves to a jcode connection, and a real second turn
    // over the recorded session produces the mock provider's answer.
    const boundBot = bot(home, opened!.db)
    const boundStore = createBotStore()
    boundStore.setState({ roots: { 'deferred-thread': bound.sessionId }, threadBackends: { 'deferred-thread': 'jcode' }, sessionThreads: { [bound.sessionId]: 'deferred-thread' }, threads: {} })
    const servingBot = { ...boundBot, store: boundStore, backends: { opencode: null, jcode: { kind: 'jcode' } as unknown as JcodeBotConnection } } as unknown as Bot
    const served = withThreadBackend(servingBot, 'deferred-thread')
    if (!served.ok) throw served.error
    const sent: string[] = []
    const servedBot = {
      ...served.bot,
      discord: {
        user: { id: 'bot-user' },
        channels: { fetch: async () => ({ id: 'deferred-thread', isThread: () => true, send: async (payload: { content: string }) => { sent.push(payload.content); return {} } }) },
      },
    } as unknown as Bot
    const turn = await serveJcodeTurn(servedBot, { threadId: 'deferred-thread', sessionId: bound.sessionId, directory: cwd, text: 'Reply with only: served' })
    if (turn instanceof Error) throw turn
    expect(turn.sessionId).toBe(bound.sessionId)
    expect(sent).toContain('ok')
    const record = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${bound.sessionId}.json`), 'utf8')) as { messages: unknown[] }
    expect(JSON.stringify(record.messages)).toContain('Reply with only: served')
  }, 300_000)

  jcodeTest('(d) a home holding one persisted session is still followed by that id', async () => {
    seeded = await seedJcodeSession({ binary: binary as string, prompt: 'Reply with only: seed' })
    const connections = await startBotConnections(
      {
        backend: { kind: 'jcode', home: seeded.home },
        callbacks: noCallbacks,
        legacyOpencodeThreads: false,
        persistedSessions: [seeded.nativeId],
      },
    )
    if (connections instanceof Error) throw connections
    stopped.push(connections.primary as JcodeBotConnection)
    expect((connections.primary as JcodeBotConnection).sessionId).toBe(seeded.nativeId)
    expect(connections.startupNotice).toBeUndefined()
    expect(connections.backends.opencode).toBe(null)
  }, 180_000)

  jcodeTest('(e) an explicit session id with no record still refuses with the current message', async () => {
    const missingId = 'session_does_not_exist'
    const result = await createJcodeBotBackend({
      binary: binary as string,
      home: path.join(root, 'empty-for-explicit'),
      sessionId: missingId,
      follow: 'existing',
      onEvent: () => {},
    })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    const error = result as JcodeBotBackendError
    expect(error.stage).toBe('session-awaiting-persist')
    expect(error.message).toContain(`session ${missingId} has no record`)
    expect(error.message).toContain('refuses to start a bot that follows nothing')
  }, 180_000)
})
