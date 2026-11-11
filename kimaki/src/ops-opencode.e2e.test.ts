import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { resolveOpencode } from './opencode-server.js'
import { createOpenCodeObserver, type OpenCodeObservedEvent } from './ops/runtime/opencode.js'
import { createProjection, fromOpenCodeObservedEvent, projectEvent } from './ops/projection.js'
import { startOpencodeTestServer, type OpencodeTestServer } from './test/harness.js'

function value<T>(result: T): Exclude<T, Error> {
  if (result instanceof Error) throw result
  return result as Exclude<T, Error>
}

let server: OpencodeTestServer | undefined
beforeAll(async () => { server = await startOpencodeTestServer() }, 75_000)
afterAll(async () => { await server?.stop() }, 30_000)

test('native external session discover/read/observe/detach leaves session usable, with no model calls', async () => {
  if (!server) throw new Error('Missing isolated server')
  const native = await server.client()
  const request = () => ({ signal: AbortSignal.timeout(10_000) })
  // The owner uses the SDK directly, outside the observer and without a Kimaki marker.
  const created = await native.session.create({ location: { directory: server.projectDirectory }, title: 'Native observer acceptance' }, request())
  const endpoint = value(await resolveOpencode({ serviceFile: server.serviceFile, ensure: false }))
  const observer = value(createOpenCodeObserver({ endpoint, hostId: 'isolated-test-host', endpointId: server.serviceFile }))
  const inventory = value(await observer.discover({ directory: server.projectDirectory }, request()))
  const discovered = inventory.sessions.find(({ key }) => key.nativeSessionId === created.id)
  expect(discovered?.native.id).toBe(created.id)
  if (!discovered) throw new Error('Native session not discovered')
  const key = discovered.key
  const listed = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'discover', '--source', 'opencode', '--service-file', server.serviceFile, '--host', key.hostId, '--endpoint', key.endpointId], { timeout: 60_000, env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' } })
  const publicInventory = JSON.parse(listed.stdout)
  expect(publicInventory).toMatchObject({ source: 'opencode', coverage: 'explicit-native-endpoint-page' })
  const publicSession = publicInventory.sessions.find((entry: { key: { nativeSessionId: string } }) => entry.key.nativeSessionId === created.id)
  expect(publicSession).toEqual({ key, title: created.title })
  expect(Object.keys(publicSession).sort()).toEqual(['key', 'title'])
  const before = value(await observer.readSnapshot({ key }, request()))
  const instructions = await native.session.instructions.entry.list({ sessionID: created.id }, request())
  expect(before.session).toEqual(await native.session.get({ sessionID: created.id }, request()))
  expect(before.messages.data).toEqual([])

  const seen: OpenCodeObservedEvent[] = []
  const remaining: OpenCodeObservedEvent[] = []
  const cancel = new AbortController()
  const first = value(await observer.observe({ key, signal: cancel.signal, onEvent: (event) => { seen.push(event) } }))
  const second = value(await observer.observe({ key, signal: cancel.signal, onEvent: (event) => { remaining.push(event) } }))
  try {
    // Native lifecycle events are sufficient. No model prompt or observer mutation.
    await native.session.update({ sessionID: created.id, title: 'Native owner rename' }, request())
    await expect.poll(() => seen.some(({ raw }) => raw.type === 'session.renamed' && raw.data.title === 'Native owner rename'), { timeout: 8_000 }).toBe(true)
    const event = seen.find(({ raw }) => raw.type === 'session.renamed')
    expect(event).toMatchObject({ key, source: { hostId: key.hostId, endpointId: key.endpointId, backendKind: 'opencode', version: endpoint.version } })
    expect(event?.raw).toMatchObject({ id: expect.any(String), created: expect.any(Number), durable: { aggregateID: created.id, seq: expect.any(Number) } })
    if (!event) throw new Error('Native rename event was not observed')
    const projected = fromOpenCodeObservedEvent(event)
    expect(projected.kind).toBe('converted')
    if (projected.kind !== 'converted') throw new Error('Native durable event was not converted')
    const projection = projectEvent(createProjection(key), projected.event)
    expect(projection.kind).toBe('applied')
    expect(projection.state.sources).toEqual([{ sourceId: 'opencode', aggregateId: created.id, sequence: projected.event.sequence }])
    expect(JSON.stringify(projection)).not.toContain('Native owner rename')
    first.detach()
    expect(await first.done).toBeNull()
    const detachedCount = seen.length
    await native.session.update({ sessionID: created.id, title: 'Still native after detach' }, request())
    await expect.poll(() => remaining.some(({ raw }) => raw.type === 'session.renamed' && raw.data.title === 'Still native after detach'), { timeout: 8_000 }).toBe(true)
    expect(seen).toHaveLength(detachedCount)
    second.detach()
    expect(await second.done).toBeNull()
    const after = await native.session.get({ sessionID: created.id }, request())
    expect(after.title).toBe('Still native after detach')
    expect(after.metadata).toEqual(before.session.metadata)
    expect(after.permissions).toEqual(before.session.permissions)
    expect(await native.session.instructions.entry.list({ sessionID: created.id }, request())).toEqual(instructions)
    expect(value(await observer.readSnapshot({ key }, request())).session.id).toBe(created.id)
    expect(server.model.requests).toEqual([])
  } finally {
    cancel.abort()
    first.detach()
    second.detach()
    await Promise.all([first.done, second.done])
  }
}, 90_000)
