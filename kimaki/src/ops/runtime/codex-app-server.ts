import childProcess from 'node:child_process'
import readline from 'node:readline'
import { ConfigError } from '../../errors.js'

export type CodexAppServerRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>
type Message = { method: string; params?: unknown; id?: number }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export async function startCodexAppServer({ binary, codexHome, timeoutMs = 30_000, holdServerRequests }: {
  binary: string
  codexHome: string
  timeoutMs?: number
  /**
   * Leave server-initiated requests unanswered instead of failing them with
   * -32601, so a caller that owns an approval surface can answer them later.
   * `respond`/`respondError` report whether they actually delivered an answer.
   */
  holdServerRequests?: boolean
}): Promise<{
  request: CodexAppServerRequest
  subscribe: (listener: (message: Message) => void) => () => void
  respond: (id: number, result: unknown) => boolean
  respondError: (id: number, code: number, message: string) => boolean
  pendingServerRequests: () => Array<{ id: number; method: string; params?: unknown }>
  close: () => Promise<void>
} | Error> {
  if (!binary.trim() || !codexHome.trim()) return new ConfigError({ reason: 'Explicit --binary and --codex-home are required' })
  const child = childProcess.spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: codexHome,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, CODEX_HOME: codexHome, HOME: codexHome, USERPROFILE: codexHome, APPDATA: codexHome, LOCALAPPDATA: codexHome, TEMP: codexHome, TMP: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map<number, Pending>()
  const listeners = new Set<(message: Message) => void>()
  const awaiting = new Set<number>()
  let id = 0
  const write = (message: unknown) => { child.stdin.write(`${JSON.stringify(message)}\n`) }
  // Every server-initiated request that is still open, so a holder can list what
  // it owes an answer to and `close` can release anything left behind.
  const open = new Map<number, { method: string; params?: unknown }>()
  const respond = (requestId: number, result: unknown) => {
    if (!awaiting.delete(requestId)) return false
    open.delete(requestId)
    write({ id: requestId, result })
    return true
  }
  const respondError = (requestId: number, code: number, message: string) => {
    if (!awaiting.delete(requestId)) return false
    open.delete(requestId)
    write({ id: requestId, error: { code, message } })
    return true
  }
  lines.on('line', (line) => {
    let message: unknown
    try { message = JSON.parse(line) } catch { return }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return
    const value = message as Record<string, unknown>
    if (typeof value.id === 'number' && pending.has(value.id) && !('method' in value)) {
      const entry = pending.get(value.id)!
      pending.delete(value.id)
      if ('error' in value) entry.reject(new Error(`app-server returned an error: ${JSON.stringify(value.error)}`))
      else if ('result' in value) entry.resolve(value.result)
      else entry.reject(new Error('app-server returned no result'))
      return
    }
    if (typeof value.method !== 'string') return
    const notification: Message = { method: value.method, ...('params' in value ? { params: value.params } : {}), ...(typeof value.id === 'number' ? { id: value.id } : {}) }
    if (notification.id !== undefined) {
      awaiting.add(notification.id)
      open.set(notification.id, { method: notification.method, ...(notification.params === undefined ? {} : { params: notification.params }) })
    }
    for (const listener of [...listeners]) { try { listener(notification) } catch { /* Isolate consumers. */ } }
    if (notification.id !== undefined && holdServerRequests !== true) queueMicrotask(() => {
      if (awaiting.has(notification.id!)) respondError(notification.id!, -32601, 'Server-initiated request unsupported')
    })
  })
  const failAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear() }
  child.on('error', failAll)
  child.on('exit', () => failAll(new Error('app-server exited')))
  const deadline = setTimeout(() => { child.kill(); failAll(new Error('app-server timed out')) }, timeoutMs)
  const close = async () => {
    clearTimeout(deadline)
    // Nothing may be left hanging: a held request is failed before the process goes.
    for (const requestId of [...open.keys()]) respondError(requestId, -32601, 'app-server closed before this request was answered')
    child.kill()
    await closed
    lines.close()
    listeners.clear()
  }
  const request: CodexAppServerRequest = (method, params) => new Promise<unknown>((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    try { write({ id: requestId, method, params }) }
    catch (cause) {
      pending.delete(requestId)
      reject(cause instanceof Error ? cause : new Error('write failed'))
    }
  })
  try {
    await request('initialize', { clientInfo: { name: 'kimaki-ops', version: '1' }, capabilities: null })
    clearTimeout(deadline)
    write({ method: 'initialized' })
  } catch (cause) {
    await close()
    return new ConfigError({ reason: `Codex app-server initialize failed: ${cause instanceof Error ? cause.message : String(cause)}` })
  }
  return {
    request,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    respond,
    respondError,
    pendingServerRequests: () => [...open.entries()].map(([requestId, entry]) => ({ id: requestId, ...entry })),
    close,
  }
}
