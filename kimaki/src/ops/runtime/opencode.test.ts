import { setTimeout as sleep } from 'node:timers/promises'
import { OpenCode, type SessionInfo, type V2Event } from '@opencode/client'
import { describe, expect, test, vi } from 'vitest'
import { ConfigError, OpenCodeError } from '../../errors.js'
import { createOpenCodeObserver } from './opencode.js'

function value<T>(result: T): Exclude<T, Error> {
  if (result instanceof Error) throw result
  return result as Exclude<T, Error>
}

const key = { hostId: 'host-a', endpointId: 'endpoint-a', backendKind: 'opencode', nativeSessionId: 'ses_native' }
const renamed = (sessionID = key.nativeSessionId): V2Event => ({
  id: 'evt_native', created: 123, type: 'session.renamed',
  durable: { aggregateID: sessionID, seq: 7, version: 1 },
  data: { sessionID, title: 'Native title' },
})

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected native operation'))
  const client = OpenCode.make({ baseUrl: 'http://observer.invalid', fetch })
  const endpoint = { client, url: 'http://observer.invalid', version: '2.0.29' }
  const observer = value(createOpenCodeObserver({ endpoint, hostId: key.hostId, endpointId: key.endpointId }))
  return { client, endpoint, observer, fetch }
}

// A cancellable native transport fixture. Each subscription owns only its iterator.
function stream(client: ReturnType<typeof setup>['client']) {
  const subscribers = new Set<(event: V2Event) => void>()
  const subscribe = vi.spyOn(client.event, 'subscribe').mockImplementation(({ signal } = {}) => ({
    [Symbol.asyncIterator]() {
      const queued: V2Event[] = [{ id: 'evt_connected', type: 'server.connected', data: {} }]
      const state: { pending: ((item: IteratorResult<V2Event>) => void) | null; closed: boolean } = { pending: null, closed: false }
      const push = (event: V2Event) => {
        if (state.pending) { const resolve = state.pending; state.pending = null; resolve({ done: false, value: event }); return }
        queued.push(event)
      }
      const close = () => {
        state.closed = true
        subscribers.delete(push)
        signal?.removeEventListener('abort', close)
        state.pending?.({ done: true, value: undefined })
      }
      subscribers.add(push)
      signal?.addEventListener('abort', close, { once: true })
      if (signal?.aborted) close()
      return {
        next: async () => {
          if (state.closed) return { done: true as const, value: undefined }
          const event = queued.shift()
          if (event) return { done: false as const, value: event }
          return new Promise<IteratorResult<V2Event>>((resolve) => { state.pending = resolve })
        },
        return: async () => { close(); return { done: true as const, value: undefined } },
      }
    },
  }))
  return { subscribe, subscribers, emit: (event: V2Event) => subscribers.forEach((push) => push(event)) }
}

describe('read-only OpenCode observer', () => {
  test('discovery preserves endpoint identity, native records and pagination without reading history', async () => {
    const { observer, client, fetch } = setup()
    const native: SessionInfo = {
      id: key.nativeSessionId, projectID: 'project_test', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 }, location: { directory: 'E:/test' },
    }
    const page = { data: [native], cursor: { next: 'native-page-cursor' } }
    const list = vi.spyOn(client.session, 'list').mockResolvedValue(page)
    const result = value(await observer.discover({ limit: 2 }))
    expect(result.sessions).toEqual([{ key, native }])
    expect(result.cursor).toBe(page.cursor)
    expect(result.sessions[0]?.native).toBe(native)
    expect(list).toHaveBeenCalledWith({ limit: 2 }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetch).not.toHaveBeenCalled()
  })

  test('snapshot is an explicit native read page, not adoption or atomic/replay truth', async () => {
    const { observer, client, fetch } = setup()
    const native: SessionInfo = {
      id: key.nativeSessionId, projectID: 'project_test', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 }, location: { directory: 'E:/test' },
    }
    vi.spyOn(client.session, 'get').mockResolvedValue(native)
    const messages = { data: [], cursor: { next: 'native-cursor' } }
    const read = vi.spyOn(client.message, 'list').mockResolvedValue(messages)
    const result = value(await observer.readSnapshot({ key, cursor: 'previous', limit: 3 }))
    expect(result).toMatchObject({ key, session: native, messages, consistency: 'non-atomic' })
    expect(result.messages).toBe(messages)
    expect(read).toHaveBeenCalledWith({ sessionID: key.nativeSessionId, cursor: 'previous', limit: 3, order: 'asc' }, expect.anything())
    expect(fetch).not.toHaveBeenCalled()
    expect(observer.capabilities.control.create.kind).toBe('unsupported')
    expect(observer.capabilities.control.submit.kind).toBe('unsupported')
    expect(observer.capabilities.control.interrupt.kind).toBe('unsupported')
    expect(observer.capabilities.control.answerApproval.kind).toBe('unsupported')
    expect(observer.capabilities.exclusiveControl.kind).toBe('unsupported')
    expect(observer.capabilities.replay.kind).toBe('unsupported')
  })

  test.each(['hostId', 'endpointId', 'backendKind', 'nativeSessionId'] as const)('rejects invalid %s before I/O', async (field) => {
    const { observer, fetch, client } = setup()
    const subscription = vi.spyOn(client.event, 'subscribe')
    const invalid = { ...key, [field]: field === 'nativeSessionId' ? '' : 'other' }
    expect(await observer.readSnapshot({ key: invalid })).toBeInstanceOf(ConfigError)
    expect(await observer.observe({ key: invalid, onEvent: vi.fn() })).toBeInstanceOf(ConfigError)
    expect(subscription).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('observe preserves raw envelope and filters exact native session, detach only releases owned subscription', async () => {
    const { observer, client, fetch } = setup()
    const transport = stream(client)
    const first = vi.fn()
    const second = vi.fn()
    const a = value(await observer.observe({ key, onEvent: first }))
    const b = value(await observer.observe({ key, onEvent: second }))
    const raw = renamed()
    transport.emit(renamed('ses_unrelated'))
    transport.emit(raw)
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(first.mock.calls[0]?.[0]).toMatchObject({ key, schemaVersion: 1, source: { backendKind: 'opencode', endpointId: key.endpointId, hostId: key.hostId, version: '2.0.29' } })
    expect(first.mock.calls[0]?.[0].raw).toBe(raw)
    a.detach()
    a.detach()
    expect(await a.done).toBeNull()
    transport.emit(raw)
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(2))
    expect(first).toHaveBeenCalledTimes(1)
    expect(transport.subscribers.size).toBe(1)
    b.detach()
    expect(await b.done).toBeNull()
    expect(transport.subscribers.size).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('abort releases observation and prevents late callbacks', async () => {
    const { observer, client } = setup()
    const transport = stream(client)
    const controller = new AbortController()
    const onEvent = vi.fn()
    const handle = value(await observer.observe({ key, signal: controller.signal, onEvent }))
    controller.abort()
    expect(await handle.done).toBeNull()
    transport.emit(renamed())
    expect(onEvent).not.toHaveBeenCalled()
    expect(transport.subscribers.size).toBe(0)
    expect(await observer.observe({ key, signal: controller.signal, onEvent })).toBeInstanceOf(OpenCodeError)
  })

  test('callback failure is reported and releases only its own subscription', async () => {
    const { observer, client } = setup()
    const transport = stream(client)
    const cause = new Error('consumer failed')
    const sibling = value(await observer.observe({ key, onEvent: vi.fn() }))
    const handle = value(await observer.observe({ key, onEvent: () => { throw cause } }))
    transport.emit(renamed())
    const result = await handle.done
    expect(result).toBeInstanceOf(OpenCodeError)
    expect(result?.cause).toBe(cause)
    expect(transport.subscribers.size).toBe(1)
    sibling.detach()
    expect(await sibling.done).toBeNull()
  })

  test('async callback rejection is a tagged completion value and closes its subscription', async () => {
    const { observer, client } = setup()
    const transport = stream(client)
    const cause = new Error('async consumer failed')
    const callback = vi.fn(async () => { throw cause })
    const handle = value(await observer.observe({ key, onEvent: callback }))
    try {
      transport.emit(renamed())
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
      const result = await Promise.race([handle.done, sleep(200).then(() => 'still pending')])
      expect(result).toBeInstanceOf(OpenCodeError)
      if (!(result instanceof OpenCodeError)) throw new Error('Missing tagged callback error')
      expect(result.operation).toBe('observer.onEvent')
      expect(result.cause).toBe(cause)
      expect(transport.subscribers.size).toBe(0)
    } finally {
      handle.detach()
      await handle.done
    }
  })

  test('pending async callback is serialized, detach completes and late rejection is handled', async () => {
    const { observer, client } = setup()
    const transport = stream(client)
    const pending = Promise.withResolvers<void>()
    const callback = vi.fn(() => pending.promise)
    const siblingCallback = vi.fn()
    const handle = value(await observer.observe({ key, onEvent: callback }))
    const sibling = value(await observer.observe({ key, onEvent: siblingCallback }))
    try {
      transport.emit(renamed())
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
      transport.emit(renamed())
      await vi.waitFor(() => expect(siblingCallback).toHaveBeenCalledTimes(2))
      expect(callback).toHaveBeenCalledTimes(1)
      handle.detach()
      expect(await Promise.race([handle.done, sleep(200).then(() => 'still pending')])).toBeNull()
      pending.reject(new Error('callback rejected after detach'))
      await sleep(0)
      expect(transport.subscribers.size).toBe(1)
      transport.emit(renamed())
      await vi.waitFor(() => expect(siblingCallback).toHaveBeenCalledTimes(3))
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      handle.detach()
      sibling.detach()
      pending.resolve()
      await Promise.all([handle.done, sibling.done])
    }
  })

  test('async callback completion allows the next native event in order', async () => {
    const { observer, client } = setup()
    const transport = stream(client)
    const pending = Promise.withResolvers<void>()
    const callback = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined)
    const handle = value(await observer.observe({ key, onEvent: callback }))
    try {
      transport.emit(renamed())
      transport.emit({ ...renamed(), id: 'evt_second' })
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
      expect(callback).toHaveBeenCalledTimes(1)
      pending.resolve()
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
      expect(callback.mock.calls.map(([event]) => event.raw.id)).toEqual(['evt_native', 'evt_second'])
    } finally {
      pending.resolve()
      handle.detach()
      await handle.done
    }
  })

  test.each([null, undefined, 'not an object', 42, []])('malformed event data %j returns a tagged error and releases owned iterator', async (data) => {
    const { observer, client } = setup()
    const transport = stream(client)
    const callback = vi.fn()
    const handle = value(await observer.observe({ key, onEvent: callback }))
    transport.emit({ ...renamed(), data } as unknown as V2Event)
    const result = await Promise.race([handle.done.catch((error: unknown) => error), sleep(200).then(() => 'still pending')])
    const retained = transport.subscribers.size
    handle.detach()
    expect(result).toBeInstanceOf(OpenCodeError)
    expect(retained).toBe(0)
    expect(callback).not.toHaveBeenCalled()
  })

  test('unexpected run failure is tagged before shared iterator cleanup', async () => {
    const { observer, client } = setup()
    const transport = stream(client)
    const cause = new Error('unexpected envelope accessor failure')
    const malformed = Object.defineProperty({ ...renamed() }, 'data', { get: () => { throw cause } })
    const handle = value(await observer.observe({ key, onEvent: vi.fn() }))
    transport.emit(malformed)
    const result = await handle.done.catch((error: unknown) => error)
    const retained = transport.subscribers.size
    handle.detach()
    expect(result).toBeInstanceOf(OpenCodeError)
    if (!(result instanceof OpenCodeError)) throw new Error('Missing tagged run failure')
    expect(result.cause).toBe(cause)
    expect(retained).toBe(0)
  })

  test('native stream failure preserves cause and closes iterator rather than retrying or resuming', async () => {
    const { observer, client, fetch } = setup()
    const cause = new Error('native stream lost')
    const close = vi.fn(async () => ({ done: true as const, value: undefined }))
    const next = vi.fn<() => Promise<IteratorResult<V2Event>>>()
      .mockResolvedValueOnce({ done: false, value: { id: 'evt_connected', type: 'server.connected', data: {} } })
      .mockRejectedValueOnce(cause)
    const subscribe = vi.spyOn(client.event, 'subscribe').mockReturnValue({ [Symbol.asyncIterator]: () => ({ next, return: close }) })
    const handle = value(await observer.observe({ key, onEvent: vi.fn() }))
    const result = await handle.done
    expect(result).toBeInstanceOf(OpenCodeError)
    expect(result?.cause).toBe(cause)
    expect(close).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  test('unexpected handshake closes owned iterator and returns an explicit error', async () => {
    const { observer, client } = setup()
    const close = vi.fn(async () => ({ done: true as const, value: undefined }))
    vi.spyOn(client.event, 'subscribe').mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: renamed() }), return: close }),
    })
    expect(await observer.observe({ key, onEvent: vi.fn() })).toBeInstanceOf(OpenCodeError)
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('same native ID on separate endpoints retains separate provenance', async () => {
    const { observer, client, endpoint } = setup()
    const other = value(createOpenCodeObserver({ endpoint, hostId: key.hostId, endpointId: 'endpoint-b' }))
    vi.spyOn(client.session, 'list').mockResolvedValue({ data: [], cursor: {} })
    expect(value(await observer.discover()).source.endpointId).toBe('endpoint-a')
    expect(value(await other.discover()).source.endpointId).toBe('endpoint-b')
    expect(await other.readSnapshot({ key })).toBeInstanceOf(ConfigError)
  })

  test('native read failures retain tagged errors and causes', async () => {
    const { observer, client } = setup()
    const cause = new Error('native read failure')
    vi.spyOn(client.session, 'list').mockRejectedValue(cause)
    const result = await observer.discover()
    expect(result).toBeInstanceOf(OpenCodeError)
    expect((result as OpenCodeError).cause).toBe(cause)
  })

  test('factory rejects blank identity, non-HTTP endpoints and unsupported versions', () => {
    const { endpoint } = setup()
    for (const input of [
      { endpoint, hostId: '', endpointId: 'a' },
      { endpoint, hostId: 'h', endpointId: '' },
      { endpoint: { ...endpoint, url: 'file:///native' }, hostId: 'h', endpointId: 'e' },
      { endpoint: { ...endpoint, version: '1.0.0' }, hostId: 'h', endpointId: 'e' },
    ]) expect(createOpenCodeObserver(input)).toBeInstanceOf(Error)
  })
})
