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
