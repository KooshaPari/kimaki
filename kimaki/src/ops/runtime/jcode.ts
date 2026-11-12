// Passive metadata discovery over an explicitly supplied Jcode home. This reads
// session records but emits only an allowlisted identity and title. Transcripts,
// tool output, provider credentials and message bodies are never returned.
import { ConfigError } from '../../errors.js'
import type { SessionKey } from '../contracts.js'
import { passiveCapabilities, sessionKeyId } from '../registry.js'

type NativeSession = { id: string; title: string | null; updatedAt: string | null }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createJcodeObserver({ jcodeHome, hostId, endpointId, readFile, readDir }: {
  jcodeHome: string
  hostId: string
  endpointId: string
  readFile: (path: string) => Promise<string>
  readDir: (path: string) => Promise<string[]>
}) {
  const valid = sessionKeyId({ hostId, endpointId, backendKind: 'jcode', nativeSessionId: 'validation' })
  if (valid instanceof Error) return valid
  if (!jcodeHome.trim()) return new ConfigError({ reason: 'An explicit Jcode home is required' })
  const source = Object.freeze({ hostId, endpointId, backendKind: 'jcode' as const })
  const sessionsDir = `${jcodeHome.replace(/[\\/]+$/, '')}/sessions`
  const fileFor = (id: string) => `${sessionsDir}/${id}.json`
  const reason = 'Jcode live observation and replay are not qualified for passive attachment'

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
    return { id: value.id, title, updatedAt }
  }

  const keyFor = (nativeSessionId: string): SessionKey => ({ ...source, nativeSessionId })

  return {
    capabilities: {
      ...passiveCapabilities,
      discovery: { kind: 'supported' as const },
      snapshot: { kind: 'supported' as const },
      observe: { kind: 'unsupported' as const, reason },
      replay: { kind: 'unsupported' as const, reason: 'No durable event cursor is qualified' },
      exclusiveControl: { kind: 'unsupported' as const, reason: 'No exclusive writer lease is established' },
    },
    async discover(input: { cursor?: string; limit?: number } = {}) {
      const names = await readDir(sessionsDir)
      const ids = names
        .filter((name) => name.startsWith('session_') && name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
      const parsed: NativeSession[] = []
      for (const id of ids) {
        const raw = await readFile(fileFor(id)).catch(() => undefined)
        if (raw === undefined) continue
        const session = parse(raw)
        if (session) parsed.push(session)
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
      }
    },
    async readSnapshot({ key }: { key: SessionKey }) {
      const validKey = sessionKeyId(key)
      if (validKey instanceof Error) return validKey
      if (key.hostId !== hostId || key.endpointId !== endpointId || key.backendKind !== 'jcode') {
        return new ConfigError({ reason: 'Session identity does not match this Jcode endpoint' })
      }
      const nativeSessionId = key.nativeSessionId
      const raw = await readFile(fileFor(nativeSessionId)).catch(() => undefined)
      if (raw === undefined) return new ConfigError({ reason: 'Jcode session record is missing or unreadable' })
      const session = parse(raw)
      if (!session) return new ConfigError({ reason: 'Malformed or mismatched Jcode session record' })
      if (session.id !== nativeSessionId) return new ConfigError({ reason: 'Record identity does not match the requested session' })
      return { key: Object.freeze({ ...source, nativeSessionId }), source, session: { id: session.id, title: session.title } }
    },
  }
}
