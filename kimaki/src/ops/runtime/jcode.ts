// ACP initialization is caller-owned. This adapter never launches Jcode, reads
// credentials, resumes sessions, or falls back to the user's shared daemon.
import { ConfigError } from '../../errors.js'
import { passiveCapabilities, sessionKeyId } from '../registry.js'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createJcodeObserver({ hostId, endpointId, initialize }: {
  hostId: string
  endpointId: string
  initialize: unknown
  // Reserved for a qualified, caller-owned ACP transport. Never invoked until
  // Jcode exposes and we qualify a passive session-list contract.
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}) {
  const valid = sessionKeyId({ hostId, endpointId, backendKind: 'jcode', nativeSessionId: 'validation' })
  if (valid instanceof Error) return valid
  if (!record(initialize) || !record(initialize.agentInfo) || initialize.agentInfo.name !== 'jcode' || typeof initialize.agentInfo.version !== 'string' || !initialize.agentInfo.version.trim()) {
    return new ConfigError({ reason: 'An initialized Jcode ACP connection with a valid agent identity is required' })
  }
  const reason = 'Jcode ACP session listing is not qualified for passive discovery'
  return {
    capabilities: {
      ...passiveCapabilities,
      discovery: { kind: 'unsupported' as const, reason },
      snapshot: { kind: 'unsupported' as const, reason: 'No passive session snapshot is qualified' },
      observe: { kind: 'unsupported' as const, reason: 'ACP resume does not establish a qualified passive live attachment' },
      replay: { kind: 'unsupported' as const, reason: 'No durable event cursor is qualified' },
      exclusiveControl: { kind: 'unsupported' as const, reason: 'No exclusive writer lease is established' },
    },
    async discover() { return new ConfigError({ reason }) },
  }
}
