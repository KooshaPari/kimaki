// OpenCode loads agents lazily: user agents missing at startup get their
// /<agent>-agent command when agent.updated arrives.

import fs from 'node:fs'
import path from 'node:path'
import { Routes } from 'discord.js'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { removeTempDir } from './test/cleanup.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitForFooter,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const matchers: DeterministicMatcher[] = [
  { id: 'late', priority: 500, when: { latestUserTextIncludes: 'late-marker' }, then: { parts: textParts('late reply') } },
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers, agents: { late: { description: 'Late agent', mode: 'primary' } } }), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await removeTempDir(dataDir)
})

async function registeredNames() {
  const commands = await twin.discord.getRegisteredCommands()
  return commands.map((command) => command.name)
}

test('agents loaded after startup get their slash commands', async () => {
  // A cold OpenCode has no user agents when the bot first registers commands;
  // agent.updated fires when the catalog finishes loading; the refresh follows it.
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && !(await registeredNames()).includes('late-agent')) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(await registeredNames()).toContain('late-agent')

  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord
    .channel(channelId)
    .user(TEST_USER_ID)
    .runSlashCommand({ name: 'late-agent', options: [{ name: 'prompt', type: 3, value: 'Go late-marker' }] })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (found) => !before.has(found.id) })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# » **tommy:** Go late-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ late*
    late reply
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ late*"
  `)
})

test('a skill change adds its command; catalog events with the same catalog write nothing to Discord', async () => {
  const skillFile = path.join(server.skillsDirectory, 'demo', 'SKILL.md')
  const skillText = '---\nname: demo\ndescription: Demo skill\n---\nDemo.\n'
  const nextCatalogEvent = () =>
    new Promise<void>((resolve) => {
      const stop = bot.opencode.subscribe((event) => {
        if (event.type !== 'skill.updated') return
        stop()
        resolve()
      })
    })
  const waitForCommand = async () => {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !(await registeredNames()).includes('demo-skill')) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // Counted from before the first write: adding demo-skill registers the commands
  // with a bulk write of its own, so that write has to be drained before the test
  // can claim that the next, identical catalog event wrote nothing.
  const bulkWrites: string[] = []
  const commandsRoute = Routes.applicationGuildCommands(bot.discord.user!.id, twin.discord.guildId)
  bot.discord.rest.on('response', (request) => {
    if (request.method === 'PUT' && request.path === commandsRoute) bulkWrites.push(request.path)
  })

  fs.mkdirSync(path.dirname(skillFile), { recursive: true })
  fs.writeFileSync(skillFile, skillText)
  await waitForCommand()
  expect(await registeredNames()).toContain('demo-skill')

  // waitForCommand polls the twin, which applies a bulk write when the bot sends
  // it; the bot's registration response is still in flight then. Wait for that
  // response, then count from an empty list so only later writes are observed.
  const drained = Date.now() + 8_000
  while (Date.now() < drained && bulkWrites.length === 0) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(bulkWrites).toEqual([commandsRoute])
  bulkWrites.length = 0

  // Same file content again: OpenCode rescans and publishes skill.updated, the commands stay the same.
  const event = nextCatalogEvent()
  fs.writeFileSync(skillFile, skillText)
  await event
  // Let the pass that the event started finish.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(bulkWrites).toEqual([])
})
