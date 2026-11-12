// Opt-in acceptance against a locally installed public Codex CLI. This starts an
// isolated app-server with no credentials and sends no model requests.
import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { expect, it } from 'vitest'
import { createCodexObserver } from './codex.js'

it.skipIf(!process.env.KIMAKI_CODEX_ACCEPTANCE)('discovers through an isolated installed app-server', async () => {
  const scratch = process.env.KIMAKI_CODEX_SCRATCH
  const executable = process.env.KIMAKI_CODEX_BINARY
  if (!scratch || !executable) throw new Error('Set KIMAKI_CODEX_SCRATCH and KIMAKI_CODEX_BINARY to run acceptance')
  const root = await fs.mkdtemp(path.join(scratch, 'codex-acceptance-'))
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  const child = childProcess.spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: root, TMP: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const deadline = setTimeout(() => child.kill(), 60_000)
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let id = 0
  lines.on('line', (line) => {
    const message: unknown = JSON.parse(line)
    if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if ('error' in message) entry.reject(new Error('app-server returned an error'))
    else if ('result' in message) entry.resolve(message.result)
  })
  child.on('error', (error) => { for (const entry of pending.values()) entry.reject(error) })
  child.on('exit', () => { for (const entry of pending.values()) entry.reject(new Error('app-server exited')) })
  const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n')
  })
  try {
    await request('initialize', { clientInfo: { name: 'kimaki-test', title: null, version: '1' }, capabilities: null })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    const observer = createCodexObserver({ hostId: 'isolated', endpointId: 'isolated', request })
    if (observer instanceof Error) throw observer
    expect(await observer.discover({ limit: 5 })).toEqual({ source: { hostId: 'isolated', endpointId: 'isolated', backendKind: 'codex' }, sessions: [], cursor: null })
    expect(await observer.readSnapshot({ key: { hostId: 'isolated', endpointId: 'isolated', backendKind: 'codex', nativeSessionId: '01900000-0000-7000-8000-000000000000' } })).toBeInstanceOf(Error)
  } finally {
    clearTimeout(deadline)
    child.kill()
    await closed
    lines.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 70_000)
