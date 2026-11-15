// Tests for the ACP stdio transport. No real jcode binary: a temp Node script
// speaks the protocol with the frame shapes observed from jcode 0.99.1.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ConfigError } from '../../errors.ts'
import { createAcpClient } from './client.ts'
import type { AcpClient } from './contracts.ts'

// The fake agent streams two chunks (plus a tool_call update and an unknown
// notification) and replies with the real jcode result shapes. Trigger words in
// the prompt text drive the failure modes.
const AGENT_SOURCE = String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(process.argv[2], String(process.pid))
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const update = (sessionId, body) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: body },
})
const rl = readline.createInterface({ input: process.stdin })

// The measured jcode 0.99.1 capabilities, unless a test passes an override.
const capabilities = process.argv[3]
  ? JSON.parse(process.argv[3])
  : { loadSession: true, sessionCapabilities: { close: {}, resume: {} } }

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'jcode', title: 'Jcode', version: '0.99.1' },
        agentCapabilities: capabilities,
        authMethods: [],
      },
    })
    return
  }
  if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'session_fox_1',
        configOptions: [{
          category: 'model',
          currentValue: 'deepseek-v4-pro',
          id: 'model',
          name: 'Model',
          options: [{ value: 'deepseek-v4-pro' }, { value: 'beam-free' }],
          type: 'select',
        }],
      },
    })
    return
  }
  if (message.method === 'session/set_config_option') {
    const value = message.params.value
    const configOptions = value === 'missing'
      ? [{ category: 'other', currentValue: 'x', id: 'other', type: 'select' }]
      : [{ category: 'model', currentValue: value, id: 'model', type: 'select' }]
    update(message.params.sessionId, { sessionUpdate: 'config_option_update', configOptions })
    send({ jsonrpc: '2.0', id: message.id, result: { configOptions } })
    return
  }
  if (message.method === 'session/cancel') {
    return
  }
  if (message.method === 'session/load') {
    const sid = message.params.sessionId
    update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'native-typed' } })
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'native-reply' } })
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { sessionId: sid, configOptions: [{ category: 'model', currentValue: 'deepseek-v4-pro', id: 'model', type: 'select' }] },
    })
    return
  }
  if (message.method !== 'session/prompt') return

  const sid = message.params.sessionId
  const text = message.params.prompt[0].text

  if (text === 'exit') process.exit(7)
  if (text === 'garbage') {
    process.stdout.write('this is not a json frame\n')
    return
  }
  if (text.startsWith('silent')) return
  if (text.startsWith('ECHO_USER')) {
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } })
    // jcode does not emit this during a prompt today, but if it ever does the
    // typed text must not be folded into the assistant's turn text.
    update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'typed-midturn' } })
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (text.startsWith('CORRECTION')) {
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the sky is grenn' } })
    // Hypothetical retraction frame. jcode 0.99.1 advertises no correction
    // capability and never sends one, so this proves an unknown update kind is
    // ignored rather than rendered as a fabricated correction.
    update(sid, { sessionUpdate: 'agent_message_retraction', messageId: 'message_1' })
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\nthe sky is green' } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (text.startsWith('RETRACT_DECLARED')) {
    // A peer that declared a retraction surface corrects a streamed segment in
    // place. The shape (agent_message_retraction with messageId + content.text)
    // is a documented extension of this client, not an observed jcode emission.
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'message_1', content: { type: 'text', text: 'the sky is grenn' } })
    update(sid, { sessionUpdate: 'agent_message_retraction', messageId: 'message_1', content: { type: 'text', text: 'the sky is green' } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (text.startsWith('RETRACT_UNKNOWN')) {
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'message_1', content: { type: 'text', text: 'Hello' } })
    update(sid, { sessionUpdate: 'agent_message_retraction', messageId: 'message_9', content: { type: 'text', text: 'corrupted' } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (text.startsWith('RETRACT_AFTER_RESULT')) {
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'message_1', content: { type: 'text', text: 'Hello' } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    setTimeout(() => {
      update(sid, { sessionUpdate: 'agent_message_retraction', messageId: 'message_1', content: { type: 'text', text: 'BOOM' } })
    }, 40)
    return
  }
  if (text.startsWith('RETRACT_UNDECLARED')) {
    // Same shape, but the handshake never declared the surface.
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'message_1', content: { type: 'text', text: 'Hello' } })
    update(sid, { sessionUpdate: 'agent_message_retraction', messageId: 'message_1', content: { type: 'text', text: 'BOOM' } })
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
    return
  }

  if (text.startsWith('AUTH_FAIL')) {
    update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [] })
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: 'OpenAI-compatible chat request failed: status: 403 Forbidden' },
    })
    return
  }

  update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_1' })
  send({ jsonrpc: '2.0', method: 'session/request_permission', params: { sessionId: sid } })
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } })
  setTimeout(() => {
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
    const result = { stopReason: 'end_turn' }
    if (!text.startsWith('NO_USAGE')) {
      result.usage = { cachedReadTokens: 0, inputTokens: 30754, outputTokens: 28, totalTokens: 30782 }
    }
    send({ jsonrpc: '2.0', id: message.id, result })
  }, 25)
})
`

let dir: string | null = null
const clients: AcpClient[] = []

const ok = <T>(value: T | Error): T => {
  if (value instanceof Error) throw value
  return value
}

const startAgent = async (options: {
  timeoutMs?: number
  expectedIdentity?: string
  identityLabel?: string
  capabilities?: Record<string, unknown>
} = {}): Promise<AcpClient> => {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-acp-'))
  const script = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.cjs`)
  const pidFile = path.join(dir, `${path.basename(script)}.pid`)
  await fs.writeFile(script, AGENT_SOURCE)
  const args = [script, pidFile]
  if (options.capabilities) args.push(JSON.stringify(options.capabilities))
  const client = createAcpClient({
    command: process.execPath,
    args,
    timeoutMs: options.timeoutMs,
    expectedIdentity: options.expectedIdentity,
    identityLabel: options.identityLabel,
  })
  clients.push(client)
  return client
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForDead = async (pid: number, timeoutMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !isAlive(pid)
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  if (dir) {
    await fs.rm(dir, { recursive: true, force: true })
    dir = null
  }
})

test('initializes and opens a session', async () => {
  const client = await startAgent()
  const initialized = ok(await client.initialize())
  // Capabilities are surfaced alongside identity; see the dedicated test below.
  expect(initialized).toMatchObject({ protocolVersion: 1, agentName: 'jcode' })
  const session = ok(await client.newSession({ cwd: process.cwd() }))
  expect(session).toEqual({ sessionId: 'session_fox_1' })
})

test('loads an existing session and recovers the native history, including user input', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const loaded = ok(await client.loadSession({ sessionId: 'session_fox_1', cwd: process.cwd() }))
  // The agent replays the user's own prompt first: this is the only ACP path
  // that surfaces input typed outside kimaki.
  expect(loaded.history).toEqual([
    { role: 'user', text: 'native-typed' },
    { role: 'agent', text: 'native-reply' },
  ])
  expect(loaded.model).toBe('deepseek-v4-pro')
  expect(loaded.sessionId).toBe('session_fox_1')
})

test('rejects a load without a session id or working directory', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  expect(await client.loadSession({ sessionId: '', cwd: process.cwd() })).toBeInstanceOf(ConfigError)
  expect(await client.loadSession({ sessionId: 'session_fox_1', cwd: ' ' })).toBeInstanceOf(ConfigError)
})

test('selects a model from the echoed config options', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const selected = ok(await client.setModel({ sessionId, model: 'beam-free' }))
  expect(selected).toEqual({ model: 'beam-free' })
})

test('rejects a model selection the agent does not confirm', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const failure = await client.setModel({ sessionId, model: 'missing' })
  expect(failure).toBeInstanceOf(ConfigError)
  expect((failure as Error).message).toMatch(/model/i)
})

test('streams prompt chunks in order and assembles the turn', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const chunks: string[] = []
  const result = ok(await client.prompt({
    sessionId,
    text: 'hello',
    onChunk: (text) => chunks.push(text),
  }))
  expect(chunks).toEqual(['Hel', 'lo'])
  expect(result.text).toBe('Hello')
  expect(result.stopReason).toBe('end_turn')
  // tool_call + two chunks; the unknown permission notification is ignored.
  expect(result.updateCount).toBe(3)
  expect(result.usage).toEqual({ inputTokens: 30754, outputTokens: 28, totalTokens: 30782 })
})

test('keeps a mid-turn user echo out of the assistant turn text', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const chunks: string[] = []
  const result = ok(await client.prompt({ sessionId, text: 'ECHO_USER', onChunk: (text) => chunks.push(text) }))
  // The typed text belongs to history, never to the assistant's reply.
  expect(chunks).toEqual(['a', 'b'])
  expect(result.text).toBe('ab')
  expect(result.text).not.toContain('typed-midturn')
  expect(result.updateCount).toBe(3)
})

test('cannot retract text already streamed: an unknown update kind is ignored, not invented', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const chunks: string[] = []
  const result = ok(await client.prompt({ sessionId, text: 'CORRECTION', onChunk: (text) => chunks.push(text) }))
  // A real jcode 0.99.1 turn emits only available_commands_update,
  // agent_message_chunk and usage_update, and its agentCapabilities declares no
  // correction or retraction surface, so both the misspelling and the restatement
  // reach the client as ordinary text. The client must not fabricate a correction.
  expect(chunks).toEqual(['the sky is grenn', '\nthe sky is green'])
  expect(result.text).toBe('the sky is grenn\nthe sky is green')
  expect(result.updateCount).toBe(3)
  expect(result.stopReason).toBe('end_turn')
})

// The handshake observed from jcode 0.99.1: loadSession and session lifecycle
// only. No retraction or correction surface is declared, and the client must not
// invent one.
const MEASURED_CAPABILITIES = { loadSession: true, sessionCapabilities: { close: {}, resume: {} } }
// The retraction key is a documented extension this client accepts; jcode does
// not send it.
const DECLARED_CAPABILITIES = { ...MEASURED_CAPABILITIES, retractMessages: {} }

test('surfaces the peer capabilities raw and reports no retraction surface for jcode', async () => {
  const client = await startAgent()
  const initialized = ok(await client.initialize())
  expect(initialized.agentCapabilities).toEqual(MEASURED_CAPABILITIES)
  expect(initialized.supportsRetraction).toBe(false)
})

test('accepts a declared retraction surface and reports it', async () => {
  const client = await startAgent({ capabilities: DECLARED_CAPABILITIES })
  const initialized = ok(await client.initialize())
  expect(initialized.agentCapabilities).toEqual(DECLARED_CAPABILITIES)
  expect(initialized.supportsRetraction).toBe(true)
})

test('a declared retraction corrects the streamed text instead of appending to it', async () => {
  const client = await startAgent({ capabilities: DECLARED_CAPABILITIES })
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const chunks: string[] = []
  const result = ok(await client.prompt({ sessionId, text: 'RETRACT_DECLARED', onChunk: (text) => chunks.push(text) }))
  // Only the original chunk streamed; the correction is applied in place, so the
  // assembled turn equals the corrected text and never the misspelling plus it.
  expect(chunks).toEqual(['the sky is grenn'])
  expect(result.text).toBe('the sky is green')
  expect(result.text).not.toContain('grenn')
  expect(result.updateCount).toBe(2)
})

test('an undeclared retraction is ignored and leaves the text untouched', async () => {
  const client = await startAgent()
  const initialized = ok(await client.initialize())
  expect(initialized.supportsRetraction).toBe(false)
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const result = ok(await client.prompt({ sessionId, text: 'RETRACT_UNDECLARED' }))
  expect(result.text).toBe('Hello')
  expect(result.text).not.toContain('BOOM')
  expect(result.updateCount).toBe(2)
})

test('a declared retraction naming an unknown segment is ignored', async () => {
  const client = await startAgent({ capabilities: DECLARED_CAPABILITIES })
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const result = ok(await client.prompt({ sessionId, text: 'RETRACT_UNKNOWN' }))
  expect(result.text).toBe('Hello')
  expect(result.text).not.toContain('corrupted')
})

test('a retraction arriving after the turn result is ignored', async () => {
  const client = await startAgent({ capabilities: DECLARED_CAPABILITIES })
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const first = ok(await client.prompt({ sessionId, text: 'RETRACT_AFTER_RESULT' }))
  expect(first.text).toBe('Hello')
  expect(first.updateCount).toBe(1)
  // The late retraction must not leak into the next turn either.
  const second = ok(await client.prompt({ sessionId, text: 'hello' }))
  expect(second.text).toBe('Hello')
  expect(second.text).not.toContain('BOOM')
})

test('omits usage when the agent sends none', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const result = ok(await client.prompt({ sessionId, text: 'NO_USAGE' }))
  expect(result.text).toBe('Hello')
  expect('usage' in result).toBe(false)
})

test('surfaces the agent error message without prompt text', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const failure = await client.prompt({ sessionId, text: 'AUTH_FAIL-SECRET-TOKEN' })
  expect(failure).toBeInstanceOf(ConfigError)
  const message = (failure as Error).message
  expect(message).toContain('403 Forbidden')
  expect(message).toContain('-32000')
  expect(message).not.toContain('SECRET-TOKEN')
})

test('times out a prompt, drops it, and stays usable', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const failure = await client.prompt({ sessionId, text: 'silent-SECRET', timeoutMs: 150 })
  expect(failure).toBeInstanceOf(ConfigError)
  expect((failure as Error).message).toMatch(/within 150ms/)
  expect((failure as Error).message).not.toContain('SECRET')
  const result = ok(await client.prompt({ sessionId, text: 'hello' }))
  expect(result.text).toBe('Hello')
  expect(result.updateCount).toBe(3)
})

test('errors when the child exits before responding', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const failure = await client.prompt({ sessionId, text: 'exit' })
  expect(failure).toBeInstanceOf(ConfigError)
  expect((failure as Error).message).toMatch(/exited/i)
})

test('errors on a malformed frame', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  const failure = await client.prompt({ sessionId, text: 'garbage' })
  expect(failure).toBeInstanceOf(ConfigError)
  expect((failure as Error).message).toMatch(/frame/i)
})

test('resolves an error when the agent cannot be spawned', async () => {
  const client = createAcpClient({
    command: path.join(os.tmpdir(), 'kimaki-acp-missing-agent-xyz'),
    args: [],
  })
  clients.push(client)
  const failure = await client.initialize()
  expect(failure).toBeInstanceOf(ConfigError)
})

test('cancel resolves undefined', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  expect(await client.cancel({ sessionId })).toBeUndefined()
})

test('close terminates the child and is idempotent', async () => {
  const client = await startAgent()
  ok(await client.initialize())
  // The fake writes its PID next to its script; find it by reading the temp dir.
  const files = await fs.readdir(dir!)
  const pidFile = files.find((name) => name.endsWith('.pid'))
  expect(pidFile).toBeDefined()
  const pid = Number(await fs.readFile(path.join(dir!, pidFile!), 'utf8'))
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  await client.close()
  await client.close()
  expect(await waitForDead(pid)).toBe(true)
  const afterClose = await client.prompt({ sessionId: 'session_fox_1', text: 'hello' })
  expect(afterClose).toBeInstanceOf(ConfigError)
})

// A runtime fork reuses this ACP surface and can claim another runtime's name, so
// a caller that resolved a profile states the identity it expects. The label is
// evidence to check, never authority to route.
test('a handshake that reports the expected identity is accepted', async () => {
  const client = await startAgent({ expectedIdentity: 'jcode' })
  const initialized = ok(await client.initialize())
  expect(initialized.agentName).toBe('jcode')
})

test('a handshake that reports another identity is refused and names both sides', async () => {
  const client = await startAgent({ expectedIdentity: 'kcode', identityLabel: 'kcode' })
  const initialized = await client.initialize()
  expect(initialized).toBeInstanceOf(ConfigError)
  const message = (initialized as Error).message
  expect(message).toContain("expects identity 'kcode'")
  expect(message).toContain("reported 'jcode'")
  expect(message).toContain('refusing to route a kcode session')
})
