import type { SessionKey } from './contracts.ts'
import type { OpenCodeObservedEvent } from './runtime/opencode.ts'

// In-memory evidence only, keyed by source and native aggregate within a
// session. High-water marks classify ordering, not proof of identical events,
// complete history, gap detection, persistence, replay or successful delivery.
export type SessionProjection = {
  session: SessionKey
  sources: { sourceId: string; aggregateId: string; sequence: number }[]
}

export type EventEnvelope = {
  session: SessionKey
  sourceId: string
  aggregateId: string
  sequence: number
  kind: 'observed'
}

export type ProjectionResult = {
  kind: 'applied' | 'duplicate' | 'out-of-order' | 'identity-mismatch' | 'invalid-evidence'
  state: SessionProjection
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const validSequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function createProjection(session: SessionKey): SessionProjection {
  return { session: { hostId: session.hostId, endpointId: session.endpointId, backendKind: session.backendKind, nativeSessionId: session.nativeSessionId }, sources: [] }
}

// Adapter output deliberately excludes event type, raw data, title, metadata,
// location, and timestamps. No native event without durable evidence is ordered.
export function fromOpenCodeObservedEvent(observed: OpenCodeObservedEvent):
  | { kind: 'converted'; event: EventEnvelope }
  | { kind: 'identity-mismatch' | 'unsupported-evidence' } {
  const { key, source, raw } = observed
  if (!key || !source || key.backendKind !== 'opencode' || source.backendKind !== 'opencode' || key.hostId !== source.hostId || key.endpointId !== source.endpointId || !validId(key.hostId) || !validId(key.endpointId) || !validId(key.nativeSessionId)) return { kind: 'identity-mismatch' }
  if (!raw || !raw.data || typeof raw.data !== 'object' || !('sessionID' in raw.data) || raw.data.sessionID !== key.nativeSessionId) return { kind: 'identity-mismatch' }
  if (observed.schemaVersion !== 1 || !('durable' in raw) || !raw.durable || !validId(raw.durable.aggregateID) || !validSequence(raw.durable.seq)) return { kind: 'unsupported-evidence' }
  return { kind: 'converted', event: { session: createProjection(key).session, sourceId: 'opencode', aggregateId: raw.durable.aggregateID, sequence: raw.durable.seq, kind: 'observed' } }
}

export function projectEvent(state: SessionProjection, event: EventEnvelope): ProjectionResult {
  const a = state.session
  const b = event.session
  if (!b || a.hostId !== b.hostId || a.endpointId !== b.endpointId || a.backendKind !== b.backendKind || a.nativeSessionId !== b.nativeSessionId) return { kind: 'identity-mismatch', state }
  if (!validId(event.sourceId) || !validId(event.aggregateId) || !validSequence(event.sequence) || event.kind !== 'observed') return { kind: 'invalid-evidence', state }
  const previous = state.sources.find((source) => source.sourceId === event.sourceId && source.aggregateId === event.aggregateId)
  if (previous && event.sequence <= previous.sequence) return { kind: event.sequence === previous.sequence ? 'duplicate' : 'out-of-order', state }
  const source = { sourceId: event.sourceId, aggregateId: event.aggregateId, sequence: event.sequence }
  return { kind: 'applied', state: { session: a, sources: previous ? state.sources.map((item) => item === previous ? source : item) : [...state.sources, source] } }
}
