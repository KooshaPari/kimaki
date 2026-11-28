import { describe, expect, test } from 'vitest'
import { ConfigError } from '../errors.js'
import type { DiscoveryObservation, SessionKey } from './contracts.js'
import { enrollSession, verifyEnrollment } from './paperclip/enrollment.ts'
import { passiveCapabilities, reconcileObservation, sessionKeyId } from './registry.js'

const key: SessionKey = {
  hostId: 'host-a',
  endpointId: 'runtime-a',
  backendKind: 'opencode',
  nativeSessionId: 's1',
}

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    provider: 'herdr',
    hostId: 'host-a',
    endpointId: 'discovery-a',
    observationId: 'pane-1',
    observedAt: 100,
    processIncarnation: 'pid-42:start-1',
    nativeSession: key,
    ...overrides,
  }
}

describe('session identity', () => {
  test('same native IDs on different endpoints, hosts and backends do not collide', () => {
    const keys = [key, { ...key, endpointId: 'runtime-b' }, { ...key, hostId: 'host-b' }, { ...key, backendKind: 'codex' }]
    const ids = keys.map(sessionKeyId)
    expect(ids.every((id) => typeof id === 'string')).toBe(true)
    expect(new Set(ids).size).toBe(4)
  })

  test('serialization is deterministic, property-order independent and delimiter safe', () => {
    const first = { ...key, hostId: 'host:runtime', endpointId: 'one' }
    const second = { ...key, hostId: 'host', endpointId: 'runtime:one' }
    expect(sessionKeyId(first)).not.toBe(sessionKeyId(second))
    expect(sessionKeyId(key)).toBe(sessionKeyId({ nativeSessionId: 's1', backendKind: 'opencode', endpointId: 'runtime-a', hostId: 'host-a' }))
    expect(sessionKeyId({ ...key, nativeSessionId: '["s1"]\n\u0000' })).not.toBe(sessionKeyId(key))
  })

  test.each(['hostId', 'endpointId', 'backendKind', 'nativeSessionId'] as const)('rejects blank %s as an error value', (field) => {
    for (const blank of ['', ' \t\n']) {
      const invalid = { ...key, [field]: blank }
      expect(sessionKeyId(invalid)).toBeInstanceOf(ConfigError)
      expect(reconcileObservation(observation({ nativeSession: invalid }))).toBeInstanceOf(ConfigError)
    }
  })
})

describe('passive discovery reconciliation', () => {
  test('resolves native identity while preserving discovery provenance', () => {
    const evidence = observation()
    expect(reconcileObservation(evidence)).toEqual({ kind: 'resolved', key, id: sessionKeyId(key), observation: evidence })
    expect(reconcileObservation(observation({ endpointId: 'another-discovery' }))).toMatchObject({ kind: 'resolved', id: sessionKeyId(key) })
  })

  test('PID reuse and missing native identity remain unresolved', () => {
    const first = observation({ nativeSession: null })
    const reused = observation({ nativeSession: null, observedAt: 200, processIncarnation: 'pid-42:start-2' })
    for (const evidence of [first, reused, { ...first, processIncarnation: null }]) {
      const result = reconcileObservation(evidence)
      expect(result).toEqual({ kind: 'unresolved', observation: evidence, reason: expect.any(String) })
      expect(result).not.toHaveProperty('key')
      expect(result).not.toHaveProperty('id')
      expect(result).not.toHaveProperty('transcript')
    }
  })

  test('daemon restart preserves logical native identity', () => {
    const before = reconcileObservation(observation())
    const after = reconcileObservation(observation({ observedAt: 200, processIncarnation: 'pid-84:start-2', observationId: 'pane-2' }))
    expect(before).toMatchObject({ kind: 'resolved', id: sessionKeyId(key) })
    expect(after).toMatchObject({ kind: 'resolved', id: sessionKeyId(key) })
    expect(after).not.toEqual(before)
  })

  test('rejects mismatched native host without rewriting either identity', () => {
    expect(reconcileObservation(observation({ nativeSession: { ...key, hostId: 'host-b' } }))).toBeInstanceOf(ConfigError)
  })

  test.each(['provider', 'hostId', 'endpointId', 'observationId'] as const)('rejects blank observation %s', (field) => {
    expect(reconcileObservation(observation({ [field]: ' \t' }))).toBeInstanceOf(ConfigError)
  })

  test('passive capabilities are versioned and every control operation is explicitly unsupported', () => {
    expect(passiveCapabilities).toEqual({
      version: 1,
      discovery: { kind: 'supported' },
      control: {
        create: { kind: 'unsupported', reason: expect.any(String) },
        submit: { kind: 'unsupported', reason: expect.any(String) },
        interrupt: { kind: 'unsupported', reason: expect.any(String) },
        answerApproval: { kind: 'unsupported', reason: expect.any(String) },
      },
    })
  })
})

describe('explicit paperclip enrollment', () => {
  const action = {
    action: 'enroll',
    session: key,
    runtime: { backendKind: 'opencode', endpointId: 'runtime-a', version: '2.0.29' },
    surface: 'paperclip',
    mode: 'observe',
    publication: 'none',
    createdAt: '2026-11-14T21:00:00.000Z',
  }

  function record(overrides: Record<string, unknown> = {}) {
    const outcome = enrollSession({ ...action, ...overrides })
    if (outcome instanceof ConfigError) throw outcome
    return outcome.record
  }

  test('an explicit action enrolls and the record round-trips through JSON', () => {
    const outcome = enrollSession(action)
    expect(outcome).not.toBeInstanceOf(ConfigError)
    if (outcome instanceof ConfigError) throw outcome
    expect(outcome.kind).toBe('enrolled')
    expect(outcome.record).toMatchObject({
      kind: 'paperclip-enrollment',
      version: 1,
      session: key,
      runtime: { backendKind: 'opencode', endpointId: 'runtime-a', version: '2.0.29' },
      surface: 'paperclip',
      mode: 'observe',
      publication: 'none',
      createdAt: '2026-11-14T21:00:00.000Z',
    })
    expect(outcome.record.enrollmentId).toMatch(/^enr_[0-9a-f]{32}$/)
    expect(outcome.record.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const reparsed: unknown = JSON.parse(JSON.stringify(outcome.record))
    expect(verifyEnrollment(reparsed)).toEqual(outcome.record)
  })

  test('seeing a session never enrolls it', () => {
    const refusal = enrollSession({ ...action, action: 'observed' })
    expect(refusal).toBeInstanceOf(ConfigError)
    expect((refusal as Error).message).toContain('action "enroll"')
  })

  test('re-enrolling the same binding is a no-op, a different one is refused by field', () => {
    const first = record()
    expect(enrollSession(action, [first])).toEqual({ kind: 'unchanged', record: first })
    const different = enrollSession({ ...action, runtime: { ...action.runtime, version: '2.0.30' } }, [first])
    expect(different).toBeInstanceOf(ConfigError)
    expect((different as Error).message).toContain('runtime.version')
    const rebased = enrollSession({ ...action, createdAt: '2026-11-14T22:00:00.000Z' }, [first])
    expect(rebased).toBeInstanceOf(ConfigError)
    expect((rebased as Error).message).toContain('createdAt')
  })

  test.each([
    ['mode', 'control'],
    ['publication', 'all'],
    ['surface', 'discord'],
  ])('refuses an authority-widening %s by name', (field, value) => {
    const refusal = enrollSession({ ...action, [field]: value })
    expect(refusal).toBeInstanceOf(ConfigError)
    expect((refusal as Error).message).toContain(field)
    expect((refusal as Error).message).toContain(String(value))
  })

  test('a tampered record fails its digest check', () => {
    const original = record()
    const tampered = { ...original, createdAt: '2026-11-15T00:00:00.000Z' }
    const verified = verifyEnrollment(tampered)
    expect(verified).toBeInstanceOf(ConfigError)
    expect((verified as Error).message).toMatch(/digest/)
    const widened = verifyEnrollment({ ...original, mode: 'control' })
    expect(widened).toBeInstanceOf(ConfigError)
    expect(verifyEnrollment({ ...original, digest: 'sha256:00' })).toBeInstanceOf(ConfigError)
    expect(verifyEnrollment(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })

  test('never enrolls a second, different binding over an existing one', () => {
    const first = record()
    const otherBinding = record({ session: { ...key, nativeSessionId: 's2' } })
    expect(otherBinding.enrollmentId).not.toBe(first.enrollmentId)
    expect(enrollSession({ ...action, session: { ...key, nativeSessionId: 's2' } }, [first])).toMatchObject({ kind: 'enrolled' })
  })
})
