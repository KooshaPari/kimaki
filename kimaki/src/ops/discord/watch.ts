import fs from 'node:fs/promises'
import path from 'node:path'
import { ChannelType, REST, Routes } from 'discord.js'
import { ConfigError, DiscordError } from '../../errors.js'

export async function openNativeDiscordWatch({ rest, tenantId, channelId, statePath, sessionId }: {
  rest: REST; tenantId: string; channelId: string; statePath: string; sessionId: string
}): Promise<Error | { publish: (history: { role: string; text: string }[]) => Promise<Error | number> }> {
  let cursor = 0
  try {
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as { sessionId?: unknown; index?: unknown }
    if (saved.sessionId !== sessionId || !Number.isSafeInteger(saved.index) || (saved.index as number) < 0) return new ConfigError({ reason: 'Invalid native Discord watch state cursor or session' })
    cursor = saved.index as number
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') return new ConfigError({ reason: 'Cannot read native Discord watch state', cause })
  }
  const channel = await rest.get(Routes.channel(channelId)).catch((cause) => new DiscordError({ operation: 'read native watch channel', cause }))
  if (channel instanceof Error) return channel
  if (!channel || typeof channel !== 'object' || !('id' in channel) || channel.id !== channelId
    || !('guild_id' in channel) || channel.guild_id !== tenantId || !('type' in channel)
    || ![ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel.type as ChannelType)) {
    return new DiscordError({ operation: 'read native watch channel', cause: new Error('Channel does not belong to the requested tenant or is not text') })
  }
  return { publish: async (history) => {
    if (history.length < cursor) return new ConfigError({ reason: 'Native history shorter than durable Discord cursor' })
    let count = 0
    for (let index = cursor; index < history.length; index++) {
      const message = history[index]!
      const sent = await rest.post(Routes.channelMessages(channelId), {
        body: { content: `${message.role}: ${message.text}`, allowed_mentions: { parse: [] } },
      }).catch((cause) => new DiscordError({ operation: 'publish native watch message', cause }))
      if (sent instanceof Error) return sent
      try {
        await fs.mkdir(path.dirname(statePath), { recursive: true })
        const temp = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`
        try {
          await fs.writeFile(temp, JSON.stringify({ sessionId, index: index + 1 }))
          await fs.rename(temp, statePath)
        } finally { await fs.rm(temp, { force: true }) }
      } catch (cause) { return new ConfigError({ reason: 'Cannot persist native Discord cursor after posting', cause }) }
      cursor = index + 1
      count++
    }
    return count
  } }
}
