import { describe, expect, test } from 'vitest'
import { ConfigError } from '../errors.js'
import type { DiscoveryObservation, SessionKey } from './contracts.js'
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
