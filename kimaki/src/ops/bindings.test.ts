// Durable metadata-only observe bindings. Tests use the real libSQL database.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openDb, type OpenedDb } from '../db.ts'
import { removeTempDirs } from '../test/cleanup.ts'
import {
  bindSurface, detachBinding, exportBindings, importBindings, listBindings,
  type BindingBackup, type SurfaceBinding,
} from './bindings.ts'

const opened: OpenedDb[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  // libSQL's native statements can retain Windows file handles until finalization.
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  global.gc?.()
  await removeTempDirs(dirs)
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

test('a superseded binding cannot carry control, and generations advance on rebind', async () => {
  const { db } = await database()
  const first = await bindSurface({ db, ...input })
  if (first instanceof Error) throw first
  expect(first.generation).toBe(1)
  const detached = await detachBinding({ db, bindingId: first.id, tenantId: input.tenantId })
  if (detached instanceof Error) throw detached
  expect(detached.state).toBe('detached')
  const second = await bindSurface({ db, ...input, idempotencyKey: 'request-2' })
  if (second instanceof Error) throw second
  expect(second.generation).toBe(2)
  // A control write aimed at the superseded binding, reusing its request id and its
  // generation, is refused: generations are not control credentials.
  const staleControl = await bindSurface({ db, ...input, mode: 'control', idempotencyKey: 'request-1' })
  expect(staleControl).toBeInstanceOf(Error)
  expect((staleControl as Error).message).toMatch(/observe/i)
  // The live binding offers no control surface either.
  expect(await bindSurface({ db, ...input, mode: 'control', idempotencyKey: 'request-3' })).toBeInstanceOf(Error)
  const rows = await listBindings({ db, tenantId: input.tenantId })
  if (rows instanceof Error) throw rows
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => row.mode === 'observe' && row.publication_policy === 'none')).toBe(true)
})

test('concurrent duplicate requests yield one binding', async () => {
  const { db } = await database()
  const results = await Promise.all(Array.from({ length: 4 }, () => bindSurface({ db, ...input })))
  expect(results.every((result) => !(result instanceof Error))).toBe(true)
  expect(new Set(results.map((result) => result instanceof Error ? '' : result.id)).size).toBe(1)
  expect(await listBindings({ db, tenantId: input.tenantId })).toHaveLength(1)
})

// Backup restore: AC33. Losing ids, generations, state, routes or the all-or-nothing
// refusal must break these tests.

// Every stored column, so a lossy restore cannot pass by matching only routes.
function wire(row: SurfaceBinding) {
  return {
    id: row.id,
    host_id: row.host_id,
    endpoint_id: row.endpoint_id,
    backend_kind: row.backend_kind,
    native_session_id: row.native_session_id,
    service_kind: row.service_kind,
    tenant_id: row.tenant_id,
    surface_id: row.surface_id,
    mode: row.mode,
    publication_policy: row.publication_policy,
    state: row.state,
    generation: row.generation,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
  }
}

function backupOf(rows: Record<string, unknown>[]) {
  return { version: 1, exportedAt: 1_700_000_000_000, rows }
}

function byId(rows: SurfaceBinding[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => [row.id, wire(row)]))
}

// Two surfaces, one detached, then a generation-2 rebind of that surface.
async function seeded() {
  const source = await database()
  const first = await bindSurface({ db: source.db, ...input })
  if (first instanceof Error) throw first
  const second = await bindSurface({ db: source.db, ...input, surfaceId: 'thread-2', idempotencyKey: 'request-2' })
  if (second instanceof Error) throw second
  const detached = await detachBinding({ db: source.db, bindingId: second.id, tenantId: input.tenantId })
  if (detached instanceof Error) throw detached
  const rebound = await bindSurface({ db: source.db, ...input, surfaceId: 'thread-2', idempotencyKey: 'request-3' })
  if (rebound instanceof Error) throw rebound
  const backup = await exportBindings({ db: source.db, tenantId: input.tenantId })
  if (backup instanceof Error) throw backup
  return { source, backup }
}

test('export is a versioned backup and restore preserves ids, generations, states, routes and timestamps', async () => {
  const { source, backup } = await seeded()
  expect(backup.version).toBe(1)
  expect(Number.isFinite(backup.exportedAt)).toBe(true)
  expect(backup.rows).toHaveLength(3)
  expect(backup.rows.every((row) => row.mode === 'observe' && row.publication_policy === 'none')).toBe(true)
  const target = await database()
  // Restore goes through the same JSON text a real backup file would carry.
  expect(await importBindings({ db: target.db, backup: JSON.parse(JSON.stringify(backup)) })).toEqual({ imported: 3, skipped: 0 })
  const before = await listBindings({ db: source.db, tenantId: input.tenantId })
  const after = await listBindings({ db: target.db, tenantId: input.tenantId })
  if (before instanceof Error) throw before
  if (after instanceof Error) throw after
  expect(byId(after)).toEqual(byId(before))
  expect(after.find((row) => row.surface_id === 'thread-1')).toMatchObject({ state: 'active', generation: 1 })
  expect(after.find((row) => row.surface_id === 'thread-2' && row.state === 'detached')).toMatchObject({ generation: 1 })
  expect(after.find((row) => row.surface_id === 'thread-2' && row.state === 'active')).toMatchObject({ generation: 2 })
  expect(after.map((row) => row.created_at).sort()).toEqual(before.map((row) => row.created_at).sort())
})

test('importing the same backup twice is a no-op', async () => {
  const { backup } = await seeded()
  const target = await database()
  expect(await importBindings({ db: target.db, backup })).toEqual({ imported: 3, skipped: 0 })
  expect(await importBindings({ db: target.db, backup })).toEqual({ imported: 0, skipped: 3 })
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toHaveLength(3)
})

test('restoring into a database that already holds identical rows is a no-op', async () => {
  const { source, backup } = await seeded()
  const before = await listBindings({ db: source.db, tenantId: input.tenantId })
  if (before instanceof Error) throw before
  expect(await importBindings({ db: source.db, backup })).toEqual({ imported: 0, skipped: 3 })
  expect(await listBindings({ db: source.db, tenantId: input.tenantId })).toEqual(before)
})

test('a same-id row with a different route is refused and leaves the original unchanged', async () => {
  const { backup } = await seeded()
  const target = await database()
  expect(await importBindings({ db: target.db, backup })).toEqual({ imported: 3, skipped: 0 })
  const before = await listBindings({ db: target.db, tenantId: input.tenantId })
  if (before instanceof Error) throw before
  const rows = backup.rows.map(wire)
  const tampered = { ...rows[0]!, surface_id: 'thread-9' }
  const result = await importBindings({ db: target.db, backup: backupOf([tampered, ...rows.slice(1)]) })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain(String(tampered['id']))
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual(before)
})

test('a different id colliding with an active surface is refused without a partial import', async () => {
  const target = await database()
  const existing = await bindSurface({ db: target.db, ...input })
  if (existing instanceof Error) throw existing
  const valid = { ...wire(existing), id: 'new-valid-id', surface_id: 'thread-7', idempotency_key: 'request-7' }
  const collision = { ...wire(existing), id: 'collision-id', idempotency_key: 'request-8' }
  const result = await importBindings({ db: target.db, backup: backupOf([valid, collision]) })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain('active binding')
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual([existing])
})

test('a different id colliding with an idempotency key is refused without a partial import', async () => {
  const target = await database()
  const existing = await bindSurface({ db: target.db, ...input })
  if (existing instanceof Error) throw existing
  const valid = { ...wire(existing), id: 'new-valid-id', surface_id: 'thread-7', idempotency_key: 'request-7' }
  const collision = { ...wire(existing), id: 'collision-id', surface_id: 'thread-8' }
  const result = await importBindings({ db: target.db, backup: backupOf([valid, collision]) })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toMatch(/request ID request-1/)
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual([existing])
})

test('malformed or authority-widening backups are refused and write nothing', async () => {
  const { backup } = await seeded()
  const target = await database()
  const row = wire(backup.rows[0]!)
  const missingField: Record<string, unknown> = { ...row }
  delete missingField['created_at']
  const refused: unknown[] = [
    { version: 2, exportedAt: Date.now(), rows: [row] },
    { version: 1, exportedAt: Date.now(), rows: [{ ...row, mode: 'control' }] },
    { version: 1, exportedAt: Date.now(), rows: [{ ...row, publication_policy: 'transcripts' }] },
    { version: 1, exportedAt: Date.now(), rows: [{ ...row, state: 'controlling' }] },
    { version: 1, exportedAt: Date.now(), rows: [{ ...row, generation: 0 }] },
    { version: 1, exportedAt: Date.now(), rows: [{ ...row, created_at: Number.POSITIVE_INFINITY }] },
    { version: 1, exportedAt: Date.now(), rows: missingField },
    { version: 1, exportedAt: Date.now(), rows: 'not-an-array' },
    { version: 1, exportedAt: Number.NaN, rows: [row] },
    { version: 1, exportedAt: Date.now(), rows: [null] },
  ]
  for (const candidate of refused) {
    expect(await importBindings({ db: target.db, backup: candidate })).toBeInstanceOf(Error)
  }
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual([])
  // The same database still accepts the intact backup, so refusals left no residue.
  expect(await importBindings({ db: target.db, backup })).toEqual({ imported: 3, skipped: 0 })
})

test('restored bindings stay metadata-only observe rows', async () => {
  const { backup } = await seeded()
  const target = await database()
  expect(await importBindings({ db: target.db, backup })).toEqual({ imported: 3, skipped: 0 })
  const fresh = {
    ...wire(backup.rows[0]!),
    id: 'fresh-id',
    surface_id: 'thread-7',
    idempotency_key: 'request-7',
    control: true,
    publication_policy_override: 'transcripts',
  }
  expect(await importBindings({ db: target.db, backup: backupOf([fresh]) })).toEqual({ imported: 1, skipped: 0 })
  const rows = await listBindings({ db: target.db, tenantId: input.tenantId })
  if (rows instanceof Error) throw rows
  expect(rows).toHaveLength(4)
  expect(rows.every((row) => row.mode === 'observe' && row.publication_policy === 'none')).toBe(true)
  expect(rows.find((row) => row.id === 'fresh-id')).toMatchObject({ mode: 'observe', publication_policy: 'none', state: 'active' })
})

test('export validates scope identifiers and an unscoped export covers every tenant', async () => {
  const { db } = await database()
  expect(await bindSurface({ db, ...input })).not.toBeInstanceOf(Error)
  expect(await bindSurface({ db, ...input, tenantId: 'guild-2', surfaceId: 'thread-2', idempotencyKey: 'request-2' })).not.toBeInstanceOf(Error)
  expect(await exportBindings({ db, tenantId: ' ' })).toBeInstanceOf(Error)
  expect(await exportBindings({ db, serviceKind: '' })).toBeInstanceOf(Error)
  const all = await exportBindings({ db })
  if (all instanceof Error) throw all
  expect(all.rows).toHaveLength(2)
  expect(new Set(all.rows.map((row) => row.tenant_id))).toEqual(new Set(['guild-1', 'guild-2']))
  const scoped = await exportBindings({ db, tenantId: 'guild-2' })
  if (scoped instanceof Error) throw scoped
  expect(scoped.rows).toMatchObject([{ tenant_id: 'guild-2', surface_id: 'thread-2' }])
  expect(await exportBindings({ db, serviceKind: 'slack' })).toMatchObject({ version: 1, rows: [] })
})

