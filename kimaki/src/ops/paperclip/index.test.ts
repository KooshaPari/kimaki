import { describe, expect, it } from 'vitest'
import { correlatePaperclipRun, matchRunnerIdentity, paperclipCapabilities } from './index.js'

const session = { hostId: 'host', endpointId: 'endpoint', backendKind: 'opencode', nativeSessionId: 'native' }

describe('Paperclip metadata boundary', () => {
  it('observes an external session without a Paperclip task or run', () => {
    expect(correlatePaperclipRun({ ownership: 'external-observe', session })).toEqual({
      ok: true, value: { ownership: 'external-observe', session },
    })
  })

  it('correlates a managed run without confusing Runner and runtime session identity', () => {
    expect(correlatePaperclipRun({
      ownership: 'paperclip-owned', session, paperclipInstanceId: 'instance', companyId: 'company',
      issueId: 'issue', agentId: 'agent', runId: 'run', attemptId: 'attempt', runnerSessionId: 'runner-session',
    })).toEqual({ ok: true, value: {
      ownership: 'paperclip-owned', session, paperclipInstanceId: 'instance', companyId: 'company',
      issueId: 'issue', agentId: 'agent', runId: 'run', attemptId: 'attempt', runnerSessionId: 'runner-session',
    } })
  })

  it('copies only allowed fields at both levels and does not read unrelated fields', () => {
    const input = { ownership: 'external-observe', session: { ...session, token: 'secret' },
      issueId: 'not-an-association', get transcript(): never { throw new Error('must not read') } }
    expect(correlatePaperclipRun(input)).toEqual({ ok: true, value: { ownership: 'external-observe', session } })
  })

  it('rejects incomplete scoped session and managed identity without guessing', () => {
    expect(correlatePaperclipRun({ ownership: 'external-observe', session: { ...session, endpointId: ' ' } })).toEqual({ ok: false, reason: 'invalid-identity' })
    expect(correlatePaperclipRun({ ownership: 'paperclip-owned', session })).toEqual({ ok: false, reason: 'invalid-identity' })
    expect(correlatePaperclipRun({ ownership: 'owned', session })).toEqual({ ok: false, reason: 'invalid-identity' })
    expect(correlatePaperclipRun(null)).toEqual({ ok: false, reason: 'invalid-identity' })
  })

  it('declares transport and mutations unavailable regardless of ownership', () => {
    expect(paperclipCapabilities).toEqual({ metadataCorrelation: true, transport: false, dispatch: false, approval: false, cancellation: false, progressPublication: false })
  })
})

describe('pinned Runner identity comparison', () => {
  const correlation = { ownership: 'paperclip-owned', session, paperclipInstanceId: 'instance', companyId: 'company',
    issueId: 'issue', agentId: 'agent', runId: 'run', attemptId: 'local-attempt', runnerSessionId: 'runner' }
  const identity = { runId: 'run', sessionId: 'runner', companyId: 'company', issueId: 'issue', agentId: 'agent' }

  it('matches only explicit Runner identity and instance scope', () => {
    expect(matchRunnerIdentity({ correlation, paperclipInstanceId: 'instance', identity })).toEqual({ ok: true })
    for (const key of Object.keys(identity)) {
      expect(matchRunnerIdentity({ correlation, paperclipInstanceId: 'instance', identity: { ...identity, [key]: 'other' } }))
        .toEqual({ ok: false, reason: 'mismatch' })
    }
    expect(matchRunnerIdentity({ correlation, paperclipInstanceId: 'other', identity })).toEqual({ ok: false, reason: 'mismatch' })
    expect(matchRunnerIdentity({ correlation, paperclipInstanceId: 'instance', identity: { ...identity, sessionId: session.nativeSessionId } }))
      .toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects malformed and external identities without creating an association', () => {
    expect(matchRunnerIdentity({ correlation, paperclipInstanceId: 'instance', identity: { ...identity, runId: '' } }))
      .toEqual({ ok: false, reason: 'invalid-identity' })
    expect(matchRunnerIdentity({ correlation, paperclipInstanceId: '', identity })).toEqual({ ok: false, reason: 'invalid-identity' })
    expect(matchRunnerIdentity({ correlation: { ownership: 'external-observe', session }, paperclipInstanceId: 'instance', identity }))
      .toEqual({ ok: false, reason: 'external-observe' })
  })
})
