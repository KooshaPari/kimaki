// Creation on bind: a new thread gets its own jcode session, from an empty database.
//
// The gap this closes (docs/opencode-removal.md Phase 1, open item 2): the bot could
// follow a seeded jcode session but `startSession` only ever created sessions through
// OpenCode, so "new threads use jcode" was unreachable. `bindJcodeSession`
// (src/jcode-thread.ts) mints a session with the seam's `follow: 'create'` and writes
// the thread row through the same `bindThread` the OpenCode path uses.
//
// What this file proves, and nothing else:
//   1. From an empty database and a real binary, binding a thread mints a session whose
//      record exists under the isolated home's `sessions` directory.
//   2. The `thread_sessions` row records that session id and backend `jcode`.
//   3. A second call for the same thread reuses the recorded session: no row change, no
//      second record. (The second *message* path never reaches creation at all — a
//      bound thread dispatches; this pins the guard that would create if it did.)
//   4. A refused creation (empty primer) writes no row and creates no record.
//   5. A coordinator channel (the default for a channel message) binds the channel id to
//      a created session, so the default path is not left on OpenCode.
//   6. The primer turn's assistant text is relayed to the thread as the answer to the
//      user's first message (the fake Discord layer records it), and the created-notice
//      is kept only for a turn that produced no text.
//   7. A SECOND user message on the bound thread is one prompt turn on the recorded
//      session through src/prompt.ts's steer path, and its assistant answer is posted
//      to the thread. The session record gains the second message and its reply
//      (counts compared before and after).
//   8. A message on a thread with no `thread_sessions` row is a named error that
//      creates no session.
//
// What is structural here: the bot context is the fields these paths read (db, store,
// backendKind, jcodeStore, a recording event-loop/discord stub, analytics) rather than a
// live Discord client. Discord thread creation is `startJcodeThread`, covered by its own
// branch of the product, not simulated here. Creation, and the second turn, are the real
// binary: the assertions read the session file the binary wrote.

import fs from 'node:fs'
import path from 'node:path'

import { ChannelType } from 'discord.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Bot } from './bot.ts'
import { openDb, type KimakiDb, type OpenedDb } from './db.ts'
import { bindJcodeSession, createdSessionPost, startJcodeCoordinator, startJcodeThread } from './jcode-thread.ts'
import { steer } from './prompt.ts'
import { createBotStore } from './store.ts'
import { removeTempDir } from './test/cleanup.ts'
import { tempDataDir } from './test/harness.ts'
import { findJcodeBinary } from './test/jcode-harness.ts'
import { startMockProvider, type MockProvider } from './test/jcode-seed.ts'
import { withThreadBackend } from './thread-backend.ts'

const binary = findJcodeBinary()

function sessionFiles(home: string): string[] {
  const dir = path.join(home, 'sessions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
}

// The persisted messages of one session, read the way the product's observer does.
function recordMessages(home: string, sessionId: string): { role: string; text: string }[] {
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${sessionId}.json`), 'utf8')) as {
    messages?: { role: string; content?: { type: string; text?: string }[] }[]
  }
  return (raw.messages ?? []).map((message) => ({
    role: message.role,
    text: (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
  }))
}

// The turn reaches the record when the writer's ACP child ends, not when the
// prompt answer arrives; the await above covers that, and this bounded wait makes
// a slow filesystem write a retry rather than a flake.
async function waitForMessages(home: string, sessionId: string, atLeast: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let messages = recordMessages(home, sessionId)
  while (messages.length < atLeast && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    messages = recordMessages(home, sessionId)
  }
  return messages
}

const opened: { handle: OpenedDb | null } = { handle: null }
const roots: string[] = []
let mock: MockProvider
let saved: Record<string, string | undefined> = {}

// A bot context shaped like the real one for the fields this path touches. `bind`
// records what the writer wrote, so the in-memory routing can be asserted next to
// the row it must agree with.
function jcodeBot({ db, home, dataDir, discord }: { db: KimakiDb; home: string; dataDir: string; discord?: unknown }) {
  const binds: { threadId: string; sessionId: string; backend: string }[] = []
  const bot = {
    db,
    dataDir,
    backendKind: 'jcode' as const,
    jcodeStore: { binary, home },
    autoWorktrees: false,
    discord: discord ?? { user: { id: 'bot-user' } },
    analytics: { track: () => {} },
    effects: { run: () => {} },
    store: { getState: () => ({ threadBackends: {} as Record<string, string> }) },
    eventLoop: {
      bind: async ({ threadId, sessionId, backend }: { threadId: string; sessionId: string; backend: string }) => {
        binds.push({ threadId, sessionId, backend })
      },
    },
  }
  return { bot: bot as unknown as Bot, binds }
}

describe.skipIf(binary === null)(`jcode session creation on bind${binary === null ? ' [SKIPPED: no jcode binary]' : ''}`, () => {
  let root = ''
  let home = ''
  let cwd = ''
  let dataDir = ''

  beforeAll(async () => {
    mock = await startMockProvider()
    // A cold home has no credentials, so the primer turn is pointed at the loopback
    // provider. Scrub both families first: a developer's own home or key would
    // silently replace the isolated ones (same rule as test/jcode-seed.ts).
    saved = {
      JCODE_HOME: process.env['JCODE_HOME'],
      JCODE_MODEL: process.env['JCODE_MODEL'],
      JCODE_PROVIDER: process.env['JCODE_PROVIDER'],
      JCODE_NO_TELEMETRY: process.env['JCODE_NO_TELEMETRY'],
      OPENAI_BASE_URL: process.env['OPENAI_BASE_URL'],
      OPENAI_API_BASE: process.env['OPENAI_API_BASE'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    }
    root = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'kimaki-jcode-thread-'))
    roots.push(root)
    home = path.join(root, 'home')
    cwd = path.join(root, 'cwd')
    for (const dir of [home, cwd]) fs.mkdirSync(dir, { recursive: true })
    process.env['JCODE_HOME'] = home
    delete process.env['JCODE_MODEL']
    delete process.env['JCODE_PROVIDER']
    process.env['JCODE_NO_TELEMETRY'] = '1'
    process.env['OPENAI_BASE_URL'] = `${mock.url}/v1`
    process.env['OPENAI_API_BASE'] = `${mock.url}/v1`
    process.env['OPENAI_API_KEY'] = 'kimaki-thread-test-key'
    dataDir = tempDataDir()
    const handle = await openDb({ dataDir, migrate: true })
    if (handle instanceof Error) throw handle
    opened.handle = handle
  }, 120_000)

  afterAll(async () => {
    opened.handle?.close()
    try {
      await mock?.close()
    } catch {
      // provider connections are already destroyed
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await removeTempDir(dataDir).catch(() => {})
    for (const dir of roots) await removeTempDir(dir).catch(() => {})
  }, 60_000)

  test('an empty database plus a real binary: bind creates one session, records it, and reuses it', async () => {
    const db = opened.handle!.db
    // Empty database: no rows at all before the binding.
    expect(await db.query.thread_sessions.findMany()).toEqual([])
    expect(sessionFiles(home)).toEqual([])

    const { bot, binds } = jcodeBot({ db, home, dataDir })
    const startedAt = Date.now()
    const first = await bindJcodeSession(bot, { threadId: 'thread-new', channelId: 'channel-1', directory: cwd, primer: 'Reply with only: ok' })
    if (first instanceof Error) throw first
    expect(first.reused).toBe(false)
    expect(first.sessionId).toMatch(/^session_/)

    // (1) The record exists on disk, written now, and carries the primer turn: a turn
    // is what persists a session at all.
    const file = path.join(home, 'sessions', `${first.sessionId}.json`)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).mtimeMs).toBeGreaterThanOrEqual(startedAt)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; messages: unknown[] }
    expect(record.id).toBe(first.sessionId)
    expect(JSON.stringify(record.messages)).toContain('Reply with only: ok')

    // (2) The row records it, with the backend the routing rule reads.
    const rows = await db.query.thread_sessions.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ thread_id: 'thread-new', session_id: first.sessionId, backend: 'jcode' })
    // The routing map and the row agree: bindThread wrote both.
    expect(binds).toEqual([{ threadId: 'thread-new', sessionId: first.sessionId, backend: 'jcode' }])

    // (3) A second binding of the same thread follows the recorded session.
    const second = await bindJcodeSession(bot, { threadId: 'thread-new', channelId: 'channel-1', directory: cwd, primer: 'Reply with only: ok' })
    if (second instanceof Error) throw second
    expect(second).toEqual({ sessionId: first.sessionId, reused: true, primerReply: null })
    expect(sessionFiles(home)).toEqual([`${first.sessionId}.json`])
    expect(await db.query.thread_sessions.findMany()).toEqual(rows)
    expect(binds).toHaveLength(1)
  }, 180_000)


  test('a coordinator channel binds the channel id to a created session', async () => {
    const db = opened.handle!.db
    const { bot, binds } = jcodeBot({ db, home, dataDir })
    // A project row is what a coordinator needs; the channel itself is a fake that
    // records what would be posted (no Discord client in this suite).
    await db.insert((await import('./schema.ts')).channel_directories).values({ channel_id: 'channel-coord', directory: cwd, channel_type: 'text' })
    const sent: string[] = []
    const channel = {
      id: 'channel-coord',
      send: async (payload: { content: string }) => {
        sent.push(payload.content)
        return {}
      },
    }
    const before = sessionFiles(home)
    const started = await startJcodeCoordinator(bot, { channel: channel as never, route: { kind: 'steer', text: 'Reply with only: ok' }, author: { id: 'user-1', username: 'user' } })
    if (started instanceof Error) throw started
    expect(started.threadId).toBe('channel-coord')
    // The row is keyed by the channel id, and the session is brand new.
    const row = await db.query.thread_sessions.findFirst({ where: { thread_id: 'channel-coord' } })
    expect(row).toMatchObject({ session_id: started.sessionId, backend: 'jcode' })
    expect(binds).toEqual([{ threadId: 'channel-coord', sessionId: started.sessionId, backend: 'jcode' }])
    expect(sessionFiles(home)).toHaveLength(before.length + 1)
    expect(fs.existsSync(path.join(home, 'sessions', `${started.sessionId}.json`))).toBe(true)
    // The primer's assistant text is what the channel sees: the question is the
    // primer, so its answer is the reply. No created-notice and no 'projected'.
    expect(sent).toEqual(['ok'])
    expect(sent.join('\n')).not.toContain('projected')

    // A second call for the same channel finds the row and posts nothing: the
    // creation and its answer were already relayed, so relaying again would
    // duplicate the turn.
    const again = await startJcodeCoordinator(bot, { channel: channel as never, route: { kind: 'steer', text: 'Reply with only: ok' }, author: { id: 'user-1', username: 'user' } })
    if (again instanceof Error) throw again
    expect(again.sessionId).toBe(started.sessionId)
    expect(sent).toEqual(['ok'])
  }, 180_000)

  // The fake Discord layer: the channel fetch `textChannel` performs, the thread
  // creation `startJcodeThread` performs, and every `send` the product makes.
  function fakeDiscord(threadId: string) {
    const sent: string[] = []
    const thread = {
      id: threadId,
      send: async (payload: { content: string }) => {
        sent.push(payload.content)
        return {}
      },
      members: { add: async () => undefined },
    }
    const channel = {
      id: 'channel-thread',
      type: ChannelType.GuildText,
      threads: { create: async () => thread },
    }
    return { discord: { user: { id: 'bot-user' }, channels: { fetch: async () => channel } }, sent }
  }

  test("the primer turn's answer is relayed to the new thread; no created-notice is posted", async () => {
    const db = opened.handle!.db
    const { discord, sent } = fakeDiscord('thread-first')
    const { bot } = jcodeBot({ db, home, dataDir, discord })
    const started = await startJcodeThread(bot, {
      channelId: 'channel-thread',
      directory: cwd,
      route: { kind: 'steer', text: 'Reply with only: ok' },
      author: { id: 'user-1', username: 'user' },
      messageId: 'message-1',
    })
    if (started instanceof Error) throw started
    // The user's first message is the primer, and its assistant text reached the
    // thread once: 'ok', not a created-notice, not the word 'projected'.
    expect(sent).toEqual(['ok'])
    expect(sent.join('\n')).not.toContain('projected')
    // The relay came from the persisted record, not from anything this path invented.
    const record = fs.readFileSync(path.join(home, 'sessions', `${started.sessionId}.json`), 'utf8')
    const assistant = (JSON.parse(record) as { messages: { role: string; content: { type: string; text: string }[] }[] }).messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content.filter((part) => part.type === 'text').map((part) => part.text))
    expect(assistant.join('\n\n').trim()).toBe('ok')
    const row = await db.query.thread_sessions.findFirst({ where: { thread_id: 'thread-first' } })
    expect(row).toMatchObject({ session_id: started.sessionId, backend: 'jcode' })
  }, 180_000)

  test('a created session with no assistant text posts the created-notice instead of a reply', async () => {
    // The one post both callers use (src/jcode-thread.ts): a turn with no text
    // keeps the notice, and the notice says what happened without 'projected'.
    const notice = createdSessionPost({ sessionId: 'session_none', primerReply: null })
    expect(notice.silent).toBe(true)
    expect(notice.content).toContain('session_none')
    expect(notice.content).toContain('created')
    expect(notice.content).toContain('no text to post')
    expect(notice.content).not.toContain('projected')
    // Whitespace-only is no text either.
    expect(createdSessionPost({ sessionId: 'session_none', primerReply: '   ' }).silent).toBe(true)
    // With text the reply IS the post (a worktree line, when one exists, prefixes it).
    expect(createdSessionPost({ sessionId: 'session_some', primerReply: 'the answer', ready: 'Worktree ready: x\n' })).toEqual({
      content: 'Worktree ready: x\nthe answer',
      silent: false,
    })
  })

  test('a refused creation (empty primer) writes no row and no record', async () => {
    const db = opened.handle!.db
    const before = sessionFiles(home)
    const beforeRows = await db.query.thread_sessions.findMany()
    const { bot, binds } = jcodeBot({ db, home, dataDir })
    const refused = await bindJcodeSession(bot, { threadId: 'thread-empty', channelId: 'channel-1', directory: cwd, primer: '   ' })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('persists no record until a turn runs')
    // No half-bound thread: no row, no routing entry, no fresh session record.
    expect(await db.query.thread_sessions.findMany()).toEqual(beforeRows)
    expect(binds).toEqual([])
    expect(sessionFiles(home)).toEqual(before)
  }, 60_000)

  test('a SECOND message on a bound thread is one prompt turn whose answer is posted', async () => {
    const db = opened.handle!.db
    const threadId = 'thread-second'
    const second = 'Reply with only: ok (second message)'

    // Bind first, exactly as a first Discord message would: this is where the
    // primer turn and the row come from.
    const { bot: bindingBot } = jcodeBot({ db, home, dataDir })
    const bound = await bindJcodeSession(bindingBot, { threadId, channelId: 'channel-second', directory: cwd, primer: 'Reply with only: ok' })
    if (bound instanceof Error) throw bound
    expect(bound.reused).toBe(false)

    const before = recordMessages(home, bound.sessionId)
    // The primer persisted a turn (at least one user message) and does not yet
    // contain the message this case sends.
    expect(before.length).toBeGreaterThanOrEqual(1)
    expect(before.some((message) => message.role === 'user')).toBe(true)
    expect(before.some((message) => message.text.includes(second))).toBe(false)

    // The bot the steer path runs on: a real store naming the thread's session
    // and backend, an OpenCode-less connection of kind jcode, and a Discord layer
    // that records what the thread would show.
    const store = createBotStore()
    store.setState({
      roots: { [threadId]: bound.sessionId },
      threadBackends: { [threadId]: 'jcode' },
      sessionThreads: { [bound.sessionId]: threadId },
    })
    const sent: string[] = []
    const thread = {
      id: threadId,
      isThread: () => true,
      send: async (payload: { content: string }) => {
        sent.push(payload.content)
        return {}
      },
    }
    const discord = { user: { id: 'bot-user' }, channels: { fetch: async () => thread } }
    const base = jcodeBot({ db, home, dataDir, discord }).bot as unknown as Bot
    const bot = {
      ...base,
      store,
      opencode: { kind: 'jcode' },
      backends: { opencode: null, jcode: { kind: 'jcode' } },
    } as unknown as Bot

    // The resolution the product performs before a prompt (thread-backend.ts), then
    // the steer path itself. This is the seam that was inert after the primer.
    const served = withThreadBackend(bot, threadId)
    if (!served.ok) throw served.error
    expect(served.backend).toBe('jcode')
    const result = await steer(served.bot, {
      sessionId: bound.sessionId,
      threadId,
      threadName: 'thread-second',
      text: second,
      author: { id: 'user-1', username: 'user' },
      messageId: 'message-2',
      directory: cwd,
    })
    if (result instanceof Error) throw result

    // The session file gained the second message and a reply to it: the real
    // binary wrote it, and the counts are compared, not assumed.
    const after = await waitForMessages(home, bound.sessionId, before.length + 2)
    expect(after.length).toBeGreaterThan(before.length)
    const users = after.filter((message) => message.role === 'user').map((message) => message.text)
    // The user's second message is in the record exactly once: this turn, not a replay.
    expect(users.filter((text) => text.includes('Reply with only: ok (second message)'))).toHaveLength(1)
    // The primer is still there: this turn appended a second user message rather
    // than replacing or re-sending the first.
    expect(users.some((text) => text.includes('Reply with only: ok'))).toBe(true)
    expect(after.filter((message) => message.role === 'assistant').length).toBeGreaterThanOrEqual(2)

    // The answer reached the thread: one post, the mock's reply, not a notice.
    expect(sent).toEqual(['ok'])
    expect(sent.join('\n')).not.toContain('completed (')

    // Still one session, one row: a turn never mints or rebinds.
    expect(sessionFiles(home)).toContain(`${bound.sessionId}.json`)
    expect(await db.query.thread_sessions.findFirst({ where: { thread_id: threadId } })).toMatchObject({
      session_id: bound.sessionId,
      backend: 'jcode',
    })
  }, 300_000)

  test('two messages at once are two turns, served in order on one session', async () => {
    const db = opened.handle!.db
    const threadId = 'thread-concurrent'
    const { bot: bindingBot } = jcodeBot({ db, home, dataDir })
    const bound = await bindJcodeSession(bindingBot, { threadId, channelId: 'channel-concurrent', directory: cwd, primer: 'Reply with only: ok' })
    if (bound instanceof Error) throw bound
    const before = recordMessages(home, bound.sessionId)

    const sent: string[] = []
    const thread = { id: threadId, isThread: () => true, send: async (payload: { content: string }) => {
      sent.push(payload.content)
      return {}
    } }
    const store = createBotStore()
    store.setState({ roots: { [threadId]: bound.sessionId }, threadBackends: { [threadId]: 'jcode' }, sessionThreads: { [bound.sessionId]: threadId } })
    const base = jcodeBot({ db, home, dataDir, discord: { user: { id: 'bot-user' }, channels: { fetch: async () => thread } } }).bot as unknown as Bot
    const bot = { ...base, store, opencode: { kind: 'jcode' }, backends: { opencode: null, jcode: { kind: 'jcode' } } } as unknown as Bot

    const send = (text: string, messageId: string) => steer(bot, {
      sessionId: bound.sessionId, threadId, threadName: 'thread-concurrent', text,
      author: { id: 'user-1', username: 'user' }, messageId, directory: cwd,
    })
    // No cancellation exists in this lane: the second message queues behind the
    // first instead of racing it, so neither turn is written over the other.
    const results = await Promise.all([send('first queued', 'message-c1'), send('second queued', 'message-c2')])
    for (const result of results) expect(result).not.toBeInstanceOf(Error)

    const after = await waitForMessages(home, bound.sessionId, before.length + 4)
    const sentTexts = after.filter((message) => message.role === 'user').map((message) => message.text)
      .filter((text) => text.includes('queued'))
    expect(sentTexts.filter((text) => text.includes('first queued'))).toHaveLength(1)
    expect(sentTexts.filter((text) => text.includes('second queued'))).toHaveLength(1)
    // In the order the user sent them: the first turn completed before the second began.
    expect(sentTexts.findIndex((text) => text.includes('first queued'))).toBeLessThan(sentTexts.findIndex((text) => text.includes('second queued')))
    expect(sent).toEqual(['ok', 'ok'])
  }, 300_000)

  test('a turn whose session record is gone is a named error and posts nothing', async () => {
    const db = opened.handle!.db
    const threadId = 'thread-norecord'
    const { bot: bindingBot } = jcodeBot({ db, home, dataDir })
    const bound = await bindJcodeSession(bindingBot, { threadId, channelId: 'channel-norecord', directory: cwd, primer: 'Reply with only: ok' })
    if (bound instanceof Error) throw bound

    // The row still names a session; the record behind it is gone. That is the
    // half-written state a turn must refuse instead of prompting a fresh session.
    const file = path.join(home, 'sessions', `${bound.sessionId}.json`)
    fs.renameSync(file, `${file}.gone`)

    const sent: string[] = []
    const thread = { id: threadId, isThread: () => true, send: async (payload: { content: string }) => {
      sent.push(payload.content)
      return {}
    } }
    const store = createBotStore()
    store.setState({ roots: { [threadId]: bound.sessionId }, threadBackends: { [threadId]: 'jcode' }, sessionThreads: { [bound.sessionId]: threadId } })
    const base = jcodeBot({ db, home, dataDir, discord: { user: { id: 'bot-user' }, channels: { fetch: async () => thread } } }).bot as unknown as Bot
    const bot = { ...base, store, opencode: { kind: 'jcode' }, backends: { opencode: null, jcode: { kind: 'jcode' } } } as unknown as Bot

    const result = await steer(bot, {
      sessionId: bound.sessionId,
      threadId,
      threadName: 'thread-norecord',
      text: 'second',
      author: { id: 'user-1', username: 'user' },
      messageId: 'message-norecord',
      directory: cwd,
    })
    // The named refusal from the write path (backend/jcode-bot-prompt.ts): the
    // turn never starts, so nothing is posted in its place.
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('is not persisted')
    expect(sent).toEqual([])
    // And no second session was minted to serve it.
    expect(sessionFiles(home).filter((name) => name === `${bound.sessionId}.json`)).toEqual([])
  }, 180_000)
})

// Always runs: the refusal needs no binary, and it is the one the brief names
// (no recorded session id is a named error, never a silent create).
test('a thread with no bound session is a named error and creates nothing', async () => {
  const dataDir = tempDataDir()
  const handle = await openDb({ dataDir, migrate: true })
  if (handle instanceof Error) throw handle
  try {
    const store = createBotStore()
    // The bot knows the thread's backend, so dispatch resolves jcode, but no row
    // records a session: exactly the half-bound state the refusal is for.
    store.setState({ roots: {}, threadBackends: { 'thread-unbound': 'jcode' }, sessionThreads: {} })
    const bot = {
      db: handle.db,
      store,
      opencode: { kind: 'jcode' },
      backendKind: 'jcode',
      jcodeStore: { binary: null, home: null },
      dataDir,
      discord: { user: { id: 'bot-user' }, channels: { fetch: async () => null } },
      effects: { run: () => {} },
      analytics: { track: () => {} },
    } as unknown as Bot
    const result = await steer(bot, {
      sessionId: 'session_never_bound',
      threadId: 'thread-unbound',
      threadName: 'thread-unbound',
      text: 'hello',
      author: { id: 'user-1', username: 'user' },
      messageId: 'message-unbound',
      directory: '/tmp',
    })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('has no bound jcode session')
    expect((result as Error).message).toContain('no session was created')
    // Nothing was written: no row, no session file.
    expect(await handle.db.query.thread_sessions.findMany()).toEqual([])
  } finally {
    handle.close()
    await removeTempDir(dataDir).catch(() => undefined)
  }
})
