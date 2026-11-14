import { describe, expect, test } from 'vitest'
import { ConfigError } from '../errors.js'
import { enrollSession } from './paperclip/enrollment.ts'
import type { PaperclipObservedEntity } from './paperclip/project.ts'
import { projectObservedSession } from './paperclip/project.ts'
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

describe('paperclip observed-session projection', () => {
  const enrolled = enrollSession({
    action: 'enroll',
    session,
    runtime: { backendKind: 'native', endpointId: 'endpoint', version: '2.0.29' },
    surface: 'paperclip',
    mode: 'observe',
    publication: 'none',
    createdAt: '2026-11-14T21:00:00.000Z',
  })
  if (enrolled instanceof ConfigError) throw enrolled
  const enrollment = enrolled.record
  const observedAt = '2026-11-14T21:05:00.000Z'

  function entity(overrides: Record<string, unknown> = {}): PaperclipObservedEntity {
    const result = projectObservedSession({
      enrollment,
      session,
      metadata: { runtimeVersion: '2.0.29', observedAt },
      ...overrides,
    })
    if (result instanceof ConfigError) throw result
    return result
  }

  test('projects an enrolled session idempotently with a stable derived entity', () => {
    const first = entity()
    const second = entity()
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first).toMatchObject({
      kind: 'paperclip-observed-session',
      version: 1,
      ownership: 'external-observe',
      policy: { mode: 'observe', publication: 'none', writes: false, dispatch: false },
      observed: {
        hostId: session.hostId,
        endpointId: session.endpointId,
        backendKind: session.backendKind,
        nativeSessionId: session.nativeSessionId,
        runtimeVersion: '2.0.29',
        observedAt,
        enrolledAt: '2026-11-14T21:00:00.000Z',
      },
    })
    expect(first.entityId).toMatch(/^pc_[0-9a-f]{32}$/)
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.externalRef).toEqual({
      system: 'kimaki',
      enrollmentId: enrollment.enrollmentId,
      sessionId: JSON.stringify([session.hostId, session.endpointId, session.backendKind, session.nativeSessionId]),
    })
    expect(first).not.toHaveProperty('transcript')
    expect(JSON.stringify(first)).not.toContain('secret')
  })

  test('refuses an unenrolled session instead of inventing an entity', () => {
    const none = projectObservedSession({ enrollment: null, session, metadata: {} })
    expect(none).toBeInstanceOf(ConfigError)
    expect((none as Error).message).toMatch(/enrollment/)
    const other = projectObservedSession({
      enrollment,
      session: { ...session, nativeSessionId: 'other' },
      metadata: {},
    })
    expect(other).toBeInstanceOf(ConfigError)
    expect((other as Error).message).toMatch(/not the enrolled session/)
    expect(other).not.toHaveProperty('entityId')
  })

  test('a mutated session changes only the derived fields', () => {
    const before = entity()
    const after = entity({ metadata: { runtimeVersion: '9.9.9', observedAt: '2026-11-14T22:00:00.000Z' } })
    const { observed: observedBefore, digest: digestBefore, ...restBefore } = before
    const { observed: observedAfter, digest: digestAfter, ...restAfter } = after
    expect(restAfter).toEqual(restBefore)
    expect(observedAfter).toEqual({
      ...observedBefore,
      runtimeVersion: '9.9.9',
      observedAt: '2026-11-14T22:00:00.000Z',
    })
    expect(digestAfter).not.toBe(digestBefore)
  })

  test('refuses a tampered enrollment record', () => {
    const tampered = { ...enrollment, createdAt: '2020-01-01T00:00:00.000Z' }
    const refused = projectObservedSession({ enrollment: tampered, session, metadata: {} })
    expect(refused).toBeInstanceOf(ConfigError)
    expect((refused as Error).message).toMatch(/digest/)
    const widened = projectObservedSession({ enrollment: { ...enrollment, mode: 'control' }, session, metadata: {} })
    expect(widened).toBeInstanceOf(ConfigError)
    expect((widened as Error).message).toMatch(/mode/)
  })
})
