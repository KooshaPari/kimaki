// Admission of a real process enumeration into `ops discover`. The discovery
// inventory says which sessions exist; this module observes the host's real
// process table ONCE and reports how the discovered pids compare with it.
// Sessions that carry no pid metadata get `countsAgree: null` with a named
// reason. A null verdict is never presented as agreement.
import { ConfigError } from '../../errors.js'
import {
  reconcileDiscovery,
  type ProcessIdentity,
  type ProcessOracle,
} from './process-oracle.js'

export type DiscoveryProcessEntry = {
  sessionId: string
  // Metadata only. `null` records a session whose process identity is unknown.
  process: ProcessIdentity | null
}

export type IdentityDisagreement = {
  sessionId: string
  pid: number
  reason: string
}

export type DiscoveryProcessAgreement = {
  // Live processes observed for the recorded pids. `null` when no enumeration
  // ran because the inventory held no pid metadata at all.
  observedProcessCount: number | null
  discoveredWithPid: number
  discoveredWithoutPid: number
  // `null` means "not comparable", never "agrees".
  countsAgree: boolean | null
  countsReason: string
  // Pids that the one live enumeration did not see, plus pids claimed by more
  // than one discovered session.
  disagreeingPids: number[]
  disagreeingSessions: IdentityDisagreement[]
  // Alive pids whose identity could not be confirmed (missing or different
  // birth marker). The count can agree while identity does not.
  unverifiedSessions: IdentityDisagreement[]
  oracle: { source: string; coverage: string; observedAt: number } | null
}

export function noPidMetadataAgreement(source: string, discovered: number): DiscoveryProcessAgreement {
  return {
    observedProcessCount: null,
    discoveredWithPid: 0,
    discoveredWithoutPid: discovered,
    countsAgree: null,
    countsReason: `${source} discovery supplied no pid metadata for any of its ${discovered} session(s), so no live process enumeration can be compared; countsAgree is null, not true`,
    disagreeingPids: [],
    disagreeingSessions: [],
    unverifiedSessions: [],
    oracle: null,
  }
}

/**
 * Compare discovered sessions with one real enumeration of the host process
 * table. The oracle is always called exactly once, scoped to the recorded pids.
 */
export async function compareDiscoveredProcesses({
  source,
  entries,
  oracle,
}: {
  source: string
  entries: DiscoveryProcessEntry[]
  oracle: ProcessOracle
}): Promise<DiscoveryProcessAgreement | ConfigError> {
  const withPid = entries.filter((entry): entry is { sessionId: string; process: ProcessIdentity } => entry.process !== null)
  const discoveredWithoutPid = entries.length - withPid.length
  if (withPid.length === 0) return noPidMetadataAgreement(source, entries.length)

  const pids = [...new Set(withPid.map((entry) => entry.process.pid))]
  const snapshot = await oracle.snapshot({ pids })
  if (snapshot instanceof Error) return snapshot

  const reconciliation = reconcileDiscovery({
    inventory: { source: `discovery:${source}`, observedAt: Date.now(), entries: withPid },
    snapshot,
  })
  if (reconciliation instanceof Error) return reconciliation

  const claimed = new Map<number, string[]>()
  for (const entry of withPid) {
    claimed.set(entry.process.pid, [...(claimed.get(entry.process.pid) ?? []), entry.sessionId])
  }
  const duplicated = [...claimed.entries()].filter(([, sessions]) => sessions.length > 1)

  const disagreeingSessions: IdentityDisagreement[] = []
  const unverifiedSessions: IdentityDisagreement[] = []
  for (const match of reconciliation.matches) {
    if (match.kind === 'missing-process') {
      disagreeingSessions.push({ sessionId: match.sessionId, pid: match.pid, reason: match.reason })
    } else if ((match.kind === 'reused' || match.kind === 'unknown') && match.pid !== null) {
      unverifiedSessions.push({ sessionId: match.sessionId, pid: match.pid, reason: match.reason })
    }
  }
  for (const [pid, sessions] of duplicated) {
    for (const sessionId of sessions) {
      const reason = `PID ${pid} is claimed by ${sessions.length} discovered sessions (${sessions.join(', ')}); one pid cannot be two live sessions`
      disagreeingSessions.push({ sessionId, pid, reason })
    }
  }

  const disagreeingPids = [...new Set([
    ...reconciliation.matches
      .filter((match) => match.kind === 'missing-process')
      .map((match) => match.pid),
    ...duplicated.map(([pid]) => pid),
  ])].sort((left, right) => left - right)

  const countsAgree = reconciliation.countsAgree
  const oracleInfo = {
    source: snapshot.source,
    coverage: snapshot.coverage,
    observedAt: snapshot.observedAt,
  }
  const countsReason = countsAgree
    ? `${withPid.length} discovered session(s) with pid metadata were all observed in one live enumeration (${snapshot.source})${discoveredWithoutPid === 0 ? '' : `; ${discoveredWithoutPid} session(s) carry no pid metadata and were not compared`}`
    : `${snapshot.processes.length} of ${withPid.length} discovered session(s) with pid metadata have a live process in one enumeration (${snapshot.source}); disagreeing pid(s): ${disagreeingPids.join(', ') || 'none observed'}${discoveredWithoutPid === 0 ? '' : `; ${discoveredWithoutPid} session(s) carry no pid metadata and were not compared`}`

  return {
    observedProcessCount: snapshot.processes.length,
    discoveredWithPid: withPid.length,
    discoveredWithoutPid,
    countsAgree,
    countsReason,
    disagreeingPids,
    disagreeingSessions,
    unverifiedSessions,
    oracle: oracleInfo,
  }
}
