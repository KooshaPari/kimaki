import { afterEach, describe, expect, it } from 'vitest'
import { createSessionHub, type HubBackend, type HubEvent } from './hub.ts'
import { startHubServer } from './hub-server.ts'

const servers: Array<{ close: () => Promise<void> }> = []
const hubs: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const hub of hubs.splice(0)) await hub.close()
})

function fakeBackend(chunks: string[] = ['o', 'k']): HubBackend {
  return {
    async start(input) {
      return { sessionId: 'session-http', model: input?.model ?? null }
    },
    async prompt(_text, onChunk) {
      for (const chunk of chunks) onChunk?.(chunk)
      return { stopReason: 'end_turn', text: chunks.join(''), updateCount: chunks.length }
    },
    async cancel() {
      return undefined
    },
    async close() {},
  }
}

async function boot({ token, chunks }: { token?: string; chunks?: string[] } = {}) {
  const hub = createSessionHub({ backend: fakeBackend(chunks), model: 'beam-free' })
  if (hub instanceof Error) throw hub
  hubs.push(hub)
  const server = await startHubServer({ hub, port: 0, token })
  if (server instanceof Error) throw server
  servers.push(server)
  const headers: Record<string, string> = token === undefined ? {} : { 'x-kimaki-hub': token }
  return { hub, server, headers }
}

// Reads server-sent events until `until` matches or the deadline passes. The
// first frame is the server's `ready` frame, which reports the resume cursor and
// whether replay was clipped, so it is returned separately from hub events.
async function readEvents(url: string, headers: Record<string, string>, until: (events: HubEvent[]) => boolean, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(url, { headers, signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: HubEvent[] = []
  let ready: { cursor: number; clipped: boolean } | undefined
  let buffer = ''
  try {
    while (!until(events)) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const line = frame.split('\n').find((part) => part.startsWith('data: '))
        if (!line) continue
        const payload = JSON.parse(line.slice('data: '.length)) as HubEvent | { cursor: number; clipped: boolean }
        if ('type' in payload) events.push(payload as HubEvent)
        else ready ??= payload as { cursor: number; clipped: boolean }
        if (until(events)) break
      }
    }
  } catch {
    // Abort or a closed stream both end the read; the caller asserts on events.
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return { events, ready }
}

describe('startHubServer', () => {
  it('reports state and refuses a bad cursor', async () => {
    const { server, headers } = await boot()
    const state = await fetch(`${server.url}/state`, { headers })
    expect(state.status).toBe(200)
    expect(await state.json()).toMatchObject({ sessionId: null, busy: false, seq: 0, subscribers: 0 })
    const bad = await fetch(`${server.url}/events?cursor=-5`, { headers })
    expect(bad.status).toBe(400)
  })

  it('fans one prompt to two independent clients', async () => {
    const { server, headers } = await boot()
    const finished = (events: HubEvent[]) => events.some((event) => event.type === 'prompt.finished')
    const first = readEvents(`${server.url}/events?cursor=0`, headers, finished)
    const second = readEvents(`${server.url}/events?cursor=0`, headers, finished)
    const posted = await fetch(`${server.url}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(posted.status).toBe(202)
    expect(await posted.json()).toEqual({ accepted: true, characters: 5 })

    for (const result of [await first, await second]) {
      expect(result.ready).toEqual({ cursor: 0, clipped: false })
      expect(result.events.map((event) => event.type)).toEqual([
        'session.started',
        'prompt.started',
        'prompt.chunk',
        'prompt.chunk',
        'prompt.finished',
      ])
      expect(result.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    }
  })

  it('replays from a cursor so a late client sees the whole turn', async () => {
    const { server, headers } = await boot()
    await fetch(`${server.url}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    // Give the detached turn a moment to publish its events.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const { events } = await readEvents(`${server.url}/events?cursor=0`, headers, (seen) => seen.length >= 5)
    expect(events.map((event) => event.type).at(-1)).toBe('prompt.finished')
  })

  it('requires the token when one is configured', async () => {
    const { server } = await boot({ token: 'shared-secret' })
    const denied = await fetch(`${server.url}/state`)
    expect(denied.status).toBe(401)
    const allowed = await fetch(`${server.url}/state`, { headers: { 'x-kimaki-hub': 'shared-secret' } })
    expect(allowed.status).toBe(200)
  })

  it('rejects a prompt body without text and cancels when idle', async () => {
    const { server, headers } = await boot()
    const bad = await fetch(`${server.url}/prompt`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(bad.status).toBe(400)
    const cancel = await fetch(`${server.url}/cancel`, { method: 'POST', headers })
    expect(cancel.status).toBe(200)
    expect(await cancel.json()).toEqual({ cancelled: true })
  })

  it('returns 404 for an unknown route', async () => {
    const { server, headers } = await boot()
    const missing = await fetch(`${server.url}/nope`, { headers })
    expect(missing.status).toBe(404)
  })
})
