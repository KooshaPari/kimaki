// AC38 with a real hub underneath.
//
// The existing rebind tests in ops/discord/view.test.ts stand in a hand-written
// SSE hub because a single `createSessionHub` reuses its session for its whole
// lifetime. This file uses the real hub module instead and witnesses the one
// transition the hub does document: a restart onto a fresh log, which produces a
// new `session.started` (hub.ts start() -> publish at seq 1; a hub created on a
// rotated log continues the old numbering).
//
// What is real here:
// - createSessionHub, its cursor/durable log/subscription/ack surface
// - startHubServer, the real loopback SSE surface
// - the turn events below are published by the hub from a backend double, not
//   hand-emitted to a fake stream
// What is stubbed:
// - the outbound Discord REST call (discord-digital-twin), as in the sibling tests
// - a loopback relay that keeps one consumer SSE connection open while the real
//   hub server behind the same URL is replaced. It forwards bytes; it never
//   invents an event, sequence number or session id.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { createSessionHub, type HubBackend, type HubEvent, type SessionHub } from './backend/hub.ts'
import { startHubServer } from './backend/hub-server.ts'
import { ConfigError } from './errors.ts'
import { defaultViewClientId, openDiscordView } from './ops/discord/view.ts'

const root = 'E:\\koosh\\Agents\\scratch\\rebind-live'
let discord: DigitalDiscord
let channelId: string
let serial = 0

beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true })
  discord = new DigitalDiscord({ guild: { name: 'Rebind Live' }, channels: [{ name: 'rebind', type: ChannelType.GuildText }] })
  await discord.start()
  channelId = (await discord.prisma.channel.findMany()).find((channel) => channel.name === 'rebind')!.id
}, 30_000)

afterAll(async () => { await discord?.stop() })

const count = async (): Promise<number> => (await discord.channel(channelId).getMessages()).length

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return
    await sleep(25)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

// A hub generation: a real session hub, its real loopback server, and the events
// its own subscriber saw. `seed` preloads a rotated durable log; the hub restores
// the sequence from it, and, when it holds no session.started, starts a new
// session on the next submit.
type Generation = {
  hub: SessionHub
  url: string
  events: HubEvent[]
  close: () => Promise<void>
}

async function generation({ sessionId, reply, seed }: {
  sessionId: string
  reply: (text: string) => string
  seed?: HubEvent[]
}): Promise<Generation> {
  const dir = fs.mkdtempSync(path.join(root, `gen-${++serial}-`))
  const logFile = path.join(dir, 'events.jsonl')
  if (seed !== undefined) fs.writeFileSync(logFile, seed.map((event) => `${JSON.stringify(event)}\n`).join(''))
  const backend: HubBackend = {
    async start() { return { sessionId, model: null } },
    async prompt(text, onChunk) {
      const answer = reply(text)
      onChunk?.(answer)
      return { stopReason: 'end_turn', text: answer, updateCount: 1 }
    },
    async cancel() { return undefined },
    async close() {},
  }
  const hub = createSessionHub({ backend, logFile })
  if (hub instanceof Error) throw hub
  const events: HubEvent[] = []
  const witness = hub.subscribe({ cursor: 0, clientId: `witness-${sessionId}-${serial}`, onEvent: (event) => events.push(event) })
  if (witness instanceof Error) throw witness
  const server = await startHubServer({ hub, port: 0 })
  if (server instanceof Error) throw server
  return {
    hub,
    url: server.url,
    events,
    close: async () => {
      await server.close()
      await hub.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// A loopback relay with one stable URL. The consumer attaches once; when the hub
// behind the URL is replaced, the relay detaches from the old hub and re-attaches
// to the new one from cursor 0, so the consumer's single SSE response survives the
// restart. Everything on the wire still comes from a real hub.
type Relay = { url: string; use: (upstream: string) => Promise<void>; close: () => Promise<void> }

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

type ClientStream = {
  response: http.ServerResponse
  client: string | undefined
  nextCursor: number
  upstream: AbortController | undefined
  closed: boolean
}

async function createRelay(): Promise<Relay> {
  let current: string | undefined
  const streams = new Set<ClientStream>()

  const attach = (stream: ClientStream): void => {
    stream.upstream?.abort()
    const controller = new AbortController()
    stream.upstream = controller
    const cursor = stream.nextCursor
    // A restarted hub numbers from one. The consumer's own cursor applies only to
    // the first attachment; a re-attachment replays the new hub from its start.
    stream.nextCursor = 0
    void (async () => {
      const target = current
      if (target === undefined) return
      const query = new URLSearchParams({ cursor: String(cursor) })
      if (stream.client !== undefined) query.set('client', stream.client)
      try {
        const upstream = await fetch(`${target}/events?${query.toString()}`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!upstream.ok || upstream.body === null) { stream.response.end(); return }
        const reader = upstream.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          // A detach must not let a stale pump write after the new hub took over.
          if (stream.closed || stream.upstream !== controller) return
          stream.response.write(Buffer.from(value))
        }
      } catch {
        // An aborted detach or an upstream that ended is a normal switch.
      }
    })()
  }

  const proxy = async (request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> => {
    const target = current
    if (target === undefined) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'no relayed hub' }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const upstream = await fetch(`${target}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers['content-type'] === undefined ? {} : { 'content-type': request.headers['content-type'] },
      body: request.method === 'GET' ? undefined : Buffer.concat(chunks),
    })
    const body = await upstream.text()
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    response.end(body)
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/events') {
        const raw = url.searchParams.get('cursor')
        const cursor = raw === null ? 0 : Number(raw)
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'cursor must be a non-negative integer' }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const stream: ClientStream = {
          response,
          client: url.searchParams.get('client') ?? undefined,
          nextCursor: cursor,
          upstream: undefined,
          closed: false,
        }
        streams.add(stream)
        response.on('close', () => {
          stream.closed = true
          stream.upstream?.abort()
          streams.delete(stream)
        })
        attach(stream)
        return
      }
      await proxy(request, response, url)
    })().catch((cause: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(cause) }))
    })
  })

  const port = await freePort()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return {
    url: `http://127.0.0.1:${port}`,
    use: async (upstream) => {
      current = upstream
      for (const stream of streams) attach(stream)
    },
    close: async () => {
      for (const stream of streams) {
        stream.closed = true
        stream.upstream?.abort()
        stream.response.end()
      }
      streams.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

const rest = (): REST => new REST({ api: discord.restUrl, version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(discord.botToken)

test('a live view fails closed when a restarted hub names a different session', async () => {
  const relay = await createRelay()
  const a = await generation({ sessionId: 'session-a', reply: (text) => `answer:${text}` })
  await relay.use(a.url)
  const statePath = path.join(root, `fail-closed-${process.pid}-${++serial}.json`)
  const controller = new AbortController()
  const before = await count()
  let posted = 0
  let b: Generation | undefined
  const run = openDiscordView({
    rest: rest(), tenantId: discord.guildId, channelId, clientId: defaultViewClientId(channelId),
    statePath, baseUrl: relay.url, signal: controller.signal, onPosted: () => { posted += 1 },
  })
  try {
    await waitFor(() => a.hub.snapshot().subscribers === 1, 'the view to attach to hub A')
    expect(await a.hub.submit('alpha')).not.toBeInstanceOf(Error)
    await waitFor(() => posted === 1, "A's turn")
    // Requirement 1: one real turn, observed once, cursor at A's sequence.
    expect(a.hub.snapshot().sessionId).toBe('session-a')
    expect(a.hub.snapshot().seq).toBe(4)
    expect(a.events.map((event) => event.type)).toEqual(['session.started', 'prompt.started', 'prompt.chunk', 'prompt.finished'])
    expect(a.events[0]).toMatchObject({ seq: 1, type: 'session.started', sessionId: 'session-a' })
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-a', seq: 4 })

    // Requirement 2: the hub is restarted at the same URL on a fresh log and
    // starts a different session. Its own start() publishes the new session.started.
    b = await generation({ sessionId: 'session-b', reply: (text) => `answer:${text}` })
    expect(await b.hub.start()).toEqual({ sessionId: 'session-b', model: null })
    expect(await b.hub.submit('beta')).not.toBeInstanceOf(Error)
    await waitFor(() => b!.hub.snapshot().seq === 4 && !b!.hub.snapshot().busy, "B's turn")
    expect(b.events[0]).toMatchObject({ seq: 1, type: 'session.started', sessionId: 'session-b' })
    await relay.use(b.url)

    // Requirement 3: without approval the view must fail closed.
    const result = await run
    expect(result).toBeInstanceOf(ConfigError)
    const message = (result as Error).message
    expect(message).toContain('session-a')
    expect(message).toContain('session-b')
    await sleep(200)
    const messages = (await discord.channel(channelId).getMessages()).slice(before)
    expect(messages.map((entry) => entry.content)).toEqual(['answer:alpha'])
    expect(posted).toBe(1)
    // The cursor stays on A so a later resume replays B's turn instead of skipping it.
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-a', seq: 4 })
  } finally {
    controller.abort()
    await relay.close()
    if (b !== undefined) await b.close()
    await a.close()
    fs.rmSync(statePath, { force: true })
  }
})

test('an approved live rebind adopts the new session and posts each turn once', async () => {
  const relay = await createRelay()
  const a = await generation({ sessionId: 'session-a', reply: (text) => `answer:${text}` })
  await relay.use(a.url)
  const statePath = path.join(root, `approved-${process.pid}-${++serial}.json`)
  const controller = new AbortController()
  const before = await count()
  const seen: number[] = []
  let b: Generation | undefined
  let c: Generation | undefined
  const run = openDiscordView({
    rest: rest(), tenantId: discord.guildId, channelId, clientId: defaultViewClientId(channelId),
    statePath, baseUrl: relay.url, signal: controller.signal, rebind: true, onPosted: (seq) => { seen.push(seq) },
  })
  try {
    await waitFor(() => a.hub.snapshot().subscribers === 1, 'the view to attach to hub A')
    expect(await a.hub.submit('alpha')).not.toBeInstanceOf(Error)
    await waitFor(() => seen.length === 1, "A's turn")
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-a', seq: 4 })

    b = await generation({ sessionId: 'session-b', reply: (text) => `answer:${text}` })
    expect(await b.hub.start()).toEqual({ sessionId: 'session-b', model: null })
    expect(await b.hub.submit('beta')).not.toBeInstanceOf(Error)
    await waitFor(() => b!.hub.snapshot().seq === 4 && !b!.hub.snapshot().busy, "B's turn")
    await relay.use(b.url)

    // Requirement 4: approval adopts B, posts B's turn once, persists B and its cursor.
    await waitFor(() => seen.length === 2, "B's post")
    expect(seen).toEqual([4, 4])
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-b', seq: 4 })
    expect((await discord.channel(channelId).getMessages()).slice(before).map((entry) => entry.content))
      .toEqual(['answer:alpha', 'answer:beta'])

    // A repeated session.started for B, at a sequence above the cursor: a hub on a
    // rotated log restores the numbering (seq 4) but not the session, so its real
    // start() publishes session.started for the same B at seq 5. B's earlier post
    // must not be duplicated, and the new turn still posts once.
    c = await generation({
      sessionId: 'session-b',
      reply: (text) => `answer:${text}`,
      seed: [
        { seq: 1, type: 'prompt.started', characters: 4 },
        { seq: 2, type: 'prompt.chunk', text: 'rot' },
        { seq: 3, type: 'prompt.chunk', text: 'ated' },
        { seq: 4, type: 'prompt.chunk', text: ' log' },
      ],
    })
    expect(await c.hub.start()).toEqual({ sessionId: 'session-b', model: null })
    const restarts = c.events.filter((event) => event.type === 'session.started')
    expect(restarts).toEqual([{ seq: 5, type: 'session.started', sessionId: 'session-b', model: null }])
    expect(await c.hub.submit('gamma')).not.toBeInstanceOf(Error)
    await waitFor(() => c!.hub.snapshot().seq === 8 && !c!.hub.snapshot().busy, "C's turn")
    await relay.use(c.url)

    await waitFor(() => seen.length === 3, "C's post")
    await sleep(200)
    expect(seen).toEqual([4, 4, 8])
    const messages = (await discord.channel(channelId).getMessages()).slice(before).map((entry) => entry.content)
    expect(messages).toEqual(['answer:alpha', 'answer:beta', 'answer:gamma'])
    expect(messages.filter((content) => content === 'answer:beta')).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({ sessionId: 'session-b', seq: 8 })

    controller.abort()
    expect(await run).toBeUndefined()
  } finally {
    controller.abort()
    await relay.close()
    if (c !== undefined) await c.close()
    if (b !== undefined) await b.close()
    await a.close()
    fs.rmSync(statePath, { force: true })
  }
})
