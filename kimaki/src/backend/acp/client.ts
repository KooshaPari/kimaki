// ACP stdio transport for the Jcode backend.
//
// One child process speaking newline-delimited JSON-RPC 2.0 over stdio. The
// client correlates responses by request id and routes `session/update`
// notifications to the active prompt, because ACP streams assistant text as
// notifications rather than in the response.
//
// Every public method resolves an Error instead of throwing (the errore
// convention used across kimaki), so callers fail closed without try/catch.
// Prompt text is never copied into an error message.

import childProcess from 'node:child_process'
import readline from 'node:readline'
import { ConfigError } from '../../errors.ts'
import type { AcpClient, AcpClientOptions, AcpFrame, AcpInitializeResult, AcpLoadResult, AcpPromptResult, CreateAcpClient } from './contracts.ts'

const DEFAULT_TIMEOUT_MS = 30_000
/** How long close() waits for a graceful exit before killing hard. */
const CLOSE_GRACE_MS = 2_000

type PromptState = {
  sessionId: string
  text: string
  updateCount: number
  onChunk?: (text: string) => void
  /** Replayed messages, used by session/load to recover native history. */
  history?: Array<{ role: 'user' | 'agent'; text: string }>
}

type Pending = {
  resolve: (frame: AcpFrame | Error) => void
  timer: ReturnType<typeof setTimeout> | null
  /** Present only for prompt calls: where notifications for this turn go. */
  prompt?: PromptState
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const positive = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const writeFrame = (stream: NodeJS.WritableStream, frame: Record<string, unknown>): boolean => {
  stream.write(`${JSON.stringify(frame)}\n`)
  return true
}

export const createAcpClient: CreateAcpClient = (options: AcpClientOptions): AcpClient => {
  const defaultTimeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const pending = new Map<number, Pending>()
  let nextId = 0
  let closed = false
  let closePromise: Promise<void> | null = null
  let failure: Error | null = null
  let exited = false
  let active: { id: number; entry: Pending } | null = null

  let child: childProcess.ChildProcess | null = null
  try {
    child = childProcess.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (cause) {
    failure = new ConfigError({ reason: 'Could not start the ACP agent process', cause })
  }

  const stdout = child?.stdout
  const lines = stdout ? readline.createInterface({ input: stdout }) : null
  child?.stderr?.resume()

  const failAll = (error: Error) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve(error)
    }
    active = null
  }

  child?.on('error', (cause) => {
    failure ??= new ConfigError({ reason: 'The ACP agent process failed to start', cause })
    failAll(failure)
  })
  child?.on('exit', () => {
    exited = true
    failAll(new ConfigError({ reason: 'The ACP agent process exited before responding' }))
  })

  /** Route a `session/update` notification to the active prompt, if any. */
  const routeUpdate = (params: Record<string, unknown> | undefined) => {
    const prompt = active?.entry.prompt
    if (!prompt || !params) return
    const sessionId = params.sessionId
    if (typeof sessionId === 'string' && sessionId !== prompt.sessionId) return
    const update = record(params.update)
    if (!update) return
    prompt.updateCount += 1
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = record(update.content)?.text
      if (typeof text === 'string' && prompt.history) prompt.history.push({ role: 'user', text })
      return
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const text = record(update.content)?.text
    if (typeof text !== 'string') return
    if (prompt.history) prompt.history.push({ role: 'agent', text })
    prompt.text += text
    try {
      prompt.onChunk?.(text)
    } catch {
      // A consumer callback must never break the transport.
    }
  }

  /** Resolve a correlated response, mapping protocol errors to ConfigError. */
  const settle = (id: number, entry: Pending, frame: AcpFrame) => {
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (active?.id === id) active = null
    if (frame.error) {
      const code = typeof frame.error.code === 'number' ? frame.error.code : 'unknown'
      // Surface the agent's own message (e.g. provider auth failures); never add
      // prompt text of our own.
      const detail = typeof frame.error.message === 'string' && frame.error.message.trim()
        ? frame.error.message.trim()
        : 'no message'
      entry.resolve(new ConfigError({ reason: `The ACP agent returned an error (code ${code}): ${detail}` }))
      return
    }
    if (!record(frame.result)) {
      entry.resolve(new ConfigError({ reason: 'The ACP agent returned no result' }))
      return
    }
    entry.resolve(frame)
  }

  const handleLine = (line: string) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (cause) {
      failAll(new ConfigError({ reason: 'The ACP agent sent a frame that is not JSON', cause }))
      return
    }
    const frame = record(parsed)
    if (!frame) {
      failAll(new ConfigError({ reason: 'The ACP agent sent a malformed frame' }))
      return
    }
    const rawId = frame.id
    // Notifications (no id) and unknown methods are ignored by design.
    if (typeof rawId !== 'number' && typeof rawId !== 'string') {
      if (frame.method === 'session/update') routeUpdate(record(frame.params) ?? undefined)
      return
    }
    if (frame.method !== undefined) return
    const key = typeof rawId === 'number' ? rawId : Number(rawId)
    if (!Number.isSafeInteger(key)) return
    const entry = pending.get(key)
    if (!entry) return
    settle(key, entry, frame as AcpFrame)
  }

  lines?.on('line', handleLine)

  const unavailable = (): Error | null => {
    if (closed) return new ConfigError({ reason: 'The ACP client is closed' })
    if (failure) return failure
    if (!child?.stdin || exited) return new ConfigError({ reason: 'The ACP agent process is not running' })
    return null
  }

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    prompt?: PromptState,
  ): Promise<AcpFrame | Error> => new Promise<AcpFrame | Error>((resolve) => {
    const blocked = unavailable()
    if (blocked) {
      resolve(blocked)
      return
    }
    const id = ++nextId
    const entry: Pending = { resolve, timer: null }
    if (prompt) entry.prompt = prompt
    pending.set(id, entry)
    if (prompt) active = { id, entry }
    entry.timer = setTimeout(() => {
      if (!pending.delete(id)) return
      if (active?.id === id) active = null
      // Method and timeout only: prompt text stays out of errors.
      resolve(new ConfigError({ reason: `The ACP agent did not answer ${method} within ${timeoutMs}ms` }))
    }, timeoutMs)
    try {
      writeFrame(child!.stdin!, { jsonrpc: '2.0', id, method, params })
    } catch (cause) {
      pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      if (active?.id === id) active = null
      resolve(new ConfigError({ reason: 'Could not write to the ACP agent process', cause }))
    }
  })

  return {
    async initialize(): Promise<AcpInitializeResult | Error> {
      const frame = await request('initialize', { protocolVersion: 1, clientCapabilities: {} }, defaultTimeoutMs)
      if (frame instanceof Error) return frame
      const result = frame.result ?? {}
      const protocolVersion = typeof result.protocolVersion === 'number' ? result.protocolVersion : null
      if (protocolVersion === null) return new ConfigError({ reason: 'The ACP agent did not report a protocol version' })
      const info = record(result.agentInfo)
      const agentName = typeof result.agentName === 'string'
        ? result.agentName
        : typeof info?.name === 'string' ? info.name : null
      return { protocolVersion, agentName }
    },

    async newSession(input: { cwd: string }): Promise<{ sessionId: string } | Error> {
      if (typeof input.cwd !== 'string' || !input.cwd.trim()) {
        return new ConfigError({ reason: 'ACP session needs a working directory' })
      }
      const frame = await request('session/new', { cwd: input.cwd, mcpServers: [] }, defaultTimeoutMs)
      if (frame instanceof Error) return frame
      const sessionId = frame.result?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        return new ConfigError({ reason: 'The ACP agent did not return a session ID' })
      }
      return { sessionId }
    },

    async setModel(input: { sessionId: string; model: string }): Promise<{ model: string } | Error> {
      if (typeof input.sessionId !== 'string' || !input.sessionId) {
        return new ConfigError({ reason: 'ACP model selection needs a session ID' })
      }
      if (typeof input.model !== 'string' || !input.model.trim()) {
        return new ConfigError({ reason: 'ACP model selection needs a model name' })
      }
      const frame = await request(
        'session/set_config_option',
        { sessionId: input.sessionId, configId: 'model', value: input.model },
        defaultTimeoutMs,
      )
      if (frame instanceof Error) return frame
      const configOptions = frame.result?.configOptions
      if (!Array.isArray(configOptions)) {
        return new ConfigError({ reason: 'The ACP agent did not return config options' })
      }
      for (const option of configOptions) {
        const entry = record(option)
        if (!entry || entry.category !== 'model') continue
        if (typeof entry.currentValue === 'string' && entry.currentValue) return { model: entry.currentValue }
      }
      return new ConfigError({ reason: 'The ACP agent did not confirm the selected model' })
    },

    async loadSession(input: { sessionId: string; cwd: string }): Promise<AcpLoadResult | Error> {
      if (typeof input.sessionId !== 'string' || !input.sessionId) {
        return new ConfigError({ reason: 'ACP session/load needs a session ID' })
      }
      if (typeof input.cwd !== 'string' || !input.cwd.trim()) {
        return new ConfigError({ reason: 'ACP session/load needs a working directory' })
      }
      const state: PromptState = { sessionId: input.sessionId, text: '', updateCount: 0, history: [] }
      const frame = await request(
        'session/load',
        { sessionId: input.sessionId, cwd: input.cwd, mcpServers: [] },
        defaultTimeoutMs,
        state,
      )
      if (frame instanceof Error) return frame
      // Replayed chunks arrive before the response, so nothing is still in flight.
      const history = state.history ?? []
      const options = Array.isArray(frame.result?.configOptions) ? frame.result.configOptions : []
      const modelOption = options.find((option) => record(option)?.category === 'model')
      const current = modelOption === undefined ? undefined : record(modelOption)?.currentValue
      return {
        sessionId: typeof frame.result?.sessionId === 'string' ? frame.result.sessionId : input.sessionId,
        history,
        model: typeof current === 'string' && current.trim() ? current : null,
      }
    },

    async prompt(input: {
      sessionId: string
      text: string
      onChunk?: (text: string) => void
      timeoutMs?: number
    }): Promise<AcpPromptResult | Error> {
      if (typeof input.sessionId !== 'string' || !input.sessionId) {
        return new ConfigError({ reason: 'ACP prompt needs a session ID' })
      }
      if (typeof input.text !== 'string') return new ConfigError({ reason: 'ACP prompt text must be a string' })
      if (input.timeoutMs !== undefined && !(Number.isFinite(input.timeoutMs) && input.timeoutMs > 0)) {
        return new ConfigError({ reason: 'ACP prompt timeout must be a positive number of milliseconds' })
      }
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
      const state: PromptState = { sessionId: input.sessionId, text: '', updateCount: 0 }
      if (input.onChunk) state.onChunk = input.onChunk
      const frame = await request(
        'session/prompt',
        { sessionId: input.sessionId, prompt: [{ type: 'text', text: input.text }] },
        timeoutMs,
        state,
      )
      if (frame instanceof Error) return frame
      const stopReason = typeof frame.result?.stopReason === 'string' ? frame.result.stopReason : 'end_turn'
      const result: AcpPromptResult = { stopReason, text: state.text, updateCount: state.updateCount }
      const usage = record(frame.result?.usage)
      if (usage) {
        result.usage = {
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
          totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
        }
      }
      return result
    },

    async cancel(input: { sessionId: string }): Promise<Error | undefined> {
      if (typeof input.sessionId !== 'string' || !input.sessionId) {
        return new ConfigError({ reason: 'ACP cancel needs a session ID' })
      }
      const blocked = unavailable()
      if (blocked) return blocked
      try {
        writeFrame(child!.stdin!, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: input.sessionId } })
      } catch (cause) {
        return new ConfigError({ reason: 'Could not write to the ACP agent process', cause })
      }
      return undefined
    },

    close(): Promise<void> {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closed = true
        failAll(new ConfigError({ reason: 'The ACP client was closed' }))
        lines?.close()
        const proc = child
        if (!proc || exited) return
        const done = new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) {
            resolve()
            return
          }
          proc.once('close', () => resolve())
        })
        try {
          proc.stdin?.end()
        } catch {
          // The child may already be gone.
        }
        try {
          proc.kill()
        } catch {
          // Already exited.
        }
        const hardDeadline = new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(true), CLOSE_GRACE_MS).unref?.()
        })
        if (await Promise.race([done.then(() => false), hardDeadline])) {
          try {
            proc.kill('SIGKILL')
          } catch {
            // Nothing left to kill.
          }
          await Promise.race([
            done,
            new Promise<void>((resolve) => {
              setTimeout(resolve, CLOSE_GRACE_MS).unref?.()
            }),
          ])
        }
      })()
      return closePromise
    },
  }
}
