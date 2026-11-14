import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { createSessionHub, type HubBackend } from '../../backend/hub.ts'
import { startHubServer } from '../../backend/hub-server.ts'
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
async function fixture(fail = false) {
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
  const hub = createSessionHub({ backend })
  if (hub instanceof Error) throw hub
  const server = await startHubServer({ hub, port: 0 })
  if (server instanceof Error) throw server
  const statePath = path.join(root, `view-${process.pid}-${++serial}.json`)
  const rest = new REST({ api: discord.restUrl, version: '10' }).setToken(discord.botToken)
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
