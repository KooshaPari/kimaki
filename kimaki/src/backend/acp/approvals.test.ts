// Approval requests on the ACP transport: the agent asks the client, and the
// client answers exactly once. No real jcode binary: a temp Node script speaks
// the protocol and records every frame it sent and received.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { AcpApprovalError } from './approvals.ts'
import { createAcpClient } from './client.ts'
import type { AcpClient, AcpServerRequest } from './contracts.ts'

// The fake agent sends a `session/request_permission` request and only finishes
// the prompt after a result/error for that id arrives, or after a short window in
// which it records `no-answer`. That ordering is what lets a test assert "one
// answer delivered" without racing the transport.
const AGENT_SOURCE = String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
const recordFile = process.argv[2]
const capabilities = process.argv[3] ? JSON.parse(process.argv[3]) : { loadSession: true }
const record = (event) => fs.appendFileSync(recordFile, JSON.stringify(event) + '\n')
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
let pending = null
let finishPrompt = null
const finish = () => {
  const fn = finishPrompt
  finishPrompt = null
  if (fn) fn()
}
const askPermission = (id, sessionId, command) => {
  record({ kind: 'request', requestId: id, sessionId })
  send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: 'call_1',
        title: 'Run command',
        kind: 'execute',
        status: 'pending',
        rawInput: { command },
      },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  pending = {
    requestId: id,
    timer: setTimeout(() => {
      if (!pending || pending.requestId !== id) return
      record({ kind: 'no-answer', requestId: id })
      pending = null
      finish()
    }, 400),
  }
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined && pending && message.id === pending.requestId) {
    clearTimeout(pending.timer)
    pending = null
    record({ kind: 'answer', frame: message })
    finish()
    return
  }
  if (message.method === 'initialize') {
    record({ kind: 'initialize', clientCapabilities: message.params.clientCapabilities })
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1, agentInfo: { name: 'jcode' }, agentCapabilities: capabilities },
    })
    return
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session_approve_1' } })
    return
  }
  if (message.method !== 'session/prompt') return
  const sid = message.params.sessionId
  const text = message.params.prompt[0].text
  finishPrompt = () => {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
  }
  if (text === 'TOOL') {
    askPermission(7001, sid, 'rm -rf build')
    return
  }
  if (text === 'FOREIGN') {
    askPermission(7003, 'other_connection_session', 'ls')
    return
  }
  if (text === 'NO_HANDLER') {
    askPermission(7002, sid, 'ls')
    return
  }
  finish()
})
`

let dir: string | null = null
const clients: AcpClient[] = []

const ok = <T>(value: T | Error): T => {
  if (value instanceof Error) throw value
  return value
}

type Event = Record<string, unknown>

const readEvents = async (file: string): Promise<Event[]> => {
  const text = (await fs.readFile(file, 'utf8')).trim()
  if (!text) return []
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Event)
}

const startAgent = async (options: { onRequest?: (request: AcpServerRequest) => void } = {}) => {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-acp-approvals-'))
  const tag = Math.random().toString(36).slice(2)
  const script = path.join(dir, `agent-${tag}.cjs`)
  const recordFile = path.join(dir, `record-${tag}.jsonl`)
  await fs.writeFile(script, AGENT_SOURCE)
  await fs.writeFile(recordFile, '')
  const client = createAcpClient({
    command: process.execPath,
    args: [script, recordFile],
    ...(options.onRequest ? { serverRequests: { onRequest: options.onRequest } } : {}),
  })
  clients.push(client)
  return { client, recordFile }
}

const openSession = async (client: AcpClient): Promise<string> => {
  ok(await client.initialize())
  const { sessionId } = ok(await client.newSession({ cwd: process.cwd() }))
  return sessionId
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  if (dir) {
    await fs.rm(dir, { recursive: true, force: true })
    dir = null
  }
})

test('a permission request reaches the handler with its payload and is answered once', async () => {
  const seen: AcpServerRequest[] = []
  const pendingDuringHandler: number[] = []
  let client!: AcpClient
  const started = await startAgent({
    onRequest: (request) => {
      seen.push(request)
      pendingDuringHandler.push(client.pendingServerRequests().length)
      // Answer from a later tick so the pending surface is observable first.
      setTimeout(() => {
        client.answerServerRequest({
          requestId: request.requestId,
          result: { outcome: { outcome: 'selected', optionId: 'allow' } },
        })
      }, 10)
    },
  })
  client = started.client
  const sessionId = await openSession(client)
  ok(await client.prompt({ sessionId, text: 'TOOL' }))

  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ requestId: 7001, method: 'session/request_permission', sessionId })
  // The raw payload is exposed unmodified, with narrow convenience copies.
  expect(seen[0]!.params.sessionId).toBe(sessionId)
  expect(seen[0]!.toolCall?.rawInput).toEqual({ command: 'rm -rf build' })
  expect(seen[0]!.options.map((option) => option.optionId)).toEqual(['allow', 'reject'])
  expect(pendingDuringHandler).toEqual([1])
  expect(client.pendingServerRequests()).toEqual([])

  const answers = (await readEvents(started.recordFile)).filter((event) => event['kind'] === 'answer')
  expect(answers).toHaveLength(1)
  expect(answers[0]!.frame).toMatchObject({
    id: 7001,
    result: { outcome: { outcome: 'selected', optionId: 'allow' } },
  })
  expect(answers[0]!.frame).not.toHaveProperty('error')
})

test('a second answer to the same request is refused by name', async () => {
  const refusals: Array<{ requestId: number | string } | Error> = []
  let first: { requestId: number | string } | Error = new Error('handler did not run')
  let client!: AcpClient
  const started = await startAgent({
    onRequest: (request) => {
      first = client.answerServerRequest({ requestId: request.requestId, result: { outcome: { outcome: 'selected', optionId: 'reject' } } })
      refusals.push(client.answerServerRequest({ requestId: request.requestId, result: { outcome: { outcome: 'selected', optionId: 'allow' } } }))
    },
  })
  client = started.client
  const sessionId = await openSession(client)
  ok(await client.prompt({ sessionId, text: 'TOOL' }))

  expect(first).toEqual({ requestId: 7001 })
  expect(refusals[0]).toBeInstanceOf(AcpApprovalError)
  expect((refusals[0] as Error).name).toBe('AcpApprovalError')
  expect((refusals[0] as Error).message).toMatch(/already answered/)

  const answers = (await readEvents(started.recordFile)).filter((event) => event['kind'] === 'answer')
  expect(answers).toHaveLength(1)
  expect(answers[0]!.frame).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'reject' } } })
})

test('an answer for an unknown request id is refused by name', async () => {
  const { client } = await startAgent({ onRequest: () => {} })
  await openSession(client)
  const refusal = client.answerServerRequest({ requestId: 987_654, result: { outcome: { outcome: 'cancelled' } } })
  expect(refusal).toBeInstanceOf(AcpApprovalError)
  expect((refusal as Error).message).toMatch(/no server-initiated request with this id is open/)
})

test('a handler that throws fails closed and the agent receives the refusal', async () => {
  let second: { requestId: number | string } | Error | null = null
  let client!: AcpClient
  const started = await startAgent({
    onRequest: () => {
      throw new Error('policy exploded')
    },
  })
  client = started.client
  const sessionId = await openSession(client)
  ok(await client.prompt({ sessionId, text: 'TOOL' }))
  // The request was answered once, by the fail-closed error, so a later attempt
  // reports that it was already answered rather than reopening it.
  second = client.answerServerRequest({ requestId: 7001, result: {} })
  expect(second).toBeInstanceOf(AcpApprovalError)
  expect((second as Error).message).toMatch(/already answered/)

  const answers = (await readEvents(started.recordFile)).filter((event) => event['kind'] === 'answer')
  expect(answers).toHaveLength(1)
  const frame = answers[0]!.frame as Record<string, unknown>
  expect(frame['id']).toBe(7001)
  const error = frame['error'] as Record<string, unknown>
  expect(error['code']).toBe(-32603)
  expect(String(error['message'])).toMatch(/handler threw/)
  expect(String(error['message'])).toContain('policy exploded')
})

test('without a handler the old drop behaviour is preserved and answering is a clean refusal', async () => {
  const started = await startAgent()
  const sessionId = await openSession(started.client)
  // The prompt still resolves: the request is dropped, not answered, and the
  // agent's own window expires. Nothing stalls on the client side.
  ok(await started.client.prompt({ sessionId, text: 'NO_HANDLER' }))
  const events = await readEvents(started.recordFile)
  expect(events.filter((event) => event['kind'] === 'answer')).toHaveLength(0)
  expect(events.some((event) => event['kind'] === 'no-answer' && event['requestId'] === 7002)).toBe(true)
  const refusal = started.client.answerServerRequest({ requestId: 7002, result: {} })
  expect(refusal).toBeInstanceOf(AcpApprovalError)
  expect((refusal as Error).message).toMatch(/without a server-request handler/)
})

test('the approval capability is only advertised when a handler exists', async () => {
  const withHandler = await startAgent({ onRequest: () => {} })
  ok(await withHandler.client.initialize())
  const withoutHandler = await startAgent()
  ok(await withoutHandler.client.initialize())
  const declared = (await readEvents(withHandler.recordFile)).find((event) => event['kind'] === 'initialize')
  const empty = (await readEvents(withoutHandler.recordFile)).find((event) => event['kind'] === 'initialize')
  expect(declared!['clientCapabilities']).toEqual({ serverRequests: { requestPermission: true } })
  expect(empty!['clientCapabilities']).toEqual({})
})

test('a request for a session this connection never opened is refused, not routed', async () => {
  const handled: AcpServerRequest[] = []
  const started = await startAgent({ onRequest: (request) => { handled.push(request) } })
  const sessionId = await openSession(started.client)
  ok(await started.client.prompt({ sessionId, text: 'FOREIGN' }))
  expect(handled).toEqual([])

  const answers = (await readEvents(started.recordFile)).filter((event) => event['kind'] === 'answer')
  expect(answers).toHaveLength(1)
  const frame = answers[0]!.frame as Record<string, unknown>
  const error = frame['error'] as Record<string, unknown>
  expect(error['code']).toBe(-32602)
  expect(String(error['message'])).toContain('other_connection_session')
  expect(String(error['message'])).toMatch(/not this connection's/)
  // The refused id was never held, so an answer for it is an unknown id.
  expect(started.client.answerServerRequest({ requestId: 7003, result: {} })).toBeInstanceOf(AcpApprovalError)
})

test('an answer naming a foreign session is refused and leaves the request open', async () => {
  const refusals: Array<{ requestId: number | string } | Error> = []
  let client!: AcpClient
  const started = await startAgent({
    onRequest: (request) => {
      refusals.push(
        client.answerServerRequest({
          requestId: request.requestId,
          result: { outcome: { outcome: 'selected', optionId: 'allow' } },
          sessionId: 'other_connection_session',
        }),
      )
      refusals.push(
        client.answerServerRequest({
          requestId: request.requestId,
          result: { outcome: { outcome: 'selected', optionId: 'allow' } },
          sessionId: request.sessionId,
        }),
      )
    },
  })
  client = started.client
  const sessionId = await openSession(client)
  ok(await client.prompt({ sessionId, text: 'TOOL' }))

  expect(refusals[0]).toBeInstanceOf(AcpApprovalError)
  expect((refusals[0] as Error).message).toMatch(/not this connection's/)
  expect(refusals[1]).toEqual({ requestId: 7001 })
  const answers = (await readEvents(started.recordFile)).filter((event) => event['kind'] === 'answer')
  expect(answers).toHaveLength(1)
})
