import { describe, expect, it } from 'vitest'
import { createCodexController, createCodexObserver } from './codex.js'
import type { CodexApprovalPolicy, CodexApprovalRequest, CodexControlMethod, CodexNotification } from './codex.js'

type Call = { method: CodexControlMethod; params: Record<string, unknown> }

function harness(handler: (call: Call) => Promise<unknown> | unknown = () => ({})) {
  const calls: Call[] = []
  const listeners = new Set<(notification: CodexNotification) => void>()
  let unsubscribed = 0
  const controller = createCodexController({
    hostId: 'host',
    endpointId: 'endpoint',
    request: (method, params) => {
      const call = { method, params }
      calls.push(call)
      return Promise.resolve().then(() => handler(call))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        unsubscribed++
      }
    },
    timeoutMs: 50,
    turnTimeoutMs: 50,
  })
  if (controller instanceof Error) throw controller
  return {
    controller,
    calls,
    unsubscribed: () => unsubscribed,
    emit: (method: string, params: unknown) => { for (const listener of [...listeners]) listener({ method, params }) },
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const delta = (threadId: string, turnId: string, text: string) => ({ threadId, turnId, itemId: 'item-1', delta: text })
const completed = (threadId: string, turnId: string, status = 'completed', extra: Record<string, unknown> = {}) => ({
  threadId,
  turn: { id: turnId, status, items: [], error: null, ...extra },
})

describe('Codex control surface', () => {
  it('declares only what the protocol and client can actually do', () => {
    const { controller } = harness()
    expect(controller.capabilities).toMatchObject({
      version: 1,
      streaming: { kind: 'supported' },
      control: { create: { kind: 'supported' }, submit: { kind: 'supported' }, interrupt: { kind: 'supported' } },
    })
    expect(controller.capabilities.control.answerApproval.kind).toBe('unsupported')
    expect('reason' in controller.capabilities.control.answerApproval).toBe(true)
  })

  it('starts a thread with an explicit cwd and returns only the key', async () => {
    const { controller, calls } = harness((call) => call.method === 'thread/start'
      ? { thread: { id: 'thread-1', preview: 'private prompt', cwd: 'private path' }, model: 'private' }
      : {})
    const started = await controller.startThread({ cwd: 'C:/work' })
    expect(started).toEqual({
      threadId: 'thread-1',
      key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' },
    })
    expect(JSON.stringify(started)).not.toContain('private')
    expect(calls).toEqual([{ method: 'thread/start', params: { cwd: 'C:/work' } }])
  })

  it('resumes an existing thread in a new app-server process', async () => {
    const { controller, calls } = harness((call) => call.method === 'thread/resume'
      ? { thread: { id: 'thread-9', preview: 'private prompt' }, model: 'm' }
      : {})
    // turn/start rejects a thread that the fresh process has not resumed.
    expect(await controller.resumeThread({ threadId: 'thread-9', cwd: 'C:/work' })).toEqual({
      threadId: 'thread-9',
      key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-9' },
    })
    expect(calls).toEqual([{ method: 'thread/resume', params: { threadId: 'thread-9', cwd: 'C:/work' } }])
  })

  it('refuses a resume that answers with a different thread', async () => {
    const { controller } = harness(() => ({ thread: { id: 'thread-other' } }))
    const resumed = await controller.resumeThread({ threadId: 'thread-9' })
    expect(resumed).toBeInstanceOf(Error)
    expect((resumed as Error).message).toMatch(/different thread/i)
  })

  it('reads a thread as user and agent messages using the observed item shapes', async () => {
    const { controller, calls } = harness(() => ({
      thread: {
        id: 'thread-9',
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            items: [
              { type: 'userMessage', content: [{ type: 'text', text: 'first ' }, { type: 'text', text: 'ask' }] },
              { type: 'agentMessage', text: 'first answer' },
              { type: 'reasoning', text: 'private reasoning' },
            ],
          },
          { id: 'turn-2', status: 'interrupted', items: [{ type: 'agentMessage', text: '' }] },
        ],
      },
    }))
    const read = await controller.readThread({ threadId: 'thread-9' })
    expect(read).toMatchObject({
      threadId: 'thread-9',
      turns: [
        { id: 'turn-1', status: 'completed', messages: [{ role: 'user', text: 'first ask' }, { role: 'agent', text: 'first answer' }] },
        { id: 'turn-2', status: 'interrupted', messages: [] },
      ],
    })
    expect(JSON.stringify(read)).not.toContain('private reasoning')
    // Reading must never resume: resume takes the native writer lock and would
    // block the session this reader is observing.
    expect(calls).toEqual([{ method: 'thread/read', params: { threadId: 'thread-9', includeTurns: true } }])
  })

  it('refuses a read that answers about another thread', async () => {
    const { controller } = harness(() => ({ thread: { id: 'thread-other', turns: [] } }))
    const read = await controller.readThread({ threadId: 'thread-9' })
    expect(read).toBeInstanceOf(Error)
  })

  it('starts a thread with an explicit cwd and returns only the key', async () => {
    const { controller, calls } = harness((call) => call.method === 'thread/start'
      ? { thread: { id: 'thread-1', preview: 'private prompt', cwd: 'private path' }, model: 'private' }
      : {})
    const started = await controller.startThread({ cwd: 'C:/work' })
    expect(started).toEqual({
      threadId: 'thread-1',
      key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' },
    })
    expect(JSON.stringify(started)).not.toContain('private')
    expect(calls).toEqual([{ method: 'thread/start', params: { cwd: 'C:/work' } }])
    expect(await controller.startThread()).toEqual({
      threadId: 'thread-1',
      key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' },
    })
    expect(calls[1]).toEqual({ method: 'thread/start', params: {} })
  })

  it('rejects malformed thread starts, blank cwd and timeouts instead of throwing', async () => {
    const malformedHarness = harness(() => ({ thread: { id: '' } }))
    expect(await malformedHarness.controller.startThread()).toBeInstanceOf(Error)
    expect(await malformedHarness.controller.startThread({ cwd: '   ' })).toBeInstanceOf(Error)
    // The malformed response was requested once; the blank cwd never reached the transport.
    expect(malformedHarness.calls).toEqual([{ method: 'thread/start', params: {} }])

    const hanging = harness(() => new Promise<never>(() => {}))
    const timedOut = await hanging.controller.startThread()
    expect(timedOut).toBeInstanceOf(Error)
    expect(String((timedOut as Error).cause)).toContain('Timed out')

    const throwing = harness(() => { throw new Error('socket closed') })
    expect(await throwing.controller.startThread()).toBeInstanceOf(Error)
  })

  it('streams deltas and resolves the completed turn text', async () => {
    const seen: string[] = []
    const { controller, emit } = harness((call) => call.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {})
    const pending = controller.sendTurn({ threadId: 'thread-1', text: 'hello', onDelta: (event) => { seen.push(event.text) } })
    await flush()
    emit('item/agentMessage/delta', delta('thread-1', 'turn-1', 'Hel'))
    emit('item/agentMessage/delta', delta('thread-1', 'turn-1', 'lo'))
    emit('turn/completed', completed('thread-1', 'turn-1'))
    expect(await pending).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: 'Hello' })
    expect(seen).toEqual(['Hel', 'lo'])
  })

  it('sends the documented turn/start payload and ignores other threads and turns', async () => {
    const seen: string[] = []
    const { controller, calls, emit } = harness((call) => call.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {})
    const pending = controller.sendTurn({ threadId: 'thread-1', text: 'hello' })
    await flush()
    emit('item/agentMessage/delta', delta('other-thread', 'turn-1', 'private'))
    emit('item/agentMessage/delta', delta('thread-1', 'other-turn', 'private'))
    emit('item/agentMessage/delta', delta('thread-1', 'turn-1', 'ok'))
    emit('turn/completed', completed('thread-1', 'turn-1'))
    const result = await pending
    expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: 'ok' })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(calls).toEqual([{
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: 'hello', text_elements: [] }] },
    }])
    expect(seen).toEqual([])
  })

  it('falls back to the completed agent message when no delta arrived', async () => {
    const { controller, emit } = harness((call) => call.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {})
    const pending = controller.sendTurn({ threadId: 'thread-1', text: 'hello' })
    await flush()
    emit('turn/completed', completed('thread-1', 'turn-1', 'completed', {
      items: [
        { type: 'reasoning', id: 'r1', summary: [], content: [] },
        { type: 'agentMessage', id: 'a1', text: 'final answer' },
      ],
    }))
    expect(await pending).toMatchObject({ status: 'completed', text: 'final answer' })
  })

  it('returns an Error for failed turns, rejected requests, malformed responses and turn timeouts', async () => {
    const failed = harness((call) => call.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {})
    const failedTurn = failed.controller.sendTurn({ threadId: 'thread-1', text: 'hello' })
    await flush()
    failed.emit('turn/completed', completed('thread-1', 'turn-1', 'failed', { error: { message: 'quota exhausted' } }))
    const failure = await failedTurn
    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).cause)).toContain('quota exhausted')

    const rejected = harness(() => Promise.reject(new Error('app-server returned an error')))
    expect(await rejected.controller.sendTurn({ threadId: 'thread-1', text: 'hello' })).toBeInstanceOf(Error)

    const malformed = harness(() => ({ turn: { id: '' } }))
    expect(await malformed.controller.sendTurn({ threadId: 'thread-1', text: 'hello' })).toBeInstanceOf(Error)

    const timedOut = harness(() => ({ turn: { id: 'turn-1' } }))
    const pending = timedOut.controller.sendTurn({ threadId: 'thread-1', text: 'hello' })
    expect(await pending).toBeInstanceOf(Error)
    expect(String((await pending as Error).cause)).toContain('Timed out')
  })

  it('rejects blank text and concurrent turns on one thread', async () => {
    const { controller, calls } = harness(() => new Promise<never>(() => {}))
    expect(await controller.sendTurn({ threadId: 'thread-1', text: '   ' })).toBeInstanceOf(Error)
    expect(calls).toHaveLength(0)
    void controller.sendTurn({ threadId: 'thread-1', text: 'first' })
    await flush()
    expect(await controller.sendTurn({ threadId: 'thread-1', text: 'second' })).toBeInstanceOf(Error)
    controller.close()
  })

  it('interrupts the tracked active turn and never guesses a turn id', async () => {
    const { controller, calls, emit } = harness((call) => {
      if (call.method === 'turn/start') return { turn: { id: 'turn-1' } }
      return {}
    })
    expect(await controller.cancel({ threadId: 'thread-1' })).toBeInstanceOf(Error)
    const pending = controller.sendTurn({ threadId: 'thread-1', text: 'hello' })
    await flush()
    expect(await controller.cancel({ threadId: 'thread-1' })).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    emit('turn/completed', completed('thread-1', 'turn-1', 'interrupted'))
    expect(await pending).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'interrupted', text: '' })
    expect(calls.filter((call) => call.method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    ])
    expect(await controller.cancel({ threadId: 'thread-1', turnId: 'explicit' })).toEqual({ threadId: 'thread-1', turnId: 'explicit' })
  })

  it('settles in-flight turns and unsubscribes on close', async () => {
    const { controller, emit, unsubscribed } = harness(() => ({ turn: { id: 'turn-1' } }))
    const pending = controller.sendTurn({ threadId: 'thread-1', text: 'hello' })
    await flush()
    controller.close()
    expect(await pending).toBeInstanceOf(Error)
    expect(unsubscribed()).toBe(1)
    controller.close()
    expect(unsubscribed()).toBe(1)
    emit('turn/completed', completed('thread-1', 'turn-1'))
  })

  it('propagates subscription failures as Errors', () => {
    const failed = createCodexController({
      hostId: 'host',
      endpointId: 'endpoint',
      request: async () => ({}),
      subscribe: () => new Error('no notification channel'),
    })
    expect(failed).toBeInstanceOf(Error)
    const threw = createCodexController({
      hostId: 'host',
      endpointId: 'endpoint',
      request: async () => ({}),
      subscribe: () => { throw new Error('closed') },
    })
    expect(threw).toBeInstanceOf(Error)
  })
})

// A transport stand-in that behaves like `startCodexAppServer` with
// holdServerRequests: a request id stays open until exactly one answer is
// written, and a second write reports false instead of being silently dropped.
function approvalHarness(policy?: CodexApprovalPolicy, withApprovals = true) {
  const listeners = new Set<(notification: CodexNotification) => void>()
  const open = new Set<number>()
  const results: Array<{ id: number; result: unknown }> = []
  const failures: Array<{ id: number; code: number; message: string }> = []
  const requests: CodexApprovalRequest[] = []
  const controller = createCodexController({
    hostId: 'host',
    endpointId: 'endpoint',
    request: async () => ({}),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    timeoutMs: 50,
    turnTimeoutMs: 50,
    serverRequests: {
      result: (id, result) => {
        if (!open.delete(id)) return false
        results.push({ id, result })
        return true
      },
      error: (id, code, message) => {
        if (!open.delete(id)) return false
        failures.push({ id, code, message })
        return true
      },
    },
    ...(withApprovals ? { approvals: { policy, onRequest: (request: CodexApprovalRequest) => { requests.push(request) } } } : {}),
  })
  if (controller instanceof Error) throw controller
  // Mirrors the transport: an id is open before its request is delivered, so an
  // answer to it is forwarded exactly once.
  const request = (id: number, method: string, params: Record<string, unknown> = {}) => {
    open.add(id)
    for (const listener of [...listeners]) {
      listener({ id, method, params })
    }
  }
  const ask = (id: number, params: Record<string, unknown> = {}) =>
    request(id, 'item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'rm -rf /tmp/x', ...params })
  // Simulates the transport losing an id, which is what a closed connection does.
  const drop = (id: number) => { open.delete(id) }
  return { controller, requests, results, failures, ask, drop, request }
}

describe('Codex approval surface', () => {
  it('declares answerApproval supported only when an approval channel exists', () => {
    const { controller } = approvalHarness(undefined, false)
    expect(controller.capabilities.control.answerApproval.kind).toBe('unsupported')
    expect(controller.answerApproval({ requestId: 1, decision: 'accept' })).toBeInstanceOf(Error)
    const configured = approvalHarness(() => 'accept')
    expect(configured.controller.capabilities.control.answerApproval.kind).toBe('supported')
  })

  it('refuses an approval surface without a result and error channel', () => {
    const controller = createCodexController({
      hostId: 'host',
      endpointId: 'endpoint',
      request: async () => ({}),
      subscribe: () => () => {},
      approvals: { policy: () => 'accept' },
    })
    expect(controller).toBeInstanceOf(Error)
    expect((controller as Error).message).toMatch(/result and an error channel/)
  })

  it('answers a policy-approved command once and surfaces the request', () => {
    const { controller, results, requests, ask } = approvalHarness(() => 'accept')
    ask(41)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ requestId: 41, method: 'item/commandExecution/requestApproval', command: 'rm -rf /tmp/x', threadId: 'thread-1', turnId: 'turn-1' })
    expect(results).toEqual([{ id: 41, result: { decision: 'accept' } }])
    expect(controller.pendingApprovals()).toEqual([])
  })

  it('leaves a request open without a policy and then answers it by id', () => {
    const { controller, results, ask } = approvalHarness()
    ask(7)
    expect(controller.pendingApprovals()).toHaveLength(1)
    expect(results).toEqual([])
    expect(controller.answerApproval({ requestId: 7, decision: 'decline' })).toEqual({ requestId: 7, decision: 'decline' })
    expect(results).toEqual([{ id: 7, result: { decision: 'decline' } }])
    expect(controller.pendingApprovals()).toEqual([])
  })

  it('refuses a replayed answer instead of forwarding it twice', () => {
    const { controller, results, ask } = approvalHarness()
    ask(9)
    expect(controller.answerApproval({ requestId: 9, decision: 'accept' })).toEqual({ requestId: 9, decision: 'accept' })
    const replay = controller.answerApproval({ requestId: 9, decision: 'decline' })
    expect(replay).toBeInstanceOf(Error)
    expect((replay as Error).message).toMatch(/already answered/)
    expect(results).toEqual([{ id: 9, result: { decision: 'accept' } }])
  })

  it('gives the first of two racing answers the request and refuses the loser', () => {
    const { controller, results, ask } = approvalHarness()
    ask(11)
    const first = controller.answerApproval({ requestId: 11, decision: 'accept' })
    const second = controller.answerApproval({ requestId: 11, decision: 'acceptForSession' })
    expect(first).toEqual({ requestId: 11, decision: 'accept' })
    expect(second).toBeInstanceOf(Error)
    expect(results).toHaveLength(1)
  })

  it('refuses an id that was never issued and an id the app-server dropped', () => {
    const { controller, results } = approvalHarness()
    const unknown = controller.answerApproval({ requestId: 99, decision: 'accept' })
    expect(unknown).toBeInstanceOf(Error)
    expect((unknown as Error).message).toMatch(/no approval request with this id is open/)
    // The transport can lose the id first (closed connection); the answer then
    // reports that instead of pretending it was delivered.
    const losing = approvalHarness()
    losing.ask(5)
    losing.drop(5)
    const dropped = losing.controller.answerApproval({ requestId: 5, decision: 'accept' })
    expect(dropped).toBeInstanceOf(Error)
    expect((dropped as Error).message).toMatch(/no longer had this request open/)
    expect(results).toEqual([])
  })

  it('fails an unexpected server request rather than leaving the turn hanging', () => {
    const { failures, request } = approvalHarness()
    request(12, 'item/tool/requestUserInput', { threadId: 'thread-1' })
    expect(failures).toEqual([{ id: 12, code: -32601, message: 'Server-initiated request item/tool/requestUserInput unsupported' }])
  })

  it('declines when a policy throws instead of granting by accident', () => {
    const { results, ask } = approvalHarness(() => { throw new Error('policy bug') })
    ask(13)
    expect(results).toEqual([{ id: 13, result: { decision: 'decline' } }])
  })
})

describe('Codex passive observer', () => {
  it('never returns native preview, path, transcript or unknown fields', async () => {
    const secret = { id: 'thread-1', preview: 'private prompt', path: 'private path', turns: ['private transcript'], unknown: 'private' }
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async (method) => method === 'thread/list'
      ? { data: [secret], nextCursor: null }
      : { thread: secret } })
    if (observer instanceof Error) throw observer
    const discovered = await observer.discover()
    const read = await observer.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' } })
    expect(JSON.stringify([discovered, read])).not.toContain('private')
  })
  it('uses state-db-only discovery and preserves pagination', async () => {
    const calls: unknown[] = []
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async (method, params) => {
      calls.push([method, params])
      return { data: [{ id: 'thread-1', status: { type: 'notLoaded' } }], nextCursor: 'next', backwardsCursor: null }
    } })
    expect(observer).not.toBeInstanceOf(Error)
    if (observer instanceof Error) return
    expect(await observer.discover({ limit: 10 })).toMatchObject({ sessions: [{ key: { nativeSessionId: 'thread-1', backendKind: 'codex' } }], cursor: 'next' })
    expect(calls).toEqual([['thread/list', { limit: 10, useStateDbOnly: true }]])
    expect(observer.capabilities.observe.kind).toBe('unsupported')
  })

  it('reads metadata without resuming and rejects mismatched keys', async () => {
    const calls: unknown[] = []
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async (method, params) => {
      calls.push([method, params])
      return { thread: { id: 'thread-1', status: { type: 'notLoaded' } } }
    } })
    if (observer instanceof Error) throw observer
    const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' }
    expect(await observer.readSnapshot({ key })).toMatchObject({ session: { id: 'thread-1' } })
    expect(await observer.readSnapshot({ key: { ...key, endpointId: 'other' } })).toBeInstanceOf(Error)
    expect(calls).toEqual([['thread/read', { threadId: 'thread-1', includeTurns: false }]])
  })

  it('does not return extra caller-supplied key properties', async () => {
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async () => ({ thread: { id: 'thread-1' } }) })
    if (observer instanceof Error) throw observer
    const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1', secret: 'private-key-field' }
    expect(JSON.stringify(await observer.readSnapshot({ key }))).not.toContain('private-key-field')
  })

  it('rejects malformed responses and mismatched native identity', async () => {
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async () => ({ thread: { id: 'other' } }) })
    if (observer instanceof Error) throw observer
    expect(await observer.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' } })).toBeInstanceOf(Error)
    expect(await observer.discover()).toBeInstanceOf(Error)
  })
})
