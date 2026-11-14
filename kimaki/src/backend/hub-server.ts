// Loopback HTTP surface for a session hub, so separate front ends can attach to
// one live backend session at the same time.
//
// GET  /state            hub snapshot
// POST /prompt  {text}   submit one turn (single writer, refused while busy)
// POST /cancel           cancel the running turn
// GET  /events?cursor=N  server-sent events, replayed from the cursor then live
//
// This binds 127.0.0.1 only. When a token is supplied, every request must carry
// it in the x-kimaki-hub header. No request reads a transcript from disk.
import http from 'node:http'
import { ConfigError } from '../errors.js'
import type { HubEvent, SessionHub } from './hub.ts'

const EVENT_NAME = 'hub'

export async function startHubServer({
  hub,
  port = 0,
  token,
}: {
  hub: SessionHub
  port?: number
  token?: string
}): Promise<{ url: string; port: number; close: () => Promise<void> } | Error> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    return new ConfigError({ reason: 'Hub server port must be an integer between 0 and 65535' })
  }
  const clients = new Set<http.ServerResponse>()
  const authorized = (request: http.IncomingMessage): boolean => {
    if (token === undefined) return true
    return request.headers['x-kimaki-hub'] === token
  }
  const json = (response: http.ServerResponse, code: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    response.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }
  const readBody = async (request: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!authorized(request)) return json(response, 401, { error: 'unauthorized' })
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/state') {
        return json(response, 200, hub.snapshot())
      }
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const body = await readBody(request)
        const text = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['text'] : undefined
        if (typeof text !== 'string') return json(response, 400, { error: 'prompt body needs a text string' })
        const result = await hub.submit(text)
        if (result instanceof Error) return json(response, 409, { error: result.message })
        return json(response, 202, result)
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const result = await hub.cancel()
        if (result instanceof Error) return json(response, 409, { error: result.message })
        return json(response, 200, { cancelled: true })
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const raw = url.searchParams.get('cursor')
        const cursor = raw === null ? 0 : Number(raw)
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          return json(response, 400, { error: 'cursor must be a non-negative integer' })
        }
        const write = (event: HubEvent): void => {
          response.write(`event: ${EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`)
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const subscription = hub.subscribe({ cursor, onEvent: write })
        if (subscription instanceof Error) {
          return json(response, 400, { error: subscription.message })
        }
        clients.add(response)
        // Tell the client where it resumed from and whether events were lost.
        response.write(`event: ready\ndata: ${JSON.stringify({ cursor, clipped: subscription.clipped })}\n\n`)
        const cleanup = (): void => {
          subscription.unsubscribe()
          clients.delete(response)
        }
        request.on('close', cleanup)
        return undefined
      }
      return json(response, 404, { error: 'not found' })
    })().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: String(error) })
      else response.end()
    })
  })

  const listening = await new Promise<Error | number>((resolve) => {
    server.once('error', (error) => resolve(error))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
  if (listening instanceof Error) {
    return new ConfigError({ reason: 'Cannot bind the hub server to loopback', cause: listening })
  }

  return {
    url: `http://127.0.0.1:${listening}`,
    port: listening,
    close: async () => {
      for (const client of clients) client.end()
      clients.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
