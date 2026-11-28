// Jcode backend over ACP. One instance owns one ACP client and one session,
// mirroring how the OpenCode backend owns one service endpoint.
//
// `jcode acp` is the control surface: initialize, session/new, session/prompt
// and session/cancel, with session/update notifications streamed back. The
// transport lives in ./acp/client.ts; this module only owns backend state and
// fails closed by resolving an Error instead of throwing.

import { ConfigError } from '../errors.ts'
import type { RuntimeProfile } from '../ops/contracts.ts'
import { RUNTIME_PROFILE_IDS, RUNTIME_PROFILES, STOCK_JCODE_PROFILE } from '../ops/contracts.ts'
import { identityRefusal } from '../ops/identity.ts'
import { createAcpClient } from './acp/client.ts'
import type { AcpClient, AcpClientOptions, CreateAcpClient, CreateJcodeBackend, JcodeBackend } from './acp/contracts.ts'

const TOOL_PROFILES = ['none', 'minimal', 'full'] as const

/** Backend input plus the runtime identity it runs under. */
export type JcodeBackendInput = Parameters<CreateJcodeBackend>[0] & {
  /** RuntimeProfileId; defaults to the stock jcode profile. */
  profile?: string
  /** Explicit store; scopes the child environment to the profile's prefix. */
  store?: string
}

/** The backend plus the profile that resolved it, so callers can record provenance. */
export type JcodeBackendWithProfile = JcodeBackend & { readonly profile: RuntimeProfile | null }

const CAPABILITIES: JcodeBackend['capabilities'] = {
  prompt: true,
  streaming: true,
  cancel: true,
  replay: false,
  exclusiveControl: false,
}

// An omitted profile is stock jcode. An unknown one is a refusal, never a
// silent fallback to the stock binary.
const resolveProfile = (id: string | undefined): RuntimeProfile | ConfigError => {
  if (id === undefined) return STOCK_JCODE_PROFILE
  const profile = (RUNTIME_PROFILES as Record<string, RuntimeProfile | undefined>)[id]
  if (profile === undefined) {
    return new ConfigError({ reason: `Unknown runtime profile '${id}'. Expected one of: ${RUNTIME_PROFILE_IDS.join(', ')}` })
  }
  return profile
}

// The executable name without a directory, extension or version suffix.
const executableName = (path: string): string =>
  (path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|ps1)$/i, '')

const knownExecutable = (name: string): string | undefined =>
  Object.values(RUNTIME_PROFILES).find((profile) => profile.executable === name)?.executable

export const createJcodeBackend = (input: JcodeBackendInput): JcodeBackendWithProfile => {
  const resolution = resolveProfile(input.profile)
  const profile = resolution instanceof Error ? null : resolution
  const binary = (input.binary ?? profile?.executable ?? '').trim()
  const toolProfile = input.toolProfile ?? 'none'
  const configuredModel = input.model
  const createClient: CreateAcpClient = input.createClient ?? createAcpClient

  // Invalid startup configuration is an Error the first start resolves, never a throw.
  const configError: Error | null = (() => {
    if (resolution instanceof Error) return resolution
    if (!profile) return new ConfigError({ reason: 'A runtime profile is required' })
    if (!binary) {
      return new ConfigError({ reason: `Runtime profile ${profile.id} expects executable ${profile.executable}, but no executable was supplied` })
    }
    const named = executableName(binary)
    const other = knownExecutable(named)
    if (other !== undefined && other !== profile.executable) {
      return new ConfigError({
        reason: `Runtime profile ${profile.id} expects executable ${profile.executable}, but '${binary}' is the ${other} executable; refusing to route a ${profile.id} session through ${other}`,
      })
    }
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

  // The child environment is scoped to the resolved profile. A kcode profile
  // never inherits the stock runtime's home variable, and a jcode profile never
  // adopts KCode's.
  const options = (): AcpClientOptions => {
    const env = profile && input.store !== undefined
      ? { ...process.env, [`${profile.envPrefix}HOME`]: input.store }
      : undefined
    return {
      command: binary,
      args: ['acp', '--tool-profile', toolProfile],
      cwd: input.cwd,
      ...(env === undefined ? {} : { env }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }
  }

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
      // The peer's self-report is evidence, not authority. KCode claims `jcode`,
      // so the profile's expectation carries a fork requirement and a kcode
      // profile must observe a -k<digits> version segment or refuse. The label
      // never selects the executable and never falls back to the stock binary.
      const resolved = profile
      if (!resolved) return new ConfigError({ reason: 'A runtime profile is required' })
      const refusal = identityRefusal(
        resolved.expectedIdentity,
        { name: initialized.agentName, version: initialized.agentVersion },
        resolved.id,
      )
      if (refusal !== null) return new ConfigError({ reason: refusal })
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
    // Provenance: null only when the profile id itself was refused.
    profile,
    capabilities: CAPABILITIES,
    sessionId: () => started?.sessionId ?? null,
    start,
    prompt,
    cancel,
    close,
  }
}
