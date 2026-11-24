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
//
// What is structural here: the bot context is the fields this path reads (db, store,
// backendKind, jcodeStore, a recording event-loop stub, analytics) rather than a live
// Discord client. Discord thread creation is `startJcodeThread`, covered by its own
// branch of the product, not simulated here. Creation itself is the real binary.

import fs from 'node:fs'
import path from 'node:path'

import { ChannelType } from 'discord.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { Bot } from './bot.ts'
import { openDb, type KimakiDb, type OpenedDb } from './db.ts'
import { bindJcodeSession, createdSessionPost, startJcodeCoordinator, startJcodeThread } from './jcode-thread.ts'
import { removeTempDir } from './test/cleanup.ts'
import { tempDataDir } from './test/harness.ts'
import { findJcodeBinary } from './test/jcode-harness.ts'
import { startMockProvider, type MockProvider } from './test/jcode-seed.ts'

const binary = findJcodeBinary()

function sessionFiles(home: string): string[] {
  const dir = path.join(home, 'sessions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
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
})
