// Explicitly launched Codex app-server for metadata-only discovery. The caller
// supplies the executable and state directory; nothing is inferred from the
// user's environment, and no credentials or model requests are used.
import childProcess from 'node:child_process'
import readline from 'node:readline'
import { ConfigError } from '../../errors.js'

export type CodexAppServerRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export async function startCodexAppServer({ binary, codexHome, timeoutMs = 30_000 }: {
  binary: string
  codexHome: string
  timeoutMs?: number
}): Promise<{ request: CodexAppServerRequest; close: () => Promise<void> } | Error> {
  if (!binary.trim() || !codexHome.trim()) return new ConfigError({ reason: 'Explicit --binary and --codex-home are required' })
  const child = childProcess.spawn(binary, ['app-server', '--listen', 'stdio://'], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, CODEX_HOME: codexHome, HOME: codexHome, USERPROFILE: codexHome, APPDATA: codexHome, LOCALAPPDATA: codexHome, TEMP: codexHome, TMP: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map<number, Pending>()
  let id = 0
  lines.on('line', (line) => {
    const message: unknown = JSON.parse(line)
    if (message === null || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if ('error' in message) entry.reject(new Error('app-server returned an error'))
    else if ('result' in message) entry.resolve(message.result)
    else entry.reject(new Error('app-server returned no result'))
  })
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear() }
  child.on('error', failAll)
  child.on('exit', () => failAll(new Error('app-server exited')))
  const deadline = setTimeout(() => { child.kill(); failAll(new Error('app-server timed out')) }, timeoutMs)
  const close = async () => {
    clearTimeout(deadline)
    child.kill()
    await closed
    lines.close()
  }
  const request: CodexAppServerRequest = (method, params) => new Promise<unknown>((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    try {
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
    } catch (cause) {
      pending.delete(requestId)
      reject(cause instanceof Error ? cause : new Error('write failed'))
    }
  })
  const initialized = await new Promise<unknown>((resolve, reject) => {
    request('initialize', { clientInfo: { name: 'kimaki-ops', version: '1' }, capabilities: null }).then(resolve, reject)
  })
  if (initialized instanceof Error) {
    await close()
    return new ConfigError({ reason: `Codex app-server initialize failed: ${initialized.message}` })
  }
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  return { request, close }
}
