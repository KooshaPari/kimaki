import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { publishObservedMetadata } from './publication.js'
import type { OpenCodeObservedEvent } from '../runtime/opencode.js'

const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'opencode', nativeSessionId: 'session' }
const observed: OpenCodeObservedEvent = {
  schemaVersion: 1,
  key,
  source: { hostId: 'host', endpointId: 'endpoint', backendKind: 'opencode', version: '2.2.5' },
  raw: { id: 'event', created: 1, type: 'session.renamed', data: { sessionID: 'session', title: 'private title @everyone' }, durable: { aggregateID: 'session', seq: 1, version: 1 } },
}
let discord: DigitalDiscord
let rest: REST
let channelId: string
beforeAll(async () => {
  discord = new DigitalDiscord({ guild: { name: 'Test Server' }, channels: [{ name: 'general', type: ChannelType.GuildText }] })
  await discord.start()
  channelId = (await discord.prisma.channel.findMany())[0]!.id
  rest = new REST({ api: discord.restUrl, version: '10' }).setToken(discord.botToken)
}, 30_000)
afterAll(async () => { await discord?.stop() })

test('requires explicit exact session, tenant and surface authorization', async () => {
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: key }
  const grant = { ...target, publication: 'metadata' as const, consent: true as const }
  expect(await publishObservedMetadata({ rest, target, observed, grant: null })).toMatchObject({ kind: 'denied' })
  expect(await publishObservedMetadata({ rest, target, observed, grant: { ...grant, tenantId: 'other' } })).toMatchObject({ kind: 'denied' })
  expect(await publishObservedMetadata({ rest, target, observed, grant: { ...grant, surfaceId: 'other' } })).toMatchObject({ kind: 'denied' })
  expect(await publishObservedMetadata({ rest, target, observed, grant: { ...grant, session: { ...key, endpointId: 'other' } } })).toMatchObject({ kind: 'denied' })
  expect(await publishObservedMetadata({ rest, target: { ...target, tenantId: 'other' }, observed, grant: { ...grant, tenantId: 'other' } })).toMatchObject({ kind: 'denied' })
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot('""')
})

test('denies missing or false affirmative consent', async () => {
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: key }
  const grant = { ...target, publication: 'metadata' as const }
  // Exercise malformed callers at the runtime boundary, not just TypeScript.
  expect(await publishObservedMetadata({ rest, target, observed, grant: grant as never })).toMatchObject({ kind: 'denied' })
  expect(await publishObservedMetadata({ rest, target, observed, grant: { ...grant, consent: false } as never })).toMatchObject({ kind: 'denied' })
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot('""')
})

test('denies consent revoked while the destination is being resolved', async () => {
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: { ...key } }
  const grant = { ...target, session: { ...key }, publication: 'metadata' as const, consent: true }
  const get = rest.get.bind(rest)
  const spy = vi.spyOn(rest, 'get').mockImplementation(async (...args) => {
    const channel = await get(...args)
    grant.consent = false
    return channel
  })
  try {
    expect(await publishObservedMetadata({ rest, target, observed, grant: grant as never })).toMatchObject({ kind: 'denied' })
    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot('""')
  } finally { spy.mockRestore() }
})

test('denies scope changes during destination lookup', async () => {
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: { ...key } }
  const grant = { ...target, session: { ...key }, publication: 'metadata' as const, consent: true }
  const get = rest.get.bind(rest)
  const spy = vi.spyOn(rest, 'get').mockImplementation(async (...args) => {
    const channel = await get(...args)
    grant.surfaceId = 'other'
    return channel
  })
  try {
    expect(await publishObservedMetadata({ rest, target, observed, grant })).toMatchObject({ kind: 'denied' })
    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot('""')
  } finally { spy.mockRestore() }
})

test('posts only fixed metadata to the authorized Discord surface', async () => {
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: key }
  const result = await publishObservedMetadata({ rest, target, observed, grant: { ...target, publication: 'metadata', consent: true } })
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# External OpenCode session activity observed."
  `)
  expect(result).toMatchObject({ kind: 'sent' })
})

test('does not publish an event from another native session', async () => {
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: key }
  const result = await publishObservedMetadata({ rest, target, observed: { ...observed, key: { ...key, nativeSessionId: 'other' } }, grant: { ...target, publication: 'metadata', consent: true } })
  expect(result).toMatchObject({ kind: 'denied' })
})
