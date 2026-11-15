// Phase 0: the bot starts against the digital twin and an isolated OpenCode
// service, answers /health, and reconnects after the service restarts on a
// new port with a new password.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import dedent from 'string-dedent'
import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest'

import { startLockServer } from './lock-server.ts'
import type { BotHandle } from './main.ts'
import {
  startOpencodeTestServer,
  freePort,
  seedProjectChannel,
  TEST_USER_ID,
  waitForFooter,
  startTestBot,
  startTwin,
  tempDataDir,
  waitFor,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

// Windows keeps the bot's sqlite file open until the test process exits, so the
// removal can fail after a passing run: retry briefly, then warn instead of failing.
function removeTempDir(directory: string) {
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
  catch (cause) { console.warn(`could not remove ${directory}`, cause) }
}

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  // A Windows temp dir can stay locked for a moment after the bot, its shim
  // child and libsql close: rmSync retries EPERM/EBUSY with these options.
  removeTempDir(dataDir)
})

test('bot answers /health and reaches the OpenCode service', async () => {
  const health = await fetch(`http://127.0.0.1:${bot.lock.port}/health`).then((response) => response.json())
  expect(health).toEqual({ status: 'ok', pid: process.pid, wrapperPid: null })
  expect(bot.discord.isReady()).toBe(true)
  expect(bot.opencode.connected).toBe(true)
  const client = bot.opencode.endpoint?.client
  expect(await client?.session.active()).toEqual({})
})

test('bot reconnects after the OpenCode service restarts with a new port', async () => {
  const before = bot.opencode.endpoint?.url
  await server.kill()
  await waitFor({ label: 'disconnect', check: async () => !bot.opencode.connected })
  // Added while disconnected: no catalog event reaches the bot, the reconnect re-reads the catalog.
  const skillFile = path.join(server.skillsDirectory, 'gap', 'SKILL.md')
  fs.mkdirSync(path.dirname(skillFile), { recursive: true })
  fs.writeFileSync(skillFile, '---\nname: gap\ndescription: Added while disconnected\n---\nGap.\n')
  await server.start()
  await waitFor({ label: 'reconnect', timeout: 10_000, check: async () => bot.opencode.connected })
  expect(bot.opencode.endpoint?.url).not.toBe(before)
  expect(await bot.opencode.endpoint?.client.session.active()).toEqual({})
  await waitFor({
    label: 'gap-skill command',
    check: async () => (await twin.discord.getRegisteredCommands()).some((command) => command.name === 'gap-skill'),
  })
}, 30_000)

test('the lock server creates a missing data dir (fresh install)', async () => {
  const root = tempDataDir()
  onTestFinished(() => removeTempDir(root))
  const missing = path.join(root, 'not', 'created')
  const lock = await startLockServer({ port: await freePort(), dataDir: missing })
  if (lock instanceof Error) throw lock
  const tokenFile = path.join(missing, 'lock-token')
  // Windows has no POSIX mode bits: writeFile's mode and chmod are no-ops there,
  // so 0600 is only observable where the mode exists.
  if (process.platform === 'win32') expect(fs.statSync(tokenFile).isFile()).toBe(true)
  else expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
  await lock.close()
})

test('a second bot on the same lock port stops the running one and takes over', async () => {
  const otherData = tempDataDir()
  const port = await freePort()
  await seedProjectChannel({ dataDir: otherData, channelId: twin.quietChannelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  const code = dedent`
    import { startBot } from ${JSON.stringify(pathToFileURL(path.resolve('src/main.ts')).href)}
    import { startLockServer } from ${JSON.stringify(pathToFileURL(path.resolve('src/lock-server.ts')).href)}
    import { disabledAnalytics } from ${JSON.stringify(pathToFileURL(path.resolve('src/analytics.ts')).href)}
    const lock = await startLockServer({ port: ${port}, dataDir: ${JSON.stringify(otherData)} })
    if (lock instanceof Error) throw lock
    const result = await startBot({ analytics: disabledAnalytics, lock, ...${JSON.stringify({ dataDir: otherData, token: twin.discord.botToken, appId: twin.discord.botUserId, discordRestUrl: twin.discord.restUrl, opencodeServiceFile: server.serviceFile, opencodeConfigDir: server.configDir, opencodeDbFile: server.dbFile, ensureOpencode: false, kimakiArgv: ['kimaki'] })} })
    if (result instanceof Error) throw result
    process.send({ ready: true })
    process.once('SIGTERM', async () => { await result.stop(); process.exit(0) })
  `
  const child = spawn(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--input-type=module', '--eval', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  // A child that exits before `ready` fails the test: its stderr says why.
  let childStderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { childStderr += chunk.toString() })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let replacement: BotHandle | undefined
  // One teardown for both bots, in one order: the replacement must be stopped
  // before its data dir is removed, or Windows keeps its sqlite file open.
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
    await replacement?.stop()
    removeTempDir(otherData)
  })
  const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error(`Old bot exited before ready: ${childStderr.trim()}`))) })
  await ready
  expect(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json())).toEqual({ status: 'ok', pid: child.pid, wrapperPid: null })
  // The replacement stops the old bot (SIGTERM) before it binds the port.
  replacement = await startTestBot({ dataDir: otherData, twin, server, lockPort: port })
  await exited
  // Windows has no graceful SIGTERM: process.kill terminates the child, so the
  // POSIX handler (result.stop()) never runs and the exit code is 1 there.
  expect(child.exitCode).toBe(process.platform === 'win32' ? 1 : 0)
  expect(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json())).toEqual({ status: 'ok', pid: process.pid, wrapperPid: null })
  await twin.discord.channel(twin.quietChannelId).user(TEST_USER_ID).sendMessage({ content: 'Lock takeover prompt' })
  const thread = await twin.discord.channel(twin.quietChannelId).waitForThread({ timeout: 8000 })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Lock takeover prompt
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *main ⋅ Ns ⋅ deterministic-v2*"
  `)
})
