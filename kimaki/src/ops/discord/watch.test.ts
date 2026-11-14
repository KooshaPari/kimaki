import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { openNativeDiscordWatch } from './watch.ts'

const root = 'E:\\koosh\\Agents\\scratch\\native-discord'
let twin: DigitalDiscord
let channelId: string
beforeAll(async () => {
  await fs.mkdir(root, { recursive: true })
  twin = new DigitalDiscord({ guild: { name: 'Native watch' }, channels: [{ name: 'general', type: ChannelType.GuildText }] })
  await twin.start()
  channelId = (await twin.prisma.channel.findMany())[0]!.id
}, 30_000)
afterAll(async () => { await twin?.stop() })
const history = [{ role: 'user', text: 'native-ok' }, { role: 'agent', text: 'native-ok' }]
const state = (name: string) => path.join(root, `${name}-${process.pid}.json`)
const open = (rest: REST, statePath: string) => openNativeDiscordWatch({ rest, tenantId: twin.guildId, channelId, statePath, sessionId: 'native-session' })
const rest = () => new REST({ api: twin.restUrl, version: '10', rejectOnRateLimit: () => true }).setToken(twin.botToken)

test('history growth posts once per message and restart skips posted history', async () => {
  const statePath = state('growth')
  await fs.rm(statePath, { force: true })
  const before = (await twin.channel(channelId).getMessages()).length
  try {
    const watcher = await open(rest(), statePath)
    expect(watcher).not.toBeInstanceOf(Error)
    if (watcher instanceof Error) throw watcher
    expect(await watcher.publish(history.slice(0, 1))).toBe(1)
    expect(await watcher.publish(history)).toBe(1)
    const restarted = await open(rest(), statePath)
    if (restarted instanceof Error) throw restarted
    expect(await restarted.publish(history)).toBe(0)
    expect((await twin.channel(channelId).getMessages()).length - before).toBe(2)
    expect(JSON.parse(await fs.readFile(statePath, 'utf8'))).toEqual({ sessionId: 'native-session', index: 2 })
    const messages = await twin.channel(channelId).getMessages()
    expect(messages.slice(-2).map((message) => message.content)).toEqual(['user: native-ok', 'agent: native-ok'])
  } finally { await fs.rm(statePath, { force: true }) }
})

test('429 is surfaced once without advancing durable cursor', async () => {
  const statePath = state('rate-limit')
  await fs.writeFile(statePath, JSON.stringify({ sessionId: 'native-session', index: 1 }))
  let posts = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: channelId, guild_id: twin.guildId, type: 0 }))
    } else {
      posts++
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
      response.end(JSON.stringify({ message: 'rate limited', retry_after: 0.05, global: false }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const limited = new REST({ api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, version: '10', rejectOnRateLimit: () => true }).setToken('stub')
    const watcher = await open(limited, statePath)
    if (watcher instanceof Error) throw watcher
    expect(await watcher.publish(history)).toBeInstanceOf(Error)
    expect(posts).toBe(1)
    expect(JSON.parse(await fs.readFile(statePath, 'utf8')).index).toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(statePath, { force: true })
  }
})
