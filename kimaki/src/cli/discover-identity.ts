// CLI-facing half of the discovery process comparison. It reads the explicit
// pid map, builds the inventory from the page that was actually discovered and
// asks the real process oracle once. Help text and the human line live here so
// ops.ts only has to call one function per source.
import fs from 'node:fs/promises'
import { ConfigError } from '../errors.ts'
import {
  compareDiscoveredProcesses,
  noPidMetadataAgreement,
  type DiscoveryProcessAgreement,
  type DiscoveryProcessEntry,
} from '../ops/discovery/identity.ts'
import {
  createProcessOracle,
  type ProcessIdentity,
  type ProcessOracle,
} from '../ops/discovery/process-oracle.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function parsePidMapEntry(raw: unknown, where: string): ProcessIdentity | ConfigError {
  const record = isRecord(raw) ? raw : null
  const pid = typeof raw === 'number' ? raw : record?.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
    return new ConfigError({ reason: `${where} pid must be a positive integer` })
  }
  if (record === null) return { pid, birthMarker: null }
  const rawMarker = record.birthMarker
  if (rawMarker === undefined || rawMarker === null) return { pid, birthMarker: null }
  if (typeof rawMarker === 'number' && Number.isFinite(rawMarker)) return { pid, birthMarker: String(rawMarker) }
  if (typeof rawMarker === 'string' && rawMarker.trim()) return { pid, birthMarker: rawMarker.trim() }
  return new ConfigError({ reason: `${where} birthMarker must be a nonblank string, a finite number or null` })
}

/**
 * Parse an explicit pid map: a JSON object keyed by native session ID whose
 * values are a positive pid or `{ pid, birthMarker? }`. A pid alone is accepted
 * but its identity stays unverified without a birth marker.
 */
export function parsePidMap(text: string, label = '--pid-map'): Map<string, ProcessIdentity> | ConfigError {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return new ConfigError({ reason: `${label} is not valid JSON`, cause })
  }
  if (!isRecord(value)) {
    return new ConfigError({ reason: `${label} must be a JSON object mapping session IDs to a pid or {pid, birthMarker}` })
  }
  const map = new Map<string, ProcessIdentity>()
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!sessionId.trim()) return new ConfigError({ reason: `${label} has a blank session ID` })
    const parsed = parsePidMapEntry(raw, `${label} entry ${sessionId}`)
    if (parsed instanceof Error) return parsed
    map.set(sessionId, parsed)
  }
  return map
}

/**
 * Build the comparison inventory from the discovered page. A map entry naming a
 * session the page did not return is refused rather than silently dropped.
 */
export function discoveryEntries(
  sessionIds: string[],
  pidMap: Map<string, ProcessIdentity>,
  source: string,
): DiscoveryProcessEntry[] | ConfigError {
  const known = new Set(sessionIds)
  const unknown = [...pidMap.keys()].filter((sessionId) => !known.has(sessionId))
  if (unknown.length > 0) {
    return new ConfigError({ reason: `--pid-map names session(s) the ${source} page did not return: ${unknown.join(', ')}` })
  }
  return sessionIds.map((sessionId) => ({ sessionId, process: pidMap.get(sessionId) ?? null }))
}

export async function discoverIdentity({
  source,
  sessionIds,
  pidMapPath,
  oracle,
}: {
  source: string
  sessionIds: string[]
  pidMapPath?: string | undefined
  oracle?: ProcessOracle | undefined
}): Promise<DiscoveryProcessAgreement | ConfigError> {
  if (pidMapPath === undefined) return noPidMetadataAgreement(source, sessionIds.length)
  const text = await fs.readFile(pidMapPath, 'utf8').catch((cause) => new ConfigError({ reason: `Cannot read --pid-map ${pidMapPath}`, cause }))
  if (text instanceof Error) return text
  const pidMap = parsePidMap(text)
  if (pidMap instanceof Error) return pidMap
  const entries = discoveryEntries(sessionIds, pidMap, source)
  if (entries instanceof Error) return entries
  return compareDiscoveredProcesses({ source, entries, oracle: oracle ?? createProcessOracle({}) })
}

/** Human verdict beside the JSON document. A dead pid is named by session. */
export function discoverIdentityLine(source: string, agreement: DiscoveryProcessAgreement): string {
  const disagreeing = agreement.disagreeingSessions.length === 0
    ? 'none'
    : agreement.disagreeingSessions.map(({ sessionId, pid }) => `${sessionId}@${pid}`).join(',')
  return `${source} discovery identity: countsAgree=${String(agreement.countsAgree)} discoveredWithPid=${agreement.discoveredWithPid} discoveredWithoutPid=${agreement.discoveredWithoutPid} observedProcessCount=${String(agreement.observedProcessCount)} disagreeingPids=[${agreement.disagreeingPids.join(',')}] disagreeing=${disagreeing} (${agreement.countsReason})`
}
