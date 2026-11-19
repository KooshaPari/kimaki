// Product analytics end to end: the real Strada SDK exports OTLP JSON logs to
// a local receiver instead of strada.sh.
//
// WHAT RUNS ON JCODE (describe below): a real `jcode run` turn, observed by the
// bot seam (backend/jcode-bot-backend.ts) in a throwaway JCODE_HOME, folded by
// the real event loop into the real analytics sink. It asserts the part of the
// funnel a persisted record can prove: `turn_started` from
// session.execution.started (the last user message), and `turn_completed` from
// session.execution.succeeded, whose `duration_sec` is the wall-clock distance
// between the two persisted timestamps. The model delay makes that value
// assertable; the zero-token reply keeps `tokens_used` out (analytics.test.ts
// covers it). This is the analytics duration/attribution behaviour, not the
// backend. The turn is driven by the seam's own ACP write path, not by a
// Discord message: the jcode seam has no ingress-to-prompt path.
//
// STILL SKIPPED ON JCODE (the skipped describe names the literal reasons):
//   * the full Discord funnel: `bot_started` needs startBot, which returns early
//     in refreshCliContext because a jcode connection has no OpenCode endpoint;
//     `session_created` needs startSession's session.create, which the seam has
//     no write path for; and a Discord message cannot become a jcode prompt.
//   * the same funnel triggered by a Discord turn (ingress to prompt).
//
// STILL ON OPENCODE (skipped, kept as the reference): the original test with the
// OpenCode deterministic provider and a Discord message.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { Client } from 'discord.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createAnalytics } from './analytics.ts'
import { createAcpClient } from './backend/acp/client.ts'
import { createJcodeBotBackend } from './backend/jcode-bot-backend.ts'
import { openDb } from './db.ts'
import type { EffectsRunner } from './effects.ts'
import { createEventLoop } from './event-loop.ts'
import { createEventRecorder } from './session-events.ts'
import { createBotStore } from './store.ts'
import { removeDataDir, removeTempDir } from './test/cleanup.ts'
import { findJcodeBinary } from './test/jcode-harness.ts'
import type { BotHandle } from './main.ts'
import type { Effect } from './thread-reducer.ts'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import {
  freePort,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  TEST_USER_ID,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

// duration_sec is wall-clock. The jcode test makes the model genuinely slow, so
// the persisted user and assistant timestamps are at least this far apart.
const TURN_DELAY_MS = 2_000
const SLOW_MARKER = 'analytics-slow-turn-marker'

// Same zero-token reply the bare deterministic model gives (so tokens_used stays
// skipped), streamed after TURN_DELAY_MS. Used only by the skipped OpenCode test.
const slowZeroTokenMatcher: DeterministicMatcher = {
  id: SLOW_MARKER,
  priority: 1,
  when: { latestUserTextIncludes: SLOW_MARKER },
  then: {
    parts: [
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'analytics turn done' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ],
    partDelaysMs: [0, TURN_DELAY_MS, 0, 0],
  },
}

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
type OtlpLogs = {
  resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: OtlpValue }> }> }> }>
}

const received: Array<Record<string, unknown>> = []
let receiver: http.Server
let endpoint: string

async function startReceiver(): Promise<{ server: http.Server; endpoint: string }> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url === '/v1/batch') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpLogs
        for (const record of body.resourceLogs.flatMap((logs) => logs.scopeLogs.flatMap((scope) => scope.logRecords))) {
          received.push(Object.fromEntries(record.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.doubleValue ?? Number(value.intValue)])))
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, endpoint: `http://127.0.0.1:${port}` }
}

beforeAll(async () => {
  const started = await startReceiver()
  receiver = started.server
  endpoint = started.endpoint
})

afterAll(async () => {
  await new Promise<void>((resolve) => receiver?.close(() => resolve()))
})

// --- OpenCode reference (skipped): a Discord turn's full funnel. ---

describe.skip('a Discord turn sends the funnel events with anonymous identity props [SKIPPED: on the jcode seam bot_started aborts in startBot refreshCliContext (no OpenCode endpoint), session_created needs session.create which the seam has no write path for, and ingress cannot become a jcode prompt]', () => {
  let server: OpencodeTestServer
  let twin: TestTwin
  let bot: BotHandle
  let dataDir: string

  beforeAll(async () => {
    dataDir = tempDataDir()
    ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers: [slowZeroTokenMatcher] }), startTwin()])
    await warmUp({ server })
    await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
    bot = await startTestBot({
      dataDir,
      twin,
      server,
      analytics: createAnalytics({ dataDir, botMode: 'self_hosted', enabled: true, endpoint }),
    })
  }, 60_000)

  afterAll(async () => {
    await bot?.stop()
    await twin?.stop()
    await server?.stop()
    await removeDataDir(dataDir)
  })

  test('a Discord turn sends the funnel events with anonymous identity props', async () => {
    await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: `${SLOW_MARKER} analytics turn` })
    const thread = await twin.discord.channel(twin.channelId).waitForThread({ timeout: 8_000 })
    await waitForFooter({ discord: twin.discord, threadId: thread.id })
    await waitFor({
      label: 'turn_completed exported',
      check: async () => {
        await bot.analytics.flush()
        return received.some((event) => event['event.name'] === 'turn_completed')
      },
    })
    const installId = fs.readFileSync(`${dataDir}/install-id`, 'utf8').trim()
    expect(normalize({ events: received, installId })).toMatchInlineSnapshot()
  })
})

// --- jcode: a real turn observed through the seam and the real event loop. ---

const jcodeBinary = findJcodeBinary()
const jcodeSkipReason = jcodeBinary === null ? 'jcode binary not found at %LOCALAPPDATA%\\jcode\\bin\\jcode.exe (set JCODE_BIN instead)' : null

// A loopback Responses API mock. Zero usage keeps `tokens_used` out, matching
// the original test's deterministic zero-token reply. `delayMs` holds the whole
// stream back, so the persisted assistant timestamp is genuinely later than the
// user prompt's.
function startMockProvider(delayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
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
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const event = (type: string, payload: Record<string, unknown>) => {
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
        }
        const message = (text: string | null, status: string) => ({
          id: 'msg_1', type: 'message', role: 'assistant', status,
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
            ...base, status: 'completed', output: [done],
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
          },
        })
        response.end()
      }, delayMs)
    })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock provider has no port')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

// One real one-shot turn through the loopback provider. jcode, not this test,
// writes the persisted user and assistant messages.
function runJcodeTurn({ binary, home, cwd, url, prompt }: { binary: string; home: string; cwd: string; url: string; prompt: string }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['run', '-p', 'openai-api', '-m', 'gpt-5.5', '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd, prompt], {
      env: {
        ...process.env,
        JCODE_HOME: home,
        JCODE_NO_TELEMETRY: '1',
        OPENAI_BASE_URL: `${url}/v1`,
        OPENAI_API_BASE: `${url}/v1`,
        OPENAI_API_KEY: 'kimaki-analytics-test-key',
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

// Two reads a moment apart agree and an assistant message exists: the seam's
// first consistency-checked read can be honest.
async function settleStore(sessionsDir: string, timeoutMs = 60_000): Promise<{ sessionId: string }> {
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
      const value = JSON.parse(first) as { id?: unknown; messages?: Array<{ role?: unknown }> }
      if (typeof value.id !== 'string' || !Array.isArray(value.messages)) continue
      if (!value.messages.some((message) => message.role === 'assistant')) continue
      return { sessionId: value.id }
    } catch {
      continue
    }
  }
  throw new Error(`the jcode store at ${sessionsDir} never settled with an assistant message within ${timeoutMs}ms`)
}

// Blank the machine-specific and wall-clock values so the snapshot stays exact
// for every property the analytics layer owns.
function normalize({ events, installId }: { events: Array<Record<string, unknown>>; installId: string }): Array<Record<string, unknown>> {
  return events.map((event) => {
    const {
      ['custom.install_id']: id,
      ['custom.platform']: platform,
      ['custom.arch']: arch,
      ['custom.duration_sec']: secs,
      ...rest
    } = event
    return {
      ...rest,
      ...(secs === undefined ? {} : { 'custom.duration_sec': '<duration_sec>' }),
      'custom.install_id': id === installId ? '<install-id>' : id,
      'custom.platform': platform === process.platform ? '<platform>' : platform,
      'custom.arch': arch === process.arch ? '<arch>' : arch,
    }
  })
}

describe.skipIf(jcodeBinary === null)(`a real jcode turn sends turn_started and turn_completed with anonymous identity props${jcodeSkipReason ? ` [SKIPPED: ${jcodeSkipReason}]` : ''}`, () => {
  const binary = jcodeBinary!
  let root = ''
  let home = ''
  let cwd = ''
  let cursorDir = ''
  let dataDir = ''
  let mock: { url: string; close: () => Promise<void> }
  let primed: { sessionId: string }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-analytics-jcode-'))
    home = path.join(root, 'home')
    cwd = path.join(root, 'cwd')
    cursorDir = path.join(root, 'cursor')
    dataDir = path.join(root, 'data')
    for (const dir of [home, cwd, cursorDir, dataDir]) fs.mkdirSync(dir, { recursive: true })
    mock = await startMockProvider(TURN_DELAY_MS)
    // A session record is only persisted once a turn runs, so prime one turn
    // before the seam attaches. Its history is the funnel's first turn; the test
    // takes a baseline after it and asserts only the second turn.
    const run = await runJcodeTurn({ binary, home, cwd, url: mock.url, prompt: 'Reply with only: ok' })
    expect(run.code, `jcode run stderr: ${run.stderr}`).toBe(0)
    primed = await settleStore(path.join(home, 'sessions'))
  }, 180_000)

  afterAll(async () => {
    try { await mock?.close() } catch { /* provider connections are already destroyed */ }
    // Best-effort: Windows can keep handles open long enough to exceed a hook
    // timeout even after the test body passed and the connection stopped.
    void removeTempDir(root).catch(() => {
      process.stderr.write(`analytics jcode test: could not remove ${root}\n`)
    })
  }, 120_000)

  test('a real jcode turn reaches the analytics sink as one turn_started and one turn_completed', async () => {
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
    const analytics = createAnalytics({ dataDir, botMode: 'self_hosted', enabled: true, endpoint })
    const loop = createEventLoop({
      store,
      db: opened.db,
      discord,
      effects: runner,
      recorder,
      analytics,
      onRunEnded: () => {},
      onTranscriptDue: () => {},
    })
    let connection: Awaited<ReturnType<typeof createJcodeBotBackend>> | undefined
    try {
      await loop.bind({ threadId: 'thread-analytics', sessionId: primed.sessionId, channelId: 'channel-analytics', directory: cwd, isNew: false })
      // Construction polls once. The primed turn is emitted there, folded by
      // this loop: it is what makes the first funnel pair arrive.
      const promptEnv = {
        ...process.env,
        JCODE_HOME: home,
        JCODE_NO_TELEMETRY: '1',
        OPENAI_BASE_URL: `${mock.url}/v1`,
        OPENAI_API_BASE: `${mock.url}/v1`,
        OPENAI_API_KEY: 'kimaki-analytics-test-key',
      }
      connection = await createJcodeBotBackend({
        binary,
        home,
        sessionId: primed.sessionId,
        cursorDir,
        cwd,
        intervalMs: 50,
        provider: 'openai-api',
        model: 'gpt-5.5',
        toolProfile: 'none',
        promptTimeoutMs: 120_000,
        createPromptClient: (options) => createAcpClient({ ...options, env: promptEnv }),
        onEvent: (event) => loop.onEvent(event),
      })
      if (connection instanceof Error) throw connection
      await waitFor({
        label: 'the primed turn reached the analytics sink',
        check: async () => {
          await analytics.flush()
          return received.some((event) => event['event.name'] === 'turn_started') && received.some((event) => event['event.name'] === 'turn_completed')
        },
      })
      const baseline = received.length
      // Drive the second turn through the seam's ACP write path (same isolated
      // home and mock provider as the primed run). A second `jcode run` process
      // in the same home is rejected here with `Unsupported OpenAI model
      // 'gpt-5.5'` during model selection, so this is the honest way to produce
      // a persisted turn the poller can observe.
      const second = await connection.prompt('Reply with only: second')
      if (second instanceof Error) throw second
      expect(second.sessionId).toBe(primed.sessionId)
      // The poller is the only emitter; flush it until the second turn lands.
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && received.length - baseline < 2) {
        await connection.flush()
        await analytics.flush()
        await sleep(100)
      }
      const fresh = received.slice(baseline)
      expect(fresh.map((event) => event['event.name'])).toEqual(['turn_started', 'turn_completed'])
      const durations = fresh.flatMap((event) => {
        const duration = event['custom.duration_sec']
        return typeof duration === 'number' ? [duration] : []
      })
      expect(durations).toHaveLength(1)
      const [duration = Number.NaN] = durations
      expect(Number.isInteger(duration)).toBe(true)
      // The model delay guarantees the floor; the persisted timestamps provide it.
      expect(duration).toBeGreaterThanOrEqual(Math.floor(TURN_DELAY_MS / 1_000))
      // Generous ceiling: a real turn, not a value frozen by the code under test.
      expect(duration).toBeLessThan(60)
      const installId = fs.readFileSync(`${dataDir}/install-id`, 'utf8').trim()
      expect(normalize({ events: fresh, installId })).toMatchInlineSnapshot(`
        [
          {
            "custom.arch": "<arch>",
            "custom.bot_mode": "self_hosted",
            "custom.install_id": "<install-id>",
            "custom.platform": "<platform>",
            "custom.schema_version": 1,
            "event.name": "turn_started",
          },
          {
            "custom.arch": "<arch>",
            "custom.bot_mode": "self_hosted",
            "custom.duration_sec": "<duration_sec>",
            "custom.install_id": "<install-id>",
            "custom.platform": "<platform>",
            "custom.schema_version": 1,
            "event.name": "turn_completed",
          },
        ]
      `)
    } finally {
      if (connection && !(connection instanceof Error)) connection.stop()
      recorder.close()
      await opened.close()
      discord.destroy()
    }
  }, 120_000)
})
