// Durable launcher fence: the pure rules of launch-fence.ts over the row store.
//
// Same public surface and the same refusals as createLaunchFence(), but the
// record lives in kimaki.db, so two independent processes contend for one
// (instanceId, runId) claim. The store's UNIQUE index decides the winner when two
// launchers both see "no claim"; the loser re-reads and the pure rules refuse it
// by name. Takeovers and renewals are compare-and-set on the row just read, so a
// launcher that lost a race can never overwrite a newer claim.
import { ConfigError } from '../../errors.js'
import {
  claimLaunch, heartbeatLaunch, releaseLaunch, authorizeLaunchWrite,
  type ClaimOutcome, type ReleaseOutcome, type WriteOutcome,
} from './launch-fence.js'
import {
  type PaperclipLaunchClaim, type Scope,
  claimIsLive, leaseMsOf, scopeOf, verifyLaunchClaim, where,
} from './launch-claim.js'
import type { FenceRow, FenceStore } from './launch-fence-store.js'

export type DurableLaunchFence = {
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

// A contended claim re-reads a few times; more than this means the run is being
// churned by other launchers, which is reported rather than retried forever.
const ATTEMPTS = 5

function recordFromRow(row: FenceRow): PaperclipLaunchClaim | ConfigError {
  const verified = verifyLaunchClaim({
    kind: 'paperclip-launch-claim',
    version: 1,
    instanceId: row.instanceId,
    runId: row.runId,
    launcher: row.launcher,
    generation: row.generation,
    claimSeq: row.claimSeq,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    digest: row.digest,
  })
  if (verified instanceof ConfigError) return verified
  return verified
}

function rowFor(record: PaperclipLaunchClaim, state: FenceRow['state']): FenceRow {
  return {
    instanceId: record.instanceId,
    runId: record.runId,
    state,
    launcher: record.launcher,
    generation: record.generation,
    claimSeq: record.claimSeq,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
    digest: record.digest,
    updatedAt: Date.parse(record.heartbeatAt),
  }
}

export function createDurableLaunchFence(options: {
  store: FenceStore
  leaseMs?: number | undefined
  now?: (() => Date) | undefined
}): DurableLaunchFence | ConfigError {
  const store = options.store
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

  const current = (scope: Scope): FenceRow | undefined => store.read(scope)

  const claim: DurableLaunchFence['claim'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const row = current(scope)
      const existing = row !== undefined && row.state === 'claimed' ? recordFromRow(row) : undefined
      if (existing instanceof ConfigError) return existing
      const floor = row === undefined ? undefined : { generation: row.generation, claimSeq: row.claimSeq }
      const outcome = claimLaunch({
        scope, launcher: input.launcher, at: now, leaseMs, hubHolder: input.hubHolder, existing, floor,
      })
      if (outcome instanceof ConfigError) return outcome
      // A live claim by this launcher: nothing to write, and a retry stays idempotent.
      if (outcome.kind === 'unchanged') return outcome
      const next = rowFor(outcome.record, 'claimed')
      if (row === undefined) {
        // Both launchers read "no claim"; the UNIQUE index lets exactly one insert.
        if (store.insert(next) === 'inserted') return outcome
        continue
      }
      if (store.replace(row, next)) return outcome
      // The row moved between read and write: re-read and be refused or retry.
    }
    return new ConfigError({
      reason: `${where(scope)} changed under launcher ${String(input.launcher)} while claiming it; another process kept winning the race`,
    })
  }

  const heartbeat: DurableLaunchFence['heartbeat'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const row = current(scope)
      if (row === undefined || row.state !== 'claimed') {
        return new ConfigError({ reason: `${where(scope)} has no launcher claim to renew` })
      }
      const existing = recordFromRow(row)
      if (existing instanceof ConfigError) return existing
      const outcome = heartbeatLaunch({
        scope, launcher: input.launcher, generation: input.generation, at: now, leaseMs, existing,
      })
      if (outcome instanceof ConfigError) return outcome
      if (store.replace(row, rowFor(outcome.record, 'claimed'))) return outcome
    }
    return new ConfigError({
      reason: `${where(scope)} changed under launcher ${String(input.launcher)} while renewing it; another process kept winning the race`,
    })
  }

  const release: DurableLaunchFence['release'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const row = current(scope)
      const existing = row !== undefined && row.state === 'claimed' ? recordFromRow(row) : undefined
      if (existing instanceof ConfigError) return existing
      const outcome = releaseLaunch({
        scope, launcher: input.launcher, generation: input.generation, at: now, existing,
      })
      if (outcome instanceof ConfigError) return outcome
      if (row === undefined) return outcome
      // Keep the row as `released`: the counters survive so numbers never repeat.
      if (store.replace(row, rowFor(outcome.record, 'released'))) return outcome
    }
    return new ConfigError({
      reason: `${where(scope)} changed under launcher ${String(input.launcher)} while releasing it; another process kept winning the race`,
    })
  }

  const authorizeWrite: DurableLaunchFence['authorizeWrite'] = (input) => {
    const scope = scopeOf(input.scope)
    if (scope instanceof ConfigError) return scope
    const now = at()
    if (now instanceof ConfigError) return now
    const row = current(scope)
    const existing = row !== undefined && row.state === 'claimed' ? recordFromRow(row) : undefined
    if (existing instanceof ConfigError) return existing
    return authorizeLaunchWrite({
      scope, launcher: input.launcher, generation: input.generation, at: now,
      hubHolder: input.hubHolder, existing,
    })
  }

  const inspect: DurableLaunchFence['inspect'] = (scope) => {
    const parsed = scopeOf(scope)
    if (parsed instanceof ConfigError) return parsed
    const row = current(parsed)
    if (row === undefined || row.state !== 'claimed') return undefined
    return recordFromRow(row)
  }

  const records = (): PaperclipLaunchClaim[] => {
    const claims: PaperclipLaunchClaim[] = []
    for (const row of store.all()) {
      if (row.state !== 'claimed') continue
      const verified = recordFromRow(row)
      if (verified instanceof ConfigError) continue
      claims.push(verified)
    }
    return claims
  }

  return { claim, heartbeat, release, authorizeWrite, inspect, records }
}

/** A claim is live at `at`; exported so callers can reason about expiry. */
export function durableClaimIsLive(record: PaperclipLaunchClaim, at: string): boolean {
  return claimIsLive(record, at)
}
