// Record shape and validation for the Paperclip launcher fence.
//
// A fence record is metadata only. It names the launcher that owns a managed
// run and carries a content digest, so an edited generation or expiry is
// detectable. Nothing here talks to a Paperclip instance.
import { ConfigError } from '../../errors.js'
import { seal } from './seal.js'

export type PaperclipLaunchClaim = {
  kind: 'paperclip-launch-claim'
  version: 1
  instanceId: string
  runId: string
  launcher: string
  generation: number
  claimSeq: number
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  digest: string
}

export type UnsealedClaim = Omit<PaperclipLaunchClaim, 'digest'>

export type Scope = { instanceId: string; runId: string }

export const DEFAULT_LEASE_MS = 30_000

export const recordOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/** A canonical identity: nonblank and not padded, so two spellings never collide. */
export function identity(value: unknown, field: string): string | ConfigError {
  if (!nonempty(value)) return new ConfigError({ reason: `Launch ${field} must be a nonblank string` })
  if (value !== value.trim()) {
    return new ConfigError({ reason: `Launch ${field} must not have leading or trailing whitespace` })
  }
  return value
}

export function isoTimestamp(value: unknown, field: string): string | ConfigError {
  if (!nonempty(value) || value !== value.trim()) {
    return new ConfigError({ reason: `Launch ${field} must be an explicit ISO 8601 timestamp` })
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return new ConfigError({ reason: `Launch ${field} must be a canonical ISO 8601 timestamp such as 2026-11-14T21:00:00.000Z` })
  }
  return value
}

export function positiveInteger(value: unknown, field: string): number | ConfigError {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return new ConfigError({ reason: `Launch ${field} must be a positive safe integer` })
  }
  return value
}

export function leaseMsOf(value: unknown): number | ConfigError {
  if (value === undefined) return DEFAULT_LEASE_MS
  return positiveInteger(value, 'leaseMs')
}

export function scopeOf(value: unknown): Scope | ConfigError {
  if (!recordOf(value)) return new ConfigError({ reason: 'Launch scope must be an object with instanceId and runId' })
  const instanceId = identity(value['instanceId'], 'scope.instanceId')
  if (instanceId instanceof ConfigError) return instanceId
  const runId = identity(value['runId'], 'scope.runId')
  if (runId instanceof ConfigError) return runId
  return { instanceId, runId }
}

export function runKey(scope: Scope): string {
  return `${scope.instanceId}\u0000${scope.runId}`
}

/** Where a run is named in a refusal: readable and unambiguous. */
export function where(scope: Scope): string {
  return `run ${scope.runId} on instance ${scope.instanceId}`
}

export function holderText(record: PaperclipLaunchClaim): string {
  return `${record.launcher} (generation ${record.generation})`
}

// Fixed-order serialization. The digest covers exactly this text.
function claimContent(record: UnsealedClaim): Record<string, unknown> {
  return {
    kind: record.kind,
    version: record.version,
    instanceId: record.instanceId,
    runId: record.runId,
    launcher: record.launcher,
    generation: record.generation,
    claimSeq: record.claimSeq,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
  }
}

export function claimDigest(record: UnsealedClaim): string {
  return seal(claimContent(record))
}

/** Stable claim id for a run. It is not an ownership proof on its own. */
export function claimIdFor(scope: Scope): string {
  return seal({ instanceId: scope.instanceId, runId: scope.runId })
}

export function unsealedClaim(
  scope: Scope,
  launcher: string,
  generation: number,
  claimSeq: number,
  acquiredAt: string,
  heartbeatAt: string,
  expiresAt: string,
): UnsealedClaim {
  return {
    kind: 'paperclip-launch-claim',
    version: 1,
    instanceId: scope.instanceId,
    runId: scope.runId,
    launcher,
    generation,
    claimSeq,
    acquiredAt,
    heartbeatAt,
    expiresAt,
  }
}

export function sealClaim(scope: Scope, launcher: string, generation: number, claimSeq: number,
  acquiredAt: string, heartbeatAt: string, expiresAt: string): PaperclipLaunchClaim {
  const next = unsealedClaim(scope, launcher, generation, claimSeq, acquiredAt, heartbeatAt, expiresAt)
  return { ...next, digest: claimDigest(next) }
}

/**
 * Recompute the digest and refuse a record modified after it was written. An
 * edited generation or expiry is exactly the tamper this catches.
 */
export function verifyLaunchClaim(value: unknown): PaperclipLaunchClaim | ConfigError {
  if (!recordOf(value)) return new ConfigError({ reason: 'Launch claim record must be an object' })
  if (value['kind'] !== 'paperclip-launch-claim' || value['version'] !== 1) {
    return new ConfigError({ reason: 'Launch claim record must be a version 1 paperclip-launch-claim' })
  }
  const digest = value['digest']
  if (!nonempty(digest)) return new ConfigError({ reason: 'Launch claim record has no content digest' })

  const instanceId = identity(value['instanceId'], 'instanceId')
  if (instanceId instanceof ConfigError) return instanceId
  const runId = identity(value['runId'], 'runId')
  if (runId instanceof ConfigError) return runId
  const launcher = identity(value['launcher'], 'launcher')
  if (launcher instanceof ConfigError) return launcher
  const generation = positiveInteger(value['generation'], 'generation')
  if (generation instanceof ConfigError) return generation
  const claimSeq = positiveInteger(value['claimSeq'], 'claimSeq')
  if (claimSeq instanceof ConfigError) return claimSeq
  const acquiredAt = isoTimestamp(value['acquiredAt'], 'acquiredAt')
  if (acquiredAt instanceof ConfigError) return acquiredAt
  const heartbeatAt = isoTimestamp(value['heartbeatAt'], 'heartbeatAt')
  if (heartbeatAt instanceof ConfigError) return heartbeatAt
  const expiresAt = isoTimestamp(value['expiresAt'], 'expiresAt')
  if (expiresAt instanceof ConfigError) return expiresAt
  if (Date.parse(expiresAt) <= Date.parse(heartbeatAt)) {
    return new ConfigError({ reason: `Launch claim ${generation} must expire after its heartbeat` })
  }

  const candidate = unsealedClaim({ instanceId, runId }, launcher, generation, claimSeq, acquiredAt, heartbeatAt, expiresAt)
  if (digest !== claimDigest(candidate)) {
    return new ConfigError({
      reason: `Launch claim for ${where({ instanceId, runId })} failed its content digest check; the record was modified after it was written`,
    })
  }
  return { ...candidate, digest }
}

/** A claim's heartbeat has not yet expired at `at`. */
export function claimIsLive(record: PaperclipLaunchClaim, at: string): boolean {
  return Date.parse(at) < Date.parse(record.expiresAt)
}
