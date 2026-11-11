// Read-only native OpenCode V2 boundary. No adoption, instruction installation,
// process ownership or surface publication. The caller explicitly selects the
// endpoint and authorizes each session read/subscription.
import type { OpenCodeClient, V2Event } from '@opencode/client'
import * as errore from 'errore'
import { ConfigError, OpenCodeError, OpenCodeVersionError } from '../../errors.js'
import { isSupportedVersion, MIN_OPENCODE_VERSION, type OpencodeEndpoint } from '../../opencode-server.js'
import type { SessionKey } from '../contracts.js'
import { passiveCapabilities, sessionKeyId } from '../registry.js'

type ListInput = NonNullable<Parameters<OpenCodeClient['session']['list']>[0]>
type ReadOptions = { signal?: AbortSignal }

export type OpenCodeObservedEvent = {
  schemaVersion: 1
  key: SessionKey
  source: { hostId: string; endpointId: string; backendKind: 'opencode'; version: string }
  // Preserve the entire native envelope: IDs, source timestamps, durable
  // sequence, location, metadata and unrecognized native payload fields.
  raw: V2Event
}

export type OpenCodeObservation = {
  detach: () => void
  // null on explicit detach/cancel. Stream loss and callback failure are values.
  done: Promise<OpenCodeError | null>
}

export function createOpenCodeObserver({ endpoint, hostId, endpointId }: {
  endpoint: OpencodeEndpoint
  hostId: string
  endpointId: string
}) {
  const identity = sessionKeyId({ hostId, endpointId, backendKind: 'opencode', nativeSessionId: 'validation' })
  if (identity instanceof Error) return identity
  const url = errore.try(() => new URL(endpoint.url), (cause) => new ConfigError({ reason: 'Select an explicit HTTP OpenCode endpoint', cause }))
  if (url instanceof Error) return url
  if (!['http:', 'https:'].includes(url.protocol)) return new ConfigError({ reason: 'Select an explicit HTTP OpenCode endpoint' })
  if (!isSupportedVersion(endpoint.version) || !/^\d+\.\d+\.\d+/.test(endpoint.version)) {
    return new OpenCodeVersionError({ version: endpoint.version, minimum: MIN_OPENCODE_VERSION })
  }
  // Capture a fixed endpoint, not the mutable connection.endpoint on reconnect.
  // endpointId is the caller's registered endpoint identity, not a PID or cwd.
  const { client, version } = endpoint
  const source = Object.freeze({ hostId, endpointId, backendKind: 'opencode' as const, version })
  const keyFor = (nativeSessionId: string): SessionKey => ({ hostId, endpointId, backendKind: 'opencode', nativeSessionId })
  const validate = (key: SessionKey) => {
    const id = sessionKeyId(key)
    if (id instanceof Error) return id
    if (key.hostId !== hostId || key.endpointId !== endpointId || key.backendKind !== 'opencode') {
      return new ConfigError({ reason: 'Session identity does not match this OpenCode endpoint. Select its registered observer' })
    }
    return null
  }
  const request = ({ signal }: ReadOptions = {}) => ({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })

  return {
    capabilities: {
      ...passiveCapabilities,
      snapshot: { kind: 'supported' as const },
      observe: { kind: 'supported' as const },
      replay: { kind: 'unsupported' as const, reason: 'Live subscription is not a durable replay cursor. Resnapshot after stream loss' },
      exclusiveControl: { kind: 'unsupported' as const, reason: 'No native UI fencing or exclusive writer lease is established' },
    },

    // One bounded native page, with the native cursor exposed rather than
    // silently truncating or scanning all sessions/history on this endpoint.
    async discover(input: ListInput = {}, options: ReadOptions = {}) {
      const page = await client.session.list(input, request(options)).catch((cause) => new OpenCodeError({ operation: 'session.list', cause }))
      if (page instanceof Error) return page
      return { source, sessions: page.data.map((native) => ({ key: keyFor(native.id), native })), cursor: page.cursor }
    },

    // An explicit historical read, never implicit in observe(). These two native
    // reads are not atomic, and this page is not a competing transcript store.
    async readSnapshot({ key, cursor, limit = 100 }: { key: SessionKey; cursor?: string; limit?: number }, options: ReadOptions = {}) {
      const invalid = validate(key)
      if (invalid instanceof Error) return invalid
      const scopedKey = Object.freeze({ ...key })
      const session = await client.session.get({ sessionID: scopedKey.nativeSessionId }, request(options)).catch((cause) => new OpenCodeError({ operation: 'session.get', cause }))
      if (session instanceof Error) return session
      if (session.id !== scopedKey.nativeSessionId) return new ConfigError({ reason: 'Native session read returned a different identity' })
      const messages = await client.message.list({ sessionID: scopedKey.nativeSessionId, cursor, limit, order: 'asc' }, request(options)).catch((cause) => new OpenCodeError({ operation: 'message.list', cause }))
      if (messages instanceof Error) return messages
      return { key: scopedKey, source, session, messages, consistency: 'non-atomic' as const }
    },

    // Resolves only after server.connected, so the caller can safely arrange a
    // subsequent native lifecycle action without racing subscription startup.
    // Exact session only, not implicit descendants or endpoint-wide publication.
    // The native transport still receives endpoint-wide events before this local
    // filter. Select only an authorized endpoint. This is not server-side session
    // isolation, and callbacks must not publish data without a surface policy.
    async observe({ key, signal, onEvent }: {
      key: SessionKey
      signal?: AbortSignal
      onEvent: (event: OpenCodeObservedEvent) => Promise<void> | void
    }): Promise<ConfigError | OpenCodeError | OpenCodeObservation> {
      const invalid = validate(key)
      if (invalid instanceof Error) return invalid
      if (signal?.aborted) return new OpenCodeError({ operation: 'event.subscribe', cause: signal.reason })
      const scopedKey = Object.freeze({ ...key })
      const owned = new AbortController()
      const detach = () => { owned.abort() }
      const subscriptionSignal = signal ? AbortSignal.any([signal, owned.signal]) : owned.signal
      const iterator = errore.try(
        () => client.event.subscribe({ signal: subscriptionSignal })[Symbol.asyncIterator](),
        (cause) => new OpenCodeError({ operation: 'event.subscribe', cause }),
      )
      if (iterator instanceof Error) return iterator
      const close = async () => {
        detach()
        return Promise.resolve().then(() => iterator.return?.()).catch((cause) => new OpenCodeError({ operation: 'event.unsubscribe', cause }))
      }
      const timeout = setTimeout(detach, 10_000)
      const first = await iterator.next().catch((cause) => new OpenCodeError({ operation: 'event.subscribe', cause }))
      clearTimeout(timeout)
      if (first instanceof Error || first.done || first.value.type !== 'server.connected' || subscriptionSignal.aborted) {
        const cleanup = await close()
        if (first instanceof Error) return first
        if (cleanup instanceof Error) return cleanup
        return new OpenCodeError({ operation: 'event.subscribe', cause: new Error('No server.connected handshake before cancellation or stream closure') })
      }
      const run = async (): Promise<OpenCodeError | null> => {
        while (!subscriptionSignal.aborted) {
          const next = await iterator.next().catch((cause) => new OpenCodeError({ operation: 'event.subscribe', cause }))
          if (subscriptionSignal.aborted) return null
          if (next instanceof Error) return next
          if (next.done) return new OpenCodeError({ operation: 'event.subscribe', cause: new Error('Native stream closed. Resnapshot before observing again') })
          const raw = next.value
          if (!raw || typeof raw !== 'object' || !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) {
            return new OpenCodeError({ operation: 'event.decode', cause: new Error('Native event data must be an object') })
          }
          if (!('sessionID' in raw.data) || raw.data.sessionID !== scopedKey.nativeSessionId) continue
          // Await consumers in order, but never make detach wait for consumer
          // work we cannot cancel. Attach the rejection handler immediately so a
          // promise rejected after detach cannot become an unhandled rejection.
          const delivered = Promise.resolve().then(() => {
            if (subscriptionSignal.aborted) return
            return onEvent({ schemaVersion: 1, key: scopedKey, source, raw })
          }).catch((cause) => new OpenCodeError({ operation: 'observer.onEvent', cause }))
          const cancelled = Promise.withResolvers<null>()
          const onAbort = () => { cancelled.resolve(null) }
          subscriptionSignal.addEventListener('abort', onAbort, { once: true })
          if (subscriptionSignal.aborted) onAbort()
          const result = await Promise.race([delivered, cancelled.promise])
          subscriptionSignal.removeEventListener('abort', onAbort)
          if (subscriptionSignal.aborted) return null
          if (result instanceof Error) return result
        }
        return null
      }
      const done = run().catch((cause) => new OpenCodeError({ operation: 'observer.run', cause })).then(async (result) => {
        const cleanup = await close()
        if (result instanceof Error) return result
        if (cleanup instanceof Error) return cleanup
        return null
      })
      return { detach, done }
    },
  }
}
