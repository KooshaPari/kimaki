// Passive metadata discovery over an explicitly supplied Jcode home. This reads
// session records but emits only an allowlisted identity and title. Transcripts,
// tool output, provider credentials and message bodies are never returned.
import { ConfigError } from '../../errors.js'
import type { RuntimeProfile, SessionKey } from '../contracts.js'
import { RUNTIME_PROFILE_IDS, RUNTIME_PROFILES, STOCK_JCODE_PROFILE } from '../contracts.js'
import { passiveCapabilities, sessionKeyId } from '../registry.js'

type NativeSession = { id: string; title: string | null; updatedAt: string | null; messageCount: number }

// Whether a read produced a trustworthy record. `consistent` means two
// independent reads agreed byte for byte and the bytes parsed to the requested
// session id. `transient` means the record was mid-write (torn, replaced or
// otherwise unparseable at that instant) and nothing about the session is
// claimed from it: a caller must not read a skipped transient as "no session".
export type JcodeObservationHealth = 'consistent' | 'transient'

// Bounded backoff between the two reads that confirm a record. A native turn
// appends to the same file, so the confirming read is what separates a settled
// record from one that is still being written.
const CONFIRM_DELAYS_MS = [1, 2, 4] as const

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type JcodeObservedEvent =
  | { schemaVersion: 1; key: SessionKey; seq: number; type: 'session.renamed'; title: string | null }
  | { schemaVersion: 1; key: SessionKey; seq: number; type: 'session.appended'; messageCount: number }

// The result of one consistency-checked read. Only `consistent` carries an
// identity or a title.
type ConsistentRead =
  | { health: 'consistent'; session: NativeSession }
  | { health: 'transient'; reason: string }
  | { health: 'missing' }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

// A profile is resolved before any store is read. An omitted profile is the
// stock jcode profile, an unknown one is a refusal rather than a fallback.
const resolveProfile = (id: string | undefined): RuntimeProfile | ConfigError => {
  if (id === undefined) return STOCK_JCODE_PROFILE
  const profile = (RUNTIME_PROFILES as Record<string, RuntimeProfile | undefined>)[id]
  if (profile === undefined) {
    return new ConfigError({ reason: `Unknown runtime profile '${id}'. Expected one of: ${RUNTIME_PROFILE_IDS.join(', ')}` })
  }
  return profile
}

const storeLeaf = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

// The store leaf names the runtime that wrote it. A profile must never read
// another runtime's store: KCode claims the jcode identity, so a `.jcode` store
// under a kcode profile would silently attribute KCode sessions to stock jcode.
const otherStoreLeaf = (profile: RuntimeProfile): string => (profile.id === 'kcode' ? '.jcode' : '.kcode')

// Resolve the store path against the profile. The path is always explicit; the
// profile decides which directory name is legitimate for this identity.
const resolveStore = (profile: RuntimeProfile, supplied: string | undefined): string | ConfigError => {
  const path = (supplied ?? '').trim()
  if (!path) {
    return new ConfigError({ reason: `Runtime profile ${profile.id} needs an explicit store (expected ${profile.storeDir})` })
  }
  const leaf = storeLeaf(path)
  const foreign = otherStoreLeaf(profile)
  if (leaf === foreign) {
    return new ConfigError({
      reason: `Runtime profile ${profile.id} expects store ${profile.storeDir}, but the supplied store ends in '${foreign}'; refusing to resolve a ${profile.id} session from the ${foreign} store`,
    })
  }
  return path
}

export function createJcodeObserver({ jcodeHome, store, profile: requestedProfile, hostId, endpointId, readFile, readDir, intervalMs = 500 }: {
  // Back-compat alias for `store`, kept because the CLI already passes it.
  jcodeHome?: string
  // Explicit store directory holding sessions/session_*.json.
  store?: string
  // RuntimeProfileId; defaults to the stock jcode profile.
  profile?: string
  hostId: string
  endpointId: string
  readFile: (path: string) => Promise<string>
  readDir: (path: string) => Promise<string[]>
  intervalMs?: number
}) {
  const resolution = resolveProfile(requestedProfile)
  if (resolution instanceof Error) return resolution
  const profile = resolution
  const valid = sessionKeyId({ hostId, endpointId, backendKind: 'jcode', nativeSessionId: 'validation' })
  if (valid instanceof Error) return valid
  const resolvedStore = resolveStore(profile, store ?? jcodeHome)
  if (resolvedStore instanceof Error) return resolvedStore
  // backendKind stays the ACP family label; profileId is the provenance that
  // distinguishes this KCode fork from stock jcode.
  const source = Object.freeze({ hostId, endpointId, backendKind: 'jcode' as const, profileId: profile.id })
  const sessionsDir = `${resolvedStore.replace(/[\\/]+$/, '')}/sessions`
  const fileFor = (id: string) => `${sessionsDir}/${id}.json`
  const reason = 'Jcode exposes no exclusive writer lease, so control is not offered'

  // Parse one session record and keep only allowlisted metadata.
  const parse = (raw: string): NativeSession | undefined => {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (!record(value) || typeof value.id !== 'string' || !value.id.trim()) return undefined
    const title = typeof value.title === 'string' && value.title.trim() ? value.title : null
    const updatedAt = typeof value.updated_at === 'string' && value.updated_at.trim() ? value.updated_at : null
    const messageCount = Array.isArray(value.messages) ? value.messages.length : 0
    return { id: value.id, title, updatedAt, messageCount }
  }

  const keyFor = (nativeSessionId: string): SessionKey => ({ hostId, endpointId, backendKind: 'jcode' as const, nativeSessionId })

  // Read a record only when it is provably settled. A single read can land in
  // the middle of an append or a replacement, so a candidate is accepted only
  // when a second read after a bounded backoff returns identical bytes, those
  // bytes parse completely, and the parsed id is the requested session. Any
  // other outcome is `transient` (or `missing` if the file never appeared), so a
  // torn record can never surface as a session, a key or a truncated title.
  const readConsistent = async (nativeSessionId: string): Promise<ConsistentRead> => {
    let last: 'missing' | 'unstable' | 'unparsable' | 'mismatch' = 'missing'
    for (const backoff of CONFIRM_DELAYS_MS) {
      const first = await readFile(fileFor(nativeSessionId)).catch(() => undefined)
      if (first === undefined) continue
      await wait(backoff)
      const second = await readFile(fileFor(nativeSessionId)).catch(() => undefined)
      if (second === undefined) {
        last = 'missing'
        continue
      }
      if (second !== first) {
        last = 'unstable'
        continue
      }
      const session = parse(first)
      if (!session) {
        last = 'unparsable'
        continue
      }
      if (session.id !== nativeSessionId) {
        last = 'mismatch'
        continue
      }
      return { health: 'consistent', session }
    }
    if (last === 'missing') return { health: 'missing' }
    return { health: 'transient', reason: last }
  }

  return {
    // Which profile resolved this store. Provenance for every page and snapshot.
    profile,
    capabilities: {
      ...passiveCapabilities,
      discovery: { kind: 'supported' as const },
      snapshot: { kind: 'supported' as const },
      observe: { kind: 'supported' as const },
      // Reads are consistency-checked: a torn record is reported transient and
      // skipped rather than being published as a session.
      consistency: {
        kind: 'supported' as const,
        description: 'A record is reported only when two reads separated by a bounded backoff agree and parse to the requested session id; a torn read is transient and never becomes a session or a title',
      },
      replay: { kind: 'unsupported' as const, reason: 'Jcode persists session state, not an event log, so missed changes cannot be replayed' },
      exclusiveControl: { kind: 'unsupported' as const, reason: 'No exclusive writer lease is established' },
    },
    async discover(input: { cursor?: string; limit?: number } = {}) {
      const names = await readDir(sessionsDir)
      const ids = names
        .filter((name) => name.startsWith('session_') && name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
      const parsed: NativeSession[] = []
      let skippedTransient = 0
      for (const id of ids) {
        const read = await readConsistent(id)
        if (read.health === 'consistent') parsed.push(read.session)
        else if (read.health === 'transient') skippedTransient += 1
      }
      // Newest first, with a stable tiebreak so pagination is deterministic.
      parsed.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id))
      const offset = input.cursor === undefined ? 0 : Number(input.cursor)
      if (!Number.isSafeInteger(offset) || offset < 0) return new ConfigError({ reason: 'Cursor must be a non-negative integer offset' })
      const limit = input.limit === undefined ? 50 : input.limit
      if (!Number.isSafeInteger(limit) || limit < 1) return new ConfigError({ reason: 'Limit must be a positive integer' })
      const page = parsed.slice(offset, offset + limit)
      const next = offset + page.length
      return {
        source,
        sessions: page.map((session) => ({ key: keyFor(session.id), title: session.title })),
        cursor: next < parsed.length ? String(next) : null,
        // Which health produced this page, and how many records were skipped as
        // transient rather than absent.
        observation: {
          health: (skippedTransient === 0 ? 'consistent' : 'transient') as JcodeObservationHealth,
          skippedTransient,
        },
      }
    },
    async readSnapshot({ key }: { key: SessionKey }) {
      const validKey = sessionKeyId(key)
      if (validKey instanceof Error) return validKey
      if (key.hostId !== hostId || key.endpointId !== endpointId || key.backendKind !== 'jcode') {
        return new ConfigError({ reason: 'Session identity does not match this Jcode endpoint' })
      }
      const nativeSessionId = key.nativeSessionId
      const read = await readConsistent(nativeSessionId)
      if (read.health === 'missing') return new ConfigError({ reason: 'Jcode session record is missing or unreadable' })
      if (read.health === 'transient') {
        // Distinct from missing: the record exists but was being written when it
        // was read, so no identity or title is claimed.
        return new ConfigError({
          reason: `Jcode session record read was transient (${read.reason}); the record was mid-write, so no session identity or title is claimed`,
        })
      }
      return { key: Object.freeze(keyFor(nativeSessionId)), source, session: { id: read.session.id, title: read.session.title } }
    },
    // Polling observation over the persisted record. Only counts and titles are
    // emitted. Nothing from messages, tool calls or paths is ever surfaced.
    async observe({ key, signal, onEvent, onHealth }: {
      key: SessionKey
      signal?: AbortSignal
      onEvent: (event: JcodeObservedEvent) => Promise<void> | void
      onHealth?: (health: JcodeObservationHealth) => void
    }) {
      const validKey = sessionKeyId(key)
      if (validKey instanceof Error) return validKey
      if (key.hostId !== hostId || key.endpointId !== endpointId || key.backendKind !== 'jcode') {
        return new ConfigError({ reason: 'Session identity does not match this Jcode endpoint' })
      }
      if (signal?.aborted) return new ConfigError({ reason: 'Observation already aborted' })
      const nativeSessionId = key.nativeSessionId
      const scopedKey = Object.freeze(keyFor(nativeSessionId))
      const first = await readConsistent(nativeSessionId)
      if (first.health === 'missing') return new ConfigError({ reason: 'Jcode session record is missing or unreadable' })
      let health: JcodeObservationHealth = first.health === 'consistent' ? 'consistent' : 'transient'
      const emitHealth = (next: JcodeObservationHealth) => {
        if (next === health) return
        health = next
        onHealth?.(next)
      }
      const initial = first.health === 'consistent' ? first.session : undefined
      let title = initial?.title ?? null
      let messageCount = initial?.messageCount ?? 0
      let seen = initial !== undefined
      let seq = 0
      let stopped = false
      const stop = () => { stopped = true }
      const onAbort = () => stop()
      signal?.addEventListener('abort', onAbort, { once: true })
      const run = async (): Promise<ConfigError | null> => {
        while (!stopped) {
          await wait(intervalMs)
          if (stopped) break
          const current = await readConsistent(nativeSessionId)
          // A torn or vanished record is skipped as transient; it never rewrites
          // the identity the observer already reported.
          if (current.health !== 'consistent') {
            emitHealth('transient')
            continue
          }
          emitHealth('consistent')
          if (!seen) {
            seen = true
            title = current.session.title
            messageCount = current.session.messageCount
            continue
          }
          if (current.session.title !== title) {
            title = current.session.title
            seq += 1
            await onEvent({ schemaVersion: 1, key: scopedKey, seq, type: 'session.renamed', title })
          }
          if (current.session.messageCount > messageCount) {
            messageCount = current.session.messageCount
            seq += 1
            await onEvent({ schemaVersion: 1, key: scopedKey, seq, type: 'session.appended', messageCount })
          }
        }
        return null
      }
      return {
        detach: stop,
        // Which health produced the most recent poll.
        health: () => health,
        done: run().catch((cause) => new ConfigError({ reason: 'Jcode observation failed', cause })),
      }
    },
  }
}
