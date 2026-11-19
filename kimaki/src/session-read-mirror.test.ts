// Parity of `session read --from-mirror` with the live client.
//
// Both halves come from one real deterministic OpenCode turn: RECORDED is the
// tail of a recorder JSONL (<dataDir>/session-events/<threadId>.jsonl) and LIVE
// is what message.list returned for the same session at the same moment. The
// event keys the fold never reads (id, durable, metadata) are dropped from the
// fixture; every value kept is copied from the recording.
//
// The mirror cannot know the session title unless the recording holds
// session.created or session.renamed, so the title tests are explicit about it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { OpenCodeClient } from '@opencode/client'

import { MIRROR_UNKNOWN, readSessionMarkdown, readSessionMarkdownFromMirror, sessionEventsFile, type MirrorEventLine } from './session-events.ts'

const SESSION_ID = 'ses_e0dd85813ffeFRqooL08Dz3uEy'
const THREAD_ID = 'thread-mirror-parity'
const DIRECTORY = 'C:\\Users\\koosh\\AppData\\Local\\Temp\\kimaki-e2e-LCqm6o\\project'
const TITLE = 'Dump session title'
// Fixed clock: the usage line counts from Date.now().
const NOW = 1_795_064_056_000

const LIVE = [
  { id: 'msg_1f227af40001OKo1YXT2zEflU5', time: { created: 1795064049488 }, text: 'Dump please dump-marker', type: 'user' },
  {
    id: 'msg_1f227af5c001xcSEWsfjj5R1ls',
    time: { created: 1795064049522, streamed: 1795064049656, completed: 1795064049870 },
    type: 'assistant',
    agent: 'build',
    model: { id: 'deterministic-v2', providerID: 'deterministic-provider' },
    content: [
      {
        type: 'tool',
        id: 'read-one',
        name: 'read',
        executed: false,
        state: {
          status: 'error',
          input: { filePath: 'package.json' },
          error: {
            type: 'tool.execution',
            message: 'Invalid arguments for tool "read":\n- path: Missing key\n\nArguments provided:\n{}\n\nUpdate the arguments and call the tool again.',
          },
        },
        time: { created: 1795064049648, ran: 1795064049652, completed: 1795064049686 },
      },
    ],
    snapshot: { start: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', end: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', files: [] },
    finish: 'tool-calls',
    rawFinish: 'tool-calls',
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  {
    id: 'msg_1f227b0e1001sgpeWErVlylLF7',
    time: { created: 1795064049904, streamed: 1795064050100, completed: 1795064050254 },
    type: 'assistant',
    agent: 'build',
    model: { id: 'deterministic-v2', providerID: 'deterministic-provider' },
    content: [
      {
        type: 'tool',
        id: 'shell-one',
        name: 'bash',
        executed: false,
        state: {
          status: 'error',
          input: { command: 'echo hi' },
          error: { type: 'tool.execution', message: 'No tool named "bash" is currently available. Please use a tool from the available tool list.' },
        },
        time: { created: 1795064050094, ran: 1795064050098, completed: 1795064050103 },
      },
    ],
    snapshot: { start: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', end: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', files: [] },
    finish: 'tool-calls',
    rawFinish: 'tool-calls',
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  {
    id: 'msg_1f227b2600018XsqZEz0yBXkLe',
    time: { created: 1795064050295, streamed: 1795064050441, completed: 1795064050564 },
    type: 'assistant',
    agent: 'build',
    model: { id: 'deterministic-v2', providerID: 'deterministic-provider' },
    content: [{ type: 'text', text: 'Dump answered with a moderately long final text.' }],
    snapshot: { start: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', end: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', files: [] },
    finish: 'stop',
    rawFinish: 'stop',
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  // message.list ends a run with this marker. Its id is not recorded, so the mirror omits it.
  { id: 'msg_1f227b388001MWUVdDTSzW6GZo', time: { created: 1795064050568 }, type: 'idle', outcome: 'succeeded' },
]

const TOKENS = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
const SNAPSHOT = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const assistant = (id: string, started: number) => ({
  type: 'session.step.started',
  created: started + 122,
  location: { directory: DIRECTORY },
  data: { sessionID: SESSION_ID, assistantMessageID: id, agent: 'build', model: { id: 'deterministic-v2', providerID: 'deterministic-provider' }, snapshot: SNAPSHOT, started },
})

// The recording, in order. A session.renamed event supplies the title, which the
// live client reads from session.get; without it the mirror cannot know it.
const RECORDED = [
  {
    at: 1795064049502,
    event: {
      type: 'session.inbox.enqueued',
      created: 1795064049473,
      location: { directory: DIRECTORY },
      data: { inboxID: 'msg_1f227af40001OKo1YXT2zEflU5', sessionID: SESSION_ID, item: { type: 'user', payload: { text: 'Dump please dump-marker' }, delivery: 'steer' } },
    },
  },
  { at: 1795064049522, event: { type: 'session.renamed', created: 1795064049475, location: { directory: DIRECTORY }, data: { sessionID: SESSION_ID, title: TITLE } } },
  { at: 1795064049522, event: { type: 'session.execution.started', created: 1795064049476, data: { sessionID: SESSION_ID } } },
  {
    at: 1795064049523,
    event: {
      type: 'session.inbox.delivered',
      created: 1795064049488,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, inboxID: 'msg_1f227af40001OKo1YXT2zEflU5' },
    },
  },
  { at: 1795064049646, event: assistant('msg_1f227af5c001xcSEWsfjj5R1ls', 1795064049522) },
  {
    at: 1795064049692,
    event: {
      type: 'session.tool.input.started',
      created: 1795064049648,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227af5c001xcSEWsfjj5R1ls', id: 'read-one', name: 'read' },
    },
  },
  {
    at: 1795064049693,
    event: {
      type: 'session.tool.called',
      created: 1795064049652,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227af5c001xcSEWsfjj5R1ls', id: 'read-one', input: { filePath: 'package.json' }, executed: false },
    },
  },
  {
    at: 1795064049694,
    event: {
      type: 'session.tool.failed',
      created: 1795064049686,
      location: { directory: DIRECTORY },
      data: {
        sessionID: SESSION_ID,
        assistantMessageID: 'msg_1f227af5c001xcSEWsfjj5R1ls',
        id: 'read-one',
        error: { type: 'tool.execution', message: 'Invalid arguments for tool "read":\n- path: Missing key\n\nArguments provided:\n{}\n\nUpdate the arguments and call the tool again.' },
        executed: false,
      },
    },
  },
  {
    at: 1795064049905,
    event: {
      type: 'session.step.ended',
      created: 1795064049870,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227af5c001xcSEWsfjj5R1ls', finish: 'tool-calls', rawFinish: 'tool-calls', cost: 0, tokens: TOKENS, snapshot: SNAPSHOT, files: [] },
    },
  },
  { at: 1795064050092, event: assistant('msg_1f227b0e1001sgpeWErVlylLF7', 1795064049904) },
  {
    at: 1795064050105,
    event: {
      type: 'session.tool.input.started',
      created: 1795064050094,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227b0e1001sgpeWErVlylLF7', id: 'shell-one', name: 'bash' },
    },
  },
  {
    at: 1795064050106,
    event: {
      type: 'session.tool.called',
      created: 1795064050098,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227b0e1001sgpeWErVlylLF7', id: 'shell-one', input: { command: 'echo hi' }, executed: false },
    },
  },
  {
    at: 1795064050107,
    event: {
      type: 'session.tool.failed',
      created: 1795064050103,
      location: { directory: DIRECTORY },
      data: {
        sessionID: SESSION_ID,
        assistantMessageID: 'msg_1f227b0e1001sgpeWErVlylLF7',
        id: 'shell-one',
        error: { type: 'tool.execution', message: 'No tool named "bash" is currently available. Please use a tool from the available tool list.' },
        executed: false,
      },
    },
  },
  {
    at: 1795064050296,
    event: {
      type: 'session.step.ended',
      created: 1795064050254,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227b0e1001sgpeWErVlylLF7', finish: 'tool-calls', rawFinish: 'tool-calls', cost: 0, tokens: TOKENS, snapshot: SNAPSHOT, files: [] },
    },
  },
  { at: 1795064050432, event: assistant('msg_1f227b2600018XsqZEz0yBXkLe', 1795064050295) },
  {
    at: 1795064050443,
    event: {
      type: 'session.text.ended',
      created: 1795064050438,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227b2600018XsqZEz0yBXkLe', ordinal: 0, text: 'Dump answered with a moderately long final text.' },
    },
  },
  {
    at: 1795064050570,
    event: {
      type: 'session.step.ended',
      created: 1795064050564,
      location: { directory: DIRECTORY },
      data: { sessionID: SESSION_ID, assistantMessageID: 'msg_1f227b2600018XsqZEz0yBXkLe', finish: 'stop', rawFinish: 'stop', cost: 0, tokens: TOKENS, snapshot: SNAPSHOT, files: [] },
    },
  },
  { at: 1795064050571, event: { type: 'session.execution.succeeded', created: 1795064050568, data: { sessionID: SESSION_ID } } },
] as unknown as MirrorEventLine[]

function fakeLiveClient() {
  return {
    session: { get: async () => ({ id: SESSION_ID, title: TITLE, location: { directory: DIRECTORY } }) },
    message: { list: async () => ({ data: LIVE, cursor: { next: null } }) },
  } as unknown as OpenCodeClient
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeMirror(events: readonly unknown[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-mirror-read-'))
  dirs.push(dataDir)
  const file = sessionEventsFile({ dataDir, threadId: THREAD_ID })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${events.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return dataDir
}

test('mirror read prints the same markdown and records as the live client for one thread', async () => {
  const dataDir = writeMirror(RECORDED)
  const live = await readSessionMarkdown({ client: fakeLiveClient(), sessionId: SESSION_ID, now: NOW })
  const mirror = await readSessionMarkdownFromMirror({ dataDir, threadId: THREAD_ID, sessionId: SESSION_ID, now: NOW })
  if (mirror instanceof Error) throw mirror
  expect(live).not.toBeInstanceOf(Error)
  expect(mirror.markdown).toBe(live)
  // Every record message.list returns, field for field, except the idle marker
  // and time.streamed (session.step.streamed is skipped by the recorder).
  const liveRecords = LIVE.filter((message) => message.type !== 'idle')
  const withoutStreamed = liveRecords.map(({ time, ...record }) => ({ ...record, time: { created: time.created, ...(time.completed !== undefined && { completed: time.completed }) } }))
  expect(mirror.messages).toEqual(withoutStreamed)
  expect(liveRecords.map((message) => Object.keys(message.time))).toEqual([['created'], ['created', 'streamed', 'completed'], ['created', 'streamed', 'completed'], ['created', 'streamed', 'completed']])
  expect(mirror.messages.map((message) => Object.keys(message.time))).toEqual([['created'], ['created', 'completed'], ['created', 'completed'], ['created', 'completed']])
  expect(mirror.title).toBe(TITLE)
  expect(mirror.directory).toBe(DIRECTORY)
  expect(mirror.markdown).toContain('## assistant 2026-11-19T04:54:10.295Z (build, deterministic-provider/deterministic-v2)')
  expect(mirror.markdown).toContain('Dump answered with a moderately long final text.')
  expect(mirror.markdown).toContain('context: 2 tokens, last run took 1s, last active 5s ago (2026-11-19T04:54:10.564Z)')
})

test('without a recorded title or location the mirror says so instead of inventing them', async () => {
  // A thread recorded after its session was created carries no session.created or
  // session.renamed, and events without a location give no directory (hello-thread
  // records such a file).
  const recorded = RECORDED.filter((line) => line.event.type !== 'session.renamed').map((line) => {
    const event: Record<string, unknown> = { ...line.event }
    delete event['location']
    return { ...line, event }
  })
  const dataDir = writeMirror(recorded)
  const live = (await readSessionMarkdown({ client: fakeLiveClient(), sessionId: SESSION_ID, now: NOW })) as string
  const mirror = await readSessionMarkdownFromMirror({ dataDir, threadId: THREAD_ID, sessionId: SESSION_ID, now: NOW })
  if (mirror instanceof Error) throw mirror
  expect(mirror.title).toBeNull()
  expect(mirror.directory).toBeNull()
  expect(mirror.markdown).toBe(live.replace(`# ${TITLE} (${SESSION_ID})`, `# ${MIRROR_UNKNOWN} (${SESSION_ID})`).replace(`directory: ${DIRECTORY}`, `directory: ${MIRROR_UNKNOWN}`))
  expect(mirror.markdown.startsWith(`# ${MIRROR_UNKNOWN} (${SESSION_ID})\n\ndirectory: ${MIRROR_UNKNOWN}`)).toBe(true)
})

test('a mirror file that does not exist fails with its path, and changes nothing else', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-mirror-read-'))
  dirs.push(dataDir)
  const result = await readSessionMarkdownFromMirror({ dataDir, threadId: THREAD_ID, sessionId: SESSION_ID })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain(sessionEventsFile({ dataDir, threadId: THREAD_ID }))
})

test('a session the mirror never saw fails instead of printing an empty transcript', async () => {
  const dataDir = writeMirror(RECORDED)
  const result = await readSessionMarkdownFromMirror({ dataDir, threadId: THREAD_ID, sessionId: 'ses_not_recorded' })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain('no messages for session ses_not_recorded')
})

// No recording of a successful tool survived this host's OpenCode cold start
// (2 attempts, 60 s each), so this turn is built from the wire types of
// SessionToolSuccess: content and metadata are copied verbatim into the record,
// which is what --verbose prints.
test('a completed tool call keeps its input, content and output line', async () => {
  const id = 'msg_assistant_success'
  const content = [{ type: 'text', text: 'hello from the mirror' }] as const
  const events = [
    { at: 1, event: { type: 'session.renamed', created: 1, data: { sessionID: SESSION_ID, title: TITLE } } },
    { at: 2, event: { type: 'session.inbox.enqueued', created: 2, data: { inboxID: 'msg_user_success', sessionID: SESSION_ID, item: { type: 'user', payload: { text: 'read it' }, delivery: 'steer' } } } },
    { at: 3, event: { type: 'session.inbox.delivered', created: 3, location: { directory: DIRECTORY }, data: { sessionID: SESSION_ID, inboxID: 'msg_user_success' } } },
    { at: 4, event: { type: 'session.step.started', created: 4, data: { sessionID: SESSION_ID, assistantMessageID: id, agent: 'build', model: { id: 'deterministic-v2', providerID: 'deterministic-provider' }, started: 4 } } },
    { at: 5, event: { type: 'session.tool.input.started', created: 5, data: { sessionID: SESSION_ID, assistantMessageID: id, id: 'read-one', name: 'read' } } },
    { at: 6, event: { type: 'session.tool.called', created: 6, data: { sessionID: SESSION_ID, assistantMessageID: id, id: 'read-one', input: { path: 'mirror-read.txt' }, executed: true } } },
    { at: 7, event: { type: 'session.tool.success', created: 7, data: { sessionID: SESSION_ID, assistantMessageID: id, id: 'read-one', content, executed: true } } },
    { at: 8, event: { type: 'session.step.ended', created: 8, data: { sessionID: SESSION_ID, assistantMessageID: id, finish: 'tool-calls', cost: 0, tokens: TOKENS } } },
    { at: 9, event: { type: 'session.text.ended', created: 9, data: { sessionID: SESSION_ID, assistantMessageID: 'msg_assistant_text', ordinal: 0, text: 'read it' } } },
  ] as unknown as MirrorEventLine[]
  const dataDir = writeMirror(events)
  const mirror = await readSessionMarkdownFromMirror({ dataDir, threadId: THREAD_ID, sessionId: SESSION_ID, verbose: true, now: NOW })
  if (mirror instanceof Error) throw mirror
  const [part] = (mirror.messages[1] as { content: unknown[] }).content as [{ state: unknown; executed?: boolean }]
  expect(part.executed).toBe(true)
  expect(part.state).toEqual({ status: 'completed', input: { path: 'mirror-read.txt' }, content })
  expect(mirror.markdown).toContain('tool read [completed] {"path":"mirror-read.txt"}')
  expect(mirror.markdown).toContain('[{"type":"text","text":"hello from the mirror"}]')
})
