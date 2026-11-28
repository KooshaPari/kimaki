import { describe, expect, it } from 'vitest'
import {
  assertControlEngine,
  classifyEngine,
  createObservationOnlyEngine,
} from './engine-identity.ts'

describe('Engine identity oracle', () => {
  it('accepts a real engine identity for control', () => {
    const verdict = assertControlEngine({ identity: 'codex', version: '0.9.1' }, 'codex')
    expect(verdict).toEqual({ kind: 'real', identity: 'codex', version: '0.9.1' })
  })

  it('refuses a synthetic engine for control and names the marker', () => {
    const flagged = assertControlEngine({ identity: 'codex', version: '0.9.1', synthetic: true })
    expect(flagged).toBeInstanceOf(Error)
    expect((flagged as Error).message).toMatch(/synthetic marker 'synthetic'/)
    expect((flagged as Error).message).toMatch(/refusing control operations/)

    // A labelled stub is caught too, and the refusal names its own label.
    const labelled = assertControlEngine({ identity: 'codex', version: '0.9.1', engine: 'stub' })
    expect((labelled as Error).message).toMatch(/synthetic marker 'stub'/)
  })

  it('refuses a synthetic identity string and a synthetic version string', () => {
    expect((assertControlEngine({ identity: 'synthetic-codex', version: '1.0.0' }) as Error).message).toMatch(
      /synthetic marker 'synthetic'/,
    )
    expect((assertControlEngine({ identity: 'codex', version: '0.0.0-fixture' }) as Error).message).toMatch(
      /synthetic marker 'fixture'/,
    )
  })

  it('refuses a real identity that omits the version instead of defaulting it', () => {
    const classified = classifyEngine({ identity: 'codex' })
    expect(classified.kind).toBe('refused')
    if (classified.kind !== 'refused') throw new Error('expected refusal')
    expect(classified.marker).toBeNull()
    expect(classified.reason).toMatch(/no runtime version/)
    expect(classified).not.toHaveProperty('version')

    const blank = assertControlEngine({ identity: 'codex', version: '   ' })
    expect((blank as Error).message).toMatch(/no runtime version/)
  })

  it('refuses an engine that is not the expected runtime', () => {
    const verdict = assertControlEngine({ identity: 'jcode', version: '1.0.0' }, 'codex')
    expect((verdict as Error).message).toMatch(/not the expected runtime 'codex'/)
  })

  it('allows a synthetic engine for observation-only and sends zero control frames', async () => {
    const calls: string[] = []
    const controller = {
      startThread: async () => { calls.push('startThread'); return { threadId: 't' } },
      sendTurn: async () => { calls.push('sendTurn'); return Error('should not control') },
      cancel: async () => { calls.push('cancel') },
    }
    const observer = createObservationOnlyEngine({
      claim: { identity: 'codex', synthetic: true },
      expectedIdentity: 'codex',
      observe: () => ({ threads: 2 }),
    })
    expect(observer).not.toBeInstanceOf(Error)
    if (observer instanceof Error) throw observer
    // The surface cannot express control at all.
    expect(observer.mode).toBe('observe')
    expect(observer.marker).toBe('synthetic')
    expect('start' in observer).toBe(false)
    expect('prompt' in observer).toBe(false)
    expect('cancel' in observer).toBe(false)
    expect(await observer.observe()).toEqual({ threads: 2 })
    expect(observer.controlFramesSent()).toBe(0)
    // The controller stub recorded no frame, before or after the observation.
    expect(calls).toEqual([])
  })

  it('still refuses a foreign engine for observation', () => {
    const observer = createObservationOnlyEngine({
      claim: { identity: 'jcode' },
      expectedIdentity: 'codex',
      observe: () => null,
    })
    expect(observer).toBeInstanceOf(Error)
    expect((observer as Error).message).toMatch(/not the expected runtime 'codex'/)
  })
})
