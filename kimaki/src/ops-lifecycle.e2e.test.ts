import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { openDb } from './db.ts'
import { removeTempDirs } from './test/cleanup.ts'
import { startOpencodeTestServer, startTwin, tempDataDir, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin

// A restarted follow process must not replay events that were already delivered.
function startFollow(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'follow', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done, stderr: () => stderr, stdout: () => stdout }
}

beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  opened.close()
}, 180_000)

afterAll(async () => {
  await Promise.all([server?.stop(), twin?.stop()])
  global.gc?.()
  await removeTempDirs([dataDir])
}, 180_000)

test('public ops lifecycle observes an external session without controlling it', async () => {
  const native = await server.client()
  const created = await native.session.create({ location: { directory: server.projectDirectory }, title: 'External session' })
  const identity = ['--host', 'pilot-host', '--endpoint', 'pilot-endpoint', '--native-session', created.id, '--tenant', twin.discord.guildId, '--surface', twin.channelId]
  const env: NodeJS.ProcessEnv = { ...process.env, KIMAKI_VITEST: '1', KIMAKI_TEST_LOGS: '1', KIMAKI_STRADA_ENABLED: '0', KIMAKI_DISCORD_REST_URL: twin.discord.restUrl }
  delete env.KIMAKI_BOT_TOKEN
  const cli = (args: string[]) => exec(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', ...args], { env, timeout: 180_000 })

  const discovered = JSON.parse((await cli(['discover', '--source', 'opencode', '--service-file', server.serviceFile, '--host', 'pilot-host', '--endpoint', 'pilot-endpoint'])).stdout)
  expect(discovered.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ key: expect.objectContaining({ nativeSessionId: created.id }) })]))
  const bindArgs = ['bind', '--data-dir', dataDir, ...identity, '--backend', 'opencode', '--request', 'pilot-request']
  const binding = JSON.parse((await cli(bindArgs)).stdout)
  expect(binding).toMatchObject({ mode: 'observe', publication_policy: 'none', state: 'active' })
  expect(JSON.parse((await cli(bindArgs)).stdout)).toEqual(binding)

  const followArgs = ['follow', '--service-file', server.serviceFile, ...identity, '--consent', '--timeout', '15000']
  await expect(cli(followArgs)).rejects.toMatchObject({ code: 1 })
  expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot('""')

  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', ...followArgs, '--token', twin.discord.botToken], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  try {
    await expect.poll(() => stderr, { timeout: 180_000 }).toContain('Follow subscription ready')
    await native.session.update({ sessionID: created.id, title: 'Private renamed title' })
    await expect.poll(async () => (await twin.discord.channel(twin.channelId).getMessages()).length, { timeout: 180_000 }).toBe(1)
    const result = await done
    expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      -# External OpenCode session activity observed."
    `)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ sent: 1, denied: 0 })
    expect(await twin.discord.channel(twin.channelId).getMessages()).toHaveLength(1)
    const detached = JSON.parse((await cli(['detach', binding.id, '--data-dir', dataDir, '--tenant', twin.discord.guildId])).stdout)
    expect(detached).toMatchObject({ id: binding.id, state: 'detached' })
    expect(await native.session.get({ sessionID: created.id })).toMatchObject({ id: created.id, title: 'Private renamed title' })
  } finally {
    child.kill()
    await done
  }
}, 300_000)

test('a restarted follow process republishes nothing it already delivered', async () => {
  const native = await server.client()
  const created = await native.session.create({ location: { directory: server.projectDirectory }, title: 'Restart session' })
  const identity = ['--service-file', server.serviceFile, '--host', 'restart-host', '--endpoint', 'restart-endpoint', '--native-session', created.id, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--consent', '--timeout', '15000']
  const env: NodeJS.ProcessEnv = { ...process.env, KIMAKI_VITEST: '1', KIMAKI_TEST_LOGS: '1', KIMAKI_STRADA_ENABLED: '0', KIMAKI_DISCORD_REST_URL: twin.discord.restUrl, KIMAKI_BOT_TOKEN: twin.discord.botToken }
  const count = async () => (await twin.discord.channel(twin.channelId).getMessages()).length
  const before = await count()
  const first = startFollow(identity, env)
  try {
    await expect.poll(() => first.stderr(), { timeout: 180_000 }).toContain('Follow subscription ready')
    await native.session.update({ sessionID: created.id, title: 'First rename' })
    await expect.poll(count, { timeout: 60_000 }).toBe(before + 1)
    // Simulate a crash and restart while the same native session keeps living.
    first.child.kill()
    await first.done
    const second = startFollow(identity, env)
    try {
      await expect.poll(() => second.stderr(), { timeout: 180_000 }).toContain('Follow subscription ready')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(await count()).toBe(before + 1)
      await native.session.update({ sessionID: created.id, title: 'Second rename' })
      await expect.poll(count, { timeout: 60_000 }).toBe(before + 2)
      const finished = await second.done
      expect(finished.code, finished.stderr).toBe(0)
      expect(JSON.parse(finished.stdout)).toMatchObject({ sent: 1, denied: 0 })
    } finally {
      second.child.kill()
      await second.done
    }
  } finally {
    first.child.kill()
  }
}, 600_000)
