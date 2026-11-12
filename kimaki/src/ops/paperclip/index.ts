import type { SessionKey } from '../contracts.js'

/** Local metadata only. These records grant no observation or execution authority. */
export type PaperclipRunCorrelation =
  | { ownership: 'external-observe'; session: SessionKey }
  | {
      ownership: 'paperclip-owned'
      session: SessionKey
      paperclipInstanceId: string
      companyId: string
      issueId: string
      agentId: string
      runId: string
      attemptId: string
      // Paperclip NativeRunIdentity.sessionId, not the native runtime session ID.
      runnerSessionId: string
    }

export const paperclipCapabilities = Object.freeze({
  metadataCorrelation: true,
  transport: false,
  dispatch: false,
  approval: false,
  cancellation: false,
  progressPublication: false,
} as const)

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Copy only explicit metadata. This neither authenticates nor associates a task remotely. */
export function correlatePaperclipRun(input: unknown):
  | { ok: true; value: PaperclipRunCorrelation }
  | { ok: false; reason: 'invalid-identity' } {
  const invalid = { ok: false, reason: 'invalid-identity' } as const
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid
  const record = input as Record<string, unknown>
  if (typeof record.session !== 'object' || record.session === null || Array.isArray(record.session)) return invalid
  const raw = record.session as Record<string, unknown>
  const { hostId, endpointId, backendKind, nativeSessionId } = raw
  if (!nonempty(hostId) || !nonempty(endpointId) || !nonempty(backendKind) || !nonempty(nativeSessionId)) return invalid
  const session: SessionKey = { hostId, endpointId, backendKind, nativeSessionId }
  if (record.ownership === 'external-observe') {
    return { ok: true, value: { ownership: 'external-observe', session } }
  }
  if (record.ownership !== 'paperclip-owned') return invalid
  const { paperclipInstanceId, companyId, issueId, agentId, runId, attemptId, runnerSessionId } = record
  if (!nonempty(paperclipInstanceId) || !nonempty(companyId) || !nonempty(issueId) ||
      !nonempty(agentId) || !nonempty(runId) || !nonempty(attemptId) || !nonempty(runnerSessionId)) return invalid
  return { ok: true, value: { ownership: 'paperclip-owned', session, paperclipInstanceId,
    companyId, issueId, agentId, runId, attemptId, runnerSessionId } }
}
