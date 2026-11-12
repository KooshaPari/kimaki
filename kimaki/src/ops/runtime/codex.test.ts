import { describe, expect, it } from 'vitest'
import { createCodexObserver } from './codex.js'

describe('Codex passive observer', () => {
  it('never returns native preview, path, transcript or unknown fields', async () => {
    const secret = { id: 'thread-1', preview: 'private prompt', path: 'private path', turns: ['private transcript'], unknown: 'private' }
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async (method) => method === 'thread/list'
      ? { data: [secret], nextCursor: null }
      : { thread: secret } })
    if (observer instanceof Error) throw observer
    const discovered = await observer.discover()
    const read = await observer.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' } })
    expect(JSON.stringify([discovered, read])).not.toContain('private')
  })
  it('uses state-db-only discovery and preserves pagination', async () => {
    const calls: unknown[] = []
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async (method, params) => {
      calls.push([method, params])
      return { data: [{ id: 'thread-1', status: { type: 'notLoaded' } }], nextCursor: 'next', backwardsCursor: null }
    } })
    expect(observer).not.toBeInstanceOf(Error)
    if (observer instanceof Error) return
    expect(await observer.discover({ limit: 10 })).toMatchObject({ sessions: [{ key: { nativeSessionId: 'thread-1', backendKind: 'codex' } }], cursor: 'next' })
    expect(calls).toEqual([['thread/list', { limit: 10, useStateDbOnly: true }]])
    expect(observer.capabilities.observe.kind).toBe('unsupported')
  })

  it('reads metadata without resuming and rejects mismatched keys', async () => {
    const calls: unknown[] = []
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async (method, params) => {
      calls.push([method, params])
      return { thread: { id: 'thread-1', status: { type: 'notLoaded' } } }
    } })
    if (observer instanceof Error) throw observer
    const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' }
    expect(await observer.readSnapshot({ key })).toMatchObject({ session: { id: 'thread-1' } })
    expect(await observer.readSnapshot({ key: { ...key, endpointId: 'other' } })).toBeInstanceOf(Error)
    expect(calls).toEqual([['thread/read', { threadId: 'thread-1', includeTurns: false }]])
  })

  it('does not return extra caller-supplied key properties', async () => {
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async () => ({ thread: { id: 'thread-1' } }) })
    if (observer instanceof Error) throw observer
    const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1', secret: 'private-key-field' }
    expect(JSON.stringify(await observer.readSnapshot({ key }))).not.toContain('private-key-field')
  })

  it('rejects malformed responses and mismatched native identity', async () => {
    const observer = createCodexObserver({ hostId: 'host', endpointId: 'endpoint', request: async () => ({ thread: { id: 'other' } }) })
    if (observer instanceof Error) throw observer
    expect(await observer.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'codex', nativeSessionId: 'thread-1' } })).toBeInstanceOf(Error)
    expect(await observer.discover()).toBeInstanceOf(Error)
  })
})
