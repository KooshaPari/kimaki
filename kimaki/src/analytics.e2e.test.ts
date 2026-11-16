// Product analytics end to end: the real Strada SDK exports OTLP JSON logs to
// a local receiver instead of strada.sh. One Discord turn produces the funnel
// events with the common identity props. The deterministic model reports zero
// tokens, so tokens_used is skipped here; analytics.test.ts covers it. The turn
// is slowed by a model delay so its wall-clock duration is measurable, which is
// what makes `duration_sec` assertable at all (see slowZeroTokenMatcher).
//
// STILL ON OPENCODE. The jcode bot seam (backend/jcode-bot-backend.ts) projects
// only session.text.ended and session.execution.succeeded out of a persisted
// Jcode record. This funnel also needs session.execution.started, which emits
// turn_started and seeds the usage turn_completed is folded from (analytics.ts
// foldAnalytics), and it needs session_created, emitted by startSession right
// after session.create (sessions.ts:496-507). The seam neither projects
// execution.started (named in JCODE_BOT_NOT_PROJECTED) nor offers a session
// write path: JcodeBotConnection.endpoint is null, so a Discord message cannot
// become a Jcode prompt. Porting would replace the Discord turn with synthetic
// events, so the funnel assertion stays here.

import fs from 'node:fs'
import http from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { removeDataDir } from './test/cleanup.ts'

import { createAnalytics } from './analytics.ts'
import type { BotHandle } from './main.ts'
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

// duration_sec is wall-clock: analytics.ts foldAnalytics rounds the difference
// between the OpenCode server's own execution.succeeded and execution.started
// timestamps. This test process never sees those timestamps, so the only way to
// pin the value is to make the turn genuinely long. Two seconds of model delay
// puts the duration deterministically at 2 or more whole seconds on any machine.
const SLOW_MARKER = 'analytics-slow-turn-marker'
const TURN_DELAY_MS = 2_000
// Same zero-token reply the bare deterministic model gives (so tokens_used stays
// skipped), streamed after TURN_DELAY_MS.
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

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string
let receiver: http.Server
const received: Array<Record<string, unknown>> = []

beforeAll(async () => {
  dataDir = tempDataDir()
  receiver = http.createServer((request, response) => {
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
  await new Promise<void>((resolve) => receiver.listen(port, '127.0.0.1', resolve))
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers: [slowZeroTokenMatcher] }), startTwin()])
  await warmUp({ server })
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({
    dataDir,
    twin,
    server,
    analytics: createAnalytics({ dataDir, botMode: 'self_hosted', enabled: true, endpoint: `http://127.0.0.1:${port}` }),
  })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await new Promise<void>((resolve) => receiver?.close(() => resolve()))
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
  // duration_sec cannot be frozen here: it is measured on the server's clock.
  // Assert its shape and the floor the model delay guarantees, then blank it so
  // the snapshot below stays exact for every other property.
  const durations = received.flatMap((event) => {
    const duration = event['custom.duration_sec']
    return typeof duration === 'number' ? [duration] : []
  })
  expect(durations).toHaveLength(1)
  const [duration = Number.NaN] = durations
  expect(Number.isInteger(duration)).toBe(true)
  expect(duration).toBeGreaterThanOrEqual(Math.floor(TURN_DELAY_MS / 1_000))
  // Generous ceiling: a real turn, not a value frozen by the code under test.
  expect(duration).toBeLessThan(60)
  expect(
    received.map((event) => {
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
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "custom.arch": "<arch>",
        "custom.bot_mode": "self_hosted",
        "custom.guild_count": 1,
        "custom.install_id": "<install-id>",
        "custom.platform": "<platform>",
        "custom.schema_version": 1,
        "custom.user_project_count": 1,
        "event.name": "bot_started",
      },
      {
        "custom.arch": "<arch>",
        "custom.bot_mode": "self_hosted",
        "custom.has_worktree": false,
        "custom.install_id": "<install-id>",
        "custom.platform": "<platform>",
        "custom.schema_version": 1,
        "custom.source": "discord",
        "event.name": "session_created",
      },
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
})
