// A caller-owned, ephemeral opt-in. This does not alter or grant authority to
// metadata-only ops bindings, and is not connected to the CLI or bot lifecycle.
// It publishes no native payload and makes no delivery or replay guarantees.
// Delivery is deliberately at-most-once per call: a failed POST is reported, not
// retried, because a POST that may have succeeded would duplicate on retry.
import { ChannelType, REST, Routes } from 'discord.js'
import { DiscordError } from '../../errors.js'
import type { RuntimeProfile, RuntimeProfileId, SessionKey } from '../contracts.js'
import { RUNTIME_PROFILES } from '../contracts.js'
import type { OpenCodeObservedEvent } from '../runtime/opencode.js'

export type MetadataTarget = { tenantId: string; surfaceId: string; session: SessionKey }
export type MetadataGrant = MetadataTarget & { publication: 'metadata'; consent: boolean }

// The only backend labels allowed in the fixed output line. A jcode-family
// backend still distinguishes stock jcode from its KCode fork by profile, so the
// display label is a superset of the backend family.
export type MetadataBackend = 'opencode' | 'jcode'
export type MetadataLabel = MetadataBackend | 'kcode'

// What a caller may hand over as provenance. Either the resolved profile itself
// (the observer exposes one) or just its id. The session binding never carries
// this: it stays the ACP family label so stored records keep their shape.
export type ProfileProvenance = Pick<RuntimeProfile, 'id'> | RuntimeProfileId

const NOTICE: Record<MetadataLabel, string> = {
  opencode: '-# External OpenCode session activity observed.',
  jcode: '-# External Jcode session activity observed.',
  kcode: '-# External KCode session activity observed.',
}

// Resolve the display label from the profile that actually served the session.
// An omitted profile means the stock jcode identity for a jcode-family backend,
// which keeps existing callers honest. An unknown profile, or a profile that
// cannot belong to this backend family, resolves to null so the caller refuses
// before any REST call. This is the only place the label is decided.
function labelFor(backend: MetadataBackend, profile: ProfileProvenance | null | undefined): MetadataLabel | null {
  if (backend !== 'opencode' && backend !== 'jcode') return null
  if (profile === null || profile === undefined) return backend
  const id = typeof profile === 'string' ? profile : profile.id
  if (!Object.hasOwn(RUNTIME_PROFILES, id)) return null
  const profileId = id as RuntimeProfileId
  // KCode rides the jcode ACP family; it can never be published as opencode.
  if (backend !== 'jcode') return null
  return profileId
}

type Denied = { kind: 'denied' }
type Outcome = { kind: 'sent' | 'denied' | 'ignored' } | DiscordError

function valid(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sameSession(a: SessionKey, b: SessionKey): boolean {
  return !!a && !!b && valid(a.hostId) && valid(a.endpointId) && valid(a.nativeSessionId)
    && a.backendKind === b.backendKind && a.hostId === b.hostId && a.endpointId === b.endpointId
    && a.nativeSessionId === b.nativeSessionId
}

// Consent and scope are re-read after the destination lookup as well, so a grant
// revoked while the channel is being resolved cannot still publish.
function scopeValid(target: MetadataTarget | null, grant: MetadataGrant | null): boolean {
  return !!grant && grant.publication === 'metadata' && grant.consent === true && !!target
    && valid(target.tenantId) && valid(target.surfaceId)
    && grant.tenantId === target.tenantId && grant.surfaceId === target.surfaceId
    && sameSession(target.session, grant.session)
}

async function resolveSurface({ rest, tenantId, surfaceId }: { rest: REST; tenantId: string; surfaceId: string }): Promise<Denied | DiscordError | { channel: unknown }> {
  const channel = await rest.get(Routes.channel(surfaceId)).catch((cause) => new DiscordError({ operation: 'read publication surface', cause }))
  if (channel instanceof DiscordError) return channel
  if (!channel || typeof channel !== 'object' || !('guild_id' in channel) || channel.guild_id !== tenantId
    || !('id' in channel) || channel.id !== surfaceId || !('type' in channel)
    || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread
      && channel.type !== ChannelType.PrivateThread && channel.type !== ChannelType.AnnouncementThread)) return { kind: 'denied' }
  return { channel }
}

async function postNotice({ rest, surfaceId, label }: { rest: REST; surfaceId: string; label: MetadataLabel }): Promise<Outcome> {
  const sent = await rest.post(Routes.channelMessages(surfaceId), {
    body: { content: NOTICE[label], allowed_mentions: { parse: [] } },
  }).catch((cause) => new DiscordError({ operation: 'publish observation metadata', cause }))
  if (sent instanceof DiscordError) return sent
  return { kind: 'sent' }
}

// Backend-neutral notice. The caller decides which metadata event justified it
// and which profile resolved the session, but nothing from that event reaches the
// message body. `profile` is the observer's provenance; when it is omitted only a
// stock jcode backend is assumed, never KCode.
export async function publishMetadataNotice({ rest, target, grant, backend, profile }: {
  rest: REST
  target: MetadataTarget
  grant: MetadataGrant | null
  backend: MetadataBackend
  profile?: ProfileProvenance | null
}): Promise<Outcome> {
  // Label resolution is first: an unknown profile is refused before any REST
  // call, so it cannot even resolve the surface.
  const label = labelFor(backend, profile)
  if (label === null) return { kind: 'denied' }
  if (!scopeValid(target, grant)) return { kind: 'denied' }
  if (target.session.backendKind !== backend) return { kind: 'denied' }
  const tenantId = target.tenantId
  const surfaceId = target.surfaceId
  const session = { ...target.session }
  const resolved = await resolveSurface({ rest, tenantId, surfaceId })
  if (resolved instanceof DiscordError || 'kind' in resolved) return resolved
  // Re-check after the await so a mid-flight revocation or scope change denies.
  if (!scopeValid({ ...target, tenantId, surfaceId, session }, grant)
    || target.tenantId !== tenantId || target.surfaceId !== surfaceId || !sameSession(session, target.session)) return { kind: 'denied' }
  return postNotice({ rest, surfaceId, label })
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
}): Promise<Outcome> {
  if (!observed || observed.schemaVersion !== 1 || !observed.source
    || observed.source.backendKind !== 'opencode'
    || !sameSession(target.session, observed.key) || !observed.raw || !observed.raw.data
    || !('sessionID' in observed.raw.data) || observed.raw.data.sessionID !== target.session.nativeSessionId) return { kind: 'denied' }
  // Limit publication to a known native lifecycle event. Its title and all
  // other event fields are intentionally excluded from the output.
  if (observed.raw.type !== 'session.renamed') return { kind: 'ignored' }
  if (!scopeValid(target, grant)) return { kind: 'denied' }
  const tenantId = target.tenantId
  const surfaceId = target.surfaceId
  const session = { ...target.session }
  const resolved = await resolveSurface({ rest, tenantId, surfaceId })
  if (resolved instanceof DiscordError || 'kind' in resolved) return resolved
  if (!scopeValid({ ...target, tenantId, surfaceId, session }, grant)
    || observed.schemaVersion !== 1 || observed.raw.type !== 'session.renamed'
    || observed.source.backendKind !== 'opencode' || observed.source.hostId !== session.hostId
    || observed.source.endpointId !== session.endpointId
    || !sameSession(session, observed.key) || observed.raw.data.sessionID !== session.nativeSessionId) return { kind: 'denied' }
  return postNotice({ rest, surfaceId, label: 'opencode' })
}
