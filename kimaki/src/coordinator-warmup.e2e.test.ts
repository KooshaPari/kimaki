// The coordinator warmup (plugin/coordinator.ts) with short windows: keep-alives while
// a worker thread runs, compaction when the channel is idle again, and the cap
// that stops the warmup while a worker is stuck.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_MODEL,
  TEST_USER_ID,
  isFooter,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  toolParts,
  waitFor,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const dataDir = tempDataDir()
// Big enough to be worth compacting (plugin/coordinator.ts MIN_COMPACT_TOKENS).
const bigUsage = { inputTokens: 120_000, outputTokens: 1, totalTokens: 120_001 }
const WARM_INTERVAL_MS = 400
const WARM_MAX_MS = 1_500

function bigText(text: string) {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: bigUsage },
  ] as const
}

// The shell tool hands its command to cmd.exe as one argv element on Windows, where the
// POSIX single quotes and `$OPENCODE_SESSION_ID` of an inline command do not apply. A
// script file passes the real command line to the shell: it groups the quoted values and
// expands the session variable itself, %VAR% in cmd.exe and $VAR in sh. Same pattern as
// coordinator.e2e.test.ts.
function dispatchScript(base: string) {
  return process.platform === 'win32' ? `${base}.cmd` : `sh ${base}.sh`
}

function scriptBase(worker: string) {
  return `warmup-${worker.replace(/-marker$/, '')}`
}

// Written once the server exists, in the directory the shell tool runs in.
function writeDispatchScripts({ channelId }: { channelId: string }) {
  const windows = process.platform === 'win32'
  const parentSession = windows ? '%OPENCODE_SESSION_ID%' : '"$OPENCODE_SESSION_ID"'
  for (const worker of ['quickjob-marker', 'stuckjob-marker']) {
    // Bounded wait: the coordinator answers IDLE right away, so its footer is not held up by
    // the worker, and the worker keeps running through the warmup window.
    const command = `kimaki send --channel ${channelId} --name "Worker ${worker}" --prompt "${worker} run" --parent-session ${parentSession} --wait 0.1`
    const file = path.join(server.projectDirectory, `${scriptBase(worker)}.${windows ? 'cmd' : 'sh'}`)
    fs.writeFileSync(file, windows ? `@echo off\r\n${command}\r\n` : `#!/bin/sh\n${command}\n`)
  }
}

// The coordinator starts a worker thread, then answers IDLE.
function delegate({ marker, worker }: { marker: string; worker: string }) {
  return [
    {
      id: `${marker}-send`,
      priority: 100,
      when: { latestUserTextIncludes: marker },
      then: { parts: toolParts({ toolCallId: `${marker}-call`, toolName: 'shell', input: { command: dispatchScript(scriptBase(worker)), description: 'Start the worker', hasSideEffect: true } }) },
    },
    { id: `${marker}-idle`, priority: 101, when: { latestUserTextIncludes: marker, rawPromptIncludes: `${marker}-call` }, then: { parts: [...bigText('IDLE')] } },
  ]
}

beforeAll(async () => {
  twin = await startTwin()
  server = await startOpencodeTestServer({
    plugins: [path.resolve('src/test/generate-log-plugin')],
    models: { [TEST_MODEL]: { name: TEST_MODEL, limit: { context: 1_000_000, output: 32_000 } } },
    matchers: [
      // OpenCode rejects a summary without the template headings.
      { id: 'compaction-summary', priority: 900, when: { latestUserTextIncludes: 'You MUST use this format for your response' }, then: { parts: textParts('## Objective\n- Keep coordinating') } },
      ...delegate({ marker: 'keepwarm-marker', worker: 'quickjob-marker' }),
      ...delegate({ marker: 'capped-marker', worker: 'stuckjob-marker' }),
      { id: 'quickjob', priority: 100, when: { latestUserTextIncludes: 'quickjob-marker' }, then: { parts: textParts('Quick job done.'), partDelaysMs: [0, 1_200, 0, 0] } },
      // Long enough that the cap's quiet window is measured while the worker is still stuck.
      { id: 'stuckjob', priority: 100, when: { latestUserTextIncludes: 'stuckjob-marker' }, then: { parts: textParts('Stuck job done.'), partDelaysMs: [0, 8_000, 0, 0] } },
      { id: 'woken', priority: 300, when: { latestUserTextIncludes: '<session-finished' }, then: { parts: [...bigText('The worker finished.')] } },
    ],
  })
  writeDispatchScripts({ channelId: twin.channelId })
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, coordinator: true, warmupTimers: { intervalMs: WARM_INTERVAL_MS, maxMs: WARM_MAX_MS } })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  // A child may still hold the temp dir for a moment on Windows.
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // Best effort: the OS cleans its temp dir.
  }
}, 60_000)

// Keep-alive requests of a session, from the test plugin.
function keepAlives(sessionId: string): number {
  const file = path.join(server.root, 'generate.log')
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line === sessionId).length
}

// A keep-alive count that no running warmup still moves: the previous test's wake can
// leave a warmup armed for one more `maxMs`, and counting across it inflates the cap.
async function settledKeepAlives(sessionId: string): Promise<number> {
  const quietMs = WARM_MAX_MS + 2 * WARM_INTERVAL_MS
  const deadline = Date.now() + 10_000
  let count = keepAlives(sessionId)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, quietMs))
    const next = keepAlives(sessionId)
    if (next === count) return next
    count = next
  }
  return count
}

async function compactions(sessionId: string): Promise<number> {
  const client = await server.client()
  const messages = await client.message.list({ sessionID: sessionId, order: 'desc', limit: 50 })
  return messages.data.filter((message) => message.type === 'compaction').length
}

// Idle markers: one after each turn of the coordinator, so a new one means the turn ended.
async function idleMarkers(sessionId: string): Promise<number> {
  const client = await server.client()
  const messages = await client.message.list({ sessionID: sessionId, order: 'desc', limit: 100 })
  return messages.data.filter((message) => message.type === 'idle').length
}

// `waitFor` clamps its deadline to 10s; a compaction request under load can take longer.
async function eventually(label: string, check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

// `waitForFooter` clamps to 10s too; the first coordinator turn can outrun that on a loaded host.
async function footerEventually(threadId: string, count = 1, timeoutMs = 25_000): Promise<void> {
  await eventually(`footer #${count} in thread ${threadId}`, async () => {
    const messages = await twin.discord.thread(threadId).getMessages()
    return messages.filter((message) => message.author.id === twin.discord.botUserId && isFooter(message)).length >= count
  }, timeoutMs)
}

test('the coordinator stays warm while its worker runs, then compacts', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Start keepwarm-marker' })
  const root = await waitFor({ label: 'coordinator session', check: async () => bot.store.getState().roots[channelId] })
  await footerEventually(channelId)
  await eventually('compaction after the wake', async () => (await compactions(root)) === 1)

  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Start keepwarm-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# Coordinator mode is on: this channel is one session that starts and manages project threads for you. Use /new-session for a thread without it. Turn it off with /toggle-coordinator or start kimaki with \`--coordinator false\`.
    -# ┣ shell _Start the worker_
    The worker finished.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  // The worker runs 1.2s, a keep-alive is due every 0.4s.
  expect(keepAlives(root)).toBeGreaterThan(0)
  const client = await server.client()
  const messages = await client.message.list({ sessionID: root, order: 'asc', limit: 30 })
  // No compaction before the wake: the channel was busy.
  expect(messages.data.map((message) => message.type)).toMatchInlineSnapshot(`
    [
      "synthetic",
      "synthetic",
      "user",
      "assistant",
      "assistant",
      "idle",
      "synthetic",
      "assistant",
      "idle",
      "compaction",
      "idle",
    ]
  `)
}, 60_000)

test('a stuck worker stops the warmup at the cap', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  // The wake of the previous test can leave a warmup armed: count only this one.
  const before = await settledKeepAlives(root)
  const idles = await idleMarkers(root)
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Start capped-marker' })
  const worker = await waitFor({
    label: 'stuck worker thread',
    check: async () => (await discord.channel(channelId).getThreads()).find((thread) => thread.name?.includes('stuckjob')),
  })
  // The coordinator answered IDLE; the worker runs 8s, far past every wait here.
  await eventually('the capped turn to go idle', async () => (await idleMarkers(root)) > idles)
  // A warm warmup ticks every intervalMs without end. The cap must make it go quiet for a
  // whole maxMs while the worker is still stuck; a missing or longer cap never goes quiet.
  let count = keepAlives(root)
  let quietSince = Date.now()
  const watchUntil = Date.now() + 2 * WARM_MAX_MS
  while (Date.now() < watchUntil) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = keepAlives(root)
    if (next !== count) {
      count = next
      quietSince = Date.now()
    }
  }
  expect(count - before).toBeGreaterThan(0)
  expect(Date.now() - quietSince).toBeGreaterThanOrEqual(WARM_MAX_MS)
  // Ending the cap also queues the compaction of the big coordinator context.
  await eventually('compaction at the cap', async () => (await compactions(root)) === 2)
  await footerEventually(worker.id)
}, 60_000)
