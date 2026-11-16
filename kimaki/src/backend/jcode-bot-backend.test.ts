// The bot's Jcode seam, proven end to end: a real `jcode run` writes a real
// assistant turn, the seam projects it into the bot's V2 event shape, and the
// event loop folds it into the thread view the bot would publish.
//
// Two claims this file makes and nothing else:
//   1. With `backend: { kind: 'jcode' }` the seam observes the persisted turn
//      once, attributed to the right session, and a restart with the same
//      durable cursor emits nothing again.
//   2. With no `backend` the seam calls the OpenCode watcher with exactly the
//      callbacks it always received, synchronously and unchanged.
//
// Honest skip: the real-turn suite needs the native binary. Its absence is a
// named skip, and a separate always-run test asserts the reason is named.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { Client } from 'discord.js'
import type { V2Event } from '@opencode/client'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { disabledAnalytics } from '../analytics.ts'
import { openDb } from '../db.ts'
import type { EffectsRunner } from '../effects.ts'
import { createEventLoop } from '../event-loop.ts'
import { startBotConnection, type BotConnectionCallbacks } from '../main.ts'
import { createEventRecorder } from '../session-events.ts'
import { createBotStore } from '../store.ts'
import type { Effect } from '../thread-reducer.ts'
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

test('the skip reason is named when the binary is absent', () => {
  if (jcodeBinary === null) expect(skipReason).toMatch(/jcode executable not found/)
  else expect(skipReason).toBeNull()
})

function removeTree(target: string): boolean {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows reports EPERM while a just-closed handle drains; retry below.
    }
    if (!fs.existsSync(target)) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  return !fs.existsSync(target)
}

// Same loopback Responses-API mock the observer suite uses: jcode itself writes
// the user prompt and the assistant answer, so the record under test is native.
function startMockProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method === 'GET' && (request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
        return
      }
      if (!(request.url ?? '').endsWith('/responses')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const event = (type: string, payload: Record<string, unknown>) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      }
      const message = (text: string | null, status: string) => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status,
        content: text === null ? [] : [{ type: 'output_text', text, annotations: [] }],
      })
      const base = { id: 'resp_1', object: 'response', created_at: 1, model: 'mock-model' }
      event('response.created', { response: { ...base, status: 'in_progress', output: [] } })
      event('response.output_item.added', { output_index: 0, item: message(null, 'in_progress') })
      event('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' })
      event('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'ok' })
      const done = message('ok', 'completed')
      event('response.content_part.done', { item_id: 'msg_1', output_index: 0, content_index: 0, part: done.content[0] })
      event('response.output_item.done', { output_index: 0, item: done })
      event('response.completed', {
        response: {
          ...base,
          status: 'completed',
          output: [done],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        },
      })
      response.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock provider has no port')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

// One real one-shot turn through the loopback provider. This is the "prompt
// goes in" half: the writer is jcode, not this test.
function runJcodeTurn({ binary, home, cwd, url }: { binary: string; home: string; cwd: string; url: string }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['run', '-p', 'openai-api', '-m', 'mock-model', '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd, 'Reply with only: ok'], {
      env: {
        ...process.env,
        JCODE_HOME: home,
        JCODE_NO_TELEMETRY: '1',
        OPENAI_BASE_URL: `${url}/v1`,
        OPENAI_API_BASE: `${url}/v1`,
        OPENAI_API_KEY: 'jcode-bot-backend-test-key',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

type SettledStore = { sessionId: string; file: string }

// Two reads a moment apart agree and an assistant message exists: the record is
// settled, so the seam's first consistency-checked read can be honest.
async function settleStore(sessionsDir: string, timeoutMs = 60_000): Promise<SettledStore> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    await sleep(200)
    const names = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((name) => name.startsWith('session_') && name.endsWith('.json')) : []
    if (names.length === 0) continue
    const file = path.join(sessionsDir, names[0]!)
    const first = fs.readFileSync(file, 'utf8')
    if (first !== last) {
      last = first
      continue
    }
    try {
      const value = JSON.parse(first) as { id?: unknown; messages?: Array<{ role?: unknown; text?: unknown }> }
      if (typeof value.id !== 'string' || !Array.isArray(value.messages)) continue
      if (!value.messages.some((message) => message.role === 'assistant')) continue
      return { sessionId: value.id, file }
    } catch {
      continue
    }
  }
  throw new Error(`the jcode store at ${sessionsDir} never settled with an assistant message within ${timeoutMs}ms`)
}

// The default path: the seam must call the OpenCode watcher with exactly the
// callbacks it always received, return its connection synchronously, and never
// touch the Jcode factory.
test('without a backend the seam calls the OpenCode path exactly as before', () => {
  const stop = (): void => {}
  const sentinel = {
    connected: false,
    endpoint: null,
    ready: Promise.resolve(new Error('not connected')),
    subscribe: () => () => {},
    stop,
  }
  const calls: BotConnectionCallbacks[] = []
  let jcodeCalled = false
  const callbacks: BotConnectionCallbacks = {
    serviceFile: '/tmp/service.json',
    ensure: true,
    onConnect: async () => {},
    onEvent: () => {},
    onDisconnect: () => {},
  }
  const selected = startBotConnection(
    { callbacks },
    (options) => {
      calls.push(options)
      return sentinel
    },
    () => {
      jcodeCalled = true
      return Promise.resolve(JcodeBotBackendError.prototype as never)
    },
  )
  expect(jcodeCalled).toBe(false)
  expect(calls).toHaveLength(1)
  // Identity, not deep equality: the same callbacks object reaches the watcher.
  expect(calls[0]).toBe(callbacks)
  expect(selected).toBe(sentinel)
  expect(selected instanceof Promise).toBe(false)
})

test('a jcode backend is constructed through the jcode factory, never OpenCode', async () => {
  const stop = (): void => {}
  const sentinel: JcodeBotConnection = {
    kind: 'jcode',
    sessionId: 'session_x',
    connected: true,
    endpoint: null,
    ready: Promise.resolve(new Error('none')),
    subscribe: () => () => {},
    stop,
    health: () => ({ state: 'consistent', lastPollAt: 0, lastTurnId: null }),
    latency: { pollIntervalMs: 1, minPollIntervalMs: 1, maxPollIntervalMs: 1, confirmMs: 0 },
    refusals: () => [],
  }
  let opencodeCalled = false
  const onEvent = (): void => {}
  const result = startBotConnection(
    { backend: { kind: 'jcode', sessionId: 'session_x' }, callbacks: { ensure: false, onConnect: async () => {}, onEvent, onDisconnect: () => {} } },
    () => {
      opencodeCalled = true
      return { ...sentinel, connected: false }
    },
    async (input) => {
      expect(input.sessionId).toBe('session_x')
      expect(input.onEvent).toBe(onEvent)
      return sentinel
    },
  )
  expect(opencodeCalled).toBe(false)
  expect(result).toBeInstanceOf(Promise)
  await expect(result).resolves.toBe(sentinel)
})

test('a missing binary is a named error, never a fallback to OpenCode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-bot-backend-missing-'))
  try {
    const missing = path.join(root, 'jcode-does-not-exist.exe')
    const result = await createJcodeBotBackend({
      binary: missing,
      home: path.join(root, 'home'),
      sessionId: 'session_missing',
      onEvent: () => {},
    })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    expect((result as Error).name).toBe('JcodeBotBackendError')
    expect((result as Error).message).toContain('binary')
    expect((result as Error).message).toContain(missing)
  } finally {
    removeTree(root)
  }
})

describe.skipIf(jcodeBinary === null)(`jcode bot seam over a real session${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`, () => {
  const binary = jcodeBinary!
  const threadId = 'thread-1'
  const channelId = 'channel-1'
  let root = ''
  let home = ''
  let cwd = ''
  let cursorDir = ''
  let dataDir = ''
  let mock: { url: string; close: () => Promise<void> }
  let settled: SettledStore

  beforeAll(async () => {
    // One bounded root, reused and re-cleaned: a jcode daemon can hold a lock on
    // its own home for a while after `jcode run` exits, so a fresh mkdtemp per
    // run would leak a locked directory every time. Reuse keeps the leftover at
    // most one path, and it is reported if it still cannot be removed.
    root = path.join(os.tmpdir(), 'kimaki-bot-backend-seam')
    removeTree(root)
    fs.mkdirSync(root, { recursive: true })
    home = path.join(root, 'home')
    cwd = path.join(root, 'cwd')
    cursorDir = path.join(root, 'cursor')
    dataDir = path.join(root, 'data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    fs.mkdirSync(cursorDir, { recursive: true })
    mock = await startMockProvider()
    const run = await runJcodeTurn({ binary, home, cwd, url: mock.url })
    expect(run.code, `jcode run stderr: ${run.stderr}`).toBe(0)
    settled = await settleStore(path.join(home, 'sessions'))
  }, 180_000)

  afterAll(async () => {
    await mock?.close()
    // A Windows handle on a just-closed SQLite file can outlive the test for a
    // moment. Leaving a temp dir is a nuisance; failing the suite over it would
    // hide the result of the claims above. The path is named instead.
    if (root && !removeTree(root)) process.stderr.write(`jcode seam test: could not remove ${root}\n`)
  }, 30_000)

  test('a session that is not persisted yet is a named construction error', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-bot-backend-empty-'))
    try {
      const result = await createJcodeBotBackend({
        binary,
        home: empty,
        sessionId: 'session_awaiting',
        cursorDir,
        onEvent: () => {},
      })
      expect(result).toBeInstanceOf(JcodeBotBackendError)
      expect((result as Error).message).toContain('session_awaiting')
      expect((result as Error).message).toContain('no record')
    } finally {
      expect(removeTree(empty)).toBe(true)
    }
  })

  test('one real turn reaches the bot as one completed turn for the right session', async () => {
    // The seam is wired the way startBot wires it, except the effects runner
    // records instead of sending to Discord: the claim is about the event loop
    // and the projection, not about Discord REST.
    const opened = await openDb({ dataDir, migrate: true })
    if (opened instanceof Error) throw opened
    const store = createBotStore()
    const effects: Effect[] = []
    const runner: EffectsRunner = {
      run: (_threadId, produced) => { effects.push(...produced) },
      dispose: () => {},
      stop: () => {},
    }
    const discord = new Client({ intents: [] })
    const recorder = createEventRecorder({ dataDir })
    const loop = createEventLoop({
      store,
      db: opened.db,
      discord,
      effects: runner,
      recorder,
      analytics: disabledAnalytics,
      onRunEnded: () => {},
      onTranscriptDue: () => {},
    })
    try {
      // Bound before the seam's first read, exactly as a bot that owns a thread.
      await loop.bind({ threadId, sessionId: settled.sessionId, channelId, directory: cwd, isNew: false })
      const events: V2Event[] = []
      const connection = await createJcodeBotBackend({
        binary,
        home,
        sessionId: settled.sessionId,
        cursorDir,
        intervalMs: 50,
        onEvent: (event) => {
          events.push(event)
          loop.onEvent(event)
        },
      })
      if (connection instanceof Error) throw connection

      expect(connection.kind).toBe('jcode')
      expect(connection.sessionId).toBe(settled.sessionId)
      expect(connection.health().state).toBe('consistent')
      expect(store.getState().roots[threadId]).toBe(settled.sessionId)
      // Both projected envelopes, and only those, in the observer's order.
      expect(events.map((event) => event.type)).toEqual(['session.text.ended', 'session.execution.succeeded'])
      const text = events[0] as Extract<V2Event, { type: 'session.text.ended' }>
      expect(text.data.sessionID).toBe(settled.sessionId)
      expect(text.data.text).toBe('ok')
      // The bot's own view: one markdown block, and an idle marker attributed to
      // the same session after the execution succeeded.
      expect(effects.filter((effect) => effect.type === 'markdown').map((effect) => (effect as { text: string }).text)).toEqual(['ok'])
      const viewed = effects.filter((effect) => effect.type === 'viewed') as Array<{ sessionId: string }>
      expect(viewed).toHaveLength(1)
      expect(viewed[0]!.sessionId).toBe(settled.sessionId)
      // A completed turn leaves no open turn in the view.
      expect(store.getState().threads[threadId]?.turn).toBeNull()
      connection.stop()
      expect(connection.health().state).toBe('stopped')
    } finally {
      recorder.close()
      await opened.close()
      discord.destroy()
    }
  }, 120_000)

  test('a restart with the same durable cursor emits nothing twice', async () => {
    const again: V2Event[] = []
    const restarted = await createJcodeBotBackend({
      binary,
      home,
      sessionId: settled.sessionId,
      cursorDir,
      intervalMs: 50,
      onEvent: (event) => again.push(event),
    })
    if (restarted instanceof Error) throw restarted
    try {
      // Construction polls once; a second scheduled poll must also stay silent.
      await sleep(250)
      expect(again).toEqual([])
      expect(restarted.health().state).toBe('consistent')
    } finally {
      restarted.stop()
    }
  })
})
