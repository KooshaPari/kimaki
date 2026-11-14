import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { createSessionHub, type HubBackend, type HubEvent } from '../../backend/hub.ts'
import { startHubServer } from '../../backend/hub-server.ts'
import { ConfigError } from '../../errors.js'
import { openDiscordView } from './view.ts'

let discord: DigitalDiscord
let channelId: string
const root = 'E:\\koosh\\Agents\\scratch\\discord-view'
beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true })
  discord = new DigitalDiscord({ guild: { name: 'View Test' }, channels: [{ name: 'general', type: ChannelType.GuildText }] })
  await discord.start()
  channelId = (await discord.prisma.channel.findMany())[0]!.id
}, 30_000)
afterAll(async () => { await discord?.stop() })

let serial = 0
async function fixture(fail = false, bufferLimit?: number, api?: string) {
  const backend: HubBackend = {
    async start() { return { sessionId: 'view-session', model: null } },
    async prompt(_prompt, onChunk) {
      if (fail) return new Error('backend unavailable')
      onChunk?.('exact ')
      onChunk?.('answer')
      return { stopReason: 'end_turn', text: 'exact answer', updateCount: 2 }
    },
    async cancel() { return undefined },
    async close() {},
  }
  const hub = createSessionHub(bufferLimit === undefined ? { backend } : { backend, bufferLimit })
  if (hub instanceof Error) throw hub
  const server = await startHubServer({ hub, port: 0 })
  if (server instanceof Error) throw server
  const statePath = path.join(root, `view-${process.pid}-${++serial}.json`)
  const rest = new REST({ api: api ?? discord.restUrl, version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(discord.botToken)
  const start = (onPosted?: (seq: number) => void) => {
    const controller = new AbortController()
    const run = openDiscordView({ rest, tenantId: discord.guildId, channelId, clientId: 'view', statePath, baseUrl: server.url, signal: controller.signal, onPosted })
    return { controller, run }
  }
  return { hub, server, statePath, start, async close() { await server.close(); await hub.close(); fs.rmSync(statePath, { force: true }) } }
}
const count = async () => (await discord.channel(channelId).getMessages()).length
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for Discord view')
}

test('one finished turn posts exact text once and records the cursor', async () => {
  const f = await fixture()
  const before = await count()
  try {
    let posted = 0
    const view = f.start(() => { posted++ })
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    expect(await f.hub.submit('secret question')).not.toBeInstanceOf(Error)
    await waitFor(async () => posted === 1)
    const messages = await discord.channel(channelId).getMessages()
    expect(messages.length - before).toBe(1)
    expect(messages.at(-1)?.content).toBe('exact answer')
    expect(JSON.parse(fs.readFileSync(f.statePath, 'utf8')).seq).toBe(f.hub.snapshot().seq)
    view.controller.abort()
    expect(await view.run).toBeUndefined()
  } finally { await f.close() }
})

test('replaying the same finished sequence posts once', async () => {
  const f = await fixture()
  const before = await count()
  try {
    expect(await f.hub.submit('question')).not.toBeInstanceOf(Error)
    let posted = 0
    const first = f.start(() => { posted++ })
    await waitFor(async () => posted === 1)
    first.controller.abort()
    expect(await first.run).toBeUndefined()
    const second = f.start()
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    expect((await count()) - before).toBe(1)
    second.controller.abort()
    expect(await second.run).toBeUndefined()
  } finally { await f.close() }
})

test('restart skips posted turn and publishes next turn once', async () => {
  const f = await fixture()
  const before = await count()
  try {
    let posted = 0
    const first = f.start(() => { posted++ })
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    await f.hub.submit('first')
    await waitFor(async () => posted === 1)
    first.controller.abort()
    expect(await first.run).toBeUndefined()
    const second = f.start(() => { posted++ })
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    expect((await count()) - before).toBe(1)
    await f.hub.submit('second')
    await waitFor(async () => posted === 2)
    expect((await count()) - before).toBe(2)
    second.controller.abort()
    expect(await second.run).toBeUndefined()
  } finally { await f.close() }
})

test('failed turn posts reason without prompt text', async () => {
  const f = await fixture(true)
  const before = await count()
  try {
    let posted = 0
    const view = f.start(() => { posted++ })
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    expect(await f.hub.submit('private prompt text')).not.toBeInstanceOf(Error)
    await waitFor(async () => posted === 1)
    const messages = await discord.channel(channelId).getMessages()
    expect(messages.length - before).toBe(1)
    expect(messages.at(-1)?.content).toContain('backend unavailable')
    expect(messages.at(-1)?.content).not.toContain('private prompt text')
    view.controller.abort()
    expect(await view.run).toBeUndefined()
  } finally { await f.close() }
})

test('refuses a clipped replay instead of mirroring a partial history', async () => {
  const f = await fixture(false, 2)
  const before = await count()
  try {
    // Four events against a two-event buffer, so cursor 0 predates the buffer.
    expect(await f.hub.submit('too old to replay')).not.toBeInstanceOf(Error)
    const view = f.start()
    const result = await view.run
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/clipped/i)
    expect(await count()).toBe(before)
    expect(fs.existsSync(f.statePath)).toBe(false)
  } finally { await f.close() }
})

test('a 429 on the view post fails without advancing the cursor', async () => {
  let posts = 0
  const stub = http.createServer((request, response) => {
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
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()))
  const api = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
  const f = await fixture(false, undefined, api)
  try {
    const view = f.start()
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    expect(await f.hub.submit('rate limited turn')).not.toBeInstanceOf(Error)
    const result = await view.run
    expect(result).toBeInstanceOf(Error)
    // One attempt, and no cursor: a retry must start from the same sequence.
    expect(posts).toBe(1)
    expect(fs.existsSync(f.statePath)).toBe(false)
  } finally {
    await f.close()
    await new Promise<void>((resolve) => stub.close(() => resolve()))
  }
})

test('refuses a cursor it cannot attribute to a session', async () => {
  const f = await fixture()
  try {
    // The hub has not started a session, so a saved cursor cannot be checked
    // against one; resuming it would swallow the next session's early events.
    fs.writeFileSync(f.statePath, JSON.stringify({ seq: 5 }))
    const before = await count()
    const view = f.start()
    const result = await view.run
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/cannot be attributed/)
    expect(await count()).toBe(before)
  } finally { await f.close() }
})

test('resumes a state file written before the session id was recorded', async () => {
  const f = await fixture()
  const before = await count()
  try {
    expect(await f.hub.submit('first turn')).not.toBeInstanceOf(Error)
    const seq = f.hub.snapshot().seq
    // Older builds wrote only { seq }. That must still resume, not be refused,
    // otherwise an upgrade silently stops every existing view.
    fs.writeFileSync(f.statePath, JSON.stringify({ seq }))
    let posted = 0
    const view = f.start(() => { posted += 1 })
    await waitFor(async () => f.hub.snapshot().subscribers === 1)
    expect((await count()) - before).toBe(0)
    expect(await f.hub.submit('second turn')).not.toBeInstanceOf(Error)
    await waitFor(async () => posted === 1)
    expect((await count()) - before).toBe(1)
    // The legacy file is upgraded in place so later restarts carry the session id.
    const saved = JSON.parse(fs.readFileSync(f.statePath, 'utf8'))
    expect(typeof saved.sessionId).toBe('string')
    expect(saved.seq).toBeGreaterThan(seq)
    view.controller.abort()
    expect(await view.run).toBeUndefined()
  } finally { await f.close() }
})

test('refuses a channel that does not belong to the requested tenant', async () => {
  const f = await fixture()
  const before = await count()
  try {
    const rest = new REST({ api: discord.restUrl, version: '10' }).setToken(discord.botToken)
    const controller = new AbortController()
    const result = await openDiscordView({
      rest,
      tenantId: '000000000000000000',
      channelId,
      clientId: 'wrong-tenant',
      statePath: f.statePath,
      baseUrl: f.server.url,
      signal: controller.signal,
    })
    expect(result).toBeInstanceOf(Error)
    expect(await count()).toBe(before)
    expect(fs.existsSync(f.statePath)).toBe(false)
  } finally { await f.close() }
})

test('refuses an unreadable state file instead of starting from zero', async () => {
  const f = await fixture()
  const before = await count()
  try {
    // Starting over on a corrupt cursor would repost turns the channel already has.
    fs.writeFileSync(f.statePath, '{"seq": ')
    const view = f.start()
    const result = await view.run
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/state/i)
    expect(await count()).toBe(before)
  } finally { await f.close() }
})

test('refuses a state cursor that belongs to another session', async () => {
  const f = await fixture()
  try {
    expect(await f.hub.submit('bound turn')).not.toBeInstanceOf(Error)
    const sessionId = f.hub.snapshot().sessionId
    expect(typeof sessionId).toBe('string')
    // A cursor from a different session would silently skip this one's turns.
    fs.writeFileSync(f.statePath, JSON.stringify({ sessionId: 'other-session', seq: f.hub.snapshot().seq }))
    const before = await count()
    const view = f.start()
    const result = await view.run
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/belongs to session/)
    expect(await count()).toBe(before)
  } finally { await f.close() }
})

// A minimal hub whose session identity can change under a live view. The real
// hub reuses its session for a server's lifetime, so a rebind is only reachable
// through a restarted hub at the same URL, which this stub stands in for.
async function rebindableHub() {
  let sessionId: string | null = null
  let seq = 0
  const streams = new Set<http.ServerResponse>()
  const server = http.createServer((request, response) => {
    response.on('error', () => {})
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/state') {
      const body = JSON.stringify({ sessionId, model: null, busy: false, seq, subscribers: streams.size, clients: [], durable: false })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      response.write(`event: ready\ndata: ${JSON.stringify({ client: 'view', cursor: seq, clipped: false, source: 'none' })}\n\n`)
      streams.add(response)
      const drop = () => { streams.delete(response) }
      request.on('close', drop)
      response.on('close', drop)
      return
    }
    if (request.method === 'POST' && url.pathname === '/ack') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ acked: seq }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const emit = (event: HubEvent): void => {
    seq = Math.max(seq, event.seq)
    if (event.type === 'session.started') sessionId = event.sessionId
    const frame = `event: hub\ndata: ${JSON.stringify(event)}\n\n`
    for (const stream of streams) {
      if (stream.writableEnded || stream.destroyed) continue
      stream.write(frame)
    }
  }
  return {
    url,
    emit,
    streams: () => streams.size,
    async close() {
      for (const stream of streams) stream.end()
      streams.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

const turnOn = (seq: number, text: string): HubEvent[] => [
  { seq, type: 'prompt.started', characters: text.length },
  { seq: seq + 1, type: 'prompt.chunk', text },
  { seq: seq + 2, type: 'prompt.finished', stopReason: 'end_turn', characters: text.length },
]

test('a repeated session.started for the bound session keeps posting its turn once', async () => {
  const hub = await rebindableHub()
  const statePath = path.join(root, `repeat-${process.pid}-${++serial}.json`)
  const rest = new REST({ api: discord.restUrl, version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(discord.botToken)
  const controller = new AbortController()
  const before = await count()
  let posted = 0
  const run = openDiscordView({ rest, tenantId: discord.guildId, channelId, clientId: 'view', statePath, baseUrl: hub.url, signal: controller.signal, onPosted: (seq) => { posted = seq } })
  try {
    await waitFor(async () => hub.streams() === 1)
    hub.emit({ seq: 1, type: 'session.started', sessionId: 'session-a', model: null })
    // A start for the session the view is already bound to is a resume, not a rebind.
    hub.emit({ seq: 2, type: 'session.started', sessionId: 'session-a', model: null })
    for (const event of turnOn(3, 'bound answer')) hub.emit(event)
    await waitFor(async () => posted === 5)
    const messages = await discord.channel(channelId).getMessages()
    expect(messages.length - before).toBe(1)
    expect(messages.at(-1)?.content).toBe('bound answer')
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-a', seq: 5 })
    controller.abort()
    expect(await run).toBeUndefined()
  } finally {
    controller.abort()
    await hub.close()
    fs.rmSync(statePath, { force: true })
  }
})

test('a live rebind to another session fails closed and posts nothing for the new one', async () => {
  const hub = await rebindableHub()
  const statePath = path.join(root, `rebind-${process.pid}-${++serial}.json`)
  const rest = new REST({ api: discord.restUrl, version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(discord.botToken)
  const controller = new AbortController()
  const before = await count()
  let posted = 0
  const run = openDiscordView({ rest, tenantId: discord.guildId, channelId, clientId: 'view', statePath, baseUrl: hub.url, signal: controller.signal, onPosted: (seq) => { posted = seq } })
  try {
    await waitFor(async () => hub.streams() === 1)
    hub.emit({ seq: 1, type: 'session.started', sessionId: 'session-a', model: null })
    for (const event of turnOn(2, 'bound answer')) hub.emit(event)
    await waitFor(async () => posted === 4)
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-a', seq: 4 })
    // The hub restarts on another session while the view is still attached, and
    // runs a full turn on it before the view can act on the name change.
    hub.emit({ seq: 5, type: 'session.started', sessionId: 'session-b', model: null })
    for (const event of turnOn(6, 'rebound answer')) hub.emit(event)
    const result = await run
    expect(result).toBeInstanceOf(ConfigError)
    const message = (result as Error).message
    expect(message).toContain('session-a')
    expect(message).toContain('session-b')
    // Give a stray B post a chance to land before counting what the channel holds.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const messages = await discord.channel(channelId).getMessages()
    expect(messages.length - before).toBe(1)
    expect(messages.at(-1)?.content).toBe('bound answer')
    expect(messages.some((entry) => entry.content.includes('rebound'))).toBe(false)
    expect(posted).toBe(4)
    // The cursor stays on A so a later resume replays B's turn instead of skipping it.
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-a', seq: 4 })
    await waitFor(async () => hub.streams() === 0)
  } finally {
    controller.abort()
    await hub.close()
    fs.rmSync(statePath, { force: true })
  }
})
