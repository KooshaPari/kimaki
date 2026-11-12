// Passive metadata only. The caller owns and explicitly selects an initialized
// app-server connection. No resume, subscription, process launch or credentials.
import * as errore from 'errore'
import { ConfigError } from '../../errors.js'
import type { SessionKey } from '../contracts.js'
import { passiveCapabilities, sessionKeyId } from '../registry.js'

export class CodexRuntimeError extends errore.createTaggedError({
  name: 'CodexRuntimeError',
  message: 'Codex app-server request $operation failed',
}) {}

type Request = (method: 'thread/list' | 'thread/read', params: Record<string, unknown>) => Promise<unknown>
type NativeThread = Record<string, unknown> & { id: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const thread = (value: unknown): value is NativeThread => record(value) && typeof value.id === 'string' && value.id.trim().length > 0

export function createCodexObserver({ hostId, endpointId, request }: { hostId: string; endpointId: string; request: Request }) {
  const valid = sessionKeyId({ hostId, endpointId, backendKind: 'codex', nativeSessionId: 'validation' })
  if (valid instanceof Error) return valid
  const source = Object.freeze({ hostId, endpointId, backendKind: 'codex' as const })
  const keyFor = (nativeSessionId: string): SessionKey => ({ ...source, nativeSessionId })
  const call = (operation: 'thread/list' | 'thread/read', params: Record<string, unknown>) =>
    Promise.resolve().then(() => request(operation, params)).catch((cause) => new CodexRuntimeError({ operation, cause }))
  return {
    capabilities: {
      ...passiveCapabilities,
      snapshot: { kind: 'supported' as const },
      observe: { kind: 'unsupported' as const, reason: 'Reading or resuming a historical thread does not attach to an external live session' },
      replay: { kind: 'unsupported' as const, reason: 'Metadata reads do not provide a durable event cursor' },
      exclusiveControl: { kind: 'unsupported' as const, reason: 'No exclusive writer lease is established' },
    },
    async discover(input: { cursor?: string; limit?: number } = {}) {
      const result = await call('thread/list', { ...input, useStateDbOnly: true })
      if (result instanceof Error) return result
      if (!record(result) || !Array.isArray(result.data) || !result.data.every(thread) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) {
        return new CodexRuntimeError({ operation: 'thread/list', cause: new Error('Malformed response') })
      }
      return { source, sessions: result.data.map((native) => ({ key: keyFor(native.id), native: { id: native.id } })), cursor: result.nextCursor }
    },
    async readSnapshot({ key }: { key: SessionKey }) {
      const valid = sessionKeyId(key)
      if (valid instanceof Error) return valid
      if (key.hostId !== hostId || key.endpointId !== endpointId || key.backendKind !== 'codex') return new ConfigError({ reason: 'Session identity does not match this Codex endpoint' })
      const scopedKey = Object.freeze({ hostId, endpointId, backendKind: 'codex' as const, nativeSessionId: key.nativeSessionId })
      const result = await call('thread/read', { threadId: scopedKey.nativeSessionId, includeTurns: false })
      if (result instanceof Error) return result
      if (!record(result) || !thread(result.thread) || result.thread.id !== scopedKey.nativeSessionId) return new CodexRuntimeError({ operation: 'thread/read', cause: new Error('Malformed or mismatched thread identity') })
      return { key: scopedKey, source, session: { id: result.thread.id } }
    },
  }
}
