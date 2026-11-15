// Non-interactive gateway onboarding through the real CLI process, like a
// cloud sandbox: stdout carries SSE events (install_url, authorized, ready).
// A local fake kimaki.dev answers /api/onboarding/status and, like the real
// OAuth callback, authorizes the new client in the twin, which plays
// gateway-proxy (REST scope rules enforced).

import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createApi } from './project.ts'
import {
  freePort,
  isFooter,
  startOpencodeTestServer,
  startTwin,
  tempDataDir,
  TEST_USER_ID,
  textParts,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const execFileAsync = promisify(execFile)
let server: OpencodeTestServer
let twin: TestTwin
let website: http.Server
let websiteUrl: string
let dataDir: string
let child: ChildProcessWithoutNullStreams | null = null

beforeAll(async () => {
  dataDir = tempDataDir()
  // Onboarding initialises <dataDir>/projects/kimaki with a plain `git init`, so its
  // branch follows this host's init.defaultBranch. Pin it, so the footer's branch is
  // the fixture's, not the host's (onboarding.e2e.test.ts does the same).
  const defaultProject = path.join(dataDir, 'projects', 'kimaki')
  fs.mkdirSync(defaultProject, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: defaultProject })
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers: [
        {
          id: 'onboarding-greeting',
          priority: 50,
          when: { latestUserTextIncludes: 'This is the Kimaki onboarding thread' },
          then: { parts: textParts('Want channels for your projects?') },
        },
      ],
    }),
    startTwin({ gateway: true }),
  ])
  await warmUp({ server })
  // Fake kimaki.dev: the user "installs" the bot as soon as the CLI polls.
  website = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/onboarding/status') {
      response.writeHead(404).end()
      return
    }
    twin.discord.authorizeGatewayClient({
      token: `${url.searchParams.get('client_id')}:${url.searchParams.get('secret')}`,
      guildIds: [twin.discord.guildId],
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ guild_id: twin.discord.guildId, discord_user_id: TEST_USER_ID }))
  })
  const port = await freePort()
  await new Promise<void>((resolve) => website.listen(port, '127.0.0.1', resolve))
  websiteUrl = `http://127.0.0.1:${port}`
}, 60_000)

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  await new Promise<void>((resolve) => website?.close(() => resolve()))
  await twin?.stop()
  await server?.stop()
  await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function sseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>)
}

// `waitFor` clamps every wait to 8-10s. That is enough when the CLI is already
// running, but this file starts the CLI itself: node plus the tsx loader costs
// seconds on Windows, and the documented `ready` event comes after the bot
// starts, onboarding runs and the voice channel is created. The budget is sized
// for the host, and the message reads stderr at the moment it throws, so an
// empty stderr is never evidence of anything.
async function waitForHost({
  label,
  timeoutMs = 120_000,
  check,
  diagnose,
  stopped,
}: {
  label: string
  timeoutMs?: number
  check: () => boolean
  diagnose: () => string
  // Non-null when the process that would emit the event is gone: no budget can help.
  stopped?: () => string | null
}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    // A process that already exited cannot emit another event. Failing here names the
    // cause; spending the budget on a wait that cannot succeed only hides it.
    const reason = stopped?.()
    if (reason) throw new Error(`${label} can no longer arrive (${reason}; ${diagnose()})`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms (${diagnose()})`)
}

async function waitForFooterCount({
  threadId,
  count,
  timeoutMs = 120_000,
}: {
  threadId: string
  count: number
  timeoutMs?: number
}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const footers = (await twin.discord.thread(threadId).getMessages()).filter(
      (message) => message.author.id === twin.discord.botUserId && isFooter(message),
    )
    if (footers.length >= count) return footers[count - 1]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for footer #${count} in thread ${threadId} after ${timeoutMs}ms`)
}

test('kimaki --gateway without a TTY installs, onboards and reports ready on stdout', async () => {
  const require = createRequire(import.meta.url)
  const proxy = new URL('/', twin.discord.restUrl).toString()
  const lockPort = await freePort()
  child = spawn(
    process.execPath,
    ['--import', pathToFileURL(require.resolve('tsx')).href, path.resolve('src/cli.ts'), '--data-dir', dataDir, '--gateway', '--machine-name', 'test-machine'],
    {
      env: {
        ...process.env,
        KIMAKI_WEBSITE_URL: websiteUrl,
        KIMAKI_GATEWAY_PROXY_URL: proxy,
        KIMAKI_LOCK_PORT: String(lockPort),
        KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile,
        OPENCODE_CONFIG_DIR: server.configDir,
      },
    },
  )
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()))
  const stopped = () => (child?.exitCode === null || child?.exitCode === undefined ? null : `the CLI process exited ${child.exitCode}`)
  await waitForHost({
    label: 'ready event',
    check: () => sseEvents(output.stdout).some((event) => event['type'] === 'ready'),
    diagnose: () => `stdout: ${output.stdout.slice(-800)} stderr: ${output.stderr.slice(-800)} exit: ${child?.exitCode}`,
    stopped,
  })

  const token = (sseEvents(output.stdout)[0]?.['url'] as string).match(/clientId=([^&]+)&clientSecret=([^&]+)/)
  expect(
    sseEvents(output.stdout).map((event) =>
      JSON.parse(
        JSON.stringify(event)
          .replaceAll(websiteUrl, '<website>')
          .replaceAll(token?.[1] ?? '-', '<clientId>')
          .replaceAll(token?.[2] ?? '-', '<secret>')
          .replaceAll(twin.discord.guildId, '<guild>'),
      ),
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "type": "install_url",
        "url": "<website>/discord-install?clientId=<clientId>&clientSecret=<secret>",
      },
      {
        "guild_id": "<guild>",
        "type": "authorized",
      },
      {
        "app_id": "1477605701202481173",
        "guild_ids": [
          "<guild>",
        ],
        "type": "ready",
      },
    ]
  `)

  // The contract: one `ready` carrying the app and guild ids, and a supervisor that
  // keeps running to serve onboarding and `kimaki restart`. A one-shot run would have
  // exited here; the CLI must not, and a failure would have set an exit code.
  expect({
    exitCode: child.exitCode,
    ready: sseEvents(output.stdout).filter((event) => event['type'] === 'ready').length,
  }).toEqual({ exitCode: null, ready: 1 })

  const channels = await createApi({ token: twin.discord.botToken, restUrl: twin.discord.restUrl }).guilds.getChannels(twin.discord.guildId)
  const names = new Map(channels.map((channel) => [channel.id, channel.name]))
  expect(channels.map((channel) => `${channel.name}${channel.parent_id ? ` (in ${names.get(channel.parent_id)})` : ''}`)).toMatchInlineSnapshot(`
    [
      "project",
      "random",
      "quiet",
      "Kimaki test-machine",
      "kimaki (in Kimaki test-machine)",
      "Kimaki voice test-machine",
    ]
  `)

  const kimakiChannel = channels.find((channel) => channel.name === 'kimaki')!
  // Coordinator mode is on by default: onboarding answers in the channel.
  await waitForFooterCount({ threadId: kimakiChannel.id, count: 1 })
  expect(await twin.discord.channel(kimakiChannel.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Kimaki** lets you code from Discord. Each project channel is linked to a folder on your computer. Write in the channel: one long session answers there and starts threads for the work.
    Reply here to add channels for your projects. <@200000000000000001>
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# Coordinator mode is on: this channel is one session that starts and manages project threads for you. Use /new-session for a thread without it. Turn it off with /toggle-coordinator or start kimaki with \`--coordinator false\`.
    Want channels for your projects?
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)

  // `kimaki restart`: the supervisor starts a new bot process, which reports ready again.
  const cli = (args: string[]) => execFileAsync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(lockPort) },
  })
  const before = JSON.parse((await cli(['status', '--json'])).stdout) as { pid: number }
  await cli(['restart'])
  await waitForHost({
    label: 'second ready event',
    check: () => sseEvents(output.stdout).filter((event) => event['type'] === 'ready').length === 2,
    diagnose: () => `stdout: ${output.stdout.slice(-800)} stderr: ${output.stderr.slice(-800)} exit: ${child?.exitCode}`,
    stopped,
  })
  const after = JSON.parse((await cli(['status', '--json'])).stdout) as { pid: number }
  // `kimaki restart` must respawn the bot, not kill the supervisor: exit code null
  // here is the product signal that the restart exited 75 and the supervisor looped.
  expect({
    newPid: after.pid !== before.pid,
    exitCode: child.exitCode,
    ready: sseEvents(output.stdout).filter((event) => event['type'] === 'ready').length,
  }).toEqual({ newPid: true, exitCode: null, ready: 2 })
}, 240_000)

test('--install-url --gateway prints the install URL with the callback and exits', async () => {
  const otherDataDir = tempDataDir()
  const require = createRequire(import.meta.url)
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const process_ = spawn(
      process.execPath,
      [
        '--import', pathToFileURL(require.resolve('tsx')).href, path.resolve('src/cli.ts'),
        '--data-dir', otherDataDir, '--install-url', '--gateway', '--gateway-callback-url', 'https://example.com/done',
      ],
      { env: { ...process.env, KIMAKI_WEBSITE_URL: 'https://kimaki.test' } },
    )
    const output = { stdout: '' }
    process_.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()))
    process_.once('exit', (code) => resolve({ code, stdout: output.stdout }))
  })
  fs.rmSync(otherDataDir, { recursive: true, force: true })
  expect({
    code: result.code,
    url: result.stdout.trim().replace(/clientId=[^&]+&clientSecret=[^&]+/, 'clientId=<clientId>&clientSecret=<secret>'),
  }).toMatchInlineSnapshot(`
    {
      "code": 0,
      "url": "https://kimaki.test/discord-install?clientId=<clientId>&clientSecret=<secret>&kimakiCallbackUrl=https%3A%2F%2Fexample.com%2Fdone",
    }
  `)
}, 120_000)
