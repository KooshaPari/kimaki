import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { DiscordError } from '../../errors.js'
import { publishMetadataNotice, publishObservedMetadata } from './publication.js'
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

// A Discord surface that only honors the credential it was given. Revocation is
// modelled the way Discord performs it: the client keeps making requests, the
// API answers 401, and no message is created. Every POST attempt is recorded so
// the tests can prove an auth failure is terminal instead of retried.
async function authSurface({ token }: { token: string }) {
  const attempts: { authorization: string | undefined; body: string }[] = []
  const delivered: string[] = []
  const requests: { method: string | undefined; url: string | undefined }[] = []
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url })
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const authorized = request.headers.authorization === `Bot ${token}`
      const reject = () => {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: '401: Unauthorized', code: 0 }))
      }
      if (request.method === 'GET' && request.url === `/v10/channels/${channelId}`) {
        if (!authorized) return reject()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: channelId, guild_id: discord.guildId, type: 0, name: 'general' }))
        return
      }
      if (request.method === 'POST' && request.url === `/v10/channels/${channelId}/messages`) {
        const body = Buffer.concat(chunks).toString('utf8')
        attempts.push({ authorization: request.headers.authorization, body })
        if (!authorized) return reject()
        delivered.push(body)
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'message', channel_id: channelId }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    rest: new REST({ api: `http://127.0.0.1:${port}`, version: '10' }).setToken(token),
    attempts,
    delivered,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

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

test('fails closed when the credential is revoked after consent but before the send', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: { ...key } }
  const grant = { ...target, session: { ...key }, publication: 'metadata' as const, consent: true as const }
  const get = surface.rest.get.bind(surface.rest)
  const spy = vi.spyOn(surface.rest, 'get').mockImplementation(async (...args) => {
    const channel = await get(...args)
    // Consent stands and the surface resolved, then the credential is revoked.
    surface.rest.setToken('revoked-credential')
    return channel
  })
  try {
    const result = await publishObservedMetadata({ rest: surface.rest, target, observed, grant })
    expect(result).toBeInstanceOf(DiscordError)
    expect((result as Error).message).toBeTruthy()
    expect(result).not.toMatchObject({ kind: 'sent' })
    // One terminal attempt with the revoked credential: a 401 is not retried.
    expect(surface.attempts).toHaveLength(1)
    expect(surface.attempts[0]?.authorization).toBe('Bot revoked-credential')
    expect(surface.delivered).toHaveLength(0)
  } finally {
    spy.mockRestore()
    await surface.close()
  }
})

test('does not deliver when the bot token is emptied before the send', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: { ...key } }
  const grant = { ...target, session: { ...key }, publication: 'metadata' as const, consent: true as const }
  const get = surface.rest.get.bind(surface.rest)
  const spy = vi.spyOn(surface.rest, 'get').mockImplementation(async (...args) => {
    const channel = await get(...args)
    surface.rest.setToken('')
    return channel
  })
  try {
    const result = await publishObservedMetadata({ rest: surface.rest, target, observed, grant })
    expect(result).toBeInstanceOf(DiscordError)
    expect((result as Error).message).toBeTruthy()
    expect(result).not.toMatchObject({ kind: 'sent' })
    // The client refuses to emit a send without a credential, so the request
    // never reaches the surface and nothing can be posted.
    expect(surface.attempts).toHaveLength(0)
    expect(surface.delivered).toHaveLength(0)
  } finally {
    spy.mockRestore()
    await surface.close()
  }
})

test('fails closed before any send when the credential is already revoked', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  surface.rest.setToken('revoked-credential')
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: { ...key } }
  const grant = { ...target, session: { ...key }, publication: 'metadata' as const, consent: true as const }
  try {
    const result = await publishObservedMetadata({ rest: surface.rest, target, observed, grant })
    expect(result).toBeInstanceOf(DiscordError)
    expect((result as Error).message).toBeTruthy()
    expect(result).not.toMatchObject({ kind: 'sent' })
    // The surface lookup is rejected, so no message POST is ever attempted.
    expect(surface.attempts).toHaveLength(0)
    expect(surface.delivered).toHaveLength(0)
  } finally {
    await surface.close()
  }
})

// AC39 residual: the notice must name the profile that actually resolved the
// session. The binding still records the ACP family label (`backendKind`), so a
// KCode session is `backendKind: 'jcode'` on the record and `kcode` in the
// published label. The label is carried by the notice content, never by the
// stored binding shape.
const jcodeSession = { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'native' }

function jcodeTarget() {
  return { tenantId: discord.guildId, surfaceId: channelId, session: { ...jcodeSession } }
}

function jcodeGrant(target: ReturnType<typeof jcodeTarget>) {
  return { ...target, session: { ...jcodeSession }, publication: 'metadata' as const, consent: true as const }
}

function noticeContent(body: string): string {
  return (JSON.parse(body) as { content: string }).content
}

test('publishes a jcode profile observation under the jcode label', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  const target = jcodeTarget()
  try {
    const result = await publishMetadataNotice({ rest: surface.rest, target, grant: jcodeGrant(target), backend: 'jcode', profile: 'jcode' })
    expect(result).toMatchObject({ kind: 'sent' })
    expect(surface.delivered).toHaveLength(1)
    expect(noticeContent(surface.delivered[0]!)).toBe('-# External Jcode session activity observed.')
    // Mentions stay disabled in every publication.
    expect(JSON.parse(surface.delivered[0]!).allowed_mentions).toEqual({ parse: [] })
  } finally {
    await surface.close()
  }
})

test('publishes a kcode profile observation under the kcode label, not jcode', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  const target = jcodeTarget()
  // Provenance arrives as the resolved profile object the observer exposes.
  const profile = { id: 'kcode' as const }
  try {
    const result = await publishMetadataNotice({ rest: surface.rest, target, grant: jcodeGrant(target), backend: 'jcode', profile })
    expect(result).toMatchObject({ kind: 'sent' })
    expect(surface.delivered).toHaveLength(1)
    const content = noticeContent(surface.delivered[0]!)
    expect(content).toBe('-# External KCode session activity observed.')
    expect(content).not.toContain('Jcode')
    // The stored binding shape is untouched: the record is still the ACP family.
    expect(target.session.backendKind).toBe('jcode')
  } finally {
    await surface.close()
  }
})

test('refuses an unresolvable profile before any REST call', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  const target = jcodeTarget()
  try {
    const result = await publishMetadataNotice({
      rest: surface.rest,
      target,
      grant: jcodeGrant(target),
      backend: 'jcode',
      profile: 'kcode-fork' as never,
    })
    expect(result).toMatchObject({ kind: 'denied' })
    // Not even the surface lookup runs, let alone the message POST.
    expect(surface.requests).toHaveLength(0)
    expect(surface.attempts).toHaveLength(0)
    expect(surface.delivered).toHaveLength(0)
  } finally {
    await surface.close()
  }
})

test('refuses a kcode profile paired with an opencode backend before any REST call', async () => {
  const surface = await authSurface({ token: 'live-credential' })
  const target = { tenantId: discord.guildId, surfaceId: channelId, session: { ...key } }
  try {
    const result = await publishMetadataNotice({
      rest: surface.rest,
      target,
      grant: { ...target, session: { ...key }, publication: 'metadata' as const, consent: true as const },
      backend: 'opencode',
      profile: 'kcode',
    })
    expect(result).toMatchObject({ kind: 'denied' })
    expect(surface.requests).toHaveLength(0)
    expect(surface.delivered).toHaveLength(0)
  } finally {
    await surface.close()
  }
})
