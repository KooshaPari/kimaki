// Client side of a session hub.
//
// Any front end that can reach the loopback URL can attach, read the ordered
// stream from its own cursor, prompt, cancel and acknowledge progress. This is
// the piece that makes `ops jcode serve` usable by more than an ad-hoc script.
import { ConfigError } from '../errors.js'
import type { HubEvent, HubSnapshot } from './hub.ts'

export type HubClientOptions = {
  baseUrl: string
  fetch?: typeof globalThis.fetch | undefined
}

const origin = (baseUrl: string): string | Error => {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch (cause) {
    return new ConfigError({ reason: 'Supply an absolute hub URL', cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return new ConfigError({ reason: 'Hub URL must use http or https' })
  }
  if (url.username || url.password) return new ConfigError({ reason: 'Credentials in a hub URL are not accepted' })
  return url.origin
}

async function call(options: HubClientOptions, path: string, init?: RequestInit): Promise<Response | Error> {
  const base = origin(options.baseUrl)
  if (base instanceof Error) return base
  const call_ = options.fetch ?? globalThis.fetch
  try {
    return await call_(`${base}${path}`, init)
  } catch (cause) {
    return new ConfigError({ reason: `Cannot reach the hub at ${base}`, cause })
  }
}

export async function readHubState(options: HubClientOptions): Promise<HubSnapshot | Error> {
  const response = await call(options, '/state', { headers: { accept: 'application/json' } })
  if (response instanceof Error) return response
  if (!response.ok) return new ConfigError({ reason: `Hub refused /state with status ${response.status}` })
  try {
    return (await response.json()) as HubSnapshot
  } catch (cause) {
    return new ConfigError({ reason: 'Hub returned a state body that is not JSON', cause })
  }
}

export async function promptHub(options: HubClientOptions & { text: string }): Promise<{ accepted: boolean; characters: number } | Error> {
  const response = await call(options, '/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: options.text }),
  })
  if (response instanceof Error) return response
  if (!response.ok) return new ConfigError({ reason: `Hub refused the prompt with status ${response.status}` })
  try {
    return (await response.json()) as { accepted: boolean; characters: number }
  } catch (cause) {
    return new ConfigError({ reason: 'Hub returned a prompt body that is not JSON', cause })
  }
}

export async function cancelHub(options: HubClientOptions): Promise<true | Error> {
  const response = await call(options, '/cancel', { method: 'POST' })
  if (response instanceof Error) return response
  if (!response.ok) return new ConfigError({ reason: `Hub refused the cancel with status ${response.status}` })
  return true
}

export async function ackHub(options: HubClientOptions & { clientId: string; seq: number }): Promise<{ acked: number } | Error> {
  const response = await call(options, '/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: options.clientId, seq: options.seq }),
  })
  if (response instanceof Error) return response
  if (!response.ok) return new ConfigError({ reason: `Hub refused the ack with status ${response.status}` })
  try {
    return (await response.json()) as { acked: number }
  } catch (cause) {
    return new ConfigError({ reason: 'Hub returned an ack body that is not JSON', cause })
  }
}

export type HubReady = { client: string; cursor: number; clipped: boolean; source: 'none' | 'buffer' | 'log' }

/**
 * Attach to the event stream. `onReady` fires once with the server's resume
 * frame, then `onEvent` receives each hub event. Resolves when the stream ends
 * or the signal aborts, and resolves an Error only if attachment itself failed.
 */
export async function openHubStream({
  baseUrl,
  clientId,
  cursor = 0,
  onReady,
  onEvent,
  signal,
  fetch: fetchImpl,
}: HubClientOptions & {
  clientId?: string
  cursor?: number
  onReady?: (ready: HubReady) => void
  onEvent: (event: HubEvent) => void
  signal?: AbortSignal
}): Promise<Error | undefined> {
  if (!Number.isSafeInteger(cursor) || cursor < 0) return new ConfigError({ reason: 'Hub cursor must be a non-negative integer' })
  const base = origin(baseUrl)
  if (base instanceof Error) return base
  const query = new URLSearchParams({ cursor: String(cursor) })
  if (clientId !== undefined) query.set('client', clientId)
  const call_ = fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await call_(`${base}/events?${query.toString()}`, { headers: { accept: 'text/event-stream' }, signal })
  } catch (cause) {
    return new ConfigError({ reason: `Cannot attach to the hub at ${base}`, cause })
  }
  if (!response.ok || response.body === null) {
    return new ConfigError({ reason: `Hub refused the stream with status ${response.status}` })
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        if (!data) continue
        let payload: unknown
        try {
          payload = JSON.parse(data.slice('data: '.length))
        } catch {
          continue
        }
        if (typeof payload !== 'object' || payload === null) continue
        if ('type' in payload) onEvent(payload as HubEvent)
        else onReady?.(payload as HubReady)
      }
    }
  } catch (cause) {
    // An aborted stream is a normal exit, not a failure.
    if (signal?.aborted) return undefined
    return new ConfigError({ reason: 'Hub stream ended unexpectedly', cause })
  } finally {
    await reader.cancel().catch(() => {})
  }
}
