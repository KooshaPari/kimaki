// Explicit enrollment of one observed session into the Paperclip surface.
//
// Enrollment is written only by an explicit operator action (`action: 'enroll'`
// supplied by a caller that names the session, its runtime, the surface, the
// mode and the publication policy). Merely observing a session never enrolls
// it. A record carries a content digest so tampering is detectable, and an
// existing binding is never replaced by different content.
import { ConfigError } from '../../errors.js'
import type { SessionKey } from '../contracts.ts'
import { derive, seal } from './seal.ts'

export type EnrollmentRuntime = {
  backendKind: string
  endpointId: string
  // Runtime version is optional metadata. It never widens authority.
  version: string | null
}

export type PaperclipEnrollment = {
  kind: 'paperclip-enrollment'
  version: 1
  enrollmentId: string
  session: SessionKey
  runtime: EnrollmentRuntime
  surface: 'paperclip'
  mode: 'observe'
  publication: 'none'
  createdAt: string
  digest: string
}

type UnsealedEnrollment = Omit<PaperclipEnrollment, 'digest'>

/** What an enrollment does, and deliberately does not, grant. */
export const enrollmentCapabilities = Object.freeze({
  observeMetadata: true,
  dispatch: false,
  approval: false,
  cancellation: false,
  publication: false,
  inference: false,
} as const)

const recordOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const SESSION_FIELDS = ['hostId', 'endpointId', 'backendKind', 'nativeSessionId'] as const
const TOP_FIELDS = ['kind', 'version', 'enrollmentId', 'surface', 'mode', 'publication', 'createdAt'] as const
const RUNTIME_FIELDS = ['backendKind', 'endpointId', 'version'] as const

// Fixed-order serialization. The digest covers exactly this text.
function content(record: UnsealedEnrollment): Record<string, unknown> {
  return {
    kind: record.kind,
    version: record.version,
    enrollmentId: record.enrollmentId,
    session: {
      hostId: record.session.hostId,
      endpointId: record.session.endpointId,
      backendKind: record.session.backendKind,
      nativeSessionId: record.session.nativeSessionId,
    },
    runtime: {
      backendKind: record.runtime.backendKind,
      endpointId: record.runtime.endpointId,
      version: record.runtime.version,
    },
    surface: record.surface,
    mode: record.mode,
    publication: record.publication,
    createdAt: record.createdAt,
  }
}

export function enrollmentDigest(record: UnsealedEnrollment): string {
  return seal(content(record))
}

/** Stable enrollment id for a binding. The same session always yields the same id. */
export function enrollmentIdFor(session: SessionKey): string {
  return derive('enr_', ['paperclip', session.hostId, session.endpointId, session.backendKind, session.nativeSessionId])
}

function isoTimestamp(value: unknown, field: string): string | ConfigError {
  if (!nonempty(value)) {
    return new ConfigError({ reason: `Enrollment ${field} must be an explicit ISO 8601 timestamp supplied by the operator action` })
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return new ConfigError({ reason: `Enrollment ${field} must be a canonical ISO 8601 timestamp such as 2026-11-14T21:00:00.000Z` })
  }
  return value
}

// Validate the record shape and refuse any authority-widening value by field.
function shape(input: Record<string, unknown>): UnsealedEnrollment | ConfigError {
  const rawSession = input['session']
  if (!recordOf(rawSession)) return new ConfigError({ reason: 'Enrollment session must be an object' })
  const session: SessionKey = {
    hostId: text(rawSession['hostId']),
    endpointId: text(rawSession['endpointId']),
    backendKind: text(rawSession['backendKind']),
    nativeSessionId: text(rawSession['nativeSessionId']),
  }
  for (const field of SESSION_FIELDS) {
    if (!session[field].trim()) return new ConfigError({ reason: `Enrollment session.${field} must be a nonblank string` })
  }

  const rawRuntime = input['runtime']
  if (!recordOf(rawRuntime)) return new ConfigError({ reason: 'Enrollment runtime must be an object' })
  if (!nonempty(rawRuntime['backendKind'])) return new ConfigError({ reason: 'Enrollment runtime.backendKind must be a nonblank string' })
  if (!nonempty(rawRuntime['endpointId'])) return new ConfigError({ reason: 'Enrollment runtime.endpointId must be a nonblank string' })
  if (rawRuntime['backendKind'] !== session.backendKind) {
    return new ConfigError({ reason: 'Enrollment runtime.backendKind must match the enrolled session backendKind' })
  }
  if (rawRuntime['endpointId'] !== session.endpointId) {
    return new ConfigError({ reason: 'Enrollment runtime.endpointId must match the enrolled session endpointId' })
  }
  const rawVersion = rawRuntime['version']
  if (rawVersion !== undefined && rawVersion !== null && !nonempty(rawVersion)) {
    return new ConfigError({ reason: 'Enrollment runtime.version must be a nonblank string or null' })
  }

  if (input['surface'] !== 'paperclip') {
    return new ConfigError({ reason: `Enrollment surface must be paperclip; refusing to widen the enrolled surface to "${String(input['surface'])}"` })
  }
  if (input['mode'] !== 'observe') {
    return new ConfigError({ reason: `Enrollment mode must be observe; refusing to widen authority with mode "${String(input['mode'])}"` })
  }
  if (input['publication'] !== 'none') {
    return new ConfigError({ reason: `Enrollment publication must be none; refusing to widen authority with publication "${String(input['publication'])}"` })
  }

  const createdAt = isoTimestamp(input['createdAt'], 'createdAt')
  if (createdAt instanceof ConfigError) return createdAt

  return {
    kind: 'paperclip-enrollment',
    version: 1,
    enrollmentId: enrollmentIdFor(session),
    session,
    runtime: {
      backendKind: rawRuntime['backendKind'],
      endpointId: rawRuntime['endpointId'],
      version: nonempty(rawVersion) ? rawVersion : null,
    },
    surface: 'paperclip',
    mode: 'observe',
    publication: 'none',
    createdAt,
  }
}

/** Recompute the digest and refuse a record modified after it was written. */
export function verifyEnrollment(record: unknown): PaperclipEnrollment | ConfigError {
  if (!recordOf(record)) return new ConfigError({ reason: 'Enrollment record must be an object' })
  if (record['kind'] !== 'paperclip-enrollment' || record['version'] !== 1) {
    return new ConfigError({ reason: 'Enrollment record must be a version 1 paperclip-enrollment' })
  }
  const digest = record['digest']
  if (!nonempty(digest)) return new ConfigError({ reason: 'Enrollment record has no content digest' })
  const unsealed = shape(record)
  if (unsealed instanceof ConfigError) return unsealed
  if (digest !== enrollmentDigest(unsealed)) {
    return new ConfigError({
      reason: `Enrollment ${unsealed.enrollmentId} failed its content digest check; the record was modified after it was written`,
    })
  }
  return { ...unsealed, digest }
}

export type EnrollmentOutcome =
  | { kind: 'enrolled' | 'unchanged'; record: PaperclipEnrollment }
  | ConfigError

function firstDifference(a: PaperclipEnrollment, b: PaperclipEnrollment): string | null {
  for (const field of TOP_FIELDS) if (a[field] !== b[field]) return field
  for (const field of SESSION_FIELDS) if (a.session[field] !== b.session[field]) return `session.${field}`
  for (const field of RUNTIME_FIELDS) if (a.runtime[field] !== b.runtime[field]) return `runtime.${field}`
  return null
}

/**
 * The explicit enrollment action. This is the only way an enrollment record is
 * created: `action` must literally be `'enroll'`, so an observer that merely
 * saw a session cannot enroll it.
 */
export function enrollSession(input: unknown, existing: readonly unknown[] = []): EnrollmentOutcome {
  if (!recordOf(input)) return new ConfigError({ reason: 'Enrollment input must be an object' })
  if (input['action'] !== 'enroll') {
    return new ConfigError({
      reason: 'Explicit enrollment requires action "enroll". Observing a session never enrolls it',
    })
  }
  const unsealed = shape(input)
  if (unsealed instanceof ConfigError) return unsealed
  const candidate: PaperclipEnrollment = { ...unsealed, digest: enrollmentDigest(unsealed) }

  const duplicate = existing.find(
    (item) => recordOf(item) && item['enrollmentId'] === candidate.enrollmentId,
  )
  if (duplicate === undefined) return { kind: 'enrolled', record: candidate }

  const prior = verifyEnrollment(duplicate)
  if (prior instanceof ConfigError) return prior
  const differing = firstDifference(prior, candidate)
  if (differing !== null) {
    return new ConfigError({
      reason: `Enrollment ${candidate.enrollmentId} already exists with a different ${differing}; refusing to replace it`,
    })
  }
  return { kind: 'unchanged', record: candidate }
}
