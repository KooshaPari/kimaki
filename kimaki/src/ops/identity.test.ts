// Pure unit tests for the profile identity matcher. The backend and transport
// tests cover the wiring; these pin the refusal boundaries on their own, because
// the fork segment is the only thing that separates stock jcode from kcode.

import { describe, expect, it } from 'vitest'

import { KCODE_PROFILE, STOCK_JCODE_PROFILE } from './contracts.ts'
import { hasForkSegment, identityRefusal, isParsableVersion } from './identity.ts'

describe('fork segment detection', () => {
  it('treats only -k<digits> versions as fork builds', () => {
    expect(hasForkSegment('0.93.0-k0.1.0')).toBe(true)
    expect(hasForkSegment('1.0.0-k1')).toBe(true)
    expect(hasForkSegment('1.1.0')).toBe(false)
    expect(hasForkSegment('0.93.0')).toBe(false)
    expect(hasForkSegment('0.99.1+linux')).toBe(false)
    expect(hasForkSegment('0.93.0-rc.1')).toBe(false)
  })

  it('refuses to read a fork segment out of an unparsable version', () => {
    expect(isParsableVersion('1.1.0')).toBe(true)
    expect(isParsableVersion('0.93.0-k0.1.0')).toBe(true)
    expect(isParsableVersion('v1.1.0')).toBe(false)
    expect(isParsableVersion('kcode')).toBe(false)
    expect(isParsableVersion('1.1')).toBe(false)
    expect(hasForkSegment('not-a-version-k1')).toBe(false)
  })
})

describe('identityRefusal', () => {
  const stock = STOCK_JCODE_PROFILE.expectedIdentity
  const fork = KCODE_PROFILE.expectedIdentity

  it('accepts each profile on its own real version', () => {
    expect(identityRefusal(stock, { name: 'jcode', version: '1.1.0' }, 'jcode')).toBe(null)
    expect(identityRefusal(fork, { name: 'jcode', version: '0.93.0-k0.1.0' }, 'kcode')).toBe(null)
  })

  it('rejects a fork build for stock and a stock build for the fork', () => {
    const forkOnStock = identityRefusal(stock, { name: 'jcode', version: '0.93.0-k0.1.0' }, 'jcode')
    expect(forkOnStock).toContain("expects identity 'jcode' without a -k<digits> fork segment")
    expect(forkOnStock).toContain("version '0.93.0-k0.1.0'")

    const stockOnFork = identityRefusal(fork, { name: 'jcode', version: '1.1.0' }, 'kcode')
    expect(stockOnFork).toContain("expects identity 'jcode' with a -k<digits> fork segment")
    expect(stockOnFork).toContain("version '1.1.0'")
  })

  it('refuses a missing name, a missing version and an unparsable version', () => {
    expect(identityRefusal(stock, { name: null, version: '1.1.0' }, 'jcode')).toContain('reported no identity')
    expect(identityRefusal(stock, { name: 'jcode', version: null }, 'jcode')).toContain('with no version')
    expect(identityRefusal(stock, { name: 'jcode', version: 'dev' }, 'jcode')).toContain('not a parsable version')
  })

  it('names the requested profile, the expectation and the arrival in every refusal', () => {
    for (const refusal of [
      identityRefusal(fork, { name: 'jcode', version: '1.1.0' }, 'kcode'),
      identityRefusal(stock, { name: 'kcode', version: '1.1.0' }, 'jcode'),
      identityRefusal(fork, { name: null, version: null }, 'kcode'),
    ]) {
      expect(refusal).toContain('Runtime profile ')
      expect(refusal).toContain('but the ACP handshake reported')
      expect(refusal).toContain('refusing to route a ')
    }
  })
})
