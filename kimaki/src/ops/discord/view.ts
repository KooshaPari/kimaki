import fs from 'node:fs/promises'
import path from 'node:path'
import { ChannelType, REST, Routes } from 'discord.js'
import { ConfigError, DiscordError } from '../../errors.js'
import { ackHub, openHubStream } from '../../backend/hub-client.ts'
import type { HubEvent } from '../../backend/hub.ts'

export async function openDiscordView({ rest, tenantId, channelId, clientId, cursor, statePath, baseUrl, signal, onPosted }: {
  rest: REST
  tenantId: string
  channelId: string
  clientId: string
  cursor?: number
  statePath: string
  baseUrl: string
  signal?: AbortSignal
  onPosted?: (seq: number) => void
}): Promise<Error | undefined> {
  let posted = 0
  try {
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as { seq?: unknown }
    if (!Number.isSafeInteger(saved.seq) || (saved.seq as number) < 0) return new ConfigError({ reason: 'Invalid Discord view state cursor' })
    posted = saved.seq as number
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      return new ConfigError({ reason: 'Cannot read Discord view state', cause })
    }
    console.info(`Discord view state missing at ${statePath}; starting at sequence 0`)
  }
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) return new ConfigError({ reason: 'Invalid Discord view cursor' })
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
  let failure: Error | undefined
  let pending = Promise.resolve()
  let text = ''
  let lastSeen = posted
  const handle = async (event: HubEvent): Promise<void> => {
    if (failure || event.seq <= lastSeen) return
    lastSeen = event.seq
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
        await fs.writeFile(temp, JSON.stringify({ seq: event.seq }))
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
