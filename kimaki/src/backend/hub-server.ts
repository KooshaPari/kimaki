// Loopback HTTP surface for a session hub, so separate front ends can attach to
// one live backend session at the same time.
//
// GET  /state            hub snapshot, including attached clients and their acks
// POST /prompt  {text, requestId?}  submit one turn; a repeated requestId refers to the receipt
// POST /cancel           cancel the running turn
// POST /ack {client, seq} record how far a client has processed the stream
// GET  /events?cursor=N&client=<id>  server-sent events, replayed from the cursor then live
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
        const requestId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['requestId'] : undefined
        const result = await hub.submit(text, typeof requestId === 'string' ? { requestId } : undefined)
        if (result instanceof Error) return json(response, 409, { error: result.message })
        return json(response, 202, result)
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const result = await hub.cancel()
        if (result instanceof Error) return json(response, 409, { error: result.message })
        return json(response, 200, { cancelled: true })
      }
      if (request.method === 'POST' && url.pathname === '/ack') {
        const body = await readBody(request)
        const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
        const clientId = record?.['client']
        const cursor = record?.['seq']
        if (typeof clientId !== 'string' || typeof cursor !== 'number') {
          return json(response, 400, { error: 'ack body needs client and seq' })
        }
        const result = hub.ack({ clientId, seq: cursor })
        if (result instanceof Error) {
          // Unknown client is a routing problem, not a bad request body.
          const code = /not attached/.test(result.message) ? 404 : 409
          return json(response, code, { error: result.message })
        }
        return json(response, 200, result)
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const raw = url.searchParams.get('cursor')
        const cursor = raw === null ? 0 : Number(raw)
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          return json(response, 400, { error: 'cursor must be a non-negative integer' })
        }
        const writeFrame = (event: HubEvent): void => {
          response.write(`event: ${EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`)
        }
        // Subscribe BEFORE any SSE header is written: a refused subscription (for
        // example a cursor ahead of the stream) must reach the client as a real 400,
        // not as a 200 whose body is JSON on an event-stream connection.
        const pending: HubEvent[] = []
        let readySent = false
        const subscription = hub.subscribe({
          cursor,
          clientId: url.searchParams.get('client') ?? undefined,
          onEvent: (event) => {
            if (readySent) writeFrame(event)
            else pending.push(event)
          },
        })
        if (subscription instanceof Error) {
          return json(response, 400, { error: subscription.message })
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        // The hub replays synchronously inside subscribe, so replayed events were
        // buffered above; flush them after the ready frame below.
        clients.add(response)
        readySent = true
        response.write(`event: ready\ndata: ${JSON.stringify({ client: subscription.clientId, cursor, clipped: subscription.clipped, source: subscription.source })}\n\n`)
        for (const event of pending) writeFrame(event)
        pending.length = 0
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          subscription.unsubscribe()
          clients.delete(response)
        }
        // An aborted SSE stream closes the response, not necessarily the request.
        // Both are wired so presence never outlives the connection.
        request.on('close', cleanup)
        response.on('close', cleanup)
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
