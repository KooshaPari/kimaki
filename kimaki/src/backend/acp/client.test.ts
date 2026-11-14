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

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'jcode', title: 'Jcode', version: '0.99.1' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, resume: {} } },
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
  if (message.method !== 'session/prompt') return

  const sid = message.params.sessionId
  const text = message.params.prompt[0].text

  if (text === 'exit') process.exit(7)
  if (text === 'garbage') {
    process.stdout.write('this is not a json frame\n')
    return
  }
  if (text.startsWith('silent')) return
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

const startAgent = async (options: { timeoutMs?: number } = {}): Promise<AcpClient> => {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-acp-'))
  const script = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.cjs`)
  const pidFile = path.join(dir, `${path.basename(script)}.pid`)
  await fs.writeFile(script, AGENT_SOURCE)
  const client = createAcpClient({
    command: process.execPath,
    args: [script, pidFile],
    timeoutMs: options.timeoutMs,
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
  expect(initialized).toEqual({ protocolVersion: 1, agentName: 'jcode' })
  const session = ok(await client.newSession({ cwd: process.cwd() }))
  expect(session).toEqual({ sessionId: 'session_fox_1' })
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
