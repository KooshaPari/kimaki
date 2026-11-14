import { mkdtemp, writeFile, rm, copyFile, mkdir } from 'node:fs/promises'
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
  const script = join(dir, 'app-server')
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
  const binary = join(dir, process.platform === 'win32' ? 'fake.exe' : 'fake')
  await copyFile(process.execPath, binary)
  const server = await startCodexAppServer({ binary, codexHome: dir, timeoutMs: 3000 })
  if (server instanceof Error) throw server
  try {
    const controller = createCodexController({ hostId: 'host', endpointId: 'endpoint', request: server.request, subscribe: server.subscribe, timeoutMs: 3000, turnTimeoutMs: 3000 })
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
