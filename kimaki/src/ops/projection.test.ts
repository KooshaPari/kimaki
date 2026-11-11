import { describe, expect, test } from 'vitest'
import { createProjection, projectEvent, fromOpenCodeObservedEvent } from './projection.ts'
import type { OpenCodeObservedEvent } from './runtime/opencode.ts'

const session = { hostId: 'host', endpointId: 'endpoint', backendKind: 'native', nativeSessionId: 'session' }
const event = { session, sourceId: 'source', aggregateId: 'aggregate', sequence: 2, kind: 'observed' as const }

describe('metadata projection', () => {
  test('retains identity and only explicitly selected metadata', () => {
    const input = { ...event, payload: { transcript: 'secret' } }
    const result = projectEvent(createProjection(session), input)
    expect(result).toEqual({ kind: 'applied', state: { session, sources: [{ sourceId: 'source', aggregateId: 'aggregate', sequence: 2 }] } })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  test('rejects every mismatched identity component', () => {
    const state = createProjection(session)
    for (const field of Object.keys(session) as (keyof typeof session)[]) {
      expect(projectEvent(state, { ...event, session: { ...session, [field]: 'other' } })).toEqual({ kind: 'identity-mismatch', state })
    }
  })
  test('distinguishes duplicate and stale evidence per source and aggregate', () => {
    const state = projectEvent(createProjection(session), event).state
    expect(projectEvent(state, event)).toEqual({ kind: 'duplicate', state })
    expect(projectEvent(state, { ...event, sequence: 1 })).toEqual({ kind: 'out-of-order', state })
    expect(projectEvent(state, { ...event, sourceId: 'other', sequence: 1 }).kind).toBe('applied')
    expect(projectEvent(state, { ...event, aggregateId: 'other', sequence: 1 }).kind).toBe('applied')
  })
  test('rejects invalid evidence', () => {
    const state = createProjection(session)
    for (const sequence of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(projectEvent(state, { ...event, sequence }).kind).toBe('invalid-evidence')
    expect(projectEvent(state, { ...event, sourceId: '' }).kind).toBe('invalid-evidence')
    expect(projectEvent(state, { ...event, aggregateId: '' }).kind).toBe('invalid-evidence')
  })
  test('converts native durable metadata without leaking raw payload', () => {
    const key = { ...session, backendKind: 'opencode' }
    const observed: OpenCodeObservedEvent = {
      schemaVersion: 1, key,
      source: { hostId: key.hostId, endpointId: key.endpointId, backendKind: 'opencode', version: '2.0.29' },
      raw: { id: 'event', created: 1, type: 'session.renamed', data: { sessionID: key.nativeSessionId, title: 'private transcript' }, durable: { aggregateID: 'aggregate', seq: 4, version: 1 } },
    }
    const result = fromOpenCodeObservedEvent(observed)
    expect(result).toEqual({ kind: 'converted', event: { session: key, sourceId: 'opencode', aggregateId: 'aggregate', sequence: 4, kind: 'observed' } })
    expect(JSON.stringify(result)).not.toContain('private transcript')
    expect(fromOpenCodeObservedEvent({ ...observed, source: { ...observed.source, endpointId: 'other' } }).kind).toBe('identity-mismatch')
    expect(fromOpenCodeObservedEvent({ ...observed, raw: { id: 'event', created: 1, type: 'session.renamed', data: { sessionID: 'other', title: 'private' }, durable: { aggregateID: 'aggregate', seq: 4, version: 1 } } }).kind).toBe('identity-mismatch')
    expect(fromOpenCodeObservedEvent({ ...observed, raw: { id: 'event', created: 1, type: 'session.text.delta', data: { sessionID: key.nativeSessionId, assistantMessageID: 'message', ordinal: 0, delta: 'private' } } }).kind).toBe('unsupported-evidence')
  })
})
