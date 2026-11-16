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
import { removeTempDir } from '../test/cleanup.ts'
import type { Effect } from '../thread-reducer.ts'
import { AcpApprovalError } from './acp/approvals.ts'
import { createAcpClient } from './acp/client.ts'
import type { AcpClient, AcpClientOptions, AcpServerRequest } from './acp/contracts.ts'
import { createJcodeBotBackend, JcodeBotBackendError, type JcodeBotConnection } from './jcode-bot-backend.ts'
import { botSocketPath } from './jcode-bot-prompt.ts'

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

// Per-instance seam roots. A fixed path is shared by every concurrent run of this
// file, so one run's `jcode run` lands on the other run's home, holds the other's
// lock, and fails the model lookup. Unique roots cost at worst a leaked locked
// directory, which teardown reports and the sweep below reaps later; a cross-run
// collision is the thing that must not happen.
const STALE_SEAM_ROOT_MS = 60 * 60 * 1000

// Non-destructive: only roots older than an hour, and a root still held open is
// skipped silently (the next run sweeps it once the daemon releases it).
function sweepStaleSeamRoots(): void {
  let names: string[]
  try {
    names = fs.readdirSync(os.tmpdir())
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_SEAM_ROOT_MS
  for (const name of names) {
    if (!name.startsWith('kimaki-bot-backend-seam-')) continue
    const target = path.join(os.tmpdir(), name)
    try {
      if (fs.statSync(target).mtimeMs >= cutoff) continue
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 0 })
    } catch {
      // Expected while a daemon still holds the directory; leave it for later.
    }
  }
}

type SeamRoots = { root: string; home: string; cwd: string; cursorDir: string; dataDir: string }

// One fresh root and its subdirectories. Every harness instance calls this, so
// two instances in one process (or two processes) never share a path.
function createSeamRoots(): SeamRoots {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-bot-backend-seam-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  const cursorDir = path.join(root, 'cursor')
  const dataDir = path.join(root, 'data')
  for (const dir of [home, cwd, cursorDir, dataDir]) fs.mkdirSync(dir, { recursive: true })
  return { root, home, cwd, cursorDir, dataDir }
}

// Thin boolean adapter over the shared bounded-retry helper: Windows reports
// EPERM/EBUSY while a just-closed handle drains, which removeTempDir absorbs
// within a hard bound. The boolean keeps the call sites' assertions intact.
async function removeTree(target: string): Promise<boolean> {
  try {
    await removeTempDir(target)
    return true
  } catch {
    return false
  }
}

// Same loopback Responses-API mock the observer suite uses: jcode itself writes
// the user prompt and the assistant answer, so the record under test is native.
function startMockProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>()
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
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock provider has no port')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        // jcode keeps provider connections alive; a graceful close would wait on
        // them until the hook timeout. Destroy them so teardown is bounded.
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

// One real one-shot turn through the loopback provider. This is the "prompt
// goes in" half: the writer is jcode, not this test.
function runJcodeTurn({ binary, home, cwd, url }: { binary: string; home: string; cwd: string; url: string }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // A catalog-known id: jcode validates the model against its catalog, not the
    // endpoint's /models list, so an invented id is rejected on some hosts.
    const child = spawn(binary, ['run', '-p', 'openai-api', '-m', 'gpt-5.5', '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd, 'Reply with only: ok'], {
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
    prompt: () => Promise.resolve(new Error('sentinel')),
    flush: () => Promise.resolve(),
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

test('two harness instances get distinct temp roots', async () => {
  const first = createSeamRoots()
  const second = createSeamRoots()
  try {
    // Isolation is the claim: two instances in one process never share a root.
    expect(first.root).not.toBe(second.root)
    expect(fs.existsSync(first.root)).toBe(true)
    expect(fs.existsSync(second.root)).toBe(true)
    expect(fs.existsSync(first.home)).toBe(true)
    expect(fs.existsSync(second.home)).toBe(true)
  } finally {
    expect(await removeTree(first.root)).toBe(true)
    expect(await removeTree(second.root)).toBe(true)
  }
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
    await removeTree(root)
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
    // A unique root per run. The old fixed path let two concurrent runs share a
    // home, so one run's `jcode run` saw the other's lock and failed in
    // `beforeAll` with `Unsupported OpenAI model 'mock-model'`. A leaked locked
    // directory is the accepted cost; the sweep reaps it once it is an hour old.
    sweepStaleSeamRoots()
    const roots = createSeamRoots()
    root = roots.root
    home = roots.home
    cwd = roots.cwd
    cursorDir = roots.cursorDir
    dataDir = roots.dataDir
    mock = await startMockProvider()
    const run = await runJcodeTurn({ binary, home, cwd, url: mock.url })
    expect(run.code, `jcode run stderr: ${run.stderr}`).toBe(0)
    settled = await settleStore(path.join(home, 'sessions'))
  }, 180_000)

  afterAll(async () => {
    try { await mock?.close() } catch { /* provider connections are already destroyed */ }
    // A Windows handle on a just-closed SQLite file can outlive the test for a
    // moment. Fail fast instead of retrying into the hook timeout, and name the
    // path: leaving a temp dir is a nuisance, failing the suite over it would
    // hide the result of the claims above.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 0 })
    } catch {
      process.stderr.write(`jcode seam test: could not remove ${root}\n`)
    }
  }, 60_000)

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
      expect(await removeTree(empty)).toBe(true)
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
// Approval channel: a scripted fake agent answers initialize, then asks for
// permission after session/load and records every frame, agent-side evidence.
const APPROVAL_AGENT = String.raw`const fs = require('node:fs')
const readline = require('node:readline')
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const record = (event) => fs.appendFileSync(process.argv[2], JSON.stringify(event) + '\n')
let waiting = null
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) { if (message.id === waiting) { record({ kind: 'answer', frame: message }); waiting = null } return }
  if (message.method === 'initialize') return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'jcode' }, agentCapabilities: {} } })
  if (message.method !== 'session/load') return
  write({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params.sessionId, configOptions: [] } })
  setTimeout(() => { waiting = 4242
    write({ jsonrpc: '2.0', id: 4242, method: 'session/request_permission', params: { sessionId: message.params.sessionId, toolCall: { rawInput: { command: 'rm -rf build' } }, options: [{ optionId: 'allow' }, { optionId: 'reject' }] } }) }, 20)
})
`
const waitAnswers = async (file: string): Promise<Array<Record<string, unknown>>> => {
  const read = (): Array<Record<string, unknown>> => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event['kind'] === 'answer') : []
  for (let attempt = 0; attempt < 100 && read().length === 0; attempt += 1) await sleep(20)
  return read()
}

// The seam owns an ACP child only here; handler and answer surface share it.
const buildApprovalSeam = async (onApproval: (request: AcpServerRequest, client: () => AcpClient) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-seam-approvals-'))
  const script = path.join(dir, 'agent.cjs')
  const recordFile = path.join(dir, 'record.jsonl')
  fs.writeFileSync(script, APPROVAL_AGENT)
  const requests: AcpServerRequest[] = []; let client: AcpClient
  const connection = await createJcodeBotBackend({
    binary: process.execPath, probe: async () => undefined, home: path.join(dir, 'home'), sessionId: 'session_approval', intervalMs: 25, cwd: dir,
    readFile: async () => JSON.stringify({ id: 'session_approval', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: '2026-01-01T00:00:00.000Z' }] }), onEvent: () => {},
    onApproval: (request) => { requests.push(request); onApproval(request, () => client) },
    createApprovalClient: (options) => (client = createAcpClient({ ...options, command: process.execPath, args: [script, recordFile] })),
  })
  if (connection instanceof Error) { await removeTree(dir); return connection }
  return { connection, dir, recordFile, requests }
}

test('an approval handler sees the payload and its answer reaches the agent exactly once', async () => {
  const run = await buildApprovalSeam((request, client) => client().answerServerRequest({ requestId: request.requestId, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }))
  if (run instanceof Error) throw run
  try {
    for (let attempt = 0; attempt < 100 && run.requests.length === 0; attempt += 1) await sleep(20)
    expect(run.requests[0]).toMatchObject({ requestId: 4242, method: 'session/request_permission', sessionId: 'session_approval', toolCall: { rawInput: { command: 'rm -rf build' } }, options: [{ optionId: 'allow' }, { optionId: 'reject' }] })
    expect(run.connection.approvals!.pending()).toEqual([])
    expect(await waitAnswers(run.recordFile)).toMatchObject([{ frame: { id: 4242, result: { outcome: { outcome: 'selected', optionId: 'allow' } } } }])
    const again = run.connection.approvals!.answer({ requestId: 4242, result: {} })
    expect([again instanceof AcpApprovalError, (again as Error).name, (again as Error).message]).toEqual([true, 'AcpApprovalError', expect.stringMatching(/already answered/)])
  } finally {
    run.connection.stop(); expect(await removeTree(run.dir)).toBe(true)
  }
})
test('without an approval handler no ACP child starts and the projection is unchanged', async () => {
  let factoryCalls = 0; const events: string[] = []
  // Per-instance home: a shared fixed path lets a concurrent run collide here.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-seam-no-approval-'))
  const connection = await createJcodeBotBackend({
    binary: process.execPath, probe: async () => undefined, home, sessionId: 'session_plain', intervalMs: 25,
    readFile: async () => JSON.stringify({ id: 'session_plain', messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: '2026-01-01T00:00:00.000Z' }] }), onEvent: (event) => events.push(event.type),
    createApprovalClient: (options) => { factoryCalls += 1; return createAcpClient(options) },
  })
  try {
    if (connection instanceof Error) throw connection
    expect([factoryCalls, Object.hasOwn(connection, 'approvals'), events]).toEqual([0, false, ['session.text.ended', 'session.execution.succeeded']]); connection.stop()
  } finally {
    if (!(await removeTree(home))) process.stderr.write(`jcode seam test: could not remove ${home}\n`)
  }
})
test('a handler that throws fails closed with one refusal, not a stalled agent', async () => {
  const run = await buildApprovalSeam(() => { throw new Error('policy exploded') })
  if (run instanceof Error) throw run
  try {
    expect(await waitAnswers(run.recordFile)).toMatchObject([{ frame: { id: 4242, error: { code: -32603 } } }])
    const late = run.connection.approvals!.answer({ requestId: 4242, result: {} })
    expect([late instanceof AcpApprovalError, (late as Error).name, (late as Error).message]).toEqual([true, 'AcpApprovalError', expect.stringMatching(/already answered/)])
  } finally {
    run.connection.stop(); expect(await removeTree(run.dir)).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// Write path: session/prompt is the ACP call that runs a turn. The scripted
// peer below is a real ACP child on the wire (the production transport spawns
// it); only the model is replaced, so the write path is exercised end to end
// without a provider. The real-binary suite at the end proves the persisted side.
// ---------------------------------------------------------------------------

const WRITE_AGENT = String.raw`const fs = require('node:fs')
const readline = require('node:readline')
const recordFile = process.argv[2]
const mode = process.argv[3] ?? 'ok'
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const record = (event) => fs.appendFileSync(recordFile, JSON.stringify(event) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) return
  if (message.method === 'initialize') return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'jcode' }, agentCapabilities: {} } })
  if (message.method === 'session/load') {
    if (mode === 'reject-load') return write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'no such session' } })
    // Replay what this peer has been prompted with, as jcode replays a session's
    // user messages. The instruction marker is part of that text, so a reconnect
    // can recover the delivered digest from the transcript.
    const replay = fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.kind === 'prompt').map((event) => event.text) : []
    for (const text of replay.length === 0 ? ['earlier turn'] : replay) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } } })
    }
    return write({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params.sessionId, configOptions: [] } })
  }
  if (message.method !== 'session/prompt') return
  record({ kind: 'prompt', text: message.params.prompt[0].text })
  if (mode === 'reject-prompt') return write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'provider unavailable' } })
  const reply = () => {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'scripted' } } } })
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
  if (mode === 'slow') setTimeout(reply, 1500)
  else reply()
})
`

const readPrompts = (file: string): string[] =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { kind?: string; text?: string })
        .filter((event) => event.kind === 'prompt')
        .map((event) => event.text ?? '')
    : []

const primeRecord = (sessionId: string): string =>
  JSON.stringify({ id: sessionId, messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'prime' }], timestamp: '2026-01-01T00:00:00.000Z' }] })

// The same environment runJcodeTurn gives `jcode run`, so the ACP child reads the
// same isolated home and the same loopback provider. Stripping the inherited
// JCODE_* set was measured to send the child to the host daemon instead.
const isolatedEnv = (home: string, url: string): NodeJS.ProcessEnv => ({
  ...process.env,
  JCODE_HOME: home,
  JCODE_NO_TELEMETRY: '1',
  OPENAI_BASE_URL: `${url}/v1`,
  OPENAI_API_BASE: `${url}/v1`,
  OPENAI_API_KEY: 'jcode-bot-backend-test-key',
})

const startWriteSeam = async ({ mode, persisted = true, promptTimeoutMs }: { mode: string; persisted?: boolean; promptTimeoutMs?: number }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-seam-write-'))
  const home = path.join(dir, 'home')
  const script = path.join(dir, 'agent.cjs')
  const recordFile = path.join(dir, 'record.jsonl')
  fs.writeFileSync(script, WRITE_AGENT)
  const sessionId = 'session_write'
  if (persisted) {
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(home, 'sessions', `${sessionId}.json`), '{}')
  }
  const events: V2Event[] = []
  const connection = await createJcodeBotBackend({
    binary: process.execPath,
    probe: async () => undefined,
    home,
    sessionId,
    cwd: dir,
    intervalMs: 60_000,
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
    readFile: async () => primeRecord(sessionId),
    onEvent: (event) => events.push(event),
    createPromptClient: (options) => createAcpClient({ ...options, command: process.execPath, args: [script, recordFile, mode] }),
  })
  if (connection instanceof Error) { await removeTree(dir); throw connection }
  return { connection, dir, home, recordFile, events, sessionId }
}

const stageOf = (value: unknown): unknown => (value as { stage?: unknown }).stage

test('a prompt runs a turn over ACP and the session instruction is delivered once', async () => {
  const run = await startWriteSeam({ mode: 'ok' })
  try {
    const first = await run.connection.prompt({ text: 'hello', instruction: 'Be terse' })
    if (first instanceof Error) throw first
    expect(first).toMatchObject({ sessionId: run.sessionId, stopReason: 'end_turn', text: 'scripted', instruction: { kind: 'prefix' } })
    const second = await run.connection.prompt({ text: 'again', instruction: 'Be terse' })
    if (second instanceof Error) throw second
    // The marker is in the transcript, so the second turn does not repeat it.
    expect(second.instruction).toEqual({ kind: 'none', digest: first.instruction.digest })
    const prompts = readPrompts(run.recordFile)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('kimaki:session-instruction')
    expect(prompts[0]).toContain('Be terse')
    expect(prompts[0]!.endsWith('hello')).toBe(true)
    expect(prompts[1]).toBe('again')
  } finally {
    run.connection.stop(); expect(await removeTree(run.dir)).toBe(true)
  }
})

test('a prompt while another is in flight is refused by name', async () => {
  const run = await startWriteSeam({ mode: 'slow' })
  try {
    const first = run.connection.prompt('slow turn')
    await sleep(300)
    const second = await run.connection.prompt('second')
    expect(second).toBeInstanceOf(JcodeBotBackendError)
    expect(stageOf(second)).toBe('prompt-in-flight')
    const finished = await first
    if (finished instanceof Error) throw finished
    expect(finished.text).toBe('scripted')
  } finally {
    run.connection.stop(); expect(await removeTree(run.dir)).toBe(true)
  }
})

test('a refused load is a named error and emits nothing', async () => {
  const run = await startWriteSeam({ mode: 'reject-load' })
  try {
    const before = run.events.length
    const refused = await run.connection.prompt('never sent')
    expect(stageOf(refused)).toBe('prompt-load')
    expect(readPrompts(run.recordFile)).toEqual([])
    await run.connection.flush()
    expect(run.events.length).toBe(before)
  } finally {
    run.connection.stop(); expect(await removeTree(run.dir)).toBe(true)
  }
})

test('a refused prompt is a named error and emits nothing', async () => {
  const run = await startWriteSeam({ mode: 'reject-prompt' })
  try {
    const before = run.events.length
    const refused = await run.connection.prompt('rejected turn')
    expect(stageOf(refused)).toBe('prompt-rejected')
    expect(readPrompts(run.recordFile)).toEqual(['rejected turn'])
    await run.connection.flush()
    expect(run.events.length).toBe(before)
  } finally {
    run.connection.stop(); expect(await removeTree(run.dir)).toBe(true)
  }
})

test('a prompt before the session is persisted and after stop is refused by name', async () => {
  const unpersisted = await startWriteSeam({ mode: 'ok', persisted: false })
  try {
    expect(stageOf(await unpersisted.connection.prompt('too early'))).toBe('prompt-session')
  } finally {
    unpersisted.connection.stop(); expect(await removeTree(unpersisted.dir)).toBe(true)
  }
  const closed = await startWriteSeam({ mode: 'ok' })
  try {
    closed.connection.stop()
    expect(stageOf(await closed.connection.prompt('too late'))).toBe('prompt-closed')
  } finally {
    expect(await removeTree(closed.dir)).toBe(true)
  }
})

test('observer-only mode starts no child and the write factory is never called', async () => {
  let approvalFactoryCalls = 0
  let promptFactoryCalls = 0
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-seam-observer-only-'))
  const events: string[] = []
  const connection = await createJcodeBotBackend({
    binary: process.execPath,
    probe: async () => undefined,
    home,
    sessionId: 'session_plain',
    intervalMs: 25,
    readFile: async () => primeRecord('session_plain'),
    onEvent: (event) => events.push(event.type),
    createApprovalClient: (options) => { approvalFactoryCalls += 1; return createAcpClient(options) },
    createPromptClient: (options) => { promptFactoryCalls += 1; return createAcpClient(options) },
  })
  try {
    if (connection instanceof Error) throw connection
    await sleep(100)
    expect([approvalFactoryCalls, promptFactoryCalls, events]).toEqual([0, 0, ['session.text.ended', 'session.execution.succeeded']])
    connection.stop()
  } finally {
    if (!(await removeTree(home))) process.stderr.write(`jcode seam test: could not remove ${home}\n`)
  }
})

describe.skipIf(jcodeBinary === null)(`jcode bot seam write path over a real session${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`, () => {
  const binary = jcodeBinary!
  let root = ''
  let home = ''
  let cursorDir = ''
  let cwd = ''
  let mock: { url: string; close: () => Promise<void> }
  let settled: SettledStore

  beforeAll(async () => {
    sweepStaleSeamRoots()
    const roots = createSeamRoots()
    root = roots.root
    home = roots.home
    cursorDir = roots.cursorDir
    cwd = roots.cwd
    mock = await startMockProvider()
    const run = await runJcodeTurn({ binary, home, cwd, url: mock.url })
    expect(run.code, `jcode run stderr: ${run.stderr}`).toBe(0)
    settled = await settleStore(path.join(home, 'sessions'))
  }, 180_000)

  afterAll(async () => {
    try { await mock?.close() } catch { /* connections are already destroyed */ }
    // The ACP server can still hold a handle for a moment; fail fast and name the
    // path rather than spending two minutes retrying.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 0 })
    } catch {
      process.stderr.write(`jcode seam write test: could not remove ${root}\n`)
    }
    try {
      fs.rmSync(botSocketPath(home), { force: true })
    } catch { /* the socket belongs to the OS temp dir */ }
  }, 60_000)

  test('a prompt runs a real turn and write+observe emits the completed turn exactly once', async () => {
    const events: V2Event[] = []
    const connection = await createJcodeBotBackend({
      binary,
      home,
      sessionId: settled.sessionId,
      cursorDir,
      cwd,
      intervalMs: 60_000,
      provider: 'openai-api',
      model: 'gpt-5.5',
      toolProfile: 'none',
      promptTimeoutMs: 120_000,
      // Point the ACP child at the same isolated home and loopback provider.
      createPromptClient: (options) => createAcpClient({ ...options, env: isolatedEnv(home, mock.url) }),
      onEvent: (event) => events.push(event),
    })
    if (connection instanceof Error) throw connection
    try {
      // Construction emitted the pre-existing turn once (emitExisting default).
      const baseline = events.length
      expect(baseline).toBe(2)
      const outcome = await connection.prompt('Reply with only: ok')
      if (outcome instanceof Error) throw outcome
      expect(outcome.text).toBe('ok')
      expect(outcome.sessionId).toBe(settled.sessionId)
      // jcode persists the turn; the poller alone turns it into bot events.
      for (let attempt = 0; attempt < 150 && events.length - baseline < 2; attempt += 1) {
        await connection.flush()
        await sleep(100)
      }
      const fresh = events.slice(baseline)
      expect(fresh.map((event) => event.type)).toEqual(['session.text.ended', 'session.execution.succeeded'])
      const text = fresh[0] as Extract<V2Event, { type: 'session.text.ended' }>
      expect(text.data.sessionID).toBe(settled.sessionId)
      expect(text.data.text).toBe('ok')
      // Extra reads must not repeat it: the durable cursor is the dedupe.
      await connection.flush()
      await connection.flush()
      expect(events.slice(baseline)).toHaveLength(2)
    } finally {
      connection.stop()
    }
  }, 180_000)
})
