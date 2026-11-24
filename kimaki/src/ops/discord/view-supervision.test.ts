// Supervision of the bot-owned Discord view. The unit tests drive a recording
// openView so the abort/await contract is visible; the last test runs the real
// openDiscordView against a local hub and the Discord digital twin, which is
// what proves the supervisor supplies enough for the view to post a turn.

import fs from 'node:fs'
import http from 'node:http'
import type { ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { createSessionHub, type HubBackend, type HubEvent } from '../../backend/hub.ts'
import { startHubServer } from '../../backend/hub-server.ts'
import { ConfigError, HubAckRefusedError } from '../../errors.js'
import { defaultViewClientId } from './view.ts'
import {
  parseViewBinding,
  readViewBinding,
  removeViewBinding,
  startViewSupervision,
  VIEW_BINDING_FILE,
  viewBindingPath,
  viewStatePath,
  writeViewBinding,
  type DiscordViewBinding,
  type OpenDiscordView,
} from './view-supervision.ts'

const dirs: string[] = []
function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-view-supervision-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// The supervisor never talks to Discord in the unit tests; a token-less REST
// instance is enough because the recorder ignores it.
const rest = new REST({ version: '10' }).setToken('test-token')

function recorder() {
  const calls: Parameters<OpenDiscordView>[0][] = []
  const openView: OpenDiscordView = async (options) => {
    calls.push(options)
    // Behaves like a healthy long-lived view: it only settles when aborted.
    return new Promise<Error | undefined>((resolve) => {
      if (options.signal?.aborted) resolve(undefined)
      else options.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
    })
  }
  return { calls, openView }
}

const binding: DiscordViewBinding = {
  tenantId: '111111111111111111',
  channelId: '222222222222222222',
  baseUrl: 'http://127.0.0.1:8787',
}

test('no binding starts no view and leaves the bot start untouched', async () => {
  const dataDir = tmpDataDir()
  const seen = recorder()
  const supervisor = await startViewSupervision({ dataDir, rest, openView: seen.openView, report: () => {} })
  expect(supervisor.state()).toBe('idle')
  expect(supervisor.binding()).toBeUndefined()
  expect(supervisor.error()).toBeUndefined()
  // The file the bot looks for is absent, which is the default for every
  // existing install.
  expect(fs.existsSync(viewBindingPath(dataDir))).toBe(false)
  expect(seen.calls).toHaveLength(0)
  await supervisor.stop()
  expect(await supervisor.result).toBeUndefined()
  expect(seen.calls).toHaveLength(0)
})

test('a binding starts the view with that channel, tenant, hub and a data-dir cursor', async () => {
  const dataDir = tmpDataDir()
  fs.writeFileSync(viewBindingPath(dataDir), JSON.stringify({ ...binding, cursor: 7, rebind: true }))
  const seen = recorder()
  const supervisor = await startViewSupervision({ dataDir, rest, openView: seen.openView, report: () => {} })
  try {
    expect(supervisor.state()).toBe('running')
    expect(supervisor.binding()).toEqual({ ...binding, cursor: 7, rebind: true })
    expect(supervisor.error()).toBeUndefined()
    expect(seen.calls).toHaveLength(1)
    const call = seen.calls[0]!
    expect(call.rest).toBe(rest)
    expect(call.tenantId).toBe(binding.tenantId)
    expect(call.channelId).toBe(binding.channelId)
    expect(call.baseUrl).toBe(binding.baseUrl)
    expect(call.clientId).toBe(defaultViewClientId(binding.channelId))
    expect(call.cursor).toBe(7)
    expect(call.rebind).toBe(true)
    // The durable cursor is the supervisor's choice, under the bot's data dir.
    expect(call.statePath).toBe(viewStatePath({ dataDir, channelId: binding.channelId }))
    expect(call.signal).toBeInstanceOf(AbortSignal)
  } finally {
    await supervisor.stop()
  }
})

test('shutdown aborts the view signal and awaits the view before resolving', async () => {
  const dataDir = tmpDataDir()
  fs.writeFileSync(viewBindingPath(dataDir), JSON.stringify({ ...binding, clientId: 'explicit-view' }))
  const order: string[] = []
  const openView: OpenDiscordView = (options) => new Promise<Error | undefined>((resolve) => {
    options.signal?.addEventListener('abort', () => {
      order.push('aborted')
      // A view needs a moment to drain its stream; stop() must wait for it.
      setTimeout(() => {
        order.push('view-settled')
        resolve(undefined)
      }, 5)
    }, { once: true })
  })
  const supervisor = await startViewSupervision({ dataDir, rest, openView, report: () => {} })
  expect(supervisor.state()).toBe('running')
  expect(order).toEqual([])
  const stopping = supervisor.stop()
  await stopping
  order.push('stop-resolved')
  expect(order).toEqual(['aborted', 'view-settled', 'stop-resolved'])
  expect(supervisor.state()).toBe('stopped')
  expect(await supervisor.result).toBeUndefined()
  // A second stop (shutdown signals can arrive twice) is a no-op.
  await supervisor.stop()
  expect(order).toEqual(['aborted', 'view-settled', 'stop-resolved'])
})

test('an unreadable or malformed binding is reported and starts no view', async () => {
  const cases: Array<{ name: string; prepare: (dataDir: string) => void; match: RegExp }> = [
    {
      name: 'invalid JSON',
      prepare: (dataDir) => fs.writeFileSync(viewBindingPath(dataDir), '{"tenantId": '),
      match: /not valid JSON/,
    },
    {
      name: 'missing baseUrl',
      prepare: (dataDir) => fs.writeFileSync(viewBindingPath(dataDir), JSON.stringify({ tenantId: binding.tenantId, channelId: binding.channelId })),
      match: /baseUrl/,
    },
    {
      name: 'unreadable file',
      prepare: (dataDir) => fs.mkdirSync(viewBindingPath(dataDir)),
      match: /Cannot read the Discord view binding/,
    },
  ]
  for (const entry of cases) {
    const dataDir = tmpDataDir()
    entry.prepare(dataDir)
    const seen = recorder()
    const reported: Error[] = []
    const supervisor = await startViewSupervision({ dataDir, rest, openView: seen.openView, report: (error) => reported.push(error) })
    expect(supervisor.state(), entry.name).toBe('failed')
    expect(supervisor.binding(), entry.name).toBeUndefined()
    expect(supervisor.error(), entry.name).toBeInstanceOf(ConfigError)
    expect(supervisor.error()?.message, entry.name).toMatch(entry.match)
    expect(reported, entry.name).toHaveLength(1)
    expect(seen.calls, entry.name).toHaveLength(0)
    expect(await supervisor.result, entry.name).toBeInstanceOf(ConfigError)
    await supervisor.stop()
  }
})

test('binding files round-trip and unsafe values are refused', async () => {
  const dataDir = tmpDataDir()
  expect(await writeViewBinding({ dataDir, binding: { ...binding, clientId: 'view', cursor: 3 } })).toBeUndefined()
  expect(await readViewBinding({ dataDir })).toEqual({ ...binding, clientId: 'view', cursor: 3 })
  // The file on disk is plain JSON, so an operator can read it.
  expect(JSON.parse(fs.readFileSync(viewBindingPath(dataDir), 'utf8'))).toEqual({ ...binding, clientId: 'view', cursor: 3 })

  expect(parseViewBinding({ ...binding, baseUrl: 'ftp://127.0.0.1:8787' })).toBeInstanceOf(ConfigError)
  expect(parseViewBinding({ ...binding, baseUrl: 'http://user:secret@127.0.0.1:8787' })).toBeInstanceOf(ConfigError)
  expect(parseViewBinding({ ...binding, cursor: -1 })).toBeInstanceOf(ConfigError)
  expect(parseViewBinding({ ...binding, channelId: ' 222' })).toBeInstanceOf(ConfigError)
  // A refused binding is never written, so the previous one survives a typo.
  expect(await writeViewBinding({ dataDir, binding: { ...binding, tenantId: '' } })).toBeInstanceOf(ConfigError)
  expect(JSON.parse(fs.readFileSync(viewBindingPath(dataDir), 'utf8')).tenantId).toBe(binding.tenantId)

  expect(await removeViewBinding({ dataDir })).toBe(true)
  expect(fs.existsSync(path.join(dataDir, VIEW_BINDING_FILE))).toBe(false)
  expect(await readViewBinding({ dataDir })).toBeNull()
})

// --- the ack/stop ordering ------------------------------------------------

// A hub double is the only way to hold the ack open exactly where the race is:
// the turn posts and the cursor file lands, the ack request is received and
// left unanswered, and the test decides whether the stop or the ack comes
// first. The real hub answers too fast to order those two events reliably.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function startFakeHub(events: HubEvent[]) {
  const ackSeen = deferred<{ client: string; seq: number }>()
  const ackRelease = deferred<number>()
  const streamClosed = deferred<void>()
  const streams = new Set<ServerResponse>()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/state') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        sessionId: 'race-session', model: null, busy: false, seq: events.length,
        subscribers: streams.size, clients: [], durable: false,
      }))
      return
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      streams.add(response)
      response.write(`event: ready\ndata: ${JSON.stringify({ client: url.searchParams.get('client'), cursor: Number(url.searchParams.get('cursor') ?? 0), clipped: false, source: 'none' })}\n\n`)
      for (const event of events) response.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`)
      const cleanup = () => { streams.delete(response); streamClosed.resolve() }
      request.on('close', cleanup)
      response.on('close', cleanup)
      return
    }
    if (request.method === 'POST' && url.pathname === '/ack') {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { client: string; seq: number }
        ackSeen.resolve(body)
        void ackRelease.promise.then((status) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: status === 404 ? `Client ${body.client} is not attached` : 'Hub refused the ack' }))
        })
      })
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    ackSeen: ackSeen.promise,
    releaseAck: (status: number) => ackRelease.resolve(status),
    streamClosed: streamClosed.promise,
    close: async () => {
      for (const stream of streams) stream.end()
      streams.clear()
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })
    },
  }
}

function fakeRest() {
  const posted: string[] = []
  const rest = {
    async get() { return { id: binding.channelId, guild_id: binding.tenantId, type: ChannelType.GuildText } },
    async post(_route: unknown, options: { body: { content: string } }) {
      posted.push(options.body.content)
      return { id: `message-${posted.length}` }
    },
  } as unknown as REST
  return { rest, posted }
}

const turnEvents: HubEvent[] = [
  { seq: 1, type: 'prompt.started', characters: 5 },
  { seq: 2, type: 'prompt.chunk', text: 'answer' },
  { seq: 3, type: 'prompt.finished', stopReason: 'end_turn', characters: 6 },
]

// The ordering this proves: the cursor lands and the ack is in flight, then
// stop() detaches the client by closing the stream, and only then is the ack
// answered with the hub's 404 "not attached". The view must read that as the
// shutdown it was asked for, so the supervisor ends stopped with no failure.
test('a stop that closes the stream before the ack is answered ends stopped, not failed', async () => {
  const hub = await startFakeHub(turnEvents)
  const dataDir = tmpDataDir()
  await writeViewBinding({ dataDir, binding: { ...binding, baseUrl: hub.url } })
  const { rest: viewRest, posted } = fakeRest()
  const reported: Error[] = []
  const supervisor = await startViewSupervision({ dataDir, rest: viewRest, report: (error) => reported.push(error) })
  try {
    // The ack request only arrives after the turn is posted and the cursor is
    // persisted, so waiting for it also proves the file the flaky test waits on
    // is on disk before the stop.
    await hub.ackSeen
    expect(posted).toEqual(['answer'])
    expect(fs.existsSync(viewStatePath({ dataDir, channelId: binding.channelId }))).toBe(true)
    const stopping = supervisor.stop()
    // stop() aborts the view, which closes the SSE stream; the hub detaches the
    // client only then. Answering the held ack afterwards is the exact 404 the
    // real hub produces when a stop wins the race.
    await hub.streamClosed
    hub.releaseAck(404)
    await stopping
  } finally {
    await hub.close()
  }
  expect(supervisor.state()).toBe('stopped')
  expect(await supervisor.result).toBeUndefined()
  expect(supervisor.error()).toBeUndefined()
  expect(reported).toHaveLength(0)
})

// The other side of the same branch: an ack refused while nothing is aborting
// is a real failure. Swallowing it would leave a view posting turns it can
// never acknowledge.
test('an ack refused while the view is still running still fails the view', async () => {
  const hub = await startFakeHub(turnEvents)
  const dataDir = tmpDataDir()
  await writeViewBinding({ dataDir, binding: { ...binding, baseUrl: hub.url } })
  const { rest: viewRest } = fakeRest()
  const reported: Error[] = []
  const supervisor = await startViewSupervision({ dataDir, rest: viewRest, report: (error) => reported.push(error) })
  try {
    await hub.ackSeen
    expect(supervisor.state()).toBe('running')
    hub.releaseAck(409)
    expect(await supervisor.result).toBeInstanceOf(HubAckRefusedError)
  } finally {
    await supervisor.stop()
    await hub.close()
  }
  expect(supervisor.state()).toBe('failed')
  expect(supervisor.error()).toBeInstanceOf(HubAckRefusedError)
  expect(reported).toHaveLength(1)
})

// --- the real view against a local hub and the Discord digital twin ---------

let discord: DigitalDiscord
let channelId: string
beforeAll(async () => {
  discord = new DigitalDiscord({ guild: { name: 'View Supervision' }, channels: [{ name: 'general', type: ChannelType.GuildText }] })
  await discord.start()
  const channels = await discord.prisma.channel.findMany()
  channelId = channels.find((channel) => channel.name === 'general')!.id
}, 60_000)
afterAll(async () => { await discord?.stop() })

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for the supervised Discord view')
}

test('a supervised real view mirrors one turn from the hub into the binding channel', async () => {
  const backend: HubBackend = {
    async start() { return { sessionId: 'supervised-session', model: null } },
    async prompt(prompt, onChunk) {
      const text = `answer:${prompt}`
      onChunk?.(text)
      return { stopReason: 'end_turn', text, updateCount: 1 }
    },
    async cancel() { return undefined },
    async close() {},
  }
  const hub = createSessionHub({ backend })
  if (hub instanceof Error) throw hub
  const server = await startHubServer({ hub, port: 0 })
  if (server instanceof Error) throw server
  const dataDir = tmpDataDir()
  await writeViewBinding({ dataDir, binding: { tenantId: discord.guildId, channelId, baseUrl: server.url } })
  const viewRest = new REST({ api: discord.restUrl, version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(discord.botToken)
  const supervisor = await startViewSupervision({ dataDir, rest: viewRest })
  try {
    await waitFor(async () => hub.snapshot().subscribers === 1)
    // The supervisor's default identity is the channel-scoped one, so a second
    // view on this channel would be refused rather than duplicate every turn.
    expect(hub.snapshot().clients.map((client) => client.clientId)).toEqual([defaultViewClientId(channelId)])
    expect(await hub.submit('supervised turn')).not.toBeInstanceOf(Error)
    // Wait for the expected content rather than a message count: a count read
    // before the turn settles is a race under load, and the content is the claim
    // that actually matters.
    await waitFor(async () => (await discord.channel(channelId).getMessages()).some((message) => message.content === 'answer:supervised turn'))
    const messages = await discord.channel(channelId).getMessages()
    expect(messages.at(-1)?.content).toBe('answer:supervised turn')
    // The cursor lands in the bot's data dir, not the cwd, right after the post.
    const statePath = viewStatePath({ dataDir, channelId })
    await waitFor(async () => fs.existsSync(statePath))
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).seq).toBe(hub.snapshot().seq)
  } finally {
    await supervisor.stop()
    await server.close()
    await hub.close()
  }
  expect(supervisor.state()).toBe('stopped')
  expect(await supervisor.result).toBeUndefined()
  expect(hub.snapshot().subscribers).toBe(0)
})
