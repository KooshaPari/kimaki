// Durable metadata-only observe bindings. Tests use the real libSQL database.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openDb, type KimakiDb, type OpenedDb } from '../db.ts'
import { removeTempDirs } from '../test/cleanup.ts'
import {
  bindSurface, detachBinding, exportBindings, importBindings, listBindings,
  createSyncBackLedger, listWorkerResultSyncBacks, recordWorkerResultSyncBack, reconcileSyncBack,
  type BindingBackup, type SurfaceBinding,
} from './bindings.ts'
import {
  abortCutover, beginCutover, completeCutover, createCutoverLedger, listCutoverRefusals,
  readSurface, writeSurface,
} from './cutover.ts'

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

// Sync-back reconciliation: AC22. A worker can succeed while the write-back to
// the coordinating surface fails. Reporting such a result as synced, losing it,
// or delivering it twice must break these tests.

const target = 'discord:guild-1:thread-1'
const result = { summary: 'refactor complete', files: ['a.ts', 'b.ts'], ok: true }

test('a worker result whose write-back failed is pending-sync, not synced and not failed', async () => {
  const ledger = createSyncBackLedger()
  const record = recordWorkerResultSyncBack({
    ledger, workerId: 'worker-1', target, payload: result,
    cause: new Error('Discord send failed: 429 Too Many Requests'),
  })
  if (record instanceof Error) throw record
  expect(record).toMatchObject({
    worker_id: 'worker-1',
    target,
    state: 'pending-sync',
    attempts: 1,
    last_error: 'Discord send failed: 429 Too Many Requests',
    ack_id: null,
    acknowledged_at: null,
  })
  expect(record.payload_digest).toMatch(/^[0-9a-f]{64}$/)
  // Digests are payload identity, not key order.
  const reordered = recordWorkerResultSyncBack({ ledger, workerId: 'worker-1', target, payload: { ok: true, files: ['a.ts', 'b.ts'], summary: 'refactor complete' } })
  expect(reordered).toEqual(record)
  expect(listWorkerResultSyncBacks({ ledger })).toEqual([record])
})

test('a successful retry flips pending-sync to synced exactly once', async () => {
  const ledger = createSyncBackLedger()
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-1', target, payload: result, cause: 'surface unreachable' })
  if (record instanceof Error) throw record
  const deliveries: string[] = []
  const deliver = (pending: { id: string }) => {
    deliveries.push(pending.id)
    return { ackId: 'ack-1' }
  }
  const first = await reconcileSyncBack({ ledger, recordId: record.id, deliver })
  if (first instanceof Error) throw first
  expect(first).toMatchObject({ status: 'synced', delivered: true })
  expect(first.record).toMatchObject({ state: 'synced', ack_id: 'ack-1', last_error: null, attempts: 2 })
  expect(first.record.acknowledged_at).toBeTypeOf('number')
  expect(deliveries).toEqual([record.id])
  // Replaying the same reconciliation delivers nothing and does not rewrite the record.
  const second = await reconcileSyncBack({ ledger, recordId: record.id, deliver })
  if (second instanceof Error) throw second
  expect(second).toMatchObject({ status: 'duplicate', delivered: false, record: first.record })
  expect(deliveries).toEqual([record.id])
  expect(listWorkerResultSyncBacks({ ledger })).toEqual([first.record])
})

test('a duplicate retry of an already synced result delivers nothing', async () => {
  const ledger = createSyncBackLedger()
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-2', target, payload: result })
  if (record instanceof Error) throw record
  let calls = 0
  const deliver = async () => {
    calls += 1
    return { ackId: `ack-${calls}` }
  }
  const synced = await reconcileSyncBack({ ledger, recordId: record.id, deliver })
  if (synced instanceof Error) throw synced
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const replay = await reconcileSyncBack({ ledger, recordId: record.id, deliver })
    if (replay instanceof Error) throw replay
    expect(replay).toMatchObject({ status: 'duplicate', delivered: false, record: synced.record })
  }
  expect(calls).toBe(1)
})

test('a conflicting payload for the same worker is refused by name instead of overwriting', async () => {
  const ledger = createSyncBackLedger()
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-3', target, payload: result, cause: 'surface unreachable' })
  if (record instanceof Error) throw record
  const conflict = recordWorkerResultSyncBack({ ledger, workerId: 'worker-3', target, payload: { ...result, summary: 'different task' } })
  expect(conflict).toBeInstanceOf(Error)
  expect((conflict as Error).message).toContain('Worker worker-3')
  expect((conflict as Error).message).toContain(record.payload_digest)
  expect((conflict as Error).message).toMatch(/Refusing a different payload/)
  // The original is untouched, including its failed attempt.
  expect(listWorkerResultSyncBacks({ ledger })).toEqual([record])
  expect(record.state).toBe('pending-sync')
  // The same result aimed at another surface is also refused by name.
  const retarget = recordWorkerResultSyncBack({ ledger, workerId: 'worker-3', target: 'discord:guild-2:thread-9', payload: result })
  expect(retarget).toBeInstanceOf(Error)
  expect((retarget as Error).message).toContain('discord:guild-1:thread-1')
})

test('two pending results reconciled out of order both land once, with monotonic attempts', async () => {
  const ledger = createSyncBackLedger()
  const earlier = recordWorkerResultSyncBack({ ledger, workerId: 'worker-4', target, payload: { step: 1 }, cause: 'surface unreachable' })
  const later = recordWorkerResultSyncBack({ ledger, workerId: 'worker-5', target, payload: { step: 2 }, cause: 'surface unreachable' })
  if (earlier instanceof Error) throw earlier
  if (later instanceof Error) throw later
  const delivered: string[] = []
  const deliver = async (pending: { worker_id: string }) => {
    delivered.push(pending.worker_id)
    return { ackId: `ack-${pending.worker_id}` }
  }
  // The later result is reconciled first, then the earlier one, then both replay.
  const secondFirst = await reconcileSyncBack({ ledger, recordId: later.id, deliver })
  if (secondFirst instanceof Error) throw secondFirst
  const firstSecond = await reconcileSyncBack({ ledger, recordId: earlier.id, deliver })
  if (firstSecond instanceof Error) throw firstSecond
  expect(delivered).toEqual(['worker-5', 'worker-4'])
  expect(secondFirst.record).toMatchObject({ state: 'synced', attempts: 2 })
  expect(firstSecond.record).toMatchObject({ state: 'synced', attempts: 2 })
  for (const recordId of [later.id, earlier.id]) {
    const replay = await reconcileSyncBack({ ledger, recordId, deliver })
    if (replay instanceof Error) throw replay
    expect(replay).toMatchObject({ status: 'duplicate', delivered: false })
  }
  expect(delivered).toEqual(['worker-5', 'worker-4'])
  const records = listWorkerResultSyncBacks({ ledger })
  expect(records.map((row) => [row.worker_id, row.state, row.attempts])).toEqual([
    ['worker-4', 'synced', 2],
    ['worker-5', 'synced', 2],
  ])
})

test('a record never reads synced while its acknowledgement is missing', async () => {
  const ledger = createSyncBackLedger()
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-6', target, payload: result, cause: 'surface unreachable' })
  if (record instanceof Error) throw record
  // A delivery that returns without an acknowledgement is not a delivery.
  const noAck = await reconcileSyncBack({ ledger, recordId: record.id, deliver: () => undefined })
  if (noAck instanceof Error) throw noAck
  expect(noAck).toMatchObject({ status: 'pending-sync', delivered: false })
  expect(noAck.record).toMatchObject({ state: 'pending-sync', ack_id: null, acknowledged_at: null, attempts: 2 })
  expect(noAck.record.last_error).toMatch(/no acknowledgement/)
  // A thrown delivery keeps the record pending too, and attempts stay monotonic.
  const threw = await reconcileSyncBack({ ledger, recordId: record.id, deliver: () => { throw new Error('still 503') } })
  if (threw instanceof Error) throw threw
  expect(threw.record).toMatchObject({ state: 'pending-sync', attempts: 3, last_error: 'still 503' })
  expect(listWorkerResultSyncBacks({ ledger })).toMatchObject([{ state: 'pending-sync' }])
  // Only a real acknowledgement flips it.
  const acked = await reconcileSyncBack({ ledger, recordId: record.id, deliver: () => ({ ackId: 'ack-6' }) })
  if (acked instanceof Error) throw acked
  expect(acked.record).toMatchObject({ state: 'synced', attempts: 4, ack_id: 'ack-6' })
})

test('a second reconciliation in flight is refused instead of delivering twice', async () => {
  const ledger = createSyncBackLedger()
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-7', target, payload: result, cause: 'surface unreachable' })
  if (record instanceof Error) throw record
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const slow = async () => {
    calls += 1
    await gate
    return { ackId: 'ack-7' }
  }
  const running = reconcileSyncBack({ ledger, recordId: record.id, deliver: slow })
  const competing = await reconcileSyncBack({ ledger, recordId: record.id, deliver: slow })
  expect(competing).toBeInstanceOf(Error)
  expect((competing as Error).message).toMatch(/already in flight/)
  release?.()
  const done = await running
  if (done instanceof Error) throw done
  expect(done).toMatchObject({ status: 'synced', delivered: true })
  expect(calls).toBe(1)
})

// Connector cutover: AC34. A cutover moves surface ownership between bindings.
// No real connector is rerouted here. Losing the pause, the generation fence,
// the single-flight guard, the abort or the retirement must break these tests.

async function rowOf(db: KimakiDb, id: string) {
  const row = await db.query.ops_surface_bindings.findFirst({ where: { id } })
  if (!row) throw new Error(`binding ${id} is missing`)
  return row
}

function surfaceOwner(db: KimakiDb, surfaceId = 'thread-1') {
  return readSurface({ db, tenantId: input.tenantId, surfaceId })
}

// One active source with a cutover already begun against a second endpoint.
async function cutoverFixture() {
  const { db, client } = await database()
  const source = await bindSurface({ db, ...input })
  if (source instanceof Error) throw source
  const begun = await beginCutover({ db, sourceId: source.id, target: { ...key, endpointId: 'runtime-b' }, idempotencyKey: 'cutover-1' })
  return { db, client, source, begun }
}

test('cutover pauses the source, hands the surface to the target, then retires the source', async () => {
  const { db, source, begun } = await cutoverFixture()
  if (begun instanceof Error) throw begun
  expect(begun).toMatchObject({ phase: 'in-progress', source_state: 'paused', target_state: 'staged', generation: 2 })
  // During the pause the surface still has exactly one owner: the paused source.
  const paused = await surfaceOwner(db)
  if (paused instanceof Error) throw paused
  expect(paused).toMatchObject({ id: source.id, state: 'paused', generation: 1 })
  const done = await completeCutover({ db, sourceId: source.id })
  if (done instanceof Error) throw done
  expect(done).toMatchObject({ phase: 'complete', source_state: 'retired', target_state: 'active', generation: 2 })
  expect(await rowOf(db, source.id)).toMatchObject({ state: 'retired', generation: 1 })
  expect(await rowOf(db, done.target_id)).toMatchObject({ state: 'active', generation: 2, endpoint_id: 'runtime-b' })
  const owner = await surfaceOwner(db)
  if (owner instanceof Error) throw owner
  expect(owner.id).toBe(done.target_id)
  const rows = await listBindings({ db, tenantId: input.tenantId })
  if (rows instanceof Error) throw rows
  expect(rows.filter((row) => row.state === 'active')).toHaveLength(1)
})

test('a competing consumer write at the superseded generation is refused and never reaches the target', async () => {
  const { db } = await database()
  const source = await bindSurface({ db, ...input })
  if (source instanceof Error) throw source
  const ledger = createCutoverLedger()
  // The owner accepts writes at the generation it actually holds.
  expect(await writeSurface({ db, ledger, bindingId: source.id, generation: 1 })).toMatchObject({ accepted: true, surface_generation: 1 })
  const begun = await beginCutover({ db, sourceId: source.id, target: { ...key, endpointId: 'runtime-b' }, idempotencyKey: 'cutover-1' })
  if (begun instanceof Error) throw begun
  const targetBefore = await rowOf(db, begun.target_id)
  const refused = await writeSurface({ db, ledger, bindingId: source.id, generation: 1 })
  if (refused instanceof Error) throw refused
  if (refused.accepted) throw new Error('the superseded generation was accepted')
  expect(refused).toMatchObject({ accepted: false, generation: 1, surface_generation: 2 })
  expect(refused.reason).toMatch(/superseded/)
  // The staged target cannot absorb the same write either, and is unchanged by it.
  const toTarget = await writeSurface({ db, ledger, bindingId: begun.target_id, generation: 2 })
  if (toTarget instanceof Error) throw toTarget
  if (toTarget.accepted) throw new Error('the staged target absorbed a write')
  expect(toTarget).toMatchObject({ accepted: false })
  expect(toTarget.reason).toMatch(/staged/)
  expect(await rowOf(db, begun.target_id)).toEqual(targetBefore)
  const refusals = listCutoverRefusals({ ledger })
  expect(refusals.map((refusal) => [refusal.binding_id, refusal.generation, refusal.surface_generation])).toEqual([
    [source.id, 1, 2],
    [begun.target_id, 2, 2],
  ])
  expect(refusals[0]?.reason).toMatch(/superseded by generation 2/)
  // The surface still reads exactly one owner: the paused source.
  expect(await surfaceOwner(db)).toMatchObject({ id: source.id, state: 'paused' })
})

test('a second cutover for the same surface is refused by name while the first is in progress', async () => {
  const { db, source, begun } = await cutoverFixture()
  if (begun instanceof Error) throw begun
  const second = await beginCutover({ db, sourceId: source.id, target: { ...key, endpointId: 'runtime-c' }, idempotencyKey: 'cutover-2' })
  expect(second).toBeInstanceOf(Error)
  expect((second as Error).message).toMatch(/already in progress/)
  expect((second as Error).message).toContain('discord:guild-1:thread-1')
  const rows = await listBindings({ db, tenantId: input.tenantId })
  if (rows instanceof Error) throw rows
  expect(rows).toHaveLength(2)
  expect(rows.filter((row) => (row.state as string) === 'staged')).toHaveLength(1)
  // Binding the surface again would create a second owner while the source is
  // paused, so it is refused until the cutover settles.
  const rebind = await bindSurface({ db, ...input, idempotencyKey: 'request-9' })
  expect(rebind).toBeInstanceOf(Error)
  expect((rebind as Error).message).toMatch(/mid-cutover/)
})

test('abort restores the source at the same generation and never activates the target', async () => {
  const { db, source, begun } = await cutoverFixture()
  if (begun instanceof Error) throw begun
  const targetBefore = await rowOf(db, begun.target_id)
  const aborted = await abortCutover({ db, sourceId: source.id })
  if (aborted instanceof Error) throw aborted
  expect(aborted).toMatchObject({ phase: 'aborted', source_state: 'active', target_state: 'detached' })
  expect(await rowOf(db, source.id)).toMatchObject({ state: 'active', generation: 1 })
  const targetAfter = await rowOf(db, begun.target_id)
  // Identity, route and generation survive; the target never gains ownership.
  expect(targetAfter).toMatchObject({
    id: targetBefore.id, generation: 2, endpoint_id: 'runtime-b',
    native_session_id: targetBefore.native_session_id, idempotency_key: 'cutover-1', state: 'detached',
  })
  expect(await surfaceOwner(db)).toMatchObject({ id: source.id, state: 'active' })
  // Not stranded: the restored owner writes at its own generation again, even
  // though the abandoned target row still records generation 2.
  const ledger = createCutoverLedger()
  expect(await writeSurface({ db, ledger, bindingId: source.id, generation: 1 })).toMatchObject({ accepted: true, surface_generation: 1 })
  // The surface is not stranded: a fresh cutover can start on the same source.
  const retry = await beginCutover({ db, sourceId: source.id, target: { ...key, endpointId: 'runtime-b' }, idempotencyKey: 'cutover-2' })
  expect(retry).not.toBeInstanceOf(Error)
})

test('completing a cutover twice is idempotent', async () => {
  const { db, source, begun } = await cutoverFixture()
  if (begun instanceof Error) throw begun
  const first = await completeCutover({ db, sourceId: source.id })
  if (first instanceof Error) throw first
  const rows = await listBindings({ db, tenantId: input.tenantId })
  if (rows instanceof Error) throw rows
  const second = await completeCutover({ db, sourceId: source.id })
  if (second instanceof Error) throw second
  expect(second).toEqual(first)
  expect(await listBindings({ db, tenantId: input.tenantId })).toEqual(rows)
})

test('cutover refuses a non-observe source, a superseded source and a stray completion by name', async () => {
  const { db, client } = await database()
  const source = await bindSurface({ db, ...input })
  if (source instanceof Error) throw source
  // The mode gate is defensive: bindSurface only writes observe rows.
  await client.execute({ sql: "UPDATE ops_surface_bindings SET mode = 'control' WHERE id = ?", args: [source.id] })
  const control = await beginCutover({ db, sourceId: source.id, target: { ...key, endpointId: 'runtime-b' }, idempotencyKey: 'cutover-1' })
  expect(control).toBeInstanceOf(Error)
  expect((control as Error).message).toMatch(/only moves an observe binding/)
  await client.execute({ sql: "UPDATE ops_surface_bindings SET mode = 'observe' WHERE id = ?", args: [source.id] })
  // A detach plus a rebind leaves the first binding a generation behind.
  const detached = await detachBinding({ db, bindingId: source.id, tenantId: input.tenantId })
  if (detached instanceof Error) throw detached
  const live = await bindSurface({ db, ...input, idempotencyKey: 'request-2' })
  if (live instanceof Error) throw live
  expect(live.generation).toBe(2)
  const ahead = await beginCutover({ db, sourceId: source.id, target: { ...key, endpointId: 'runtime-b' }, idempotencyKey: 'cutover-2' })
  expect(ahead).toBeInstanceOf(Error)
  expect((ahead as Error).message).toMatch(/A superseded binding cannot be cut over/)
  // Completing or aborting a cutover that never began names the reason.
  expect(await completeCutover({ db, sourceId: live.id })).toBeInstanceOf(Error)
  expect(((await completeCutover({ db, sourceId: live.id })) as Error).message).toMatch(/Only a paused source/)
  expect(((await abortCutover({ db, sourceId: live.id })) as Error).message).toMatch(/nothing to abort/)
  expect(((await completeCutover({ db, sourceId: 'missing-binding' })) as Error).message).toMatch(/No binding missing-binding/)
  expect(await readSurface({ db, tenantId: 'guild-9', surfaceId: 'thread-9' })).toBeInstanceOf(Error)
})
