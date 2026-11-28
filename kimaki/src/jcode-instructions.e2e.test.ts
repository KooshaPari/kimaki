// Boundary test for the one durable Kimaki session instruction on the jcode
// path. It uses the real backend and writer code; only the ACP peers (the
// jcode process and the model behind it) are substituted.
//
// Five claims, in order:
//   1. both the OpenCode value and the jcode primer come from one pure builder;
//   2. the first jcode turn carries that exact text as a labelled user prefix;
//   3. a later turn on the same session does not re-inject it;
//   4. resume replays the marker, so the digest survives a new writer;
//   5. an instruction over the 64k bound is refused at creation, never sent.
//
// Plus the regression claim: a bound thread whose Discord channel cannot be
// resolved still gets its turn served by `steer`, with the degraded thread-only
// instruction prefix carried in the persisted prompt.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { AcpClient } from './backend/acp/contracts.ts'
import { createJcodeBotBackend, JcodeBotBackendError } from './backend/jcode-bot-backend.ts'
import {
  INSTRUCTION_MARKER,
  instructionDigest,
  MAX_INSTRUCTION_CHARS,
} from './backend/instructions.ts'
import { createJcodeBotWriter } from './backend/jcode-bot-prompt.ts'
import { sessionInstruction, type SessionInstructionInput } from './system-prompt.ts'
import { removeTempDir } from './test/cleanup.ts'
import { openDb, type OpenedDb } from './db.ts'
import { bindJcodeSession } from './jcode-thread.ts'
import { steer } from './prompt.ts'
import { createBotStore, type BotStore } from './store.ts'
import type { Bot } from './bot.ts'
import { withThreadBackend } from './thread-backend.ts'
import { findJcodeBinary } from './test/jcode-harness.ts'
import { startMockProvider, type MockProvider } from './test/jcode-seed.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempDir(root).catch(() => {})
})

const input: SessionInstructionInput = {
  sessionId: 'session_bound',
  threadId: 'thread_1',
  channelId: 'channel_1',
  guildId: 'guild_1',
  userId: 'user_1',
  dataDir: '/tmp/kimaki-data',
  channelTopic: 'session instruction boundary',
  agents: [{ name: 'reviewer', description: 'Reviews changes' }],
  parentSessionId: 'session_parent',
  coordinator: true,
}

const durable = sessionInstruction(input)
const staged: Omit<SessionInstructionInput, 'sessionId'> = {
  threadId: input.threadId,
  channelId: input.channelId,
  guildId: input.guildId,
  userId: input.userId,
  dataDir: input.dataDir,
  channelTopic: input.channelTopic,
  agents: input.agents,
  parentSessionId: input.parentSessionId,
  coordinator: input.coordinator,
}

function fakeAcpClient(home: string, prompts: string[]): AcpClient {
  return {
    async initialize() {
      return { protocolVersion: 1, agentName: 'jcode', agentVersion: '1.1.0', agentCapabilities: {}, supportsRetraction: false }
    },
    async newSession() {
      return { sessionId: input.sessionId }
    },
    async setModel(modelInput) {
      return { model: modelInput.model }
    },
    async loadSession(load) {
      const recordFile = path.join(home, 'sessions', `${load.sessionId}.json`)
      const history = fs.existsSync(recordFile)
        ? (JSON.parse(fs.readFileSync(recordFile, 'utf8')) as { messages?: Array<{ role?: string; content?: Array<{ text?: string }> }> }).messages
            ?.filter((message) => message.role === 'user')
            .map((message) => ({ role: 'user' as const, text: message.content?.[0]?.text ?? '' }))
            .filter((message) => message.text !== '') ?? []
        : []
      return { sessionId: load.sessionId, history, model: null }
    },
    async prompt(prompt) {
      prompts.push(prompt.text)
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
      fs.writeFileSync(path.join(home, 'sessions', `${input.sessionId}.json`), JSON.stringify({
        id: input.sessionId,
        messages: prompts.map((text, index) => ({ id: `m${index}`, role: 'user', content: [{ type: 'text', text }], timestamp: '2026-01-01T00:00:00.000Z' })),
      }))
      return { stopReason: 'end_turn', text: 'scripted', updateCount: 0 }
    },
    async cancel() {
      return undefined
    },
    pendingServerRequests() {
      return []
    },
    answerServerRequest() {
      return { requestId: 0 }
    },
    async close() {},
  }
}

describe('jcode session instruction boundary', () => {
  test('the pure builder produces the byte-stable instruction the jcode path sends', () => {
    expect(sessionInstruction(input)).toBe(durable)
    expect(durable).toContain('session_bound')
    expect(durable).toContain('session instruction boundary')
    expect(durable).toContain('Available agents:\n- `reviewer`: Reviews changes')
    expect(durable).toContain('session_parent')
  })

  test('the first turn carries the instruction once; later turns do not re-inject it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-instruction-'))
    roots.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const prompts: string[] = []
    const connection = await createJcodeBotBackend({
      binary: process.execPath,
      probe: async () => undefined,
      home,
      cwd: root,
      follow: 'create',
      createPrompt: 'first question',
      createInstruction: staged,
      createCreateClient: () => fakeAcpClient(home, prompts),
      onEvent: () => {},
    })
    if (connection instanceof Error) throw connection
    try {
      expect(prompts).toHaveLength(1)
      const digest = instructionDigest(durable)
      expect(digest).not.toBe(null)
      expect(prompts[0]).toContain(`<!-- ${INSTRUCTION_MARKER} sha256=${digest} role=user-prefix -->`)
      expect(prompts[0]).toContain(durable)
      expect(prompts[0]!.endsWith('first question')).toBe(true)

      const writer = createJcodeBotWriter({
        home,
        sessionId: input.sessionId,
        binary: process.execPath,
        cwd: root,
        closed: () => false,
        createClient: () => fakeAcpClient(home, prompts),
      })
      try {
        const followed = await writer.prompt({ text: 'second question', instruction: durable })
        if (followed instanceof Error) throw followed
      } finally {
        writer.close()
      }
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toBe('second question')
    } finally {
      connection.stop()
    }
  })

  test('a resumed writer reads the replayed marker and suppresses the digest', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-resume-'))
    roots.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
    const prompts: string[] = []
    fs.writeFileSync(path.join(home, 'sessions', `${input.sessionId}.json`), JSON.stringify({
      id: input.sessionId,
      messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: `<!-- ${INSTRUCTION_MARKER} sha256=${instructionDigest(durable)} role=user-prefix -->\n${durable}\n<!-- /${INSTRUCTION_MARKER} -->\n\nfirst question` }], timestamp: '2026-01-01T00:00:00.000Z' }],
    }))
    const writer = createJcodeBotWriter({
      home,
      sessionId: input.sessionId,
      binary: process.execPath,
      cwd: root,
      closed: () => false,
      createClient: () => fakeAcpClient(home, prompts),
    })
    try {
      const followed = await writer.prompt({ text: 'after resume', instruction: durable })
      if (followed instanceof Error) throw followed
      expect(followed.instruction).toEqual({ kind: 'none', digest: instructionDigest(durable) })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe('after resume')
    } finally {
      writer.close()
    }
  })

  test('an oversized create instruction is a named refusal, never a truncated first turn', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-oversize-'))
    roots.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const prompts: string[] = []
    const tooLong = 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)
    const result = await createJcodeBotBackend({
      binary: process.execPath,
      probe: async () => undefined,
      home,
      cwd: root,
      follow: 'create',
      createPrompt: 'first question',
      createInstruction: { ...staged, channelTopic: tooLong },
      createCreateClient: () => fakeAcpClient(home, prompts),
      onEvent: () => {},
    })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    const error = result as JcodeBotBackendError
    expect(error.stage).toBe('create-prompt')
    expect(error.message).toContain(String(MAX_INSTRUCTION_CHARS))
    expect(prompts).toEqual([])
  })

  test('an unresolvable channel still serves the turn with a degraded instruction prefix', async () => {
    const binary = findJcodeBinary()
    if (binary === null) throw new Error('JCODE_BIN is required for this regression test')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-degraded-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const cwd = path.join(root, 'cwd')
    const dataDir = path.join(root, 'data')
    for (const dir of [home, cwd, dataDir]) fs.mkdirSync(dir, { recursive: true })
    const keys = ['JCODE_HOME', 'JCODE_MODEL', 'JCODE_PROVIDER', 'JCODE_NO_TELEMETRY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_API_KEY']
    const saved: Record<string, string | undefined> = {}
    for (const key of keys) saved[key] = process.env[key]
    let mock: MockProvider | undefined
    let handle: OpenedDb | undefined
    try {
      mock = await startMockProvider()
      process.env['JCODE_HOME'] = home
      delete process.env['JCODE_MODEL']
      delete process.env['JCODE_PROVIDER']
      process.env['JCODE_NO_TELEMETRY'] = '1'
      process.env['OPENAI_BASE_URL'] = `${mock.url}/v1`
      process.env['OPENAI_API_BASE'] = `${mock.url}/v1`
      process.env['OPENAI_API_KEY'] = 'kimaki-degraded-test-key'
      const opened = await openDb({ dataDir, migrate: true })
      if (!('close' in opened)) throw opened
      handle = opened
      const store: BotStore = createBotStore()
      const threadId = 'thread-degraded-channel'
      const bot = {
        db: handle.db, dataDir, backendKind: 'jcode', jcodeStore: { binary, home }, autoWorktrees: false,
        discord: { user: { id: 'bot-user' } }, analytics: { track: () => {} }, effects: { run: () => {} },
        store, eventLoop: { bind: () => {} },
      } as unknown as Bot
      const bound = await bindJcodeSession(bot, { threadId, channelId: 'channel-degraded', directory: cwd, primer: 'Reply with only: ok' })
      if (bound instanceof Error) throw bound
      store.setState({
        roots: { [threadId]: bound.sessionId },
        threadBackends: { [threadId]: 'jcode' },
        sessionThreads: { [bound.sessionId]: threadId },
      })
      const sent: string[] = []
      const thread = { id: threadId, isThread: () => true, send: async (payload: { content: string }) => { sent.push(payload.content); return {} } }
      // Discord cannot resolve the thread as a text channel: the lookup that
      // used to abort the whole turn before it reached the writer.
      let fetches = 0
      const degradedBot = {
        ...bot,
        opencode: { kind: 'jcode' },
        backends: { opencode: null, jcode: { kind: 'jcode' } },
        // The first fetch (instruction context) cannot resolve the thread as a
        // text channel. The second fetch (post target) resolves it so the answer
        // can actually reach the thread; a turn that cannot post is a real error.
        discord: {
          user: { id: 'bot-user' },
          channels: {
            fetch: async () => {
              fetches += 1
              if (fetches === 1) return new Error(`Discord use non-text channel ${threadId} failed`)
              return thread
            },
          },
        },
      } as unknown as Bot
      const served = withThreadBackend(degradedBot, threadId)
      if (!served.ok) throw served.error
      const result = await steer(served.bot, {
        sessionId: bound.sessionId, threadId, threadName: threadId, text: 'Reply with only: degraded',
        author: { id: 'user-1', username: 'user' }, messageId: 'message-degraded', directory: cwd,
      })
      if (result instanceof Error) throw result
      // The answer is posted, not merely a no-error return.
      expect(sent).toEqual(['ok'])
      expect(fetches).toBe(2)
      // The real binary persisted the prefix with the degraded, thread-only context.
      const record = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${bound.sessionId}.json`), 'utf8')) as {
        messages: { role: string; content: { text?: string }[] }[]
      }
      const promptText = record.messages
        .map((message) => message.content.map((part) => part.text ?? '').join(''))
        .find((text) => text.includes('Reply with only: degraded')) ?? ''
      const degraded = sessionInstruction({
        sessionId: bound.sessionId, threadId, channelId: threadId, guildId: '', userId: 'user-1',
        dataDir, channelTopic: null, agents: [], parentSessionId: null, coordinator: false, disabled: [],
      })
      expect(promptText).toContain(`<!-- ${INSTRUCTION_MARKER} sha256=${instructionDigest(degraded)} role=user-prefix -->`)
      expect(promptText).toContain(degraded)
      expect(promptText).toContain(`Discord thread ID: ${threadId}`)
      expect(promptText.endsWith('Reply with only: degraded')).toBe(true)
    } finally {
      if (handle !== undefined) handle.close()
      await mock?.close()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 300_000)
})
