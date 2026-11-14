// Shared contracts for the Jcode backend over ACP.
//
// `jcode acp` is an Agent Client Protocol adapter backed by the Jcode daemon, so
// ACP is the control surface: initialize, session/new, session/prompt and
// session/cancel, with session/update notifications streamed back. That makes
// Jcode a real backend rather than an observation source.
//
// These types are the seam between the transport (client.ts), the backend
// adapter (../jcode.ts), the CLI and the acceptance test. Keep them stable.

/** One decoded JSON-RPC frame from the agent. */
export type AcpFrame = {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string; data?: unknown }
}

/** A `session/update` payload, narrowed to what a chat client needs. */
export type AcpSessionUpdate = {
  sessionUpdate: string
  content?: { type?: string; text?: string }
  [key: string]: unknown
}

export type AcpClientOptions = {
  /** Executable to spawn, resolved by the caller. */
  command: string
  /** Arguments that put the executable into ACP mode. */
  args: string[]
  /** Working directory for the agent process. */
  cwd?: string
  /** Explicit environment. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv
  /** Per-request deadline in milliseconds. Defaults to 30s for control frames. */
  timeoutMs?: number
}

export type AcpInitializeResult = {
  protocolVersion: number
  agentName: string | null
}

export type AcpPromptResult = {
  stopReason: string
  /** Concatenated assistant text, assembled from streamed chunks. */
  text: string
  /** Number of `session/update` notifications observed for this turn. */
  updateCount: number
  /** Token usage when the agent reports it on the prompt result. */
  usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
}

/**
 * One message replayed by `session/load`. jcode 0.99.1 emits
 * `user_message_chunk` for what the user typed in the native client and
 * `agent_message_chunk` for its reply, before the load response arrives.
 */
export type AcpHistoryMessage = {
  role: 'user' | 'agent'
  text: string
}

export type AcpLoadResult = {
  sessionId: string
  history: AcpHistoryMessage[]
  /** Model the loaded session is using, when the agent reports config options. */
  model: string | null
}

/**
 * Transport-level ACP client. Every method resolves an Error instead of
 * throwing, so callers can fail closed without try/catch.
 */
export type AcpClient = {
  initialize(): Promise<AcpInitializeResult | Error>
  newSession(input: { cwd: string }): Promise<{ sessionId: string } | Error>
  /**
   * Select the session model. Verified against jcode 0.99.1: the agent accepts
   * `session/set_config_option {sessionId, configId: 'model', value}` and echoes
   * the new selection in `configOptions`, also emitting a `config_option_update`.
   * Without this the session keeps the model from the agent's own config.
   */
  setModel(input: { sessionId: string; model: string }): Promise<{ model: string } | Error>
  /**
   * Attach to an existing native session and receive its replayed history.
   * Verified against jcode 0.99.1: the agent replays the user's own prompts as
   * `user_message_chunk` and the replies as `agent_message_chunk` before it
   * answers `session/load`, which is the only native read path for input typed
   * outside kimaki.
   */
  loadSession(input: { sessionId: string; cwd: string }): Promise<AcpLoadResult | Error>
  prompt(input: {
    sessionId: string
    text: string
    /** Called for each assistant text chunk as it streams. */
    onChunk?: (text: string) => void
    timeoutMs?: number
  }): Promise<AcpPromptResult | Error>
  cancel(input: { sessionId: string }): Promise<Error | undefined>
  close(): Promise<void>
}

export type CreateAcpClient = (options: AcpClientOptions) => AcpClient

/**
 * Backend surface kimaki exposes for Jcode. One instance owns one ACP child
 * process and one session, mirroring how the OpenCode backend owns one service
 * endpoint.
 */
export type JcodeBackend = {
  capabilities: {
    prompt: true
    streaming: true
    cancel: true
    /** ACP is a control channel; it is not an event log. */
    replay: false
    /** Several clients may attach, but Jcode offers no exclusive writer lease. */
    exclusiveControl: false
  }
  /** ACP session ID once started, otherwise null. */
  sessionId(): string | null
  start(input?: { model?: string }): Promise<{ sessionId: string; model: string | null } | Error>
  prompt(text: string, onChunk?: (text: string) => void): Promise<AcpPromptResult | Error>
  cancel(): Promise<Error | undefined>
  close(): Promise<void>
}

export type CreateJcodeBackend = (input: {
  binary?: string
  cwd: string
  /** Model selected per session over ACP; without it the agent keeps its own default. */
  model?: string
  toolProfile?: 'none' | 'minimal' | 'full'
  timeoutMs?: number
  /** Test seam: replace the ACP client factory. */
  createClient?: CreateAcpClient
}) => JcodeBackend
