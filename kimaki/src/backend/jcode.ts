// Jcode backend over ACP. One instance owns one ACP client and one session,
// mirroring how the OpenCode backend owns one service endpoint.
//
// `jcode acp` is the control surface: initialize, session/new, session/prompt
// and session/cancel, with session/update notifications streamed back. The
// transport lives in ./acp/client.ts; this module only owns backend state and
// fails closed by resolving an Error instead of throwing.

import { ConfigError } from '../errors.ts'
import { createAcpClient } from './acp/client.ts'
import type { AcpClient, AcpClientOptions, CreateAcpClient, CreateJcodeBackend, JcodeBackend } from './acp/contracts.ts'

const TOOL_PROFILES = ['none', 'minimal', 'full'] as const

const CAPABILITIES: JcodeBackend['capabilities'] = {
  prompt: true,
  streaming: true,
  cancel: true,
  replay: false,
  exclusiveControl: false,
}

export const createJcodeBackend: CreateJcodeBackend = (input) => {
  const binary = input.binary ?? 'jcode'
  const toolProfile = input.toolProfile ?? 'none'
  const configuredModel = input.model
  const createClient: CreateAcpClient = input.createClient ?? createAcpClient

  // Invalid startup configuration is an Error the first start resolves, never a throw.
  const configError: Error | null = (() => {
    if (!input.cwd?.trim()) return new ConfigError({ reason: 'Jcode backend needs an explicit working directory (cwd)' })
    if (!TOOL_PROFILES.includes(toolProfile)) return new ConfigError({ reason: 'Jcode tool profile must be none, minimal or full' })
    if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)) {
      return new ConfigError({ reason: 'Jcode timeoutMs must be a positive integer in milliseconds' })
    }
    return null
  })()

  let client: AcpClient | null = null
  let clientError: Error | null = configError
  // The started session and the model selected for it over ACP.
  let started: { sessionId: string; model: string | null } | null = null
  let starting: Promise<{ sessionId: string; model: string | null } | Error> | null = null
  let closed = false

  const options = (): AcpClientOptions => ({
    command: binary,
    args: ['acp', '--tool-profile', toolProfile],
    cwd: input.cwd,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })

  const ensureClient = (): AcpClient | Error => {
    if (client) return client
    if (clientError) return clientError
    try {
      client = createClient(options())
    } catch (cause) {
      clientError = new ConfigError({ reason: `Cannot create the Jcode ACP client for ${binary}`, cause })
      return clientError
    }
    if (!client) {
      clientError = new ConfigError({ reason: `Cannot create the Jcode ACP client for ${binary}` })
      return clientError
    }
    return client
  }

  // A transport that misbehaves becomes an Error result rather than an exception.
  const attempt = async <T>(run: () => Promise<T>, reason: string): Promise<T | Error> => {
    try {
      return await run()
    } catch (cause) {
      return new ConfigError({ reason, cause })
    }
  }

  const start = async (startInput?: { model?: string }): Promise<{ sessionId: string; model: string | null } | Error> => {
    if (closed) return new ConfigError({ reason: 'Jcode backend is closed' })
    if (started) return started
    if (starting) return starting
    const requestedModel = startInput?.model ?? configuredModel
    if (requestedModel !== undefined && !requestedModel.trim()) {
      return new ConfigError({ reason: 'Jcode model must be a non-empty model ID' })
    }
    starting = (async () => {
      const acp = ensureClient()
      if (acp instanceof Error) return acp
      const initialized = await attempt(() => acp.initialize(), 'Jcode ACP initialize failed')
      if (initialized instanceof Error) return initialized
      const session = await attempt(() => acp.newSession({ cwd: input.cwd }), 'Jcode ACP session/new failed')
      if (session instanceof Error) return session
      if (!session.sessionId?.trim()) return new ConfigError({ reason: 'Jcode returned an empty ACP session ID' })
      // The agent keeps its own default model unless one is selected here.
      let model: string | null = null
      if (requestedModel !== undefined) {
        const selected = await attempt(
          () => acp.setModel({ sessionId: session.sessionId, model: requestedModel }),
          'Jcode ACP session/set_config_option failed',
        )
        if (selected instanceof Error) return selected
        model = selected.model
      }
      started = { sessionId: session.sessionId, model }
      return started
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  const prompt = async (text: string, onChunk?: (text: string) => void) => {
    if (closed) return new ConfigError({ reason: 'Jcode backend is closed' })
    if (!started) return new ConfigError({ reason: 'Jcode backend is not started. Call start() first' })
    const acp = ensureClient()
    if (acp instanceof Error) return acp
    const id = started.sessionId
    return attempt(
      () => acp.prompt({
        sessionId: id,
        text,
        ...(onChunk === undefined ? {} : { onChunk }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      }),
      'Jcode ACP session/prompt failed',
    )
  }

  const cancel = async (): Promise<Error | undefined> => {
    if (closed) return new ConfigError({ reason: 'Jcode backend is closed' })
    if (!started) return new ConfigError({ reason: 'Jcode backend is not started. Call start() first' })
    const acp = ensureClient()
    if (acp instanceof Error) return acp
    try {
      return await acp.cancel({ sessionId: started.sessionId })
    } catch (cause) {
      return new ConfigError({ reason: 'Jcode ACP session/cancel failed', cause })
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    started = null
    const acp = client
    client = null
    if (!acp) return
    try {
      await acp.close()
    } catch {
      // Close is best effort: the process may already be gone.
    }
  }

  return {
    capabilities: CAPABILITIES,
    sessionId: () => started?.sessionId ?? null,
    start,
    prompt,
    cancel,
    close,
  }
}
