// Queue cases in a thread that do not start from a queued Discord message:
// `kimaki send . queue`, a TUI prompt queued on the session, an item the TUI
// promotes to steer, a plain message while an item waits, and `. queue` on an
// idle thread. Split from queue.e2e so both files run in parallel.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { removeDataDir } from './test/cleanup.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  slowTextMatcher,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  toolParts,
  waitForBotMessageContaining,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const exec = promisify(execFile)

function reply(marker: string, text: string): DeterministicMatcher {
  return { id: marker, priority: 50, when: { latestUserTextIncludes: marker }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  slowTextMatcher({ marker: 'slow-marker', text: 'slow-done', delayMs: 1_200 }),
  reply('steer-marker', 'steer ok'),
  reply('queued-one', 'queued one ok'),
  reply('idle-marker', 'idle ok'),
]

// The CLI turn is held open on a file the test creates once the queue ack
// shows the prompt. A cold `tsx` spawn of src/cli.ts takes about as long as a
// `slowTextMatcher` delay, so with a timer the echo sometimes landed after the
// answer (and once after the whole turn, with no ack at all). The gate makes
// "busy when the CLI queues" a fact instead of a race.
const windows = process.platform === 'win32'
const gateCallID = 'gate-call'
const gateFlagName = 'gate-open.flag'
const gateScriptName = windows ? 'hold-gate.cmd' : 'hold-gate.sh'
const gateHold = 'Hold while the CLI queues'
const gateHeld = `_${gateHold}_`

function writeGateScript(directory: string): string {
  const flag = path.join(directory, gateFlagName)
  const scriptPath = path.join(directory, gateScriptName)
  const script = windows
    ? `@echo off\r\n:wait\r\nif exist "${flag}" goto open\r\nping -n 2 127.0.0.1 >nul\r\ngoto wait\r\n:open\r\necho gate-open\r\n`
    : `while [ ! -f "${flag}" ]; do sleep 0.1; done\necho gate-open\n`
  fs.writeFileSync(scriptPath, script)
  // The shell tool runs PowerShell on Windows, which does not look in the
  // current directory for a bare name (`hold-gate.cmd` -> command not found),
  // so it never held. Call the script by its absolute path instead.
  return windows ? `cmd /c "${scriptPath}"` : `sh "${scriptPath}"`
}

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  // Pushed after start: the hold script lives in the project directory, which
  // the server creates. `matchers` is the array the test model reads per request.
  matchers.push(
    {
      id: gateCallID,
      priority: 20,
      when: { latestUserTextIncludes: 'gate-marker' },
      then: { parts: toolParts({ toolCallId: gateCallID, toolName: 'shell', input: { command: writeGateScript(server.projectDirectory), description: gateHold, hasSideEffect: true } }) },
    },
    // The answer only after the held command returned: the queued CLI prompt
    // has been acked by then, so the echo always precedes the answer text.
    {
      id: 'gate-done',
      priority: 21,
      when: { latestUserTextIncludes: 'gate-marker', rawPromptIncludes: gateCallID },
      then: { parts: textParts('slow-done') },
    },
  )
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await removeDataDir(dataDir)
})

// Starts a slow turn in a new thread and waits until it runs (banner posted).
async function startSlowThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: `${content} slow-marker` })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  await waitForBotMessageContaining({ discord, threadId: thread.id, text: '*using ' })
  return thread
}

// A turn that stays busy until `openGate()`: a held shell command is running,
// so a prompt sent now is queued, not raced against an answer.
async function startGatedThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: `${content} gate-marker` })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  // The tool line means the command is running, so the thread is busy.
  await waitForBotMessageContaining({ discord, threadId: thread.id, text: gateHeld })
  return thread
}

function openGate() {
  fs.writeFileSync(path.join(server.projectDirectory, gateFlagName), '')
}

function rootOf(threadId: string): string {
  const sessionID = bot.store.getState().roots[threadId]
  if (!sessionID) throw new Error(`thread ${threadId} has no session`)
  return sessionID
}

test('CLI . queue into a busy thread shows the full text, then replies to it when it runs', async () => {
  const thread = await startGatedThread('CLI queue')
  await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'send', '--thread', thread.id, '--prompt', 'From the CLI queued-one\nsecond line. queue', '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port) },
  })
  // The product's own signal that the CLI prompt reached the busy thread: the
  // ack shows the prompt and its position. Only then does the held turn answer.
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'Queued at position 1' })
  openGate()
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued one ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    CLI queue gate-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _Hold while the CLI queues_
    -# » **CLI:** From the CLI queued-one
    -# second line

    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to TestBot: -# » **CLI:** From the CLI queued-one -#]
    -# Queued message sent
    queued one ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a prompt queued from the TUI shows its text, then a reply to it when it runs', async () => {
  const thread = await startSlowThread('TUI queue')
  const client = await server.client()
  await client.session.prompt({ sessionID: rootOf(thread.id), text: 'Typed in the TUI queued-one', delivery: 'queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued one ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    TUI queue slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# » **user:** Typed in the TUI queued-one
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to TestBot: -# » **user:** Typed in the TUI queued-o]
    -# Queued message sent
    queued one ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a queued item the TUI sends now (steer) gets its reply when promoted, once', async () => {
  const thread = await startSlowThread('Promote me')
  const queued = await twin.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Run me now queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  const client = await server.client()
  await client.session.inbox.update({ sessionID: rootOf(thread.id), inboxID: `msg_discord_${queued.id}`, delivery: 'steer' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued one ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Promote me slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    Run me now queued-one. queue
    --- from: assistant (TestBot)
    [reply to tommy: Run me now queued-one. queue]
    -# Queued
    [reply to tommy: Run me now queued-one. queue]
    -# Queued message sent
    slow-done
    queued one ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a plain message while an item waits runs first, then the queued item gets its reply', async () => {
  const thread = await startSlowThread('Steer past the queue')
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendMessage({ content: 'Later queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  await user.sendMessage({ content: 'Now steer-marker' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued one ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Steer past the queue slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    Later queued-one. queue
    --- from: assistant (TestBot)
    [reply to tommy: Later queued-one. queue]
    -# Queued
    --- from: user (tommy)
    Now steer-marker
    --- from: assistant (TestBot)
    steer ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to tommy: Later queued-one. queue]
    -# Queued message sent
    queued one ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('. queue on an idle thread runs at once, like a plain message', async () => {
  const thread = await startSlowThread('Idle queue')
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  await twin.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Nothing waits idle-marker. queue' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Idle queue slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Nothing waits idle-marker. queue
    --- from: assistant (TestBot)
    idle ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
