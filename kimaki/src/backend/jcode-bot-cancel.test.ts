// The cancel primitive, proven at two levels.
//
// The guard matrix runs against a typed fake AcpClient so every refusal is
// asserted by name and by "the transport was never touched". The wire test runs
// the real ACP transport against a scripted child and proves the exact method
// this module writes is `session/cancel`, that the running prompt then resolves
// with the peer's stop reason, and that no bot event is produced anywhere.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, test } from 'vitest'

import { createAcpClient } from './acp/client.ts'
import type { AcpClient, AcpPromptResult } from './acp/contracts.ts'
import { cancelJcodeTurn } from './jcode-bot-cancel.ts'
import { JcodeBotBackendError } from './jcode-bot-error.ts'

const stageOf = (value: unknown): unknown => (value as { stage?: unknown }).stage

type Fake = { client: AcpClient; calls: Array<{ sessionId: string }> }

function fakeClient(overrides: Partial<AcpClient> = {}): Fake {
  const calls: Array<{ sessionId: string }> = []
  const client: AcpClient = {
    initialize: async () => ({ protocolVersion: 1, agentName: 'jcode', agentVersion: '1.1.0', agentCapabilities: {}, supportsRetraction: false }),
    newSession: async () => ({ sessionId: 'session_fake' }),
    setModel: async () => ({ model: 'mock-model' }),
    loadSession: async () => ({ sessionId: 'session_fake', history: [], model: null }),
    prompt: async (): Promise<AcpPromptResult> => ({ stopReason: 'end_turn', text: 'ok', updateCount: 1 }),
    cancel: async (input) => {
      calls.push({ sessionId: input.sessionId })
      return undefined
    },
    pendingServerRequests: () => [],
    answerServerRequest: () => ({ requestId: 1 }),
    close: async () => {},
    ...overrides,
  }
  return { client, calls }
}

describe('cancelJcodeTurn guard matrix', () => {
  test('a running turn is cancelled and resolves a value, never an event', async () => {
    const fake = fakeClient()
    const outcome = await cancelJcodeTurn({ sessionId: 'session_live', client: fake.client, running: true })
    expect(outcome).toEqual({ sessionId: 'session_live', cancelled: true })
    // The shape is the claim: no `type`, no `data`, nothing the event loop could fold.
    expect(Object.keys(outcome as object).sort()).toEqual(['cancelled', 'sessionId'])
    expect(fake.calls).toEqual([{ sessionId: 'session_live' }])
  })

  test('a live running predicate is evaluated, so a stale boolean is not required', async () => {
    const fake = fakeClient()
    let busy = false
    const pending = cancelJcodeTurn({ sessionId: 'session_live', client: fake.client, running: () => busy })
    await sleep(0)
    expect(stageOf(await pending)).toBe('cancel-not-running')
    busy = true
    expect(await cancelJcodeTurn({ sessionId: 'session_live', client: fake.client, running: () => busy })).toEqual({ sessionId: 'session_live', cancelled: true })
    expect(fake.calls).toHaveLength(1)
  })

  test('cancelling a turn that is not running is a named refusal, not a success', async () => {
    const fake = fakeClient()
    const refused = await cancelJcodeTurn({ sessionId: 'session_idle', client: fake.client, running: false })
    expect(refused).toBeInstanceOf(JcodeBotBackendError)
    expect(stageOf(refused)).toBe('cancel-not-running')
    expect((refused as Error).message).toContain('session_idle')
    expect(fake.calls).toEqual([])
  })

  test('no live connection is refused and never creates one', async () => {
    // The module has no factory to call: this resolves before any I/O. The bound
    // is evidence that a child was not spawned and awaited on the way.
    const began = Date.now()
    const refused = await cancelJcodeTurn(null)
    expect(stageOf(refused)).toBe('cancel-no-connection')
    expect(Date.now() - began).toBeLessThan(100)
    const alsoNull = await cancelJcodeTurn({ sessionId: 'session_x', client: null, running: true })
    expect(stageOf(alsoNull)).toBe('cancel-no-connection')
  })

  test('a closed seam is refused before the transport is touched', async () => {
    const fake = fakeClient()
    const refused = await cancelJcodeTurn({ sessionId: 'session_closed', client: fake.client, running: true, closed: true })
    expect(stageOf(refused)).toBe('cancel-closed')
    expect(fake.calls).toEqual([])
  })

  test('a target without a session id is refused', async () => {
    const fake = fakeClient()
    const refused = await cancelJcodeTurn({ sessionId: '   ', client: fake.client, running: true })
    expect(stageOf(refused)).toBe('cancel-session')
    expect(fake.calls).toEqual([])
  })

  test('a transport refusal is a named cancel-rejected', async () => {
    const fake = fakeClient({ cancel: async () => new Error('the write failed') })
    const refused = await cancelJcodeTurn({ sessionId: 'session_reject', client: fake.client, running: true })
    expect(stageOf(refused)).toBe('cancel-rejected')
    expect((refused as { cause?: unknown }).cause).toBeInstanceOf(Error)
  })

  test('a closed transport refusal maps to cancel-closed', async () => {
    const fake = fakeClient({ cancel: async () => new Error('The ACP client is closed') })
    const refused = await cancelJcodeTurn({ sessionId: 'session_reject', client: fake.client, running: true })
    expect(stageOf(refused)).toBe('cancel-closed')
  })

  test('a transport throw is a named cancel-threw', async () => {
    const fake = fakeClient({ cancel: async () => { throw new Error('boom') } })
    const refused = await cancelJcodeTurn({ sessionId: 'session_throw', client: fake.client, running: true })
    expect(stageOf(refused)).toBe('cancel-threw')
  })
})

// A real ACP child: it answers initialize/session/new, holds one prompt, and only
// answers that prompt after it receives `session/cancel`. Every frame it handles
// is recorded, agent-side evidence of the exact method.
const CANCEL_AGENT = String.raw`const fs = require('node:fs')
const readline = require('node:readline')
const recordFile = process.argv[2]
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const record = (event) => fs.appendFileSync(recordFile, JSON.stringify(event) + '\n')
let pending = null
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) return
  if (message.method === 'initialize') return write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'jcode' }, agentCapabilities: {} } })
  if (message.method === 'session/new') return write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session_wire' } })
  if (message.method === 'session/prompt') {
    pending = message.id
    record({ kind: 'prompt', sessionId: message.params.sessionId, text: message.params.prompt[0].text })
    return
  }
  if (message.method === 'session/cancel') {
    record({ kind: 'cancel', sessionId: message.params.sessionId })
    const id = pending
    pending = null
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } })
    return write({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } })
  }
})
`

const readRecords = (file: string): Array<Record<string, unknown>> =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : []

test('session/cancel reaches the peer and ends the running prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-cancel-wire-'))
  const script = path.join(dir, 'agent.cjs')
  const recordFile = path.join(dir, 'record.jsonl')
  fs.writeFileSync(script, CANCEL_AGENT)
  const client = createAcpClient({ command: process.execPath, args: [script, recordFile], cwd: dir, timeoutMs: 20_000 })
  try {
    const initialized = await client.initialize()
    if (initialized instanceof Error) throw initialized
    const session = await client.newSession({ cwd: dir })
    if (session instanceof Error) throw session

    const running = client.prompt({ sessionId: session.sessionId, text: 'do the long thing', timeoutMs: 20_000 })
    // Wait until the peer has actually taken the prompt: cancelling before that
    // would be a race the test could not attribute.
    for (let attempt = 0; attempt < 100 && !readRecords(recordFile).some((event) => event['kind'] === 'prompt'); attempt += 1) await sleep(20)

    const outcome = await cancelJcodeTurn({ sessionId: session.sessionId, client, running: true })
    expect(outcome).toEqual({ sessionId: 'session_wire', cancelled: true })

    const finished = await running
    if (finished instanceof Error) throw finished
    // The peer answered the held prompt only because it saw session/cancel.
    expect(finished.stopReason).toBe('cancelled')
    expect(finished.text).toBe('partial')

    const records = readRecords(recordFile)
    expect(records.filter((event) => event['kind'] === 'cancel')).toEqual([{ kind: 'cancel', sessionId: 'session_wire' }])
    // No event value came back from the cancel: only the prompt text crossed.
    expect(records.filter((event) => event['kind'] !== 'cancel' && event['kind'] !== 'prompt')).toEqual([])
  } finally {
    await client.close()
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 0 }) } catch { /* temp dir is disposable */ }
  }
})
