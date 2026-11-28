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
})
