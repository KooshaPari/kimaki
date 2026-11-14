import fs from 'node:fs/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, REST } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  classifyIncoming,
  markForPublish,
  publishGuarded,
  readEchoMarker,
  stripEchoMarker,
  type EchoConfig,
  type EchoMessage,
} from './echo.ts'

const root = 'E:\\koosh\\Agents\\scratch\\discord-echo'
const OTHER_BOT_ID = '910000000000000001'
const HUMAN_ID = '910000000000000002'
let twin: DigitalDiscord
let channelId: string
let guard: EchoConfig

beforeAll(async () => {
  await fs.mkdir(root, { recursive: true })
  twin = new DigitalDiscord({
    guild: { name: 'Echo' },
    channels: [{ name: 'general', type: ChannelType.GuildText }],
    users: [
      { id: OTHER_BOT_ID, username: 'OtherBot', bot: true },
      { id: HUMAN_ID, username: 'Human' },
    ],
  })
  await twin.start()
  channelId = (await twin.prisma.channel.findMany())[0]!.id
  guard = { serviceId: 'kimaki', self: { id: twin.botUserId, bot: true } }
}, 30_000)
afterAll(async () => { await twin?.stop() })

const rest = () => new REST({ api: twin.restUrl, version: '10', retries: 0, rejectOnRateLimit: () => true }).setToken(twin.botToken)
const channel = async (): Promise<EchoMessage[]> => (await twin.channel(channelId).getMessages())
  .map((message) => ({ id: message.id, author: { id: message.author.id, bot: !!message.author.bot }, content: message.content }))
const count = async () => (await twin.channel(channelId).getMessages()).length

// One drain is one pass of the ingest loop: observe every unseen message once,
// publish what the guard allows, and repeat until a pass publishes nothing. A
// loop that never reaches that fixed point is the bug this test is looking for.
async function drain(seen: Set<string>, limit = 20): Promise<string[]> {
  const posted: string[] = []
  for (let round = 0; round < limit; round++) {
    let progressed = false
    for (const message of await channel()) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      const outcome = await publishGuarded({ rest: rest(), channelId, message, guard })
      if (outcome instanceof Error) throw outcome
      if (outcome.kind !== 'sent') continue
      posted.push(outcome.content)
      progressed = true
    }
    if (!progressed) return posted
  }
  throw new Error('echo exchange did not reach a fixed point')
}

test('an own published message carries no duplicate: re-ingest is dropped', async () => {
  const seen = new Set((await channel()).map((message) => message.id))
  const before = await count()
  const source = await twin.simulateUserMessage({ channelId, userId: HUMAN_ID, content: 'human question' })
  const posted = await drain(seen)
  // Exactly one publish for the human turn, and it carries durable provenance.
  expect(posted).toHaveLength(1)
  const published = (await channel()).at(-1)!
  expect(published.author).toEqual({ id: twin.botUserId, bot: true })
  expect(readEchoMarker(published.content)).toEqual({ serviceId: 'kimaki', origin: source.id, hop: 1 })
  expect(stripEchoMarker(published.content)).toBe('human question')
  // Re-observing our own message, by identity and by marker, is always a drop.
  expect(classifyIncoming(published, guard)).toEqual({ action: 'drop', reason: 'own-message' })
  expect(classifyIncoming({ ...published, author: { id: '999', bot: true } }, guard))
    .toEqual({ action: 'drop', reason: 'own-marker' })
  expect(await count()).toBe(before + 2)
  // Feeding the same message back through the loop adds nothing.
  seen.delete(published.id)
  expect(await publishGuarded({ rest: rest(), channelId, message: published, guard }))
    .toEqual({ kind: 'dropped', reason: 'own-message' })
  expect(await count()).toBe(before + 2)
})

test('a peer bot exchange terminates in two publishes and never loops', async () => {
  const seen = new Set((await channel()).map((message) => message.id))
  const before = await count()
  const peer = await twin.simulateUserMessage({ channelId, userId: OTHER_BOT_ID, content: 'peer status' })
  // First publish is the peer's own message; the second is ours, and it carries
  // the marker that makes the echo back un-publishable.
  const posted = await drain(seen)
  expect(posted).toHaveLength(1)
  expect(await count()).toBe(before + 2)
  const [peerMessage, ours] = (await channel()).slice(before)
  expect(peerMessage!.id).toBe(peer.id)
  expect(peerMessage!.author).toEqual({ id: OTHER_BOT_ID, bot: true })
  expect(await publishGuarded({ rest: rest(), channelId, message: ours!, guard }))
    .toEqual({ kind: 'dropped', reason: 'own-message' })
  // A full second pass over the channel publishes nothing: the fixed point is
  // reached at two messages, not an unbounded echo.
  expect(await drain(seen)).toHaveLength(0)
  expect(await count()).toBe(before + 2)
})

test('an unmarked message from another bot is published exactly once', async () => {
  const before = await count()
  const source = await twin.simulateUserMessage({ channelId, userId: OTHER_BOT_ID, content: 'deploy finished' })
  const message: EchoMessage = { id: source.id, author: { id: OTHER_BOT_ID, bot: true }, content: 'deploy finished' }
  expect(classifyIncoming(message, guard).action).toBe('publish')
  const outcome = await publishGuarded({ rest: rest(), channelId, message, guard })
  if (outcome instanceof Error) throw outcome
  expect(outcome.kind).toBe('sent')
  if (outcome.kind !== 'sent') throw new Error('unreachable')
  expect(stripEchoMarker(outcome.content)).toBe('deploy finished')
  expect(readEchoMarker(outcome.content)).toEqual({ serviceId: 'kimaki', origin: source.id, hop: 1 })
  expect(await count()).toBe(before + 2)
  // Exactly once: a second call for the same observation is the caller's
  // responsibility, but the published copy itself can never be re-published.
  expect(await publishGuarded({ rest: rest(), channelId, message: (await channel()).at(-1)!, guard }))
    .toEqual({ kind: 'dropped', reason: 'own-message' })
})

test('ten interleaved messages reach a fixed point with a literal publish count', async () => {
  const peers: Array<{ guard: EchoConfig; posted: number }> = [
    { guard: { serviceId: 'kimaki', self: { id: '1001', bot: true } }, posted: 0 },
    { guard: { serviceId: 'other', self: { id: '1002', bot: true } }, posted: 0 },
  ]
  const sources: EchoMessage[] = Array.from({ length: 10 }, (_, index) => ({
    id: `source-${index + 1}`,
    author: { id: '2001', bot: true },
    content: `interleaved ${index + 1}`,
  }))
  const queue: EchoMessage[] = [...sources]
  let serial = 0
  let steps = 0
  let published = 0
  while (queue.length > 0) {
    if (++steps > 500) throw new Error('echo exchange did not reach a fixed point')
    const message = queue.shift()!
    for (const peer of peers) {
      const outcome = classifyIncoming(message, peer.guard)
      if (outcome.action !== 'publish') continue
      published++
      peer.posted++
      // Deliver the new message back to every listener, including the service
      // that just wrote it, exactly as a gateway fan-out would.
      queue.push({ id: `pub-${++serial}`, author: peer.guard.self, content: outcome.content })
    }
  }
  // Ten sources, two guarded services: each publishes each source once and then
  // drops the other service's marked copy. The fixed point is literal.
  expect(peers.map((peer) => peer.posted)).toEqual([10, 10])
  expect(published).toBe(20)
  expect(queue).toHaveLength(0)
})

test('a human cannot suppress a message by pasting a marker into it', () => {
  const content = `please read this\n${markForPublish({ serviceId: 'kimaki', origin: 'src-1', hop: 1, content: '' })}`
  const message: EchoMessage = { id: 'src-1', author: { id: HUMAN_ID, bot: false }, content }
  expect(classifyIncoming(message, guard).action).toBe('publish')
})

test('raises the bridge bound only when the operator asks for it', () => {
  const peer: EchoMessage = {
    id: 'peer-1',
    author: { id: OTHER_BOT_ID, bot: true },
    content: markForPublish({ serviceId: 'other', origin: 'peer-1', hop: 1, content: 'peer turn' }),
  }
  expect(classifyIncoming(peer, guard)).toEqual({ action: 'drop', reason: 'cycle' })
  const bridged = classifyIncoming(peer, { ...guard, maxHops: 2 })
  expect(bridged.action).toBe('publish')
  if (bridged.action !== 'publish') throw new Error('unreachable')
  expect(bridged.hop).toBe(2)
  expect(readEchoMarker(bridged.content)).toEqual({ serviceId: 'kimaki', origin: 'peer-1', hop: 2 })
  expect(stripEchoMarker(bridged.content)).toBe('peer turn')
  // The bridged copy is itself bound: a second service drops it at hop 2.
  const echo: EchoMessage = {
    id: 'peer-2',
    author: { id: '1003', bot: true },
    content: markForPublish({ serviceId: 'third', origin: 'peer-1', hop: 2, content: 'peer turn' }),
  }
  expect(classifyIncoming(echo, { ...guard, maxHops: 2 })).toEqual({ action: 'drop', reason: 'cycle' })
})
