import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startOpencodeTestServer, startTwin, type OpencodeTestServer, type TestTwin } from './test/harness.js'

let server: OpencodeTestServer
let twin: TestTwin
beforeAll(async () => { [server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()]) }, 75_000)
afterAll(async () => { await Promise.all([server?.stop(), twin?.stop()]) }, 30_000)

test('follow publishes one fixed line only with consent', async () => {
  const native = await server.client()
  const created = await native.session.create({ location: { directory: server.projectDirectory }, title: 'External session' })
  const args = ['--service-file', server.serviceFile, '--host', 'host', '--endpoint', 'endpoint', '--native-session', created.id, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--timeout', '9000']
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
  const refused = await run([]).done
  expect(refused.code).not.toBe(0)
  await native.session.update({ sessionID: created.id, title: 'Without consent' })
  expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot('""')
  const follow = run(['--consent'])
  try {
    await expect.poll(() => follow.stderr(), { timeout: 120_000 }).toContain('Follow subscription ready')
    await native.session.update({ sessionID: created.id, title: 'Private rename @everyone' })
    await expect.poll(async () => (await twin.discord.channel(twin.channelId).getMessages()).length, { timeout: 60_000 }).toBe(1)
    const result = await follow.done
    expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      -# External OpenCode session activity observed."
    `)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ sent: 1, denied: 0 })
    expect(await twin.discord.channel(twin.channelId).getMessages()).toHaveLength(1)
  } finally { follow.child.kill() }
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
