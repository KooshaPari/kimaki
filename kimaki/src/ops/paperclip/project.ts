// Pure projection of an explicitly enrolled session into the Paperclip entity
// that an observed external run needs: a stable entity id, an external
// reference the Paperclip side can key on, the observed native identity, and an
// explicit no-write policy. Nothing here is authenticated against a live
// Paperclip instance, and nothing is invented for an unenrolled session.
import { ConfigError } from '../../errors.js'
import type { SessionKey } from '../contracts.ts'
import { sessionKeyId } from '../registry.ts'
import type { PaperclipEnrollment } from './enrollment.ts'
import { verifyEnrollment } from './enrollment.ts'
import { derive, seal } from './seal.ts'

export type PaperclipObservedEntity = {
  kind: 'paperclip-observed-session'
  version: 1
  entityId: string
  externalRef: { system: 'kimaki'; enrollmentId: string; sessionId: string }
  ownership: 'external-observe'
  title: string
  observed: {
    hostId: string
    endpointId: string
    backendKind: string
    nativeSessionId: string
    runtimeVersion: string | null
    observedAt: string | null
    enrolledAt: string
  }
  policy: { mode: 'observe'; publication: 'none'; writes: false; dispatch: false }
  digest: string
}

type UnsealedEntity = Omit<PaperclipObservedEntity, 'digest'>

/** Fields this projection may derive from live session metadata. */
export const projectedMetadataFields = Object.freeze(['runtimeVersion', 'observedAt'] as const)

const recordOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const SESSION_FIELDS = ['hostId', 'endpointId', 'backendKind', 'nativeSessionId'] as const

// Fixed-order serialization. The digest covers exactly this text.
function content(entity: UnsealedEntity): Record<string, unknown> {
  return {
    kind: entity.kind,
    version: entity.version,
    entityId: entity.entityId,
    externalRef: {
      system: entity.externalRef.system,
      enrollmentId: entity.externalRef.enrollmentId,
      sessionId: entity.externalRef.sessionId,
    },
    ownership: entity.ownership,
    title: entity.title,
    observed: {
      hostId: entity.observed.hostId,
      endpointId: entity.observed.endpointId,
      backendKind: entity.observed.backendKind,
      nativeSessionId: entity.observed.nativeSessionId,
      runtimeVersion: entity.observed.runtimeVersion,
      observedAt: entity.observed.observedAt,
      enrolledAt: entity.observed.enrolledAt,
    },
    policy: {
      mode: entity.policy.mode,
      publication: entity.policy.publication,
      writes: entity.policy.writes,
      dispatch: entity.policy.dispatch,
    },
  }
}

export function entityDigest(entity: UnsealedEntity): string {
  return seal(content(entity))
}

/** Stable entity id: a function of the enrollment only, never of live metadata. */
export function entityIdFor(enrollmentId: string): string {
  return derive('pc_', ['paperclip-observed-session', enrollmentId])
}

function optionalTimestamp(value: unknown, field: string): string | null | ConfigError {
  if (value === undefined || value === null) return null
  if (!nonempty(value)) return new ConfigError({ reason: `Projection ${field} must be a nonblank string or null` })
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return new ConfigError({ reason: `Projection ${field} must be a canonical ISO 8601 timestamp` })
  }
  return value
}

/**
 * Project an enrolled session. Pure and idempotent: the same enrollment plus
 * the same metadata always yields a byte-identical entity, and changing only
 * `runtimeVersion` or `observedAt` changes only those derived fields.
 */
export function projectObservedSession(input: unknown): PaperclipObservedEntity | ConfigError {
  if (!recordOf(input)) return new ConfigError({ reason: 'Projection input must be an object' })

  const rawEnrollment = input['enrollment']
  if (rawEnrollment === undefined || rawEnrollment === null) {
    return new ConfigError({
      reason: 'Refusing to project a session with no explicit enrollment record; projection is derived only from an enrollment',
    })
  }
  const enrollment: PaperclipEnrollment | ConfigError = verifyEnrollment(rawEnrollment)
  if (enrollment instanceof ConfigError) return enrollment

  const rawSession = input['session']
  if (!recordOf(rawSession)) return new ConfigError({ reason: 'Projection session must be an object' })
  const session: SessionKey = {
    hostId: text(rawSession['hostId']),
    endpointId: text(rawSession['endpointId']),
    backendKind: text(rawSession['backendKind']),
    nativeSessionId: text(rawSession['nativeSessionId']),
  }
  for (const field of SESSION_FIELDS) {
    if (!session[field].trim()) return new ConfigError({ reason: `Projection session.${field} must be a nonblank string` })
  }

  const sessionId = sessionKeyId(session)
  if (sessionId instanceof ConfigError) return sessionId
  const enrolledSessionId = sessionKeyId(enrollment.session)
  if (enrolledSessionId instanceof ConfigError) return enrolledSessionId
  if (sessionId !== enrolledSessionId) {
    return new ConfigError({
      reason: `Session ${sessionId} is not the enrolled session ${enrolledSessionId}; refusing to project an unenrolled session`,
    })
  }

  const rawMetadata = input['metadata'] === undefined || input['metadata'] === null ? {} : input['metadata']
  if (!recordOf(rawMetadata)) return new ConfigError({ reason: 'Projection metadata must be an object' })
  const rawVersion = rawMetadata['runtimeVersion']
  if (rawVersion !== undefined && rawVersion !== null && !nonempty(rawVersion)) {
    return new ConfigError({ reason: 'Projection metadata.runtimeVersion must be a nonblank string or null' })
  }
  const runtimeVersion = nonempty(rawVersion) ? rawVersion : null
  const observedAt = optionalTimestamp(rawMetadata['observedAt'], 'metadata.observedAt')
  if (observedAt instanceof ConfigError) return observedAt

  const unsealed: UnsealedEntity = {
    kind: 'paperclip-observed-session',
    version: 1,
    entityId: entityIdFor(enrollment.enrollmentId),
    externalRef: { system: 'kimaki', enrollmentId: enrollment.enrollmentId, sessionId },
    ownership: 'external-observe',
    title: `Observed ${enrollment.session.backendKind} session ${enrollment.session.nativeSessionId} on ${enrollment.session.hostId}`,
    observed: {
      hostId: enrollment.session.hostId,
      endpointId: enrollment.session.endpointId,
      backendKind: enrollment.session.backendKind,
      nativeSessionId: enrollment.session.nativeSessionId,
      runtimeVersion,
      observedAt,
      enrolledAt: enrollment.createdAt,
    },
    policy: { mode: 'observe', publication: 'none', writes: false, dispatch: false },
  }
  return { ...unsealed, digest: entityDigest(unsealed) }
}
