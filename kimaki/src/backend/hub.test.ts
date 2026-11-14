import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSessionHub, type HubBackend, type HubEvent } from './hub.ts'

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// Default backend completes a turn immediately. `blocking: true` holds the turn
// open so tests can observe the busy state and cancellation.
function fakeBackend({ blocking = false, overrides = {} }: { blocking?: boolean; overrides?: Partial<HubBackend> } = {}) {
  let releaseTurn: (() => void) | undefined
  const calls = { starts: 0, prompts: [] as string[], cancels: 0, closes: 0 }
  const backend: HubBackend = {
    async start(input) {
      calls.starts += 1
      return { sessionId: 'session-1', model: input?.model ?? null }
    },
    async prompt(text, onChunk) {
      calls.prompts.push(text)
      onChunk?.('ok')
      if (blocking) {
        await new Promise<void>((resolve) => {
          releaseTurn = resolve
        })
      }
      return { stopReason: 'end_turn', text: 'ok', updateCount: 1 }
    },
    async cancel() {
      calls.cancels += 1
      return undefined
    },
    async close() {
      calls.closes += 1
    },
    ...overrides,
  }
  return { backend, calls, release: () => releaseTurn?.() }
}

describe('createSessionHub', () => {
  it('fans one turn out to several subscribers in order', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend, model: 'beam-free' })
    if (hub instanceof Error) throw hub

    const first: HubEvent[] = []
    const second: HubEvent[] = []
    const a = hub.subscribe({ onEvent: (event) => first.push(event) })
    const b = hub.subscribe({ onEvent: (event) => second.push(event) })
    if (a instanceof Error || b instanceof Error) throw new Error('subscribe failed')

    const submitted = await hub.submit('hello')
    expect(submitted).toEqual({ accepted: true, characters: 5 })
    await wait(10)

    const kinds = (events: HubEvent[]) => events.map((event) => event.type)
    expect(kinds(first)).toEqual(['session.started', 'prompt.started', 'prompt.chunk', 'prompt.finished'])
    expect(kinds(second)).toEqual(kinds(first))
    expect(first.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(second.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    const started = first[0]!
    expect(started).toMatchObject({ type: 'session.started', sessionId: 'session-1', model: 'beam-free' })
  })

  it('replays buffered events to a late subscriber from its cursor', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    hub.subscribe({ onEvent: () => {} })
    await hub.submit('hello')
    await wait(10)

    const replayed: HubEvent[] = []
    const late = hub.subscribe({ cursor: 0, onEvent: (event) => replayed.push(event) })
    if (late instanceof Error) throw late
    expect(late.clipped).toBe(false)
    expect(replayed.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(late.cursor).toBe(4)
  })

  it('resumes from a cursor without repeating earlier events', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    await hub.submit('hello')
    await wait(10)

    const resumed: HubEvent[] = []
    const subscription = hub.subscribe({ cursor: 3, onEvent: (event) => resumed.push(event) })
    if (subscription instanceof Error) throw subscription
    expect(resumed.map((event) => event.seq)).toEqual([4])
  })

  it('reports a cursor that predates the replay buffer as clipped', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend, bufferLimit: 2 })
    if (hub instanceof Error) throw hub
    await hub.submit('hello')
    await wait(10)

    const seen: HubEvent[] = []
    const subscription = hub.subscribe({ cursor: 0, onEvent: (event) => seen.push(event) })
    if (subscription instanceof Error) throw subscription
    expect(subscription.clipped).toBe(true)
    expect(seen.map((event) => event.seq)).toEqual([3, 4])
  })

  it('refuses a second prompt while one turn is running', async () => {
    const { backend } = fakeBackend({ blocking: true })
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    expect(await hub.submit('first')).toMatchObject({ accepted: true })
    const second = await hub.submit('second')
    expect(second).toBeInstanceOf(Error)
    expect(hub.snapshot().busy).toBe(true)
  })

  it('reports the turn as no longer busy after it finishes', async () => {
    const { backend, release } = fakeBackend({ blocking: true })
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    await hub.submit('hello')
    release()
    await wait(10)
    expect(hub.snapshot().busy).toBe(false)
  })

  it('surfaces a failed turn as an event instead of throwing', async () => {
    const { backend } = fakeBackend({
      overrides: {
        async prompt() {
          return new Error('model access is disabled')
        },
      },
    })
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    const events: HubEvent[] = []
    hub.subscribe({ onEvent: (event) => events.push(event) })
    await hub.submit('hello')
    await wait(10)
    expect(events.at(-1)).toMatchObject({ type: 'prompt.failed', reason: 'model access is disabled' })
  })

  it('cancels only while a turn is running', async () => {
    const { backend, calls } = fakeBackend({ blocking: true })
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    expect(await hub.cancel()).toBeUndefined()
    await hub.submit('hello')
    expect(await hub.cancel()).toBeUndefined()
    expect(calls.cancels).toBe(1)
  })

  it('closes once and refuses new work afterwards', async () => {
    const { backend, calls } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    await hub.close()
    await hub.close()
    expect(calls.closes).toBe(1)
    expect(await hub.submit('hello')).toBeInstanceOf(Error)
    expect(await hub.cancel()).toBeInstanceOf(Error)
  })

  it('rejects empty prompt text, negative cursors and a bad buffer size', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    expect(await hub.submit('   ')).toBeInstanceOf(Error)
    expect(hub.subscribe({ cursor: -1, onEvent: () => {} })).toBeInstanceOf(Error)
    expect(hub.subscribe({ cursor: 99, onEvent: () => {} })).toBeInstanceOf(Error)
    expect(createSessionHub({ backend, bufferLimit: 0 })).toBeInstanceOf(Error)
  })

  it('drops a subscriber that throws without stopping the turn', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    hub.subscribe({
      onEvent: () => {
        throw new Error('client went away')
      },
    })
    const healthy: HubEvent[] = []
    hub.subscribe({ onEvent: (event) => healthy.push(event) })
    await hub.submit('hello')
    await wait(10)
    expect(healthy.map((event) => event.type)).toEqual([
      'session.started',
      'prompt.started',
      'prompt.chunk',
      'prompt.finished',
    ])
    expect(hub.snapshot().subscribers).toBe(1)
  })

  it('appends a durable log and restores sequence and session after restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-log-'))
    const logFile = path.join(dir, 'events.jsonl')
    try {
      const first = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (first instanceof Error) throw first
      await first.submit('hello')
      await wait(10)
      expect(first.snapshot()).toMatchObject({ seq: 4, durable: true, sessionId: 'session-1' })
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(4)
      expect(JSON.parse(lines[3]!)).toMatchObject({ seq: 4, type: 'prompt.finished' })
      await first.close()

      // A second hub on the same log continues the sequence and keeps the session.
      const second = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (second instanceof Error) throw second
      expect(second.snapshot()).toMatchObject({ seq: 4, sessionId: 'session-1', model: null, durable: true })
      const replayed: HubEvent[] = []
      const subscription = second.subscribe({ cursor: 0, onEvent: (event) => replayed.push(event) })
      if (subscription instanceof Error) throw subscription
      expect(replayed.map((event) => event.seq)).toEqual([1, 2, 3, 4])
      expect(subscription.clipped).toBe(false)
      await second.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays from the log when the cursor predates the buffer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-log-replay-'))
    const logFile = path.join(dir, 'events.jsonl')
    try {
      const hub = createSessionHub({ backend: fakeBackend().backend, logFile, bufferLimit: 2 })
      if (hub instanceof Error) throw hub
      await hub.submit('hello')
      await wait(10)
      const seen: HubEvent[] = []
      const subscription = hub.subscribe({ cursor: 0, onEvent: (event) => seen.push(event) })
      if (subscription instanceof Error) throw subscription
      expect(subscription.clipped).toBe(false)
      expect(subscription.source).toBe('log')
      expect(seen.map((event) => event.seq)).toEqual([1, 2, 3, 4])
      await hub.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tolerates a corrupt log line instead of failing the replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-log-corrupt-'))
    const logFile = path.join(dir, 'events.jsonl')
    try {
      fs.writeFileSync(logFile, `${JSON.stringify({ seq: 1, type: 'prompt.started', characters: 5 })}\n{not json}\n`)
      const hub = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (hub instanceof Error) throw hub
      expect(hub.snapshot().seq).toBe(1)
      const seen: HubEvent[] = []
      hub.subscribe({ cursor: 0, onEvent: (event) => seen.push(event) })
      expect(seen.map((event) => event.seq)).toEqual([1])
      await hub.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a second hub while the lease is held, then allows it after release', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-lease-'))
    const logFile = path.join(dir, 'events.jsonl')
    try {
      const first = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (first instanceof Error) throw first
      const blocked = createSessionHub({ backend: fakeBackend().backend, logFile })
      expect(blocked).toBeInstanceOf(Error)
      await first.close()
      const allowed = createSessionHub({ backend: fakeBackend().backend, logFile })
      expect(allowed).not.toBeInstanceOf(Error)
      if (allowed instanceof Error) throw allowed
      await allowed.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes over a lease left behind by a dead process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-stale-'))
    const logFile = path.join(dir, 'events.jsonl')
    const leaseFile = `${logFile}.lock`
    try {
      fs.writeFileSync(leaseFile, JSON.stringify({ pid: 999_999, startedAt: '2020-01-01T00:00:00.000Z' }))
      const hub = createSessionHub({ backend: fakeBackend().backend, logFile })
      expect(hub).not.toBeInstanceOf(Error)
      if (hub instanceof Error) throw hub
      expect(JSON.parse(fs.readFileSync(leaseFile, 'utf8'))).toMatchObject({ pid: process.pid })
      await hub.close()
      expect(fs.existsSync(leaseFile)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists attached clients with their acknowledged position', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    const first = hub.subscribe({ clientId: 'cli', onEvent: () => {} })
    const second = hub.subscribe({ clientId: 'discord', onEvent: () => {} })
    if (first instanceof Error || second instanceof Error) throw new Error('subscribe failed')
    expect(hub.snapshot().clients).toEqual([
      { clientId: 'cli', acked: 0 },
      { clientId: 'discord', acked: 0 },
    ])
    await hub.submit('hello')
    await wait(10)
    expect(hub.ack({ clientId: 'cli', seq: 4 })).toEqual({ acked: 4 })
    expect(hub.snapshot().clients).toContainEqual({ clientId: 'cli', acked: 4 })
    first.unsubscribe()
    expect(hub.snapshot().clients.map((entry) => entry.clientId)).toEqual(['discord'])
  })

  it('keeps acknowledgements monotonic and refuses invalid ones', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    const subscription = hub.subscribe({ clientId: 'cli', onEvent: () => {} })
    if (subscription instanceof Error) throw subscription
    await hub.submit('hello')
    await wait(10)
    expect(hub.ack({ clientId: 'cli', seq: 3 })).toEqual({ acked: 3 })
    // A stale ack from a reconnecting client must not move the position back.
    expect(hub.ack({ clientId: 'cli', seq: 1 })).toEqual({ acked: 3 })
    expect(hub.ack({ clientId: 'cli', seq: 4 })).toEqual({ acked: 4 })
    expect(hub.ack({ clientId: 'cli', seq: 5 })).toBeInstanceOf(Error)
    expect(hub.ack({ clientId: 'ghost', seq: 1 })).toBeInstanceOf(Error)
    expect(hub.ack({ clientId: '', seq: 1 })).toBeInstanceOf(Error)
    expect(hub.ack({ clientId: 'cli', seq: -1 })).toBeInstanceOf(Error)
  })

  it('refuses a duplicate client identity while it is attached', async () => {
    const { backend } = fakeBackend()
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    const first = hub.subscribe({ clientId: 'cli', onEvent: () => {} })
    if (first instanceof Error) throw first
    expect(hub.subscribe({ clientId: 'cli', onEvent: () => {} })).toBeInstanceOf(Error)
    first.unsubscribe()
    const again = hub.subscribe({ clientId: 'cli', onEvent: () => {} })
    expect(again).not.toBeInstanceOf(Error)
  })

  it('remembers an acknowledgement across a restart when the stream is durable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-acks-'))
    const logFile = path.join(dir, 'events.jsonl')
    try {
      const first = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (first instanceof Error) throw first
      const subscription = first.subscribe({ clientId: 'cli', onEvent: () => {} })
      if (subscription instanceof Error) throw subscription
      await first.submit('hello')
      await wait(10)
      expect(first.ack({ clientId: 'cli', seq: 4 })).toEqual({ acked: 4 })
      await first.close()

      const second = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (second instanceof Error) throw second
      const resumed = second.subscribe({ clientId: 'cli', onEvent: () => {} })
      if (resumed instanceof Error) throw resumed
      expect(second.snapshot().clients).toContainEqual({ clientId: 'cli', acked: 4 })
      await second.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not pretend to remember acks without a durable stream', async () => {
    const hub = createSessionHub({ backend: fakeBackend().backend })
    if (hub instanceof Error) throw hub
    const subscription = hub.subscribe({ clientId: 'cli', onEvent: () => {} })
    if (subscription instanceof Error) throw subscription
    await hub.submit('hello')
    await wait(10)
    expect(hub.ack({ clientId: 'cli', seq: 4 })).toEqual({ acked: 4 })
    expect(hub.snapshot().durable).toBe(false)
    const other = createSessionHub({ backend: fakeBackend().backend })
    if (other instanceof Error) throw other
    const fresh = other.subscribe({ clientId: 'cli', onEvent: () => {} })
    if (fresh instanceof Error) throw fresh
    expect(other.snapshot().clients).toContainEqual({ clientId: 'cli', acked: 0 })
  })

  it('clamps a stale ack file entry to the restored sequence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-acks-clamp-'))
    const logFile = path.join(dir, 'events.jsonl')
    const acksFile = `${logFile}.acks.json`
    try {
      fs.writeFileSync(logFile, `${JSON.stringify({ seq: 1, type: 'prompt.started', characters: 5 })}\n`)
      fs.writeFileSync(acksFile, JSON.stringify({ cli: 99 }))
      const hub = createSessionHub({ backend: fakeBackend().backend, logFile })
      if (hub instanceof Error) throw hub
      const subscription = hub.subscribe({ clientId: 'cli', onEvent: () => {} })
      if (subscription instanceof Error) throw subscription
      expect(hub.snapshot().clients).toContainEqual({ clientId: 'cli', acked: 1 })
      await hub.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
