import { afterEach, describe, expect, it } from 'vitest'
import { createSessionHub, type HubBackend, type HubEvent } from './hub.ts'
import { startHubServer } from './hub-server.ts'
import { ackHub, cancelHub, openHubStream, promptHub, readHubState } from './hub-client.ts'

const servers: Array<{ close: () => Promise<void> }> = []
const hubs: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const hub of hubs.splice(0)) await hub.close()
})

function fakeBackend(): HubBackend {
  return {
    async start(input) {
      return { sessionId: 'session-client', model: input?.model ?? null }
    },
    async prompt(_text, onChunk) {
      onChunk?.('o')
      onChunk?.('k')
      return { stopReason: 'end_turn', text: 'ok', updateCount: 2 }
    },
    async cancel() {
      return undefined
    },
    async close() {},
  }
}

async function boot() {
  const hub = createSessionHub({ backend: fakeBackend(), model: 'beam-free' })
  if (hub instanceof Error) throw hub
  hubs.push(hub)
  const created = await startHubServer({ hub, port: 0 })
  if (created instanceof Error) throw created
  servers.push(created)
  return { server: created }
}

describe('hub client', () => {
  it('reads state, prompts, streams the turn and acknowledges it', async () => {
    const { server } = await boot()
    const before = await readHubState({ baseUrl: server.url })
    expect(before).not.toBeInstanceOf(Error)
    if (before instanceof Error) throw before
    expect(before).toMatchObject({ sessionId: null, seq: 0, busy: false, durable: false })

    const events: HubEvent[] = []
    let ready: { client: string; cursor: number } | undefined
    let settle: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      settle = resolve
    })
    const controller = new AbortController()
    const attach = openHubStream({
      baseUrl: server.url,
      clientId: 'cli',
      cursor: 0,
      signal: controller.signal,
      onReady: (frame) => {
        ready = frame
      },
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'prompt.finished') settle?.()
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    const submitted = await promptHub({ baseUrl: server.url, text: 'hello' })
    expect(submitted).toEqual({ accepted: true, characters: 5 })
    await finished

    // Acknowledge while still attached: presence ends with the connection.
    const acked = await ackHub({ baseUrl: server.url, clientId: 'cli', seq: 5 })
    expect(acked).toEqual({ acked: 5 })

    controller.abort()
    expect(await attach).toBeUndefined()

    expect(ready).toMatchObject({ client: 'cli', cursor: 0 })
    expect(events.map((event) => `${event.seq}:${event.type}`)).toEqual([
      '1:session.started',
      '2:prompt.started',
      '3:prompt.chunk',
      '4:prompt.chunk',
      '5:prompt.finished',
    ])
  })

  it('reports a refused prompt instead of hanging', async () => {
    const { server } = await boot()
    const refused = await promptHub({ baseUrl: server.url, text: '   ' })
    // An empty prompt is a bad request; the client must surface it, not block.
    expect(refused).toBeInstanceOf(Error)
  })

  it('refuses an invalid or unreachable hub URL', async () => {
    expect(await readHubState({ baseUrl: 'not a url' })).toBeInstanceOf(Error)
    expect(await readHubState({ baseUrl: 'file:///tmp/hub' })).toBeInstanceOf(Error)
    expect(await readHubState({ baseUrl: 'http://user:pass@127.0.0.1:1' })).toBeInstanceOf(Error)
    expect(await readHubState({ baseUrl: 'http://127.0.0.1:1' })).toBeInstanceOf(Error)
    expect(await openHubStream({ baseUrl: 'http://127.0.0.1:1', onEvent: () => {} })).toBeInstanceOf(Error)
  })

  it('refuses a negative cursor and an ack for an unknown client', async () => {
    const { server } = await boot()
    expect(await openHubStream({ baseUrl: server.url, cursor: -1, onEvent: () => {} })).toBeInstanceOf(Error)
    expect(await ackHub({ baseUrl: server.url, clientId: 'ghost', seq: 0 })).toBeInstanceOf(Error)
  })

  it('cancels through the client and treats an idle cancel as success', async () => {
    const { server } = await boot()
    expect(await cancelHub({ baseUrl: server.url })).toBe(true)
  })
})
