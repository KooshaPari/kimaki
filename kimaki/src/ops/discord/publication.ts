// A caller-owned, ephemeral opt-in. This does not alter or grant authority to
// metadata-only ops bindings, and is not connected to the CLI or bot lifecycle.
// It publishes no native payload and makes no delivery or replay guarantees.
import { ChannelType, REST, Routes } from 'discord.js'
import { DiscordError } from '../../errors.js'
import type { SessionKey } from '../contracts.js'
import type { OpenCodeObservedEvent } from '../runtime/opencode.js'

export type MetadataTarget = { tenantId: string; surfaceId: string; session: SessionKey }
export type MetadataGrant = MetadataTarget & { publication: 'metadata'; consent: boolean }

function valid(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sameSession(a: SessionKey, b: SessionKey): boolean {
  return !!a && !!b && valid(a.hostId) && valid(a.endpointId) && valid(a.nativeSessionId)
    && a.backendKind === 'opencode' && a.hostId === b.hostId && a.endpointId === b.endpointId
    && a.backendKind === b.backendKind && a.nativeSessionId === b.nativeSessionId
}

// Trusted callers must obtain consent and revoke the same grant object themselves.
// Revocation after the POST starts cannot cancel it. A grant is not
// proof of a Discord user's permissions. Only a fixed message is sent, with all
// mentions disabled. Each invocation can create a message: no retry or dedup.
export async function publishObservedMetadata({ rest, target, observed, grant }: {
  rest: REST
  target: MetadataTarget
  observed: OpenCodeObservedEvent
  grant: MetadataGrant | null
}): Promise<{ kind: 'sent' | 'denied' | 'ignored' } | DiscordError> {
  if (!grant || grant.publication !== 'metadata' || grant.consent !== true || !target || !valid(target.tenantId) || !valid(target.surfaceId)
    || grant.tenantId !== target.tenantId || grant.surfaceId !== target.surfaceId
    || !sameSession(target.session, grant.session) || !observed || observed.schemaVersion !== 1
    || !sameSession(target.session, observed.key) || !observed.source
    || observed.source.backendKind !== 'opencode' || observed.source.hostId !== target.session.hostId
    || observed.source.endpointId !== target.session.endpointId || !observed.raw || !observed.raw.data
    || !('sessionID' in observed.raw.data) || observed.raw.data.sessionID !== target.session.nativeSessionId) return { kind: 'denied' }
  // Limit publication to a known native lifecycle event. Its title and all
  // other event fields are intentionally excluded from the output.
  if (observed.raw.type !== 'session.renamed') return { kind: 'ignored' }
  const tenantId = target.tenantId
  const surfaceId = target.surfaceId
  const session = { ...target.session }
  const channel = await rest.get(Routes.channel(surfaceId)).catch((cause) => new DiscordError({ operation: 'read publication surface', cause }))
  if (channel instanceof DiscordError) return channel
  if (grant.consent !== true || grant.publication !== 'metadata'
    || grant.tenantId !== tenantId || grant.surfaceId !== surfaceId || !sameSession(session, grant.session)
    || target.tenantId !== tenantId || target.surfaceId !== surfaceId || !sameSession(session, target.session)
    || observed.schemaVersion !== 1 || observed.raw.type !== 'session.renamed'
    || observed.source.backendKind !== 'opencode' || observed.source.hostId !== session.hostId
    || observed.source.endpointId !== session.endpointId
    || !sameSession(session, observed.key) || observed.raw.data.sessionID !== session.nativeSessionId) return { kind: 'denied' }
  if (!channel || typeof channel !== 'object' || !('guild_id' in channel) || channel.guild_id !== tenantId
    || !('id' in channel) || channel.id !== surfaceId || !('type' in channel)
    || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread
      && channel.type !== ChannelType.PrivateThread && channel.type !== ChannelType.AnnouncementThread)) return { kind: 'denied' }
  const sent = await rest.post(Routes.channelMessages(surfaceId), {
    body: { content: '-# External OpenCode session activity observed.', allowed_mentions: { parse: [] } },
  }).catch((cause) => new DiscordError({ operation: 'publish observation metadata', cause }))
  if (sent instanceof DiscordError) return sent
  return { kind: 'sent' }
}
