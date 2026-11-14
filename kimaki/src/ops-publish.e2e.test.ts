import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { publishObservedMetadata } from './ops/discord/publication.ts'
import type { OpenCodeObservedEvent } from './ops/runtime/opencode.ts'

const exec = promisify(execFile)
const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'opencode', nativeSessionId: 'session' }
const observed: OpenCodeObservedEvent = {
  schemaVersion: 1, key,
  source: { hostId: 'host', endpointId: 'endpoint', backendKind: 'opencode', version: '2.2.5' },
  raw: { id: 'event', created: 1, type: 'session.renamed', data: { sessionID: 'session', title: 'private @everyone' }, durable: { aggregateID: 'session', seq: 1, version: 1 } },
}
let discord: DigitalDiscord
let channelId: string
let dir: string
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-publish-'))
  fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(observed))
  discord = new DigitalDiscord({ guild: { name: 'Test Server' }, channels: [{ name: 'general', type: ChannelType.GuildText }] })
  await discord.start()
  channelId = (await discord.prisma.channel.findMany())[0]!.id
}, 30_000)
afterAll(async () => {
  await discord?.stop()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})
function cli(args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'ops', 'publish', ...args], {
    timeout: 120_000,
    env: { ...process.env, KIMAKI_BOT_TOKEN: discord.botToken, KIMAKI_DISCORD_REST_URL: discord.restUrl },
  })
}
function args() {
  return ['--tenant', discord.guildId, '--surface', channelId, '--host', 'host', '--endpoint', 'endpoint', '--native-session', 'session', '--event-file', path.join(dir, 'event.json')]
}
test('CLI requires consent and explicit scope, then posts exactly one fixed metadata line', async () => {
  const missing = await cli(args()).then(() => null, (error: Error) => error)
  expect(missing).toBeInstanceOf(Error)
  // Two representative omissions: each CLI spawn costs a full runtime import.
  for (const flag of ['--tenant', '--native-session']) {
    const input = args()
    input.splice(input.indexOf(flag), 2)
    await expect(cli([...input, '--consent'])).rejects.toThrow()
  }
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot('""')
  const result = await cli([...args(), '--consent'])
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# External OpenCode session activity observed."
  `)
  expect(JSON.parse(result.stdout)).toEqual({ kind: 'sent' })
  expect(await discord.channel(channelId).getMessages()).toHaveLength(1)
}, 300_000)
test('revoked consent during real twin channel lookup posts nothing', async () => {
  const second = new DigitalDiscord({ guild: { name: 'Second' }, channels: [{ name: 'general', type: ChannelType.GuildText }] })
  await second.start()
  try {
    const surfaceId = (await second.prisma.channel.findMany())[0]!.id
    const target = { tenantId: second.guildId, surfaceId, session: key }
    const grant = { ...target, publication: 'metadata' as const, consent: true }
    const rest = new REST({ api: second.restUrl, version: '10' }).setToken(second.botToken)
    const get = rest.get.bind(rest)
    vi.spyOn(rest, 'get').mockImplementation(async (...params) => {
      const channel = await get(...params)
      grant.consent = false
      return channel
    })
    const before = (await second.channel(surfaceId).getMessages()).length
    const result = await publishObservedMetadata({ rest, target, observed, grant })
    // Compare counts: twin instances in one process may share channel identity.
    expect((await second.channel(surfaceId).getMessages()).length).toBe(before)
    expect(result).toEqual({ kind: 'denied' })
  } finally { await second.stop() }
})

test('malformed and mismatched event files are refused before any Discord call', async () => {
  const before = (await discord.channel(channelId).getMessages()).length
  const invalid = path.join(dir, 'invalid.json')
  fs.writeFileSync(invalid, '{"not": "an event"')
  await expect(cli([...args(), '--consent', '--event-file', invalid])).rejects.toMatchObject({ code: 1 })
  const other = path.join(dir, 'other-session.json')
  fs.writeFileSync(other, JSON.stringify({ ...observed, key: { ...key, nativeSessionId: 'other' } }))
  await expect(cli([...args(), '--consent', '--event-file', other])).rejects.toMatchObject({ code: 1 })
  expect((await discord.channel(channelId).getMessages()).length).toBe(before)
}, 300_000)

test('an unreachable Discord endpoint fails without reporting success', async () => {
  const unreachable = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'ops', 'publish', ...args(), '--consent'], {
    timeout: 120_000,
    env: { ...process.env, KIMAKI_BOT_TOKEN: 'unused', KIMAKI_DISCORD_REST_URL: 'http://127.0.0.1:1' },
  }).then(() => null, (error: Error) => error)
  expect(unreachable).toBeInstanceOf(Error)
  expect(JSON.stringify(unreachable)).not.toContain('"kind":"sent"')
}, 300_000)

test('a 429 on the send fails once instead of retrying or claiming a send', async () => {
  let posts = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/v10/channels/${channelId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: channelId, guild_id: discord.guildId, type: 0, name: 'general' }))
      return
    }
    if (request.method === 'POST' && request.url === `/v10/channels/${channelId}/messages`) {
      posts += 1
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      response.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    const failure = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'ops', 'publish', ...args(), '--consent'], {
      timeout: 120_000,
      env: { ...process.env, KIMAKI_BOT_TOKEN: 'stub', KIMAKI_DISCORD_REST_URL: `http://127.0.0.1:${port}` },
    }).then(() => null, (error: Error & { stdout?: string; stderr?: string }) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(posts).toBe(1)
    const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`
    expect(output).not.toContain('"kind":"sent"')
    expect(output.trim().length).toBeGreaterThan(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 300_000)

test('a 429 on the channel lookup posts nothing', async () => {
  let posts = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/v10/channels/${channelId}`) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      response.end(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }))
      return
    }
    if (request.method === 'POST') {
      posts += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    const failure = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'ops', 'publish', ...args(), '--consent'], {
      timeout: 120_000,
      env: { ...process.env, KIMAKI_BOT_TOKEN: 'stub', KIMAKI_DISCORD_REST_URL: `http://127.0.0.1:${port}` },
    }).then(() => null, (error: Error & { stdout?: string; stderr?: string }) => error)
    expect(failure).toBeInstanceOf(Error)
    // The surface lookup is refused, so no send is ever attempted.
    expect(posts).toBe(0)
    const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`
    expect(output).not.toContain('"kind":"sent"')
    expect(output.trim().length).toBeGreaterThan(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 300_000)

test('a 503 on the send is not retried into a second delivery attempt', async () => {
  let posts = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/v10/channels/${channelId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: channelId, guild_id: discord.guildId, type: 0, name: 'general' }))
      return
    }
    if (request.method === 'POST' && request.url === `/v10/channels/${channelId}/messages`) {
      posts += 1
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' })
      response.end(JSON.stringify({ message: 'Service Unavailable', code: 0 }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    const failure = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'ops', 'publish', ...args(), '--consent'], {
      timeout: 120_000,
      env: { ...process.env, KIMAKI_BOT_TOKEN: 'stub', KIMAKI_DISCORD_REST_URL: `http://127.0.0.1:${port}` },
    }).then(() => null, (error: Error & { stdout?: string; stderr?: string }) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(posts).toBe(1)
    const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`
    expect(output).not.toContain('"kind":"sent"')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 300_000)

test('a 500 on the send is not retried into a second delivery attempt', async () => {
  let posts = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/v10/channels/${channelId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: channelId, guild_id: discord.guildId, type: 0, name: 'general' }))
      return
    }
    if (request.method === 'POST' && request.url === `/v10/channels/${channelId}/messages`) {
      posts += 1
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'Internal Server Error', code: 0 }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  try {
    const failure = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'ops', 'publish', ...args(), '--consent'], {
      timeout: 120_000,
      env: { ...process.env, KIMAKI_BOT_TOKEN: 'stub', KIMAKI_DISCORD_REST_URL: `http://127.0.0.1:${port}` },
    }).then(() => null, (error: Error & { stdout?: string; stderr?: string }) => error)
    expect(failure).toBeInstanceOf(Error)
    // At-most-once means one attempt per call, so a 5xx must not be re-sent.
    expect(posts).toBe(1)
    const output = `${failure?.stdout ?? ''}${failure?.stderr ?? ''}`
    expect(output).not.toContain('"kind":"sent"')
    expect(output.trim().length).toBeGreaterThan(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 300_000)
