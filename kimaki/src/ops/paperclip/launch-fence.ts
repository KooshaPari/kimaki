// Launcher fence for one managed Paperclip run.
//
// Two independent launchers can try to own the same managed run: a session hub
// that already holds the backend writer lease, and a Paperclip-side launcher.
// The hub lease refuses a second hub; this record supplies the missing half: a
// Paperclip claim that names its launcher and refuses a competing one.
//
// This is a local metadata record, not a Paperclip API. It grants no dispatch,
// cancellation or remote write authority. Its only job is to make "who owns
// this run" explicit and checkable in both directions: a Paperclip claim is
// refused while the hub holds the run, and a superseded launcher's later writes
// are refused once someone else has taken the run over.
//
// Claim invariants:
// - one claim per (instanceId, runId)
// - generation and claimSeq are monotonic per run and never reset, so a
//   released run still hands out higher numbers than any prior owner saw
// - a live claim (heartbeat not yet expired) belongs to its holder alone
// - a claim whose heartbeat expired may be taken over, and the takeover bumps
//   the generation so the previous holder's writes are refused afterwards
// - release is holder-only and frees the run exactly once
import { ConfigError } from '../../errors.js'
import type { PaperclipLaunchClaim, Scope } from './launch-claim.js'
import {
  claimIsLive, holderText, identity, isoTimestamp, leaseMsOf, positiveInteger,
  runKey, scopeOf, sealClaim, verifyLaunchClaim, where,
} from './launch-claim.js'

/** What this fence does, and deliberately does not, grant. */
export const launchFenceCapabilities = Object.freeze({
  localClaimRecord: true,
  competingClaimRefusal: true,
  staleTakeover: true,
  hubLeaseCoordination: true,
  dispatch: false,
  cancellation: false,
  remoteWrite: false,
  inference: false,
} as const)

export type ClaimOutcome =
  | { kind: 'claimed' | 'unchanged'; record: PaperclipLaunchClaim }
  | ConfigError

export type ReleaseOutcome =
  | { kind: 'released'; record: PaperclipLaunchClaim }
  | ConfigError

export type WriteOutcome =
  | { kind: 'authorized'; record: PaperclipLaunchClaim }
  | ConfigError

function expiryFrom(at: string, leaseMs: number): string {
  return new Date(Date.parse(at) + leaseMs).toISOString()
}

/**
 * Claim a run for one launcher.
 *
 * - no claim, or a released run: a fresh claim at the next generation/counter
 * - a live claim by the same launcher: unchanged, so a retry is idempotent
 * - a live claim by anyone else: refused, naming the current holder
 * - an expired claim: taken over, generation and claimSeq advanced by one
 * - a hub holder that is not this launcher: refused before any claim is made
 *
 * `floor` carries the highest generation/counter ever issued for the run, so a
 * released run cannot hand out numbers a prior holder already used.
 */
export function claimLaunch(input: {
  scope: unknown
  launcher: unknown
  at: unknown
  leaseMs?: number | undefined
  hubHolder?: string | undefined
  existing?: unknown
  floor?: { generation: number; claimSeq: number } | undefined
}): ClaimOutcome {
  const scope = scopeOf(input.scope)
  if (scope instanceof ConfigError) return scope
  const launcher = identity(input.launcher, 'launcher')
  if (launcher instanceof ConfigError) return launcher
  const at = isoTimestamp(input.at, 'at')
  if (at instanceof ConfigError) return at
  const leaseMs = leaseMsOf(input.leaseMs)
  if (leaseMs instanceof ConfigError) return leaseMs

  // The hub lease is the other half of the fence. A hub holder that is not this
  // launcher already owns the run; Paperclip does not get to claim over it.
  if (input.hubHolder !== undefined) {
    const hubHolder = identity(input.hubHolder, 'hubHolder')
    if (hubHolder instanceof ConfigError) return hubHolder
    if (hubHolder !== launcher) {
      return new ConfigError({
        reason: `Hub launcher ${hubHolder} already holds ${where(scope)}; refusing to claim it for launcher ${launcher}`,
      })
    }
  }

  let existing: PaperclipLaunchClaim | undefined
  if (input.existing !== undefined && input.existing !== null) {
    const verified = verifyLaunchClaim(input.existing)
    if (verified instanceof ConfigError) return verified
    if (verified.instanceId !== scope.instanceId || verified.runId !== scope.runId) {
      return new ConfigError({
        reason: `Existing launch claim belongs to ${where({
          instanceId: verified.instanceId, runId: verified.runId,
        })}, not ${where(scope)}`,
      })
    }
    existing = verified
  }

  const floorGeneration = input.floor?.generation ?? 0
  const floorSeq = input.floor?.claimSeq ?? 0
  if (!Number.isSafeInteger(floorGeneration) || floorGeneration < 0 ||
      !Number.isSafeInteger(floorSeq) || floorSeq < 0) {
    return new ConfigError({ reason: 'Launch floor must hold nonnegative safe integers' })
  }

  if (existing !== undefined) {
    if (claimIsLive(existing, at)) {
      if (existing.launcher === launcher) return { kind: 'unchanged', record: existing }
      return new ConfigError({
        reason: `${where(scope)} is already claimed by ${holderText(existing)}; launcher ${launcher} cannot claim it`,
      })
    }
    // Expired heartbeat: takeover, with a generation bump that fences out the
    // previous holder. Idempotency comes from the live-same-launcher branch
    // above, so a retried claim after a successful takeover is unchanged.
    const generation = Math.max(existing.generation, floorGeneration) + 1
    const claimSeq = Math.max(existing.claimSeq, floorSeq) + 1
    return { kind: 'claimed', record: sealClaim(scope, launcher, generation, claimSeq, at, at, expiryFrom(at, leaseMs)) }
  }

  const generation = floorGeneration + 1
  const claimSeq = floorSeq + 1
  return { kind: 'claimed', record: sealClaim(scope, launcher, generation, claimSeq, at, at, expiryFrom(at, leaseMs)) }
}

/** Renew a claim this launcher still holds. A stale claim cannot be renewed. */
export function heartbeatLaunch(input: {
  scope: unknown
  launcher: unknown
  generation: unknown
  at: unknown
  leaseMs?: number | undefined
  existing?: unknown
}): ClaimOutcome {
  const scope = scopeOf(input.scope)
  if (scope instanceof ConfigError) return scope
  const launcher = identity(input.launcher, 'launcher')
  if (launcher instanceof ConfigError) return launcher
  const generation = positiveInteger(input.generation, 'generation')
  if (generation instanceof ConfigError) return generation
  const at = isoTimestamp(input.at, 'at')
  if (at instanceof ConfigError) return at
  const leaseMs = leaseMsOf(input.leaseMs)
  if (leaseMs instanceof ConfigError) return leaseMs

  const verified = verifyLaunchClaim(input.existing)
  if (verified instanceof ConfigError) return verified
  if (verified.instanceId !== scope.instanceId || verified.runId !== scope.runId) {
    return new ConfigError({ reason: `Launch claim belongs to a different run than ${where(scope)}` })
  }
  if (verified.launcher !== launcher || verified.generation !== generation) {
    return new ConfigError({
      reason: `${where(scope)} is claimed by ${holderText(verified)}; launcher ${launcher} at generation ${generation} cannot renew it`,
    })
  }
  if (!claimIsLive(verified, at)) {
    return new ConfigError({
      reason: `${where(scope)} claim held by ${holderText(verified)} has a stale heartbeat (expired ${verified.expiresAt}); it may be taken over and cannot be renewed`,
    })
  }
  const next = sealClaim(scope, launcher, verified.generation, verified.claimSeq, verified.acquiredAt, at,
    expiryFrom(at, leaseMs))
  return { kind: 'unchanged', record: next }
}

/** Holder-only release. The first release frees the run; a second one is refused. */
export function releaseLaunch(input: {
  scope: unknown
  launcher: unknown
  generation: unknown
  at: unknown
  existing?: unknown
}): ReleaseOutcome {
  const scope = scopeOf(input.scope)
  if (scope instanceof ConfigError) return scope
  const launcher = identity(input.launcher, 'launcher')
  if (launcher instanceof ConfigError) return launcher
  const generation = positiveInteger(input.generation, 'generation')
  if (generation instanceof ConfigError) return generation
  isoTimestamp(input.at, 'at') // validates and discards; release carries no time

  if (input.existing === undefined || input.existing === null) {
    return new ConfigError({ reason: `${where(scope)} is not claimed; launcher ${launcher} cannot release it` })
  }
  const verified = verifyLaunchClaim(input.existing)
  if (verified instanceof ConfigError) return verified
  if (verified.launcher !== launcher || verified.generation !== generation) {
    return new ConfigError({
      reason: `${where(scope)} is claimed by ${holderText(verified)}; launcher ${launcher} at generation ${generation} cannot release it`,
    })
  }
  return { kind: 'released', record: verified }
}

/**
 * Decide whether a launcher may write to a run. This is the fence that stops a
 * superseded launcher, and a hub writer that is not the current holder, from
 * writing quietly.
 */
export function authorizeLaunchWrite(input: {
  scope: unknown
  launcher: unknown
  generation: unknown
  at: unknown
  hubHolder?: string | undefined
  existing?: unknown
}): WriteOutcome {
  const scope = scopeOf(input.scope)
  if (scope instanceof ConfigError) return scope
  const launcher = identity(input.launcher, 'launcher')
  if (launcher instanceof ConfigError) return launcher
  const generation = positiveInteger(input.generation, 'generation')
  if (generation instanceof ConfigError) return generation
  const at = isoTimestamp(input.at, 'at')
  if (at instanceof ConfigError) return at

  if (input.hubHolder !== undefined) {
    const hubHolder = identity(input.hubHolder, 'hubHolder')
    if (hubHolder instanceof ConfigError) return hubHolder
    if (hubHolder !== launcher) {
      return new ConfigError({
        reason: `Hub launcher ${hubHolder} holds ${where(scope)}; launcher ${launcher} cannot write to it`,
      })
    }
  }

  if (input.existing === undefined || input.existing === null) {
    return new ConfigError({ reason: `${where(scope)} has no launcher claim; launcher ${launcher} cannot write to it` })
  }
  const verified = verifyLaunchClaim(input.existing)
  if (verified instanceof ConfigError) return verified
  if (verified.launcher !== launcher) {
    return new ConfigError({
      reason: `${where(scope)} is claimed by ${holderText(verified)}; launcher ${launcher} at generation ${generation} cannot write to it`,
    })
  }
  if (verified.generation !== generation) {
    return new ConfigError({
      reason: `${where(scope)} is claimed by ${holderText(verified)}; launcher ${launcher} at generation ${generation} was superseded and cannot write to it`,
    })
  }
  if (!claimIsLive(verified, at)) {
    return new ConfigError({
      reason: `${where(scope)} claim held by ${holderText(verified)} has a stale heartbeat (expired ${verified.expiresAt}); launcher ${launcher} cannot write to it`,
    })
  }
  return { kind: 'authorized', record: verified }
}

export type LaunchFence = {
  claim(input: { scope: unknown; launcher: unknown; hubHolder?: string | undefined }): ClaimOutcome
  heartbeat(input: { scope: unknown; launcher: unknown; generation: unknown }): ClaimOutcome
  release(input: { scope: unknown; launcher: unknown; generation: unknown }): ReleaseOutcome
  authorizeWrite(input: {
    scope: unknown
    launcher: unknown
    generation: unknown
    hubHolder?: string | undefined
  }): WriteOutcome
  inspect(scope: unknown): PaperclipLaunchClaim | undefined | ConfigError
  records(): PaperclipLaunchClaim[]
}

/**
 * Stateful wrapper over the pure rules. Records stay plain JSON, the same
 * metadata-only shape as the other Paperclip records, so a caller can persist
 * and re-seed them. `now` is injectable so expiry is testable without sleeping.
 */
export function createLaunchFence(options: {
  leaseMs?: number | undefined
  now?: (() => Date) | undefined
  records?: readonly unknown[] | undefined
} = {}): LaunchFence | ConfigError {
  const leaseMs = leaseMsOf(options.leaseMs)
  if (leaseMs instanceof ConfigError) return leaseMs
  const clock = options.now ?? (() => new Date())

  const at = (): string | ConfigError => {
    const value = clock()
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      return new ConfigError({ reason: 'Launch fence clock returned an invalid date' })
    }
    return value.toISOString()
  }

  const claims = new Map<string, PaperclipLaunchClaim>()
  const retired = new Map<string, { generation: number; claimSeq: number }>()

  for (const seed of options.records ?? []) {
    const verified = verifyLaunchClaim(seed)
    if (verified instanceof ConfigError) return verified
    claims.set(runKey(verified), verified)
  }

  const lookup = (scope: Scope): PaperclipLaunchClaim | undefined => claims.get(runKey(scope))

  const claim: LaunchFence['claim'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    const outcome = claimLaunch({
      scope, launcher: input.launcher, at: now, leaseMs, hubHolder: input.hubHolder,
      existing: lookup(scope), floor: retired.get(runKey(scope)),
    })
    if (outcome instanceof ConfigError) return outcome
    claims.set(runKey(scope), outcome.record)
    return outcome
  }

  const heartbeat: LaunchFence['heartbeat'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    const existing = lookup(scope)
    if (existing === undefined) {
      return new ConfigError({ reason: `${where(scope)} has no launcher claim to renew` })
    }
    const outcome = heartbeatLaunch({
      scope, launcher: input.launcher, generation: input.generation, at: now, leaseMs, existing,
    })
    if (outcome instanceof ConfigError) return outcome
    claims.set(runKey(scope), outcome.record)
    return outcome
  }

  const release: LaunchFence['release'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    const outcome = releaseLaunch({
      scope, launcher: input.launcher, generation: input.generation, at: now, existing: lookup(scope),
    })
    if (outcome instanceof ConfigError) return outcome
    // Free the run exactly once; the counters survive so numbers never repeat.
    claims.delete(runKey(scope))
    retired.set(runKey(scope), { generation: outcome.record.generation, claimSeq: outcome.record.claimSeq })
    return outcome
  }

  const authorizeWrite: LaunchFence['authorizeWrite'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    return authorizeLaunchWrite({
      scope, launcher: input.launcher, generation: input.generation, at: now,
      hubHolder: input.hubHolder, existing: lookup(scope),
    })
  }

  const inspect: LaunchFence['inspect'] = (scope) => {
    const parsed = scopeOf(scope)
    if (parsed instanceof ConfigError) return parsed
    return lookup(parsed)
  }

  const records = (): PaperclipLaunchClaim[] => [...claims.values()]

  return { claim, heartbeat, release, authorizeWrite, inspect, records }
}
