import { ConfigError } from '../errors.js'
import type {
  DiscoveryObservation,
  PassiveCapabilities,
  ReconciledObservation,
  SessionKey,
} from './contracts.js'

export const passiveCapabilities: PassiveCapabilities = {
  version: 1,
  discovery: { kind: 'supported' },
  control: {
    create: { kind: 'unsupported', reason: 'Passive discovery cannot create sessions' },
    submit: { kind: 'unsupported', reason: 'Passive discovery cannot submit prompts' },
    interrupt: { kind: 'unsupported', reason: 'Passive discovery cannot interrupt sessions' },
    answerApproval: { kind: 'unsupported', reason: 'Passive discovery cannot answer approvals' },
  },
}

export function sessionKeyId(key: SessionKey): string | ConfigError {
  for (const field of ['hostId', 'endpointId', 'backendKind', 'nativeSessionId'] as const) {
    if (typeof key[field] !== 'string' || !key[field].trim()) {
      return new ConfigError({ reason: `Session identity ${field} must be a nonblank string` })
    }
  }
  // A fixed-position JSON tuple escapes delimiters and preserves exact native IDs.
  // Discovery evidence and process incarnation intentionally do not participate.
  return JSON.stringify([key.hostId, key.endpointId, key.backendKind, key.nativeSessionId])
}

export function reconcileObservation(
  observation: DiscoveryObservation,
): ReconciledObservation | ConfigError {
  for (const field of ['provider', 'hostId', 'endpointId', 'observationId'] as const) {
    if (typeof observation[field] !== 'string' || !observation[field].trim()) {
      return new ConfigError({ reason: `Discovery observation ${field} must be a nonblank string` })
    }
  }
  if (observation.nativeSession === null) {
    return {
      kind: 'unresolved',
      observation,
      reason: 'Native session identity is missing. Process or directory presence cannot resolve a session',
    }
  }
  const id = sessionKeyId(observation.nativeSession)
  if (id instanceof Error) return id
  if (observation.hostId !== observation.nativeSession.hostId) {
    return new ConfigError({ reason: 'Discovery hostId must match native session hostId' })
  }
  return { kind: 'resolved', key: observation.nativeSession, id, observation }
}
