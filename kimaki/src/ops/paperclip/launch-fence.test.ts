import { describe, expect, it } from 'vitest'
import {
  authorizeLaunchWrite, claimLaunch, createLaunchFence, heartbeatLaunch,
  launchFenceCapabilities, releaseLaunch, type LaunchFence,
} from './launch-fence.js'
import { verifyLaunchClaim } from './launch-claim.js'

const scope = { instanceId: 'pc-instance', runId: 'run-1' }
const paperclipA = 'paperclip:worker-a'
const paperclipB = 'paperclip:worker-b'
const hub = 'hub:pid-4242'
const start = '2026-11-14T00:00:00.000Z'
const leaseMs = 60_000

function harness(startAt = start) {
  let now = new Date(startAt)
  const created = createLaunchFence({ leaseMs, now: () => now })
  if (created instanceof Error) throw created
  return {
    fence: created,
    advance(ms: number) {
      now = new Date(now.getTime() + ms)
    },
    now: () => now.toISOString(),
  }
}

function refusal(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error(`expected a refusal, got ${JSON.stringify(value)}`)
  return value
}

describe('Paperclip launch fence: one writer per managed run', () => {
  it('lets the first claim win and records a verifiable holder', () => {
    const { fence } = harness()
    const claimed = fence.claim({ scope, launcher: paperclipA })
    expect(claimed).toMatchObject({
      kind: 'claimed',
      record: {
        kind: 'paperclip-launch-claim',
        version: 1,
        instanceId: 'pc-instance',
        runId: 'run-1',
        launcher: paperclipA,
        generation: 1,
        claimSeq: 1,
        acquiredAt: start,
        heartbeatAt: start,
        expiresAt: '2026-11-14T00:01:00.000Z',
      },
    })
    if (claimed instanceof Error) throw claimed
    expect(verifyLaunchClaim(claimed.record)).toEqual(claimed.record)
    expect(fence.inspect(scope)).toEqual(claimed.record)
    expect(launchFenceCapabilities).toMatchObject({ localClaimRecord: true, dispatch: false, remoteWrite: false })
  })

  it('refuses a second claim on a live run and names the current holder', () => {
    const { fence, advance } = harness()
    fence.claim({ scope, launcher: paperclipA })
    advance(1_000)
    const refused = refusal(fence.claim({ scope, launcher: paperclipB }))
    expect(refused.message).toContain('run run-1 on instance pc-instance')
    expect(refused.message).toContain('already claimed by')
    expect(refused.message).toContain(paperclipA)
    expect(refused.message).toContain('generation 1')
    expect(refused.message).toContain(paperclipB)
    // The holder is unchanged by the failed attempt.
    expect(fence.inspect(scope)).toMatchObject({ launcher: paperclipA, generation: 1 })
  })

  it('takes over a stale claim and refuses the superseded launcher afterwards', () => {
    const { fence, advance } = harness()
    fence.claim({ scope, launcher: paperclipA })
    advance(leaseMs + 1)
    const taken = fence.claim({ scope, launcher: paperclipB })
    if (taken instanceof Error) throw taken
    expect(taken.kind).toBe('claimed')
    expect(taken.record).toMatchObject({ launcher: paperclipB, generation: 2, claimSeq: 2 })

    const stale = refusal(fence.authorizeWrite({ scope, launcher: paperclipA, generation: 1 }))
    expect(stale.message).toContain('is claimed by')
    expect(stale.message).toContain(paperclipB)
    expect(stale.message).toContain('generation 2')
    expect(stale.message).toMatch(/cannot write/)

    // Forging the current generation does not help: the launcher is wrong.
    const forged = refusal(fence.authorizeWrite({ scope, launcher: paperclipA, generation: 2 }))
    expect(forged.message).toContain(paperclipB)

    expect(fence.authorizeWrite({ scope, launcher: paperclipB, generation: 2 })).toMatchObject({
      kind: 'authorized', record: { launcher: paperclipB, generation: 2 },
    })
  })

  it('treats a takeover as idempotent and never double-bumps the generation', () => {
    const { fence, advance } = harness()
    fence.claim({ scope, launcher: paperclipA })
    advance(leaseMs + 1)
    const first = fence.claim({ scope, launcher: paperclipB })
    const again = fence.claim({ scope, launcher: paperclipB })
    if (first instanceof Error || again instanceof Error) throw first instanceof Error ? first : again
    expect(again.kind).toBe('unchanged')
    expect(again.record).toEqual(first.record)
    expect(again.record).toMatchObject({ generation: 2, claimSeq: 2 })
    expect(fence.records()).toHaveLength(1)
  })

  it('frees the run exactly once and never reissues counters', () => {
    const { fence, advance } = harness()
    fence.claim({ scope, launcher: paperclipA })
    const released = fence.release({ scope, launcher: paperclipA, generation: 1 })
    if (released instanceof Error) throw released
    expect(released.kind).toBe('released')
    expect(fence.inspect(scope)).toBeUndefined()

    const twice = refusal(fence.release({ scope, launcher: paperclipA, generation: 1 }))
    expect(twice.message).toContain('is not claimed')
    expect(twice.message).toContain(paperclipA)

    advance(1_000)
    const next = fence.claim({ scope, launcher: paperclipB })
    if (next instanceof Error) throw next
    expect(next.record).toMatchObject({ generation: 2, claimSeq: 2 })
  })

  it('refuses a release by a launcher that does not hold the run', () => {
    const { fence } = harness()
    fence.claim({ scope, launcher: paperclipA })
    const refused = refusal(fence.release({ scope, launcher: paperclipB, generation: 1 }))
    expect(refused.message).toContain('is claimed by')
    expect(refused.message).toContain(paperclipA)
  })
})

describe('Paperclip launch fence: hub lease in both directions', () => {
  it('refuses a Paperclip claim while the hub holds the run', () => {
    const { fence } = harness()
    const refused = refusal(fence.claim({ scope, launcher: paperclipA, hubHolder: hub }))
    expect(refused.message).toContain('Hub launcher hub:pid-4242 already holds')
    expect(refused.message).toContain('run run-1 on instance pc-instance')
    expect(refused.message).toContain('refusing to claim it for launcher paperclip:worker-a')
    expect(fence.inspect(scope)).toBeUndefined()

    // Pure rule refuses the same way, and only accepts when the hub is the claimant.
    expect(claimLaunch({ scope, launcher: paperclipA, at: start, hubHolder: hub })).toBeInstanceOf(Error)
    expect(claimLaunch({ scope, launcher: hub, at: start, hubHolder: hub })).toMatchObject({
      kind: 'claimed', record: { launcher: hub },
    })
  })

  it('does not let the fence record silently replace the hub writer', () => {
    const { fence } = harness()
    // The hub claims the run through the same fence; Paperclip must not take it.
    const hubClaim = fence.claim({ scope, launcher: hub })
    if (hubClaim instanceof Error) throw hubClaim
    const refused = refusal(fence.claim({ scope, launcher: paperclipA, hubHolder: hub }))
    expect(refused.message).toContain('already holds')
    expect(fence.inspect(scope)).toMatchObject({ launcher: hub })

    // A write with the wrong launcher, or the wrong generation, is refused too.
    const wrongLauncher = refusal(fence.authorizeWrite({ scope, launcher: paperclipA, generation: 1, hubHolder: hub }))
    expect(wrongLauncher.message).toContain('Hub launcher hub:pid-4242 holds')
    const wrongGeneration = refusal(fence.authorizeWrite({ scope, launcher: hub, generation: 2 }))
    expect(wrongGeneration.message).toContain('was superseded')
    expect(fence.authorizeWrite({ scope, launcher: hub, generation: 1 })).toMatchObject({ kind: 'authorized' })
  })
})

describe('Paperclip launch fence: records and heartbeat', () => {
  it('renews a held claim and refuses renewal once the heartbeat is stale', () => {
    const { fence, advance } = harness()
    fence.claim({ scope, launcher: paperclipA })
    advance(30_000)
    const renewed = fence.heartbeat({ scope, launcher: paperclipA, generation: 1 })
    if (renewed instanceof Error) throw renewed
    expect(renewed.record).toMatchObject({ heartbeatAt: '2026-11-14T00:00:30.000Z', expiresAt: '2026-11-14T00:01:30.000Z' })
    // The renewed claim still blocks the competitor.
    expect(fence.claim({ scope, launcher: paperclipB })).toBeInstanceOf(Error)

    advance(leaseMs + 1)
    const stale = refusal(fence.heartbeat({ scope, launcher: paperclipA, generation: 1 }))
    expect(stale.message).toContain('stale heartbeat')
    expect(stale.message).toContain(paperclipA)
  })

  it('round-trips a persisted record and refuses a tampered one', () => {
    const { fence } = harness()
    const claimed = fence.claim({ scope, launcher: paperclipA })
    if (claimed instanceof Error) throw claimed
    const seeded = createLaunchFence({ leaseMs, now: () => new Date(start), records: fence.records() })
    if (seeded instanceof Error) throw seeded
    expect(seeded.inspect(scope)).toEqual(claimed.record)
    // A second launcher is refused against the re-seeded record as well.
    expect(seeded.claim({ scope, launcher: paperclipB })).toBeInstanceOf(Error)

    const tampered = { ...claimed.record, generation: 9 }
    expect(createLaunchFence({ records: [tampered] })).toBeInstanceOf(Error)
  })

  it('validates identity, scope and timestamps without inventing a claim', () => {
    const { fence } = harness()
    expect(fence.claim({ scope: { instanceId: 'pc-instance' }, launcher: paperclipA })).toBeInstanceOf(Error)
    expect(fence.claim({ scope, launcher: ' paperclip:worker-a' })).toBeInstanceOf(Error)
    expect(claimLaunch({ scope, launcher: paperclipA, at: '2026-11-14 00:00:00' })).toBeInstanceOf(Error)
    expect(claimLaunch({ scope, launcher: paperclipA, at: start, leaseMs: 0 })).toBeInstanceOf(Error)
    expect(authorizeLaunchWrite({ scope, launcher: paperclipA, generation: 1, at: start })).toBeInstanceOf(Error)
    expect(releaseLaunch({ scope, launcher: paperclipA, generation: 1, at: start })).toBeInstanceOf(Error)
    expect(heartbeatLaunch({ scope, launcher: paperclipA, generation: 1, at: start })).toBeInstanceOf(Error)
  })
})

// Type-level check that the fence factory is the shape callers get.
const fenceShape: LaunchFence | undefined = undefined
void fenceShape
