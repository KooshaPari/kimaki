import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { JCODE_SKIP_NO_BINARY, startJcodeTestHub } from './test/jcode-harness.ts'
import { startTwin, type TestTwin } from './test/harness.js'

const execFileAsync = promisify(execFile)

let twin: TestTwin
beforeAll(async () => { twin = await startTwin() }, 75_000)
afterAll(async () => { await twin?.stop() }, 30_000)

test('follow publishes one fixed line only with consent', async (ctx) => {
  // Honest skip: the jcode harness names the exact reason the runtime is absent.
  // The handle also proves the binary path this test will actually execute.
  const harness = await startJcodeTestHub()
  const skipReason = harness.skipReason
  const binary = harness.binary
  await harness.close()
  if (skipReason !== null || binary === null) {
    expect(skipReason).toBe(JCODE_SKIP_NO_BINARY)
    ctx.skip(true, skipReason ?? JCODE_SKIP_NO_BINARY)
    return
  }
  // A real session record, written by the real binary into an explicit home.
  // `ops follow --source jcode` polls persisted records, so the seed has to be
  // one; a synthetic rewrite would only test this test's own JSON.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-follow-real-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  const jcodeEnv = { ...process.env, JCODE_HOME: home, JCODE_NO_TELEMETRY: '1' }
  const secret = 'SYNTHETIC SECRET BODY'
  await execFileAsync(binary, ['run', secret, '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd], { env: jcodeEnv, timeout: 120_000 }).catch(() => undefined)
  const sessions = path.join(home, 'sessions')
  const nativeId = fs.readdirSync(sessions).find((name) => name.endsWith('.json'))!.replace(/\.json$/, '')
  const args = ['--source', 'jcode', '--jcode-home', home, '--host', 'host', '--endpoint', 'endpoint', '--native-session', nativeId, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--timeout', '9000']
  const run = (extra: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'follow', ...args, ...extra], {
      env: { ...process.env, KIMAKI_TEST_LOGS: '1', KIMAKI_BOT_TOKEN: twin.discord.botToken, KIMAKI_DISCORD_REST_URL: twin.discord.restUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
    return { child, done, stderr: () => stderr }
  }
  try {
    const refused = await run([]).done
    expect(refused.code).not.toBe(0)
    expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot('""')
    const follow = run(['--consent'])
    try {
      await expect.poll(() => follow.stderr(), { timeout: 120_000 }).toContain('Follow subscription ready')
      // A real rename through the product's own CLI, not a JSON rewrite: this
      // is the write the follower has to notice.
      await execFileAsync(binary, ['session', 'rename', nativeId, 'Private rename @everyone', '--no-update', '--quiet', '-C', cwd], { env: jcodeEnv, timeout: 30_000 })
      await expect.poll(async () => (await twin.discord.channel(twin.channelId).getMessages()).length, { timeout: 60_000 }).toBe(1)
      const result = await follow.done
      expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        -# External Jcode session activity observed."
      `)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ sent: 1, denied: 0 })
      expect(await twin.discord.channel(twin.channelId).getMessages()).toHaveLength(1)
      // Only metadata is published: the transcript stays in the native store.
      expect(await twin.discord.channel(twin.channelId).text()).not.toContain(secret)
      expect(await twin.discord.channel(twin.channelId).text()).not.toContain('Private rename')
    } finally { follow.child.kill() }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 300_000)

test('follow publishes a Jcode rename from an explicit home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-follow-'))
  const sessions = path.join(home, 'sessions')
  fs.mkdirSync(sessions)
  const sessionId = 'session_synthetic_1'
  const record = (title: string, messages: unknown[]) => JSON.stringify({
    id: sessionId,
    title,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: new Date().toISOString(),
    provider_key: 'synthetic',
    model: 'synthetic',
    working_dir: 'C:/synthetic/project',
    messages,
  })
  const file = path.join(sessions, `${sessionId}.json`)
  fs.writeFileSync(file, record('Before', [{ role: 'user', content: 'SYNTHETIC SECRET BODY' }]))
  const env = { ...process.env, KIMAKI_TEST_LOGS: '1', KIMAKI_BOT_TOKEN: twin.discord.botToken, KIMAKI_DISCORD_REST_URL: twin.discord.restUrl }
  const args = ['--source', 'jcode', '--jcode-home', home, '--host', 'jcode-host', '--endpoint', 'jcode-endpoint', '--native-session', sessionId, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--timeout', '9000']
  const before = (await twin.discord.channel(twin.channelId).getMessages()).length
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'follow', ...args, '--consent'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    fs.writeFileSync(file, record('After rename @everyone', [
      { role: 'user', content: 'SYNTHETIC SECRET BODY' },
      { role: 'assistant', content: 'SYNTHETIC SECRET REPLY' },
    ]))
    await expect.poll(async () => (await twin.discord.channel(twin.channelId).getMessages()).length, { timeout: 20_000 }).toBe(before + 1)
    const finished = await done
    expect(finished.code, finished.stderr).toBe(0)
    expect(JSON.parse(finished.stdout)).toMatchObject({ sent: 1, denied: 0 })
    const text = await twin.discord.channel(twin.channelId).text()
    expect(text).toContain('-# External Jcode session activity observed.')
    expect(text).not.toContain('SYNTHETIC')
    expect(text).not.toContain('After rename')
  } finally {
    child.kill()
    await done.catch(() => undefined)
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 300_000)

test('a 429 on the follow notice fails once instead of retrying', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-429-'))
  const sessions = path.join(home, 'sessions')
  fs.mkdirSync(sessions)
  const sessionId = 'session_synthetic_429'
  const record = (title: string) => JSON.stringify({
    id: sessionId,
    title,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: new Date().toISOString(),
    provider_key: 'synthetic',
    model: 'synthetic',
    working_dir: 'C:/synthetic/project',
    messages: [{ role: 'user', content: 'SYNTHETIC SECRET BODY' }],
  })
  const file = path.join(sessions, `${sessionId}.json`)
  fs.writeFileSync(file, record('Before'))
  let posts = 0
  const stub = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/v10/channels/${twin.channelId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: twin.channelId, guild_id: twin.discord.guildId, type: 0, name: 'general' }))
      return
    }
    if (request.method === 'POST' && request.url === `/v10/channels/${twin.channelId}/messages`) {
      posts += 1
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      response.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()))
  const port = (stub.address() as AddressInfo).port
  const env = { ...process.env, KIMAKI_TEST_LOGS: '1', KIMAKI_BOT_TOKEN: 'stub', KIMAKI_DISCORD_REST_URL: `http://127.0.0.1:${port}` }
  const args = ['--source', 'jcode', '--jcode-home', home, '--host', 'jcode-host', '--endpoint', 'jcode-endpoint', '--native-session', sessionId, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--timeout', '9000']
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'follow', ...args, '--consent'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    fs.writeFileSync(file, record('Rate limited rename'))
    const result = await done
    expect(posts, result.stderr).toBe(1)
    expect(result.code).not.toBe(0)
    const output = `${result.stdout}${result.stderr}`
    expect(output).not.toContain('"kind":"sent"')
    expect(output.trim().length).toBeGreaterThan(0)
  } finally {
    child.kill()
    await done.catch(() => undefined)
    await new Promise<void>((resolve) => stub.close(() => resolve()))
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 300_000)
