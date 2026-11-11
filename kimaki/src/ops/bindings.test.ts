// Durable metadata-only observe bindings. Tests use the real libSQL database.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openDb, type OpenedDb } from '../db.ts'
import { bindSurface, detachBinding, listBindings } from './bindings.ts'

const opened: OpenedDb[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  // libSQL's native statements can retain Windows file handles until finalization.
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  global.gc?.()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
async function database() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-ops-'))
  dirs.push(dataDir)
  const result = await openDb({ dataDir, migrate: true })
  if (result instanceof Error) throw result
  opened.push(result)
  return { ...result, dataDir }
}
const key = { hostId: 'host', endpointId: 'runtime', backendKind: 'codex', nativeSessionId: 'thread-1' }
const input = { session: key, serviceKind: 'discord', tenantId: 'guild-1', surfaceId: 'thread-1', idempotencyKey: 'request-1' }

// Removing target scoping, idempotency checks, or durable SQL writes must break these tests.
test('persists two observers without owning a runtime or legacy thread mapping', async () => {
  const { db, dataDir } = await database()
  const first = await bindSurface({ db, ...input })
  const second = await bindSurface({ db, ...input, surfaceId: 'thread-2', idempotencyKey: 'request-2' })
  expect(first).toMatchObject({ mode: 'observe', publication_policy: 'none', generation: 1, state: 'active' })
  expect(second).toMatchObject({ state: 'active' })
  expect(await db.query.thread_sessions.findMany()).toEqual([])
  const reopened = await openDb({ dataDir, migrate: false })
  if (reopened instanceof Error) throw reopened
  opened.push(reopened)
  expect(await listBindings({ db: reopened.db, tenantId: input.tenantId })).toHaveLength(2)
})

test('same idempotency key returns original binding but rejects different intent', async () => {
  const { db } = await database()
  const first = await bindSurface({ db, ...input })
  expect(await bindSurface({ db, ...input })).toEqual(first)
  expect(await bindSurface({ db, ...input, session: { ...key, nativeSessionId: 'other' } })).toBeInstanceOf(Error)
})

test('detach is tenant scoped, repeatable, and cannot stop an external process', async () => {
  const { db } = await database()
  const first = await bindSurface({ db, ...input })
  if (first instanceof Error) throw first
  expect(await detachBinding({ db, bindingId: first.id, tenantId: 'wrong' })).toBeInstanceOf(Error)
  expect(await detachBinding({ db, bindingId: first.id, tenantId: input.tenantId })).toMatchObject({ state: 'detached' })
  expect(await detachBinding({ db, bindingId: first.id, tenantId: input.tenantId })).toMatchObject({ state: 'detached' })
  expect(await listBindings({ db, tenantId: 'wrong' })).toEqual([])
  // No runtime reference or callback exists in this API. Detach only updates SQL metadata.
  expect(await listBindings({ db, tenantId: input.tenantId })).toMatchObject([{ state: 'detached' }])
})

test('occupied surface rejects a different session until detach, then fences old generation', async () => {
  const { db } = await database()
  const first = await bindSurface({ db, ...input })
  if (first instanceof Error) throw first
  const next = { ...input, session: { ...key, nativeSessionId: 'other' }, idempotencyKey: 'request-2' }
  expect(await bindSurface({ db, ...next })).toBeInstanceOf(Error)
  await detachBinding({ db, bindingId: first.id, tenantId: input.tenantId })
  expect(await bindSurface({ db, ...next })).toMatchObject({ generation: 2, state: 'active' })
  expect(await bindSurface({ db, ...input })).toMatchObject({ id: first.id, state: 'detached' })
})

test('tenant and endpoint boundaries cannot collide', async () => {
  const { db } = await database()
  expect(await bindSurface({ db, ...input })).not.toBeInstanceOf(Error)
  expect(await bindSurface({ db, ...input, tenantId: 'guild-2', session: { ...key, endpointId: 'other' } })).not.toBeInstanceOf(Error)
  expect(await listBindings({ db, tenantId: 'guild-1' })).toMatchObject([{ endpoint_id: 'runtime' }])
  expect(await listBindings({ db, tenantId: 'guild-2' })).toMatchObject([{ endpoint_id: 'other' }])
})

test('rejects empty identity and non-observe modes at the public boundary', async () => {
  const { db } = await database()
  expect(await bindSurface({ db, ...input, tenantId: ' ' })).toBeInstanceOf(Error)
  expect(await bindSurface({ db, ...input, session: { ...key, nativeSessionId: '' } })).toBeInstanceOf(Error)
  expect(await bindSurface({ db, ...input, mode: 'control' })).toBeInstanceOf(Error)
})

test('concurrent duplicate requests yield one binding', async () => {
  const { db } = await database()
  const results = await Promise.all(Array.from({ length: 4 }, () => bindSurface({ db, ...input })))
  expect(results.every((result) => !(result instanceof Error))).toBe(true)
  expect(new Set(results.map((result) => result instanceof Error ? '' : result.id)).size).toBe(1)
  expect(await listBindings({ db, tenantId: input.tenantId })).toHaveLength(1)
})
