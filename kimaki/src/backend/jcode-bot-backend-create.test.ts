// Creation on the bot's Jcode seam: a bot that has no session yet mints one.
//
// What this file claims, and nothing else:
//   1. `follow: 'create'` mints a session through the real binary and that id
//      exists on disk under the home's `sessions` directory afterwards.
//   2. The created id can then be followed by the existing path and read.
//   3. A creation failure is a named JcodeBotBackendError, never a half-started
//      backend and never a silent fall back to an existing session.
//
// Measured against the real binary (jcode v1.1.0-dev): `session/new` mints an id
// but writes no record; a turn is what persists it. So creation requires a
// `createPrompt` and records that the first turn is not emitted as a bot event.
//
// Credentials: a cold `JCODE_HOME` has none, so the child is pointed at the
// loopback Responses-API provider from `test/jcode-seed.ts`. No paid call.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { V2Event } from '@opencode/client'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { removeTempDir } from '../test/cleanup.ts'
import { startMockProvider, type MockProvider } from '../test/jcode-seed.ts'
import type { AcpClient } from './acp/contracts.ts'
import { createJcodeBotBackend, JcodeBotBackendError, type JcodeBotConnection } from './jcode-bot-backend.ts'

function findJcode(): string | null {
  const candidates = [
    process.env['JCODE_BIN'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'jcode', 'bin', 'jcode.exe'),
    path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'jcode', 'bin', 'jcode.exe'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

const jcodeBinary = findJcode()
const skipReason = jcodeBinary === null ? 'jcode executable not found (set JCODE_BIN or install jcode)' : null

test('the create skip reason is named when the binary is absent', () => {
  if (jcodeBinary === null) expect(skipReason).toMatch(/jcode executable not found/)
  else expect(skipReason).toBeNull()
})

const sessionFile = (home: string, sessionId: string): string => path.join(home, 'sessions', `${sessionId}.json`)

const readRecord = (home: string, sessionId: string): { id: string; messages: unknown[] } =>
  JSON.parse(fs.readFileSync(sessionFile(home, sessionId), 'utf8')) as { id: string; messages: unknown[] }

// A fake ACP child for the failure cases: no process, no model, every method
// replaced. The seam treats each failure as a named stage.
function fakeCreateClient(overrides: Partial<AcpClient> = {}): AcpClient {
  return {
    async initialize() {
      return { protocolVersion: 1, agentName: 'jcode', agentVersion: '1.1.0', agentCapabilities: {}, supportsRetraction: false }
    },
    async newSession() {
      return { sessionId: 'session_fake_created' }
    },
    async setModel(input) {
      return { model: input.model }
    },
    async loadSession(input) {
      return { sessionId: input.sessionId, history: [], model: null }
    },
    async prompt() {
      return { stopReason: 'end_turn', text: 'ok', updateCount: 0 }
    },
    async cancel() {
      return undefined
    },
    pendingServerRequests() {
      return []
    },
    answerServerRequest() {
      return { requestId: 0 }
    },
    async close() {},
    ...overrides,
  }
}

describe('creation refuses a half-started backend', () => {
  const base = { binary: process.execPath, probe: async () => undefined, cwd: '/tmp/work', onEvent: () => {} }

  test('follow: create without a cwd is a named create-cwd error', async () => {
    const result = await createJcodeBotBackend({ ...base, cwd: '', follow: 'create', createPrompt: 'hi' })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    expect((result as JcodeBotBackendError).stage).toBe('create-cwd')
  })

  test('follow: create with an explicit sessionId refuses instead of mixing the modes', async () => {
    const result = await createJcodeBotBackend({ ...base, sessionId: 'session_existing', follow: 'create', createPrompt: 'hi' })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    expect((result as JcodeBotBackendError).stage).toBe('create-with-session')
  })

  test('follow: create without createPrompt names why a primer is required', async () => {
    const result = await createJcodeBotBackend({ ...base, follow: 'create' })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    const error = result as JcodeBotBackendError
    expect(error.stage).toBe('create-primer')
    expect(error.message).toContain('persists no record until a turn runs')
  })

  test('a refused session/new is create-session, and no connection is returned', async () => {
    const failure = new Error('session/new exploded')
    const result = await createJcodeBotBackend({
      ...base,
      follow: 'create',
      createPrompt: 'hi',
      createCreateClient: () => fakeCreateClient({ newSession: async () => failure }),
    })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    expect((result as JcodeBotBackendError).stage).toBe('create-session')
  })

  test('a failed first turn is create-prompt, and no connection is returned', async () => {
    const result = await createJcodeBotBackend({
      ...base,
      follow: 'create',
      createPrompt: 'hi',
      createCreateClient: () => fakeCreateClient({ prompt: async () => new Error('provider unavailable') }),
    })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    expect((result as JcodeBotBackendError).stage).toBe('create-prompt')
  })

  test('a created session that never persists is create-persist, never a follow', async () => {
    // A prepared existing session: creation must not adopt it when it fails.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-create-persist-'))
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
    const existing = 'session_existing'
    fs.writeFileSync(sessionFile(home, existing), JSON.stringify({ id: existing, messages: [] }))
    try {
      const result = await createJcodeBotBackend({
        ...base,
        home,
        follow: 'create',
        createPrompt: 'hi',
        createTimeoutMs: 300,
        createCreateClient: () => fakeCreateClient(),
      })
      expect(result).toBeInstanceOf(JcodeBotBackendError)
      const error = result as JcodeBotBackendError
      expect(error.stage).toBe('create-persist')
      expect(error.message).toContain('session_fake_created')
      expect(result).not.toHaveProperty('sessionId', existing)
    } finally {
      await removeTempDir(home).catch(() => {})
    }
  })
})

describe.skipIf(jcodeBinary === null)(`creation over the real binary${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`, () => {
  const binary = jcodeBinary!
  let root = ''
  let home = ''
  let cwd = ''
  let mock: MockProvider
  let saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-bot-backend-create-'))
    home = path.join(root, 'home')
    cwd = path.join(root, 'cwd')
    for (const dir of [home, cwd]) fs.mkdirSync(dir, { recursive: true })
    mock = await startMockProvider()
    // The seam's creation client passes no env, so the child inherits this
    // process's. Scrub the JCODE_*/OPENAI_* families first: a developer's own
    // credentials or home would silently replace the isolated ones.
    saved = {
      JCODE_HOME: process.env['JCODE_HOME'],
      JCODE_MODEL: process.env['JCODE_MODEL'],
      JCODE_PROVIDER: process.env['JCODE_PROVIDER'],
      OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
      OPENAI_API_BASE: process.env['OPENAI_API_BASE'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    }
    delete process.env['JCODE_MODEL']
    delete process.env['JCODE_PROVIDER']
    process.env['JCODE_HOME'] = home
    process.env['JCODE_NO_TELEMETRY'] = '1'
    process.env['OPENAI_BASE_URL'] = `${mock.url}/v1`
    process.env['OPENAI_API_BASE'] = `${mock.url}/v1`
    process.env['OPENAI_API_KEY'] = 'kimaki-create-test-key'
  }, 120_000)

  afterAll(async () => {
    try {
      await mock?.close()
    } catch {
      /* provider connections are already destroyed */
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // A just-stopped daemon can still hold the temp home for a moment.
    try {
      await removeTempDir(root)
    } catch {
      process.stderr.write(`jcode create test: could not remove ${root}\n`)
    }
  }, 60_000)

  test('create mints a session whose record exists on disk, and the primer is not emitted', async () => {
    const events: V2Event[] = []
    const startedAt = Date.now()
    const cursorDir = path.join(root, 'cursor-create')
    fs.mkdirSync(cursorDir, { recursive: true })
    const created = await createJcodeBotBackend({
      binary,
      home,
      cwd,
      follow: 'create',
      createPrompt: 'Reply with only: ok',
      provider: 'openai-api',
      cursorDir,
      intervalMs: 50,
      onEvent: (event) => events.push(event),
    })
    if (created instanceof Error) throw created
    const connection: JcodeBotConnection = created
    const sessionId = created.sessionId
    if (sessionId === null) throw new Error('follow: create returned no session')
    try {
      expect(connection.kind).toBe('jcode')
      expect(sessionId).toMatch(/^session_/)
      // (a) the id exists on disk under this home's sessions directory.
      const file = sessionFile(home, sessionId)
      expect(fs.existsSync(file)).toBe(true)
      const record = readRecord(home, sessionId)
      expect(record.id).toBe(sessionId)
      expect(record.messages.length).toBeGreaterThan(0)
      // Evidence a turn really ran: the primer text is in the user history.
      expect(JSON.stringify(record.messages)).toContain('Reply with only: ok')
      // ...written during this test, not left over from an earlier one.
      expect(fs.statSync(file).mtimeMs).toBeGreaterThanOrEqual(startedAt)
      // The priming turn was this construction's own write: it is not news.
      expect(events).toEqual([])
      expect(connection.health().state).toBe('consistent')
    } finally {
      connection.stop()
    }
  }, 180_000)

  test('the created session can be followed by id and read on the existing path', async () => {
    const cursorDir = path.join(root, 'cursor-follow')
    fs.mkdirSync(cursorDir, { recursive: true })
    const created = await createJcodeBotBackend({
      binary,
      home,
      cwd,
      follow: 'create',
      createPrompt: 'Reply with only: ok',
      provider: 'openai-api',
      cursorDir: path.join(root, 'cursor-create-2'),
      intervalMs: 50,
      onEvent: () => {},
    })
    if (created instanceof Error) throw created
    created.stop()

    // (b) follow by the id creation returned, on the unchanged path.
    const events: V2Event[] = []
    const followed = await createJcodeBotBackend({
      binary,
      home,
      sessionId: created.sessionId,
      cursorDir,
      intervalMs: 50,
      onEvent: (event) => events.push(event),
    })
    if (followed instanceof Error) throw followed
    try {
      expect(followed.sessionId).toBe(created.sessionId)
      expect(followed.health().state).toBe('consistent')
      const texts = events.filter((event) => event.type === 'session.text.ended') as Array<{ data: { text: string } }>
      expect(texts.map((event) => event.data.text)).toEqual(['ok'])
    } finally {
      followed.stop()
    }
  }, 180_000)

  test('a store with an existing session is not adopted when creation fails a primer turn', async () => {
    // Real binary, real store, and the loopback provider withdrawn for this one
    // construction: the primer turn cannot complete, so creation must fail by
    // name rather than fall back to following anything.
    const isolated = path.join(root, 'cold-home')
    fs.mkdirSync(isolated, { recursive: true })
    const providerEnv = ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_API_KEY'] as const
    const restore = providerEnv.map((key) => [key, process.env[key]] as const)
    for (const key of providerEnv) delete process.env[key]
    try {
      const run = await createJcodeBotBackend({
        binary,
        home: isolated,
        cwd,
        follow: 'create',
        createPrompt: 'Reply with only: ok',
        createTimeoutMs: 500,
        onEvent: () => {},
      })
      expect(run).toBeInstanceOf(JcodeBotBackendError)
      expect(['create-prompt', 'create-persist']).toContain((run as JcodeBotBackendError).stage)
      // No half-started backend: nothing to stop, and no session id was adopted.
      expect(run).not.toHaveProperty('sessionId')
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 180_000)

  test('nothing is emitted and the connection reads further turns after creation', async () => {
    const events: V2Event[] = []
    const cursorDir = path.join(root, 'cursor-turn')
    fs.mkdirSync(cursorDir, { recursive: true })
    const created = await createJcodeBotBackend({
      binary,
      home,
      cwd,
      follow: 'create',
      createPrompt: 'Reply with only: ok',
      provider: 'openai-api',
      cursorDir,
      intervalMs: 25,
      onEvent: (event) => events.push(event),
    })
    if (created instanceof Error) throw created
    try {
      const turn = await created.prompt('Reply with only: ok')
      if (turn instanceof Error) throw turn
      // The observer is the only emitter; a deterministic read surfaces the turn.
      for (let attempt = 0; attempt < 200 && !events.some((event) => event.type === 'session.text.ended'); attempt += 1) {
        await sleep(100)
        await created.flush()
      }
      const texts = events.filter((event) => event.type === 'session.text.ended') as Array<{ data: { text: string } }>
      expect(texts.map((event) => event.data.text)).toEqual(['ok'])
    } finally {
      created.stop()
    }
  }, 180_000)
})
