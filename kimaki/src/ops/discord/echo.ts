// A general bot-to-bot echo guard for a channel that more than one service
// mirrors. It is the ingest-side counterpart to the outbound publish paths in
// view.ts, publication.ts and watch.ts, and it keeps their rules: content only,
// all mentions disabled, and at-most-once delivery per call (a failed POST is
// reported, never retried, because a POST that may have succeeded would
// duplicate on retry).
//
// A message is an echo when either:
//   1. its author is this bot (author id plus the bot flag), or
//   2. it carries this service's durable marker on a bot-authored message.
//
// Every message this guard publishes carries a marker line at the end:
//   -# echo:<service> origin:<first message id> hop:<n>
// `hop` counts how many services have re-published the message. The limit is
// configurable but defaults to one, so a message that already carries another
// service's marker can be bridged at most once and a two-service exchange
// terminates instead of looping forever. A human message can never carry a
// trusted marker: markers on non-bot authors are ignored, so they cannot be
// used to suppress publication.
import { REST, Routes } from 'discord.js'
import { DiscordError } from '../../errors.js'

export const MAX_MESSAGE_LENGTH = 2000

export type EchoIdentity = { id: string; bot: boolean }
export type EchoMessage = { id: string; author: EchoIdentity; content: string }
export type EchoConfig = {
  // Durable service identity, not a process id: it must survive restarts.
  serviceId: string
  // This bot's own Discord user identity.
  self: EchoIdentity
  // How many service re-publications a message may accumulate. One means a
  // message carrying another service's marker is never re-published.
  maxHops?: number
}
export type EchoDecision =
  | { action: 'drop'; reason: EchoDropReason }
  | { action: 'publish'; content: string; origin: string; hop: number }
export type EchoDropReason = 'own-message' | 'own-marker' | 'cycle'
export type GuardedOutcome = { kind: 'dropped'; reason: EchoDropReason } | { kind: 'sent'; content: string } | DiscordError

export type EchoMarker = { serviceId: string; origin: string; hop: number }

const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/
const ORIGIN = /^[A-Za-z0-9._:-]{1,64}$/
const MARKER = /(?:^|\n)-# echo:([a-z0-9][a-z0-9._-]{0,31}) origin:([A-Za-z0-9._:-]{1,64}) hop:(\d{1,2})\s*$/

export function markerLine({ serviceId, origin, hop }: EchoMarker): string {
  return `-# echo:${serviceId} origin:${origin} hop:${hop}`
}

// Read the marker only from the final line, so ordinary text that happens to
// mention "echo:" earlier in the message is not mistaken for provenance.
export function readEchoMarker(content: string): EchoMarker | null {
  const match = MARKER.exec(content.trimEnd())
  if (!match) return null
  const serviceId = match[1]!
  const origin = match[2]!
  const hop = Number.parseInt(match[3]!, 10)
  if (!SERVICE_ID.test(serviceId) || !ORIGIN.test(origin) || !Number.isSafeInteger(hop)) return null
  return { serviceId, origin, hop }
}

export function stripEchoMarker(content: string): string {
  return content.trimEnd().replace(MARKER, '').trimEnd()
}

// Replace any existing marker rather than stacking them, so a republish keeps
// one authoritative provenance line and one hop count.
export function markForPublish({ serviceId, origin, hop, content }: {
  serviceId: string
  origin: string
  hop: number
  content: string
}): string {
  if (!SERVICE_ID.test(serviceId)) throw new TypeError(`Invalid echo service id: ${serviceId}`)
  if (!ORIGIN.test(origin)) throw new TypeError(`Invalid echo origin id: ${origin}`)
  if (!Number.isSafeInteger(hop) || hop < 0) throw new TypeError(`Invalid echo hop: ${hop}`)
  const body = stripEchoMarker(content)
  const marker = markerLine({ serviceId, origin, hop })
  const room = MAX_MESSAGE_LENGTH - marker.length - (body ? 1 : 0)
  if (room <= 0) return marker
  const kept = body.slice(0, room)
  return kept ? `${kept}\n${marker}` : marker
}

// Decide what happens to one message observed in the shared channel. The only
// publishable outcomes carry the marker that stops the next service, so the
// exchange is bounded by construction rather than by channel history.
export function classifyIncoming(message: EchoMessage, config: EchoConfig): EchoDecision {
  const maxHops = config.maxHops ?? 1
  if (!SERVICE_ID.test(config.serviceId)) throw new TypeError(`Invalid echo service id: ${config.serviceId}`)
  if (!Number.isSafeInteger(maxHops) || maxHops < 1) throw new TypeError(`Invalid echo hop limit: ${maxHops}`)
  if (!message || typeof message.id !== 'string' || !ORIGIN.test(message.id)) {
    throw new TypeError('Echo message needs a stable message id')
  }
  const author = message.author
  const botAuthor = !!author && typeof author.id === 'string' && author.bot === true
  // Own user identity wins over content: this is the cheapest and most durable
  // proof that the message came from us, before any marker was even written.
  if (botAuthor && author.id === config.self.id) return { action: 'drop', reason: 'own-message' }
  // Only a bot-authored marker is provenance. A human cannot suppress a
  // message by pasting a marker into it.
  const marker = botAuthor ? readEchoMarker(message.content) : null
  if (marker === null) {
    return {
      action: 'publish',
      content: markForPublish({ serviceId: config.serviceId, origin: message.id, hop: 1, content: message.content }),
      origin: message.id,
      hop: 1,
    }
  }
  if (marker.serviceId === config.serviceId) return { action: 'drop', reason: 'own-marker' }
  // A cycle is closed as soon as the accumulated hops reach the limit. With the
  // default of one, another known service's marker is never re-published.
  if (marker.hop >= maxHops) return { action: 'drop', reason: 'cycle' }
  const hop = marker.hop + 1
  return {
    action: 'publish',
    content: markForPublish({ serviceId: config.serviceId, origin: marker.origin, hop, content: message.content }),
    origin: marker.origin,
    hop,
  }
}

// Publish one observed message if the guard allows it. Delivery is at most once
// per call: a failed POST is returned, never retried.
export async function publishGuarded({ rest, channelId, message, guard }: {
  rest: REST
  channelId: string
  message: EchoMessage
  guard: EchoConfig
}): Promise<GuardedOutcome> {
  const decision = classifyIncoming(message, guard)
  if (decision.action === 'drop') return { kind: 'dropped', reason: decision.reason }
  const sent = await rest.post(Routes.channelMessages(channelId), {
    body: { content: decision.content, allowed_mentions: { parse: [] } },
  }).catch((cause) => new DiscordError({ operation: 'publish guarded echo message', cause }))
  if (sent instanceof DiscordError) return sent
  return { kind: 'sent', content: decision.content }
}
