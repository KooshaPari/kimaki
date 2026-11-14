import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startCodexAppServer } from './codex-app-server.js'
import { createCodexController } from './codex.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

it('streams a completed turn over a fake newline JSON-RPC child', async () => {
  const scratch = 'E:/koosh/Agents/scratch/codex-transport'
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'kimaki-codex-fake-'))
  dirs.push(dir)
  const script = join(dir, 'app-server.js')
  await writeFile(script, `const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hel' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'lo' } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
  }
});`)
  // Node interprets the app-server argument as the script in the isolated cwd.
  const binary = process.execPath
  const server = await startCodexAppServer({ binary, codexHome: dir, timeoutMs: 20000 })
  if (server instanceof Error) throw server
  try {
    const controller = createCodexController({ hostId: 'host', endpointId: 'endpoint', request: server.request, subscribe: server.subscribe, timeoutMs: 20000, turnTimeoutMs: 20000 })
    if (controller instanceof Error) throw controller
    try {
      const started = await controller.startThread()
      if (started instanceof Error) throw started
      const deltas: string[] = []
      const result = await controller.sendTurn({ threadId: started.threadId, text: 'hello', onDelta: ({ text }) => deltas.push(text) })
      expect(deltas).toEqual(['Hel', 'lo'])
      expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: 'Hello' })
    } finally { controller.close() }
  } finally { await server.close() }
})

it('names a missing codex home instead of reporting a spawn ENOENT', async () => {
  const server = await startCodexAppServer({
    binary: process.execPath,
    codexHome: 'E:/koosh/Agents/scratch/codex-transport/definitely-missing-home',
    timeoutMs: 5_000,
  })
  expect(server).toBeInstanceOf(Error)
  expect((server as Error).message).toMatch(/codex-home directory does not exist/i)
})

it('answers an unhandled server request with a JSON-RPC error and still settles the turn', async () => {
  const scratch = 'E:/koosh/Agents/scratch/codex-transport'
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'kimaki-codex-approval-'))
  dirs.push(dir)
  const script = join(dir, 'app-server.js')
  // The fake asks for approval mid-turn and echoes our answer back so the test can
  // see it. Approval answering is declared unsupported, so the answer must be an
  // error rather than a silent stall.
  await writeFile(script, `const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'done' } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
  }
  if (message.id === 999) send({ method: 'observed/approvalAnswer', params: message });
});`)
  const server = await startCodexAppServer({ binary: process.execPath, codexHome: dir, timeoutMs: 20000 })
  if (server instanceof Error) throw server
  try {
    const controller = createCodexController({ hostId: 'host', endpointId: 'endpoint', request: server.request, subscribe: server.subscribe, timeoutMs: 20000, turnTimeoutMs: 20000 })
    if (controller instanceof Error) throw controller
    try {
      const answers: unknown[] = []
      if (server.subscribe === undefined) throw new Error('the transport must expose subscribe')
      server.subscribe((notification) => {
        if (notification.method === 'observed/approvalAnswer') answers.push(notification.params)
      })
      const started = await controller.startThread()
      if (started instanceof Error) throw started
      const result = await controller.sendTurn({ threadId: started.threadId, text: 'needs approval' })
      expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: 'done' })
      // The error answer is written on a microtask, so give the child a moment to
      // receive it and echo it back.
      for (let attempt = 0; attempt < 40 && answers.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(answers).toHaveLength(1)
      const answer = answers[0] as { id?: number; error?: { code?: number; message?: string }; result?: unknown }
      expect(answer.id).toBe(999)
      expect(answer.error?.code).toBeDefined()
      expect(answer.error?.message).toMatch(/unhandled|unsupported/i)
      expect(answer.result).toBeUndefined()
    } finally { controller.close() }
  } finally { await server.close() }
})

it('holds an approval request for the controller so exactly one answer reaches the runtime', async () => {
  const scratch = 'E:/koosh/Agents/scratch/codex-transport'
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'kimaki-codex-hold-'))
  dirs.push(dir)
  const script = join(dir, 'app-server.js')
  // The fake raises a command approval, waits for the answer, and only then
  // finishes the turn: a held request is now a real decision the client owns.
  await writeFile(script, `const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ id: 999, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'echo hi' } });
  }
  if (message.id === 999) {
    send({ method: 'observed/approvalAnswer', params: message });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'ran' } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
  }
});`)
  const server = await startCodexAppServer({ binary: process.execPath, codexHome: dir, timeoutMs: 20000, holdServerRequests: true })
  if (server instanceof Error) throw server
  try {
    const answers: unknown[] = []
    server.subscribe((notification) => {
      if (notification.method === 'observed/approvalAnswer') answers.push(notification.params)
    })
    const requests: Array<{ requestId: number; command: string | null }> = []
    const controller = createCodexController({
      hostId: 'host',
      endpointId: 'endpoint',
      request: server.request,
      subscribe: server.subscribe,
      timeoutMs: 20000,
      turnTimeoutMs: 20000,
      holdsServerRequests: true,
      serverRequests: { result: server.respond, error: server.respondError },
      approvals: { policy: () => 'accept', onRequest: (request) => { requests.push({ requestId: request.requestId, command: request.command }) } },
    })
    if (controller instanceof Error) throw controller
    try {
      const started = await controller.startThread()
      if (started instanceof Error) throw started
      const result = await controller.sendTurn({ threadId: started.threadId, text: 'needs approval' })
      expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: 'ran' })
      expect(requests).toEqual([{ requestId: 999, command: 'echo hi' }])
      expect(answers).toHaveLength(1)
      expect(answers[0]).toMatchObject({ id: 999, result: { decision: 'accept' } })
      // The transport reports whether it actually delivered: the id is spent.
      expect(server.respond(999, { decision: 'accept' })).toBe(false)
      expect(server.pendingServerRequests()).toEqual([])
    } finally { controller.close() }
  } finally { await server.close() }
})

it('fails a held server request when the transport closes instead of leaving it open', async () => {
  const scratch = 'E:/koosh/Agents/scratch/codex-transport'
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'kimaki-codex-hold-close-'))
  dirs.push(dir)
  const script = join(dir, 'app-server.js')
  await writeFile(script, `const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    send({ id: 42, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'item-1' } });
  }
  if (message.id === 42) send({ method: 'observed/approvalAnswer', params: message });
});`)
  const server = await startCodexAppServer({ binary: process.execPath, codexHome: dir, timeoutMs: 20000, holdServerRequests: true })
  if (server instanceof Error) throw server
  await server.request('thread/start', {})
  for (let attempt = 0; attempt < 40 && server.pendingServerRequests().length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(server.pendingServerRequests()).toEqual([{ id: 42, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'item-1' } }])
  await server.close()
  // Closing releases the request with an explicit error, so the runtime is never
  // left waiting on a client that has gone away. The child is killed in the same
  // breath, so the proof is that the id is spent rather than that it echoed back.
  expect(server.pendingServerRequests()).toEqual([])
  expect(server.respondError(42, -32601, 'late answer')).toBe(false)
  expect(server.respond(42, { decision: 'accept' })).toBe(false)
})

it('drops held server requests and reports undelivered answers when the child exits on its own', async () => {
  const scratch = 'E:/koosh/Agents/scratch/codex-transport'
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'kimaki-codex-hold-exit-'))
  dirs.push(dir)
  const script = join(dir, 'app-server.js')
  // The fake raises an approval the client owns and then dies of its own accord: no
  // `close` call from the parent. An answer written afterwards would go nowhere, so
  // it must be reported as undelivered rather than as success.
  await writeFile(script, `const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') {
    send({ id: 42, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'item-1' } });
  }
  if (message.method === 'shell/exitNow') setTimeout(() => process.exit(0), 0);
});`)
  const server = await startCodexAppServer({ binary: process.execPath, codexHome: dir, timeoutMs: 20000, holdServerRequests: true })
  if (server instanceof Error) throw server
  try {
    // Both requests hang by design; settle them into plain promises so the exit is
    // observable without an unhandled rejection.
    const ignore = (promise: Promise<unknown>) => promise.then(() => undefined, () => undefined)
    const started = ignore(server.request('thread/start', {}))
    for (let attempt = 0; attempt < 200 && server.pendingServerRequests().length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(server.pendingServerRequests()).toEqual([{ id: 42, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'item-1' } }])
    // Trigger the child's own exit, then wait for the transport to notice it.
    const exited = ignore(server.request('shell/exitNow', {}))
    await Promise.all([started, exited])
    expect(server.pendingServerRequests()).toEqual([])
    expect(server.respond(42, { decision: 'accept' })).toBe(false)
    expect(server.respondError(42, -32601, 'late answer')).toBe(false)
  } finally { await server.close() }
  expect(server.pendingServerRequests()).toEqual([])
  expect(server.respond(42, { decision: 'accept' })).toBe(false)
  expect(server.respondError(42, -32601, 'late answer')).toBe(false)
})
