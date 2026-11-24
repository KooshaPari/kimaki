// A new Discord thread on a jcode bot gets its own native jcode session.
//
// docs/opencode-removal.md Phase 1 left exactly this gap: `startSession` minted
// sessions through OpenCode, and the jcode seam could only follow one that already
// existed. Creation now happens where a thread is bound, so a fresh install needs
// no OpenCode at all, and it never happens at bot start (a bot start follows a
// session; it does not create one).
//
// Two rules are structural here, not comments:
//
//   * A thread whose row already names a session is never re-created. The row is
//     read first, and a row means "follow this id" — the create path is not
//     entered again, so a second message cannot replace a live session.
//   * A failed creation leaves no row behind. The row is written only after the
//     seam returns a session id whose record is on disk; a refusal is returned to
//     the caller and reported on the thread it was for.
//
// What is deliberately not here: serving turns. The seam's create path mints and
// primes a session, and this module stops that connection once the record settles
// (the bot's long-lived connections are chosen at start, per thread-backend.ts).
// Projecting a created thread's turns to Discord is the next step, not this one.

import crypto from 'node:crypto'
import path from 'node:path'

import type { TextChannel } from 'discord.js'

import type { Author, Bot, PromptFile } from './bot.ts'
import { routeText, textChannel } from './bot.ts'
import { createJcodeBotBackend } from './backend/jcode-bot-backend.ts'
import { bindThread } from './bind-thread.ts'
import { ConfigError, DbError, DiscordError } from './errors.ts'
import { formatError, SILENT_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { formatEcho } from './queue.ts'
import type { Route } from './routes.ts'
import { createWorktree } from './worktrees.ts'

const logger = createLogger('JCODE-THREAD')

/** The binding input, shared by the Discord path and the e2e test. */
export type JcodeSessionBinding = {
  /** The Discord thread (or channel-as-conversation) the session is bound to. */
  threadId: string
  channelId: string
  /** The thread's working directory: the cwd the created session runs in. */
  directory: string
  /** The user's first message. The seam requires it: a record appears only after a turn. */
  primer: string
}

export type JcodeSessionBound = {
  sessionId: string
  /** True when the row already named a session and nothing was created. */
  reused: boolean
}

/**
 * Mint a jcode session for a thread and write its row, or return a named error.
 *
 * `follow: 'create'` is the seam's creation mode: ACP `session/new` mints an id
 * but persists no record, so the primer turn is what makes the session real, and
 * construction refuses to return a connection whose record has not settled.
 */
export async function bindJcodeSession(bot: Bot, { threadId, channelId, directory, primer }: JcodeSessionBinding): Promise<Error | JcodeSessionBound> {
  if (bot.backendKind !== 'jcode') {
    return new ConfigError({ reason: `Thread ${threadId} cannot get a jcode session: this bot's backend is ${bot.backendKind}` })
  }

  // The row is the authority (thread-backend.ts). If it already names a session,
  // that session is followed, never replaced: re-creating here would silently
  // orphan whatever the thread has been talking to.
  const existing = await bot.db.query.thread_sessions
    .findFirst({ where: { thread_id: threadId }, columns: { session_id: true } })
    .catch((cause) => new DbError({ operation: 'read thread_sessions', cause }))
  if (existing instanceof Error) return existing
  if (existing && existing.session_id.trim() !== '') {
    logger.log(`thread ${threadId} already names session ${existing.session_id}; following it instead of creating`)
    return { sessionId: existing.session_id, reused: true }
  }

  const created = await createJcodeBotBackend({
    ...(bot.jcodeStore.binary === null ? {} : { binary: bot.jcodeStore.binary }),
    ...(bot.jcodeStore.home === null ? {} : { home: bot.jcodeStore.home }),
    cwd: directory,
    follow: 'create',
    createPrompt: primer,
    // Same durable dedupe location the bot's other connections use.
    cursorDir: path.join(bot.dataDir, 'jcode-observe'),
    // The primer's own turn is this construction's write and is never news; this
    // connection is stopped below anyway, so nothing here reaches Discord.
    onEvent: () => {},
  })
  if (created instanceof Error) return created

  try {
    const bound = await bindThread(bot, { threadId, sessionId: created.sessionId, channelId, directory, isNew: true })
    if (bound instanceof Error) return bound
    return { sessionId: created.sessionId, reused: false }
  } finally {
    // Creation only: the bot has no per-thread connection registry yet, so an
    // observer left running would poll a record nobody reads.
    created.stop()
  }
}

export type NewJcodeThreadInput = {
  channelId: string
  directory: string
  route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
  author: Author
  messageId: string
  startMessageId?: string | null
  showInput?: boolean
  threadName?: string
  // More Discord users added to the thread next to the author (`kimaki send --user`).
  members?: readonly string[]
  files?: readonly PromptFile[]
  worktree?: string | false
  baseBranch?: string
  run?: boolean
}

/**
 * The jcode branch of `startSession`: create the Discord thread, bind a created
 * session to it, and report the outcome on that thread.
 *
 * A creation refusal is posted inside the thread (the caller's error reply would
 * land in the channel that spawned it) and returned unchanged, so the caller logs
 * and surfaces the same named reason. No row is written for a refused creation.
 */
export async function startJcodeThread(bot: Bot, input: NewJcodeThreadInput): Promise<Error | { threadId: string; sessionId: string }> {
  const { channelId, directory: requestedDirectory, route, author, messageId, startMessageId = messageId, showInput = startMessageId === null, threadName: explicitName, members = [], files = [], worktree, baseBranch, run = true } = input
  const defaults = await bot.db.query.channel_directories
    .findFirst({ where: { channel_id: channelId }, with: { channel_worktree: true } })
    .catch((cause) => new DbError({ operation: 'read channel defaults', cause }))
  if (defaults instanceof Error) return defaults

  const text = routeText(route)
  const channelWorktrees = defaults?.channel_worktree ? defaults.channel_worktree.enabled === 1 : bot.autoWorktrees
  const useWorktree = typeof worktree === 'string' || (worktree !== false && channelWorktrees)
  const textSlug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'session'
  const slug = typeof worktree === 'string' && worktree ? worktree : `${textSlug}-${crypto.randomBytes(4).toString('hex')}`
  const threadName = explicitName ?? (useWorktree ? slug : text.replace(/\s+/g, ' ').slice(0, 80) || 'Kimaki session')

  // The checkout first: a failed worktree must not leave a thread that has nowhere to run.
  const checkout = useWorktree
    ? await createWorktree({ projectDirectory: defaults?.directory ?? requestedDirectory, dataDir: bot.dataDir, name: slug, baseBranch })
    : null
  if (checkout instanceof Error) return checkout
  const directory = checkout?.directory ?? requestedDirectory

  const channel = await textChannel(bot, channelId)
  if (channel instanceof Error) return channel
  const thread = await channel.threads
    .create({ name: threadName, autoArchiveDuration: 1440, ...(startMessageId && { startMessage: startMessageId }) })
    .catch((cause) => new DiscordError({ operation: 'create thread', cause }))
  if (thread instanceof Error) return thread
  for (const id of new Set([author.id, ...members])) {
    if (id !== bot.discord.user?.id) void thread.members.add(id).catch((e: Error) => logger.warn(`add member ${id}`, e))
  }

  const bound = await bindJcodeSession(bot, { threadId: thread.id, channelId, directory, primer: text })
  if (bound instanceof Error) {
    // The named refusal belongs where the user is looking: the thread it was for.
    await thread
      .send({ content: formatError(bound.message), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
      .catch(() => undefined)
    return bound
  }
  bot.analytics.track('session_created', { has_worktree: Boolean(checkout), source: 'discord' })

  const ready = checkout ? `Worktree ready: \`${directory}\`\nBranch: \`${checkout.branch ?? 'detached'}\`\n` : ''
  if (!run) {
    const posted = await thread
      .send({ content: `${ready}Send a message to start working.`, allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
      .catch((cause) => new DiscordError({ operation: 'post worktree ready', cause }))
    if (posted instanceof Error) return posted
    return { threadId: thread.id, sessionId: bound.sessionId }
  }
  if (showInput) {
    const names = files.map((file) => file.name).join(', ')
    const shown = names ? `${text}\nFiles: ${names}` : text
    bot.effects.run(thread.id, [{ type: 'send', text: formatEcho({ username: author.username, text: shown }), echo: true }])
  }
  // Honest about what this step is: the session exists and its primer turn ran,
  // but the seam projects turns to Discord only through a long-lived connection
  // chosen at bot start, so this thread has no reply to show yet.
  const posted = await thread
    .send({
      content: `${ready}jcode session \`${bound.sessionId}\` created. Replies from a jcode session are not projected to Discord yet; this thread keeps that session for when they are.`,
      allowedMentions: { parse: [] },
      flags: SILENT_MESSAGE_FLAGS,
    })
    .catch((cause) => new DiscordError({ operation: 'post jcode session', cause }))
  if (posted instanceof Error) return posted
  logger.log(`thread ${thread.id} bound to created jcode session ${bound.sessionId}`)
  return { threadId: thread.id, sessionId: bound.sessionId }
}

export type NewJcodeCoordinatorInput = {
  channel: TextChannel
  route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
  author: Author
}

/**
 * The jcode branch of `startCoordinator`: one long session that lives in the
 * channel itself, bound with the channel ID as its conversation.
 *
 * A refusal is posted in the channel, which is where the user typed.
 */
export async function startJcodeCoordinator(bot: Bot, { channel, route, author }: NewJcodeCoordinatorInput): Promise<Error | { threadId: string; sessionId: string }> {
  const defaults = await bot.db.query.channel_directories
    .findFirst({ where: { channel_id: channel.id }, columns: { directory: true } })
    .catch((cause) => new DbError({ operation: 'read channel defaults', cause }))
  if (defaults instanceof Error) return defaults
  if (!defaults) return new ConfigError({ reason: 'This channel is not configured with a project directory' })

  const bound = await bindJcodeSession(bot, { threadId: channel.id, channelId: channel.id, directory: defaults.directory, primer: routeText(route) })
  if (bound instanceof Error) {
    await channel.send({ content: formatError(bound.message), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS }).catch(() => undefined)
    return bound
  }
  bot.analytics.track('session_created', { has_worktree: false, source: 'discord' })
  const posted = await channel
    .send({
      content: `jcode session \`${bound.sessionId}\` created for this channel. Replies from a jcode session are not projected to Discord yet; this channel keeps that session for when they are.`,
      allowedMentions: { parse: [] },
      flags: SILENT_MESSAGE_FLAGS,
    })
    .catch((cause) => new DiscordError({ operation: 'post jcode coordinator session', cause }))
  if (posted instanceof Error) return posted
  logger.log(`channel ${channel.id} bound to ${author.id}'s created jcode session ${bound.sessionId}`)
  return { threadId: channel.id, sessionId: bound.sessionId }
}
