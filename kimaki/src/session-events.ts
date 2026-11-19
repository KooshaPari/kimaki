// Debugging support: every event folded into a thread is appended to
// <dataDir>/session-events/<threadId>.jsonl, exactly as the reducer saw it
// (root + subagent sessions + kimaki.* internal events, in order).
//
// Why Kimaki records them: OpenCode 2.0.19 keeps no event history
// (`session.log` only answers log.synced, spec 29.2 #10), and message.list
// drops transient events like session.retry.scheduled. A recorded file is also
// a reducer fixture: replay it with test/replay.ts to reproduce a bug.
//
//   kimaki session events <sessionId|threadId>   print the JSONL
//   kimaki session read <sessionId|threadId>     print the messages from OpenCode
//   kimaki session sync                          write <dataDir>/transcripts/<sessionId>.md for rg

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { OpenCodeClient, SessionInboxItem, V2Event } from '@opencode/client'

import type { KimakiDb } from './db.ts'
import { ConfigError, DbError, OpenCodeError } from './errors.ts'
import { createLogger } from './logger.ts'
import { eventSessionId, isKimakiEvent, type ThreadEvent } from './thread-reducer.ts'

const logger = createLogger('EVENTS')

// Streaming deltas are the bulk of the traffic; the *.ended events carry the full text.
const SKIPPED_TYPES = new Set([
  'session.text.delta',
  'session.reasoning.delta',
  'session.tool.input.delta',
  'session.step.streamed',
])
const MAX_STRING = 10_000
// Per thread file. Older lines are dropped by starting a new file.
const MAX_FILE_BYTES = 20 * 1024 * 1024

export function sessionEventsDir({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'session-events')
}

export function sessionEventsFile({ dataDir, threadId }: { dataDir: string; threadId: string }): string {
  return path.join(sessionEventsDir({ dataDir }), `${threadId}.jsonl`)
}

function truncateStrings(_key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= MAX_STRING) return value
  return `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} chars truncated]`
}

export function createEventRecorder({ dataDir }: { dataDir: string }) {
  const streams = new Map<string, { stream: fs.WriteStream; bytes: number }>()
  const created = { dir: false }

  function open(threadId: string) {
    const existing = streams.get(threadId)
    if (existing && existing.bytes < MAX_FILE_BYTES) return existing
    existing?.stream.end()
    if (!created.dir) {
      fs.mkdirSync(sessionEventsDir({ dataDir }), { recursive: true })
      created.dir = true
    }
    const file = sessionEventsFile({ dataDir, threadId })
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    // Over the limit: start over rather than grow forever.
    const flags = size >= MAX_FILE_BYTES ? 'w' : 'a'
    const stream = fs.createWriteStream(file, { flags })
    stream.on('error', (error) => logger.warn(`cannot write ${file}`, error))
    const entry = { stream, bytes: flags === 'w' ? 0 : size }
    streams.set(threadId, entry)
    return entry
  }

  return {
    record(threadId: string, event: ThreadEvent): void {
      if (SKIPPED_TYPES.has(event.type)) return
      const entry = open(threadId)
      const line = `${JSON.stringify({ at: Date.now(), event }, truncateStrings)}\n`
      entry.bytes += Buffer.byteLength(line)
      entry.stream.write(line)
    },
    async close(): Promise<void> {
      await Promise.all(
        [...streams.values()].map(({ stream }) => new Promise<void>((resolve) => stream.end(() => resolve()))),
      )
      streams.clear()
    },
  }
}

export type EventRecorder = ReturnType<typeof createEventRecorder>

export type ResolvedSession = { threadId: string; sessionId: string }

// Accepts a root session id or a Discord thread id (both are in thread_sessions).
export async function resolveSession({
  db,
  id,
}: {
  db: KimakiDb
  id: string
}): Promise<DbError | ConfigError | ResolvedSession> {
  const row = await db.query.thread_sessions
    .findFirst({ where: { OR: [{ thread_id: id }, { session_id: id }] }, orderBy: { updated_at: 'desc' } })
    .catch((e) => new DbError({ operation: 'read thread_sessions', cause: e }))
  if (row instanceof Error) return row
  if (!row) return new ConfigError({ reason: `No Kimaki thread for ${id}. Pass a root session id or thread id.` })
  return { threadId: row.thread_id, sessionId: row.session_id }
}

export type Message = Awaited<ReturnType<OpenCodeClient['message']['list']>>['data'][number]
type Session = Awaited<ReturnType<OpenCodeClient['session']['get']>>

// Long enough for most edits, commands and subagent prompts; huge writes stay short.
const TOOL_INPUT_LIMIT = 5000

function renderMessage(message: Message, options: { thinking?: boolean; verbose?: boolean }): string {
  const time = new Date(message.time.created).toISOString()
  if (message.type === 'user' || message.type === 'synthetic' || message.type === 'system') return `## ${message.type} ${time}\n\n${message.text}`
  if (message.type === 'compaction' && message.status !== 'failed') return `## compaction ${time}\n\n${message.summary}`
  if (message.type !== 'assistant') return `## ${message.type} ${time}\n\n${JSON.stringify(message)}`
  const header = `## assistant ${time} (${message.agent}, ${message.model.providerID}/${message.model.id})`
  const parts = message.content.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'reasoning') return options.thinking ? part.text : ''
    if (part.type === 'tool') {
      const state = part.state
      const input = options.verbose ? JSON.stringify(state.input ?? {}) : JSON.stringify(state.input ?? {}).slice(0, TOOL_INPUT_LIMIT)
      const error = state.status === 'error' ? `\nerror: ${JSON.stringify(state).slice(0, 500)}` : ''
      const output = options.verbose && state.status === 'completed' ? `\n${JSON.stringify(state.content)}` : ''
      // Without --verbose tool outputs are hidden, but uploaded media stays findable.
      const media = options.verbose ? '' : mediaBlock(uploadedMedia(part))
      return `tool ${part.name} [${state.status}] ${input}${error}${output}${media && `\n${media}`}`
    }
    return ''
  })
  const finish = message.finish ? `\n\nfinish: ${message.finish}` : ''
  return `${header}\n\n${parts.join('\n\n')}${finish}`
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return '<1s'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${Math.round(tokens / 1_000)}k`
}

export type SessionUsage = { contextTokens: number; runMs: number | null; endedAt: number }

// Context size of the latest step, length of the latest run and when it ended. Oldest-first input.
// Agents use it to judge if a follow-up would rewrite a big, expired prompt cache.
export function sessionUsage(messages: readonly Message[]): SessionUsage | null {
  const lastIndex = messages.findLastIndex((message) => message.type === 'assistant')
  const last = messages[lastIndex]
  if (last?.type !== 'assistant') return null
  const step = messages.findLast((message) => message.type === 'assistant' && !!message.tokens)
  const tokens = step?.type === 'assistant' ? step.tokens : undefined
  const contextTokens = tokens ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write : 0
  // A run starts at a user prompt. Synthetic items also arrive mid-run (subagent results), so they count only without one.
  const before = messages.slice(0, lastIndex)
  const start = before.findLast((message) => message.type === 'user') ?? before.findLast((message) => message.type === 'synthetic')
  const endedAt = last.time.completed ?? last.time.created
  return { contextTokens, runMs: start ? endedAt - start.time.created : null, endedAt }
}

function usageLine(usage: SessionUsage | null, now: number): string {
  if (!usage) return ''
  const run = usage.runMs === null ? '' : `, last run took ${formatDuration(usage.runMs)}`
  return `\n\ncontext: ${formatTokens(usage.contextTokens)} tokens${run}, last active ${formatDuration(now - usage.endedAt)} ago (${new Date(usage.endedAt).toISOString()})`
}

// The text of the last assistant message that has text, like OpenCode's
// subagent completion (session/subagent-completion.ts). Oldest-first input.
export function finalAnswer(messages: readonly Message[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.type === 'user') return null
    if (message.type !== 'assistant') continue
    const text = message.content.flatMap((part) => (part.type === 'text' && part.text.trim() ? [part.text.trim()] : [])).join('\n\n')
    if (text) return text
  }
  return null
}

type MessagePart = Extract<Message, { type: 'assistant' }>['content'][number]

const UPLOAD_RESULT_PREFIX = '{"uploaded":'
// `"url":"..."` of each file in that JSON line (upload in prompt.ts). A regex, not zod:
// this module loads on every CLI start. Discord URLs have no quotes or backslashes.
const UPLOAD_URL = /"url":"([^"\\]+)"/g

// Discord URLs of the files a `kimaki upload-to-discord` call posted, from the result
// line it printed into the shell output (the system prompt says never to pipe it).
// The session history holds them, so this needs no Discord read and survives restarts.
function uploadedMedia(part: MessagePart): string[] {
  if (part.type !== 'tool' || part.state.status !== 'completed') return []
  return part.state.content
    .flatMap((content) => (content.type === 'text' ? content.text.split('\n') : []))
    .filter((line) => line.startsWith(UPLOAD_RESULT_PREFIX))
    .flatMap((line) => [...line.matchAll(UPLOAD_URL)].map((match) => match[1]!))
}

function mediaBlock(urls: readonly string[]): string {
  return urls.length === 0 ? '' : `Media uploaded to Discord:\n${urls.map((url) => `- ${url}`).join('\n')}`
}

// Inputs and the final answer of each turn, no tool calls: what agents read most often.
function renderAnswers({ session, messages, usage = '' }: { session: Pick<Session, 'id' | 'title' | 'location'>; messages: Message[]; usage?: string }): string {
  const title = `# ${session.title} (${session.id})\n\ndirectory: ${session.location.directory}${usage}`
  const blocks: string[] = []
  let turn: Message[] = []
  const flush = () => {
    const answer = finalAnswer(turn)
    const last = turn.findLast((message) => message.type === 'assistant')
    const media = mediaBlock(turn.flatMap((message) => (message.type === 'assistant' ? message.content.flatMap(uploadedMedia) : [])))
    if (answer && last?.type === 'assistant') blocks.push(`## assistant ${new Date(last.time.created).toISOString()} (${last.agent}, ${last.model.providerID}/${last.model.id})\n\n${answer}${media && `\n\n${media}`}`)
    turn = []
  }
  for (const message of messages) {
    if (message.type === 'assistant') {
      turn.push(message)
      continue
    }
    flush()
    if (message.type === 'user' || message.type === 'synthetic') blocks.push(`## ${message.type} ${new Date(message.time.created).toISOString()}\n\n${message.text}`)
    if (message.type === 'compaction' && message.status !== 'failed') blocks.push(`## compaction ${new Date(message.time.created).toISOString()}\n\n${message.summary}`)
  }
  // A turn without an answer yet (running, or waiting on a question): show its tool calls.
  if (turn.length > 0 && !finalAnswer(turn)) blocks.push(...turn.map((message) => renderMessage(message, {})))
  else flush()
  const more = `Only prompts and final answers are shown. Every tool call and the reasoning: kimaki session read ${session.id} --thinking`
  return [title, ...blocks, more].join('\n\n')
}

// Oldest first, as markdown. OpenCode returns the newest first.
// Default: prompts and final answers. `full`: every message with tool calls.
export async function readSessionMarkdown({
  client,
  sessionId,
  full,
  thinking,
  verbose,
  now = Date.now(),
}: {
  client: OpenCodeClient
  sessionId: string
  full?: boolean
  thinking?: boolean
  verbose?: boolean
  // Fixed clock for callers that compare two renders (the mirror parity test).
  now?: number
}): Promise<OpenCodeError | string> {
  const [session, messages] = await Promise.all([
    client.session.get({ sessionID: sessionId }).catch((e) => new OpenCodeError({ operation: 'session.get', cause: e })),
    allMessages({ client, sessionId }),
  ])
  if (session instanceof Error) return session
  if (messages instanceof Error) return messages
  const usage = usageLine(sessionUsage(messages), now)
  if (!full && !thinking && !verbose) return renderAnswers({ session, messages, usage })
  return renderSession({ session, messages, thinking, verbose, usage })
}

// Transcripts pass no usage: their "ago" would be stale on disk.
function renderSession({ session, messages, thinking, verbose, usage = '' }: { session: Pick<Session, 'id' | 'title' | 'location'>; messages: Message[]; thinking?: boolean; verbose?: boolean; usage?: string }): string {
  const title = `# ${session.title} (${session.id})\n\ndirectory: ${session.location.directory}${usage}`
  return [title, ...messages.map((message) => renderMessage(message, { thinking, verbose }))].join('\n\n')
}

// Transcripts: <dataDir>/transcripts/<sessionId>.md, the `session read` markdown
// with thinking but no tool outputs, so agents can search every session with rg.
// The file mtime is the session's time.updated: a file at least that new is current.
export function transcriptsDir({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'transcripts')
}

export async function writeTranscript({ client, dataDir, session }: { client: OpenCodeClient; dataDir: string; session: Pick<Session, 'id' | 'title' | 'location'> & { time: Pick<Session['time'], 'updated'> } }): Promise<OpenCodeError | ConfigError | void> {
  const messages = await allMessages({ client, sessionId: session.id })
  if (messages instanceof Error) return messages
  const dir = transcriptsDir({ dataDir })
  const file = path.join(dir, `${session.id}.md`)
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const written = await (async () => {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.promises.writeFile(temp, `${renderSession({ session, messages, thinking: true })}\n`, { mode: 0o600 })
    await fs.promises.utimes(temp, session.time.updated / 1000, session.time.updated / 1000)
    await fs.promises.rename(temp, file)
  })().catch((cause) => new ConfigError({ reason: `Cannot write ${file}`, cause }))
  if (written instanceof Error) await fs.promises.rm(temp, { force: true }).catch((error) => logger.warn(`cannot remove ${temp}`, error))
  return written
}

// The bot calls this when a run ends, so transcripts of new sessions appear on their own.
export async function syncSessionTranscript({ client, dataDir, sessionId }: { client: OpenCodeClient; dataDir: string; sessionId: string }): Promise<OpenCodeError | ConfigError | void> {
  const session = await client.session.get({ sessionID: sessionId }).catch((cause) => new OpenCodeError({ operation: 'session.get', cause }))
  if (session instanceof Error) return session
  return writeTranscript({ client, dataDir, session })
}

export type SyncResult = { written: number; skipped: number; failed: number }

// Sessions updated in the last `days` days (0 = all time) of every project.
// Skips sessions whose transcript is current, unless `rebuild`.
export async function syncTranscripts({
  client,
  dataDir,
  days,
  rebuild,
}: {
  client: OpenCodeClient
  dataDir: string
  days: number
  rebuild: boolean
}): Promise<OpenCodeError | SyncResult> {
  const [sessions, active] = await Promise.all([allSessions({ client }), client.session.active().catch((cause) => new OpenCodeError({ operation: 'session.active', cause }))])
  if (sessions instanceof Error) return sessions
  if (active instanceof Error) return active
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0
  const recent = sessions.filter((session) => session.time.updated >= cutoff)
  const result: SyncResult = { written: 0, skipped: 0, failed: 0 }
  const next = { index: 0 }
  const worker = async () => {
    while (next.index < recent.length) {
      const session = recent[next.index++]!
      const file = path.join(transcriptsDir({ dataDir }), `${session.id}.md`)
      const stat = await fs.promises.stat(file).catch(() => null)
      // time.updated may not move when a run ends: the live hook writes busy sessions when they stop.
      if (session.id in active || (!rebuild && stat && stat.mtimeMs >= session.time.updated - 1)) {
        result.skipped++
        continue
      }
      const written = await writeTranscript({ client, dataDir, session })
      if (written instanceof Error) {
        result.failed++
        logger.warn(`transcript of ${session.id} failed`, written)
        continue
      }
      result.written++
      logger.log(`transcript ${result.written + result.skipped + result.failed}/${recent.length}: ${session.id}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, recent.length) }, worker))
  return result
}

// Cursor pagination of message.list / session.list: every page, in order.
export async function collectPages<T>({
  operation,
  page,
}: {
  operation: string
  page: (cursor: string | undefined) => Promise<{ data: readonly T[]; cursor: { next?: string | null } }>
}): Promise<OpenCodeError | T[]> {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const result = await page(cursor).catch((cause) => new OpenCodeError({ operation, cause }))
    if (result instanceof Error) return result
    items.push(...result.data)
    cursor = result.cursor.next ?? undefined
  } while (cursor)
  return items
}

// Oldest first. A cursor must not be combined with `order`.
export function allMessages({ client, sessionId, type }: { client: OpenCodeClient; sessionId: string; type?: 'user' }) {
  return collectPages({
    operation: 'message.list',
    page: (cursor) => client.message.list({ sessionID: sessionId, limit: 200, ...(type && { type }), ...(cursor ? { cursor } : { order: 'asc' as const }) }),
  })
}

export function allSessions({ client, project }: { client: OpenCodeClient; project?: string }) {
  return collectPages({
    operation: 'session.list',
    page: (cursor) => client.session.list({ project, limit: 200, ...(cursor ? { cursor } : { order: 'desc' as const }) }),
  })
}

// Why `kimaki session wait` returned for a session. `idle`: no run was in progress
// when the wait started. `running`: the timeout ended the wait first.
export type WaitStatus = 'finished' | 'failed' | 'interrupted' | 'idle' | 'question' | 'permission' | 'running'

function eventStatus(event: V2Event): { sessionId: string; status: WaitStatus } | null {
  if (event.type === 'form.created') return { sessionId: event.data.form.sessionID, status: 'question' }
  if (event.type === 'permission.asked') return { sessionId: event.data.sessionID, status: 'permission' }
  if (event.type === 'session.execution.succeeded') return { sessionId: event.data.sessionID, status: 'finished' }
  if (event.type === 'session.execution.failed') return { sessionId: event.data.sessionID, status: 'failed' }
  if (event.type === 'session.execution.interrupted') return { sessionId: event.data.sessionID, status: 'interrupted' }
  return null
}

// Waits until every session ended its run or paused for the user, on one event stream.
// When `signal` ends the wait, the sessions not done yet get `running`.
export async function waitForSessions({ client, sessionIds, signal }: { client: OpenCodeClient; sessionIds: readonly string[]; signal?: AbortSignal }): Promise<OpenCodeError | Map<string, WaitStatus>> {
  const statuses = new Map<string, WaitStatus>()
  const settle = (sessionId: string, status: WaitStatus) => {
    if (sessionIds.includes(sessionId) && !statuses.has(sessionId)) statuses.set(sessionId, status)
  }
  const done = () => statuses.size === new Set(sessionIds).size
  const controller = new AbortController()
  const subscriptionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const iterator = client.event.subscribe({ signal: subscriptionSignal })[Symbol.asyncIterator]()
  const result = await (async () => {
    const first = await iterator.next().catch((cause) => new OpenCodeError({ operation: 'event.subscribe', cause }))
    if (first instanceof Error) return first
    if (first.done || first.value.type !== 'server.connected') return new OpenCodeError({ operation: 'connect session wait stream' })
    // Subscribed before hydrating, so no run can end unseen in between.
    const consume = (async () => {
      while (!subscriptionSignal.aborted) {
        const next = await iterator.next().catch((cause) => new OpenCodeError({ operation: 'event.subscribe', cause }))
        if (next instanceof Error) return next
        if (next.done) return new OpenCodeError({ operation: 'session wait stream ended' })
        const ended = eventStatus(next.value)
        if (ended) settle(ended.sessionId, ended.status)
        if (done()) return
      }
      return new OpenCodeError({ operation: 'session wait cancelled' })
    })()
    const hydrated = await Promise.all([
      client.session.active({ signal: subscriptionSignal }),
      Promise.all(sessionIds.map((sessionID) => Promise.all([
        client.session.form.list({ sessionID }, { signal: subscriptionSignal }),
        client.permission.list({ sessionID }, { signal: subscriptionSignal }),
      ]))),
    ]).catch((cause) => new OpenCodeError({ operation: 'hydrate session wait', cause }))
    if (hydrated instanceof Error) return hydrated
    const [active, pending] = hydrated
    for (const [index, sessionId] of sessionIds.entries()) {
      const [forms, permissions] = pending[index] ?? [[], []]
      if (forms.length > 0) settle(sessionId, 'question')
      if (permissions.length > 0) settle(sessionId, 'permission')
      if (!active[sessionId]) settle(sessionId, 'idle')
    }
    if (done()) return
    return consume
  })()
  controller.abort()
  await iterator.return?.(undefined).catch(() => undefined)
  if (result instanceof Error && !signal?.aborted) return result
  for (const sessionId of sessionIds) settle(sessionId, 'running')
  return statuses
}

// ---------------------------------------------------------------------------
// Durable mirror reads: `kimaki session read --from-mirror`.
//
// createEventRecorder above writes every event the reducer saw, which carries
// enough to rebuild what message.list returns. Only recorded values are used;
// a field the mirror cannot know is either marked MIRROR_UNKNOWN or omitted:
//
//   title      session.created/session.renamed of the session, else MIRROR_UNKNOWN
//   directory  the location of the newest event of the session, else MIRROR_UNKNOWN
//   idle       message.list ends a run with an `idle` message whose id is not
//              recorded, so it is omitted (the default output never shows it)
//   ids        user (inboxID) and assistant (assistantMessageID) ids equal live;
//              a compaction id equals live only when compaction.started has inputID
//   streamed   message.time.streamed comes from session.step.streamed, which the
//              recorder skips, so it is omitted (nothing renders it)
//   long text  the recorder truncates strings over MAX_STRING, so a huge tool
//              input or output differs from live after that many characters
//   --json     refused: the verbatim records would miss the idle marker and id

export const MIRROR_UNKNOWN = '(not recorded in the mirror)'

export type MirrorEventLine = { at: number; event: ThreadEvent }

export async function readMirrorEvents({ dataDir, threadId }: { dataDir: string; threadId: string }): Promise<ConfigError | MirrorEventLine[]> {
  const file = sessionEventsFile({ dataDir, threadId })
  const content = await fs.promises.readFile(file, 'utf8').catch((cause) => new ConfigError({ reason: `Cannot read the session-events mirror ${file}`, cause }))
  if (content instanceof Error) return content
  const events: MirrorEventLine[] = []
  const lines = content.split('\n')
  for (const [index, text] of lines.entries()) {
    if (!text) continue
    const parsed = (() => {
      try {
        return JSON.parse(text) as MirrorEventLine
      } catch (cause) {
        return new ConfigError({ reason: `Cannot parse line ${index + 1} of the session-events mirror ${file}`, cause })
      }
    })()
    if (parsed instanceof Error) return parsed
    events.push(parsed)
  }
  return events
}

type MirrorPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; name: string; executed?: boolean; state: Record<string, unknown>; time: { created: number; ran?: number; completed?: number } }

type MirrorCompaction = { id: string; type: 'compaction'; time: { created: number }; status: 'running' | 'completed' | 'failed'; reason: 'auto' | 'manual'; summary: string; recent: string }

type MirrorAssistant = { message: Extract<Message, { type: 'assistant' }>; parts: MirrorPart[] }

// Rebuilds message.list records of one session from recorded events, oldest first
// like allMessages. A session the mirror never saw yields no messages.
function foldMirrorEvents({ events, sessionId }: { events: readonly MirrorEventLine[]; sessionId: string }): { title: string | null; directory: string | null; messages: Message[] } {
  let title: string | null = null
  let directory: string | null = null
  const messages: Message[] = []
  // An inbox item becomes a message when it is delivered: message.list shows it then, with the delivery time.
  const queued = new Map<string, SessionInboxItem>()
  const assistants = new Map<string, MirrorAssistant>()
  const tools = new Map<string, Extract<MirrorPart, { type: 'tool' }>>()
  const compactions = new Map<string, MirrorCompaction>()

  const assistant = (id: string, created: number): MirrorAssistant => {
    const existing = assistants.get(id)
    if (existing) return existing
    const message = { id, type: 'assistant', time: { created }, agent: '', model: { providerID: '', id: '' }, content: [] } as unknown as Extract<Message, { type: 'assistant' }>
    const entry: MirrorAssistant = { message, parts: [] }
    assistants.set(id, entry)
    messages.push(message)
    return entry
  }

  for (const { event } of events) {
    if (isKimakiEvent(event)) continue
    if (event.type === 'server.connected') continue
    if (eventSessionId(event) !== sessionId) continue
    if ('location' in event && event.location?.directory) directory = event.location.directory
    switch (event.type) {
      case 'session.created':
        title = event.data.title ?? null
        directory = event.data.location.directory
        break
      case 'session.renamed':
        title = event.data.title
        break
      case 'session.moved':
        directory = event.data.location.directory
        break
      case 'session.inbox.enqueued':
        // A compaction item carries no reason or summary; the compaction.* events do.
        if (event.data.item.type !== 'compaction') queued.set(event.data.inboxID, event.data.item)
        break
      case 'session.inbox.cancelled':
        queued.delete(event.data.inboxID)
        break
      case 'session.inbox.delivered': {
        const item = queued.get(event.data.inboxID)
        if (!item) break
        queued.delete(event.data.inboxID)
        const time = { created: event.created }
        if (item.type === 'user') {
          const { payload } = item
          messages.push({
            id: event.data.inboxID,
            type: 'user',
            time,
            text: payload.text,
            ...(payload.files && { files: payload.files }),
            ...(payload.agents && { agents: payload.agents }),
            ...(payload.skills && { skills: payload.skills }),
            ...(payload.metadata && { metadata: payload.metadata }),
          })
        } else if (item.type === 'synthetic') {
          messages.push({ id: event.data.inboxID, type: 'synthetic', time, text: item.payload.text, ...(item.payload.description !== undefined && { description: item.payload.description }) })
        }
        break
      }
      case 'session.step.started': {
        const entry = assistant(event.data.assistantMessageID, event.data.started)
        entry.message.agent = event.data.agent
        entry.message.model = event.data.model
        if (event.data.snapshot) entry.message.snapshot = { start: event.data.snapshot }
        break
      }
      case 'session.text.ended':
        assistant(event.data.assistantMessageID, event.created).parts.push({ type: 'text', text: event.data.text })
        break
      case 'session.reasoning.ended':
        assistant(event.data.assistantMessageID, event.created).parts.push({ type: 'reasoning', text: event.data.text })
        break
      case 'session.tool.input.started': {
        const key = `${event.data.assistantMessageID}:${event.data.id}`
        const part: Extract<MirrorPart, { type: 'tool' }> = { type: 'tool', id: event.data.id, name: event.data.name, state: { status: 'running', input: {} }, time: { created: event.created } }
        tools.set(key, part)
        assistant(event.data.assistantMessageID, event.created).parts.push(part)
        break
      }
      case 'session.tool.called': {
        const key = `${event.data.assistantMessageID}:${event.data.id}`
        const existing = tools.get(key)
        const part: Extract<MirrorPart, { type: 'tool' }> = existing ?? { type: 'tool', id: event.data.id, name: 'tool', state: { status: 'running', input: {} }, time: { created: event.created } }
        if (!existing) {
          tools.set(key, part)
          assistant(event.data.assistantMessageID, event.created).parts.push(part)
        }
        ;(part.state as { input: unknown }).input = event.data.input
        part.executed = event.data.executed
        part.time.ran = event.created
        break
      }
      case 'session.tool.success': {
        const part = tools.get(`${event.data.assistantMessageID}:${event.data.id}`)
        if (!part) break
        part.state = { status: 'completed', input: (part.state as { input?: unknown }).input ?? {}, content: event.data.content, ...(event.data.metadata !== undefined && { metadata: event.data.metadata }) }
        part.time.completed = event.created
        break
      }
      case 'session.tool.failed': {
        const part = tools.get(`${event.data.assistantMessageID}:${event.data.id}`)
        if (!part) break
        part.state = { status: 'error', input: (part.state as { input?: unknown }).input ?? {}, error: event.data.error, ...(event.data.content !== undefined && { content: event.data.content }) }
        part.time.completed = event.created
        break
      }
      case 'session.step.ended': {
        const entry = assistant(event.data.assistantMessageID, event.created)
        entry.message.finish = event.data.finish
        if (event.data.rawFinish !== undefined) entry.message.rawFinish = event.data.rawFinish
        entry.message.tokens = event.data.tokens
        entry.message.cost = event.data.cost
        entry.message.time = { ...entry.message.time, completed: event.created }
        if (entry.message.snapshot || event.data.snapshot || event.data.files) {
          entry.message.snapshot = { ...entry.message.snapshot, ...(event.data.snapshot && { end: event.data.snapshot }), ...(event.data.files && { files: event.data.files }) }
        }
        break
      }
      case 'session.step.failed': {
        const entry = assistant(event.data.assistantMessageID, event.created)
        entry.message.error = event.data.error
        if (event.data.finish !== undefined) entry.message.finish = event.data.finish
        if (event.data.rawFinish !== undefined) entry.message.rawFinish = event.data.rawFinish
        if (event.data.tokens !== undefined) entry.message.tokens = event.data.tokens
        entry.message.time = { ...entry.message.time, completed: event.created }
        break
      }
      case 'session.compaction.started': {
        // Without inputID message.list's compaction id is unknown, so no record is invented.
        if (!event.data.inputID) break
        const message: MirrorCompaction = { id: event.data.inputID, type: 'compaction', time: { created: event.created }, status: 'running', reason: event.data.reason, summary: '', recent: '' }
        compactions.set(event.data.inputID, message)
        messages.push(message as unknown as Message)
        break
      }
      case 'session.compaction.ended': {
        // compaction.ended names no inputID: it closes the compaction still running.
        // Without a started event the id is unknown, so no record is invented.
        const message = [...compactions.values()].findLast((candidate) => candidate.status === 'running')
        if (!message) break
        message.status = 'completed'
        message.summary = event.data.text
        message.recent = event.data.recent
        break
      }
      case 'session.compaction.failed': {
        if (!event.data.inputID) break
        const existing = compactions.get(event.data.inputID)
        const message: MirrorCompaction = existing ?? { id: event.data.inputID, type: 'compaction', time: { created: event.created }, status: 'failed', reason: event.data.reason, summary: '', recent: '' }
        message.status = 'failed'
        if (!existing) {
          compactions.set(message.id, message)
          messages.push(message as unknown as Message)
        }
        break
      }
      default:
        break
    }
  }

  for (const entry of assistants.values()) entry.message.content = entry.parts as unknown as Extract<Message, { type: 'assistant' }>['content']
  return { title, directory, messages }
}

export type MirrorRead = { markdown: string; messages: Message[]; title: string | null; directory: string | null }

// `kimaki session read --from-mirror`: the same markdown as readSessionMarkdown,
// rendered from <dataDir>/session-events/<threadId>.jsonl instead of OpenCode.
export async function readSessionMarkdownFromMirror({
  dataDir,
  threadId,
  sessionId,
  full,
  thinking,
  verbose,
  now = Date.now(),
}: {
  dataDir: string
  threadId: string
  sessionId: string
  full?: boolean
  thinking?: boolean
  verbose?: boolean
  now?: number
}): Promise<ConfigError | MirrorRead> {
  const events = await readMirrorEvents({ dataDir, threadId })
  if (events instanceof Error) return events
  const folded = foldMirrorEvents({ events, sessionId })
  if (folded.messages.length === 0) {
    return new ConfigError({ reason: `The session-events mirror of thread ${threadId} has no messages for session ${sessionId} (${sessionEventsFile({ dataDir, threadId })}). Use live mode for a session that ran elsewhere.` })
  }
  const session = { id: sessionId, title: folded.title ?? MIRROR_UNKNOWN, location: { directory: folded.directory ?? MIRROR_UNKNOWN } }
  const usage = usageLine(sessionUsage(folded.messages), now)
  const markdown = !full && !thinking && !verbose ? renderAnswers({ session, messages: folded.messages, usage }) : renderSession({ session, messages: folded.messages, thinking, verbose, usage })
  return { markdown, messages: folded.messages, title: folded.title, directory: folded.directory }
}
