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
})
