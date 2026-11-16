import fs from 'node:fs/promises'
import path from 'node:path'
import { ChannelType, REST, Routes } from 'discord.js'
import type { KimakiDb } from '../../db.ts'
import { ConfigError, DiscordError } from '../../errors.js'
import { ackHub, openHubStream, readHubState } from '../../backend/hub-client.ts'
import type { HubEvent } from '../../backend/hub.ts'
import { claimSurface, type CutoverLedger, type SurfaceClaim, type SurfaceConsumer } from '../cutover.ts'

// A view's hub identity is scoped to the channel it mirrors, not to the process
// that happens to run it. Two views on one channel therefore claim the same id,
// and the hub refuses the second one instead of letting both post every turn
// twice. Views on different channels stay independent because the id differs.
export function defaultViewClientId(channelId: string): string {
  return `discord-view-${channelId}`
}

// AC34: the durable claim a view holds on its surface. It is the binding row the
// consumer's identity names, checked through the same writeSurface fence a
// cutover moves, so the view never keeps posting through a pause or a handover.
export type ViewClaim = {
  db: KimakiDb
  ledger: CutoverLedger
  consumer: SurfaceConsumer
  serviceKind?: string
  onClaim?: (result: SurfaceClaim) => void
}

export async function openDiscordView({ rest, tenantId, channelId, clientId, cursor, statePath, baseUrl, signal, onPosted, rebind = false, claim }: {
  rest: REST
  tenantId: string
  channelId: string
  clientId: string
  cursor?: number
  statePath: string
  baseUrl: string
  signal?: AbortSignal
  onPosted?: (seq: number) => void
  // Following a live session change is an explicit operator decision. Off by
  // default, because switching silently would mix two sessions in one channel.
  rebind?: boolean
  // Without a claim the view keeps its pre-cutover behavior: one hub subscriber
  // per channel id and no metadata store. With one, every post is fenced.
  claim?: ViewClaim
}): Promise<Error | undefined> {
  let posted = 0
  let savedSession: string | undefined
  try {
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as { seq?: unknown; sessionId?: unknown }
    if (!Number.isSafeInteger(saved.seq) || (saved.seq as number) < 0) return new ConfigError({ reason: 'Invalid Discord view state cursor' })
    posted = saved.seq as number
    if (typeof saved.sessionId === 'string' && saved.sessionId.trim()) savedSession = saved.sessionId
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      return new ConfigError({ reason: 'Cannot read Discord view state', cause })
    }
    console.info(`Discord view state missing at ${statePath}; starting at sequence 0`)
  }
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) return new ConfigError({ reason: 'Invalid Discord view cursor' })
  // A view resume is only meaningful for the session it was posted from. Refuse a
  // state file that belongs to another session instead of silently skipping its
  // turns, which is what makes rebinding safe rather than lossy.
  const hubState = await readHubState({ baseUrl })
  if (hubState instanceof Error) return hubState
  if (savedSession !== undefined && hubState.sessionId !== null && hubState.sessionId !== savedSession) {
    return new ConfigError({ reason: `Discord view state belongs to session ${savedSession}, but the hub is serving ${hubState.sessionId}` })
  }
  // A cursor that cannot be attributed to a session would silently swallow the
  // next session's early events, because they carry lower sequence numbers.
  if (hubState.sessionId === null && posted > 0) {
    return new ConfigError({ reason: 'Hub has no session yet, so the saved cursor cannot be attributed to one; start the session or use a fresh state file' })
  }
  const channel = await rest.get(Routes.channel(channelId)).catch((cause) => new DiscordError({ operation: 'read Discord view channel', cause }))
  if (channel instanceof Error) return channel
  if (!channel || typeof channel !== 'object' || !('id' in channel) || channel.id !== channelId
    || !('guild_id' in channel) || channel.guild_id !== tenantId || !('type' in channel)
    || ![ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type as ChannelType)) {
    return new DiscordError({ operation: 'read Discord view channel', cause: new Error('Channel does not belong to the requested tenant or is not text') })
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  // Refreshing the claim is what makes this process a real consumer of the
  // surface rather than an unattached mirror: the binding row it named is asked
  // again, and a cutover that paused, superseded or retired it is authoritative.
  const refreshClaim = async (): Promise<SurfaceClaim | Error | undefined> => {
    if (claim === undefined) return undefined
    const taken = await claimSurface({
      db: claim.db, ledger: claim.ledger, tenantId, surfaceId: channelId, serviceKind: claim.serviceKind, consumer: claim.consumer,
    })
    if (taken instanceof Error) return taken
    claim.onClaim?.(taken)
    return taken
  }
  const initial = await refreshClaim()
  if (initial instanceof Error) return initial
  // A paused or staged row is a cutover window: stay attached and post nothing
  // until the surface settles. A missing, retired or superseded claim can never
  // write, so the view stops here instead of retrying forever.
  if (initial !== undefined && !initial.claimed && !initial.retryable) return new ConfigError({ reason: initial.reason })
  let failure: Error | undefined
  let pending = Promise.resolve()
  let text = ''
  let lastSeen = posted
  let boundSession = savedSession ?? (hubState.sessionId ?? undefined)
  const handle = async (event: HubEvent): Promise<void> => {
    if (failure) return
    // A restarted hub numbers its log from the beginning, so the new session's
    // start can carry a lower sequence than the cursor. It still has to be seen:
    // dropping it would silently keep posting the new session's turns under the
    // old session's identity.
    const foreignStart = event.type === 'session.started'
      && boundSession !== undefined && boundSession !== event.sessionId
    if (!foreignStart && event.seq <= lastSeen) return
    // For an approved rebind this is also the cursor reset: the new session's
    // events continue from its own start event, not from the old session's seq.
    lastSeen = event.seq
    if (event.type === 'session.started') {
      // The hub names its session on start; a state file for a different one is a
      // rebind, not a resume, so it must fail rather than mix two sessions.
      if (boundSession !== undefined && boundSession !== event.sessionId) {
        if (!rebind) {
          failure = new ConfigError({ reason: `Discord view state belongs to session ${boundSession}, but the hub started ${event.sessionId}` })
          controller.abort()
          return
        }
        // The operator approved the rebind. Drop any buffered turn from the old
        // session; its already-posted history is never replayed, and its queued
        // events sit below the reset cursor so they cannot post after the switch.
        text = ''
      }
      boundSession = event.sessionId
    }
    if (event.type === 'prompt.started') text = ''
    if (event.type === 'prompt.chunk') text += event.text
    if (event.type !== 'prompt.finished' && event.type !== 'prompt.failed') return
    const content = event.type === 'prompt.failed' ? `Turn failed: ${event.reason}` : text
    text = ''
    if (!content) {
      failure = new ConfigError({ reason: 'Cannot publish an empty turn without fabricating text' })
      controller.abort()
      return
    }
    // AC34: the pause and the handover are observed here, on the live surface.
    // The claim is refreshed immediately before the post, so a turn the surface
    // no longer belongs to is never written.
    if (claim !== undefined) {
      const refreshed = await refreshClaim()
      if (refreshed instanceof Error) {
        failure = refreshed
        controller.abort()
        return
      }
      if (refreshed !== undefined && !refreshed.claimed) {
        // The turn is dropped, not deferred: a cutover window is retried on the
        // next turn, and a lost claim stops the view with the named refusal.
        if (!refreshed.retryable) {
          failure = new ConfigError({ reason: refreshed.reason })
          controller.abort()
        }
        return
      }
    }
    const sent = await rest.post(Routes.channelMessages(channelId), {
      body: { content, allowed_mentions: { parse: [] } },
    }).catch((cause) => new DiscordError({ operation: 'publish Discord view turn', cause }))
    if (sent instanceof Error) {
      failure = sent
      controller.abort()
      return
    }
    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true })
      const temp = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, JSON.stringify({ sessionId: boundSession ?? null, seq: event.seq }))
        await fs.rename(temp, statePath)
      } finally { await fs.rm(temp, { force: true }) }
      posted = event.seq
    } catch (cause) {
      failure = new ConfigError({ reason: 'Cannot persist Discord view cursor after posting', cause })
      controller.abort()
      return
    }
    const acked = await ackHub({ baseUrl, clientId, seq: event.seq })
    if (acked instanceof Error) {
      failure = acked
      controller.abort()
      return
    }
    onPosted?.(posted)
  }
  try {
    const result = await openHubStream({ baseUrl, clientId, cursor: posted, signal: controller.signal,
      onReady: (ready) => {
        if (ready.clipped) {
          failure = new ConfigError({ reason: 'Discord view replay cursor was clipped' })
          controller.abort()
        }
      },
      onEvent: (event) => { pending = pending.then(() => handle(event)).catch((cause) => {
        failure = cause instanceof Error ? cause : new Error(String(cause))
        controller.abort()
      }) },
    })
    await pending
    return failure ?? (signal?.aborted && result instanceof Error && (result as Error & { cause?: Error }).cause?.name === 'AbortError' ? undefined : result)
  } finally {
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}
