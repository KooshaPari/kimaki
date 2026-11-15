// AC33 through an object-store boundary: the backup leaves the local JSON file
// and is written to a store under a conditional key, then restored by reading the
// bytes back and verifying a content digest before anything is written.
//
// Removing the digest check, the conditional put, or the version refusal must
// break these tests.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openDb, type OpenedDb } from '../db.ts'
import { removeTempDirs } from '../test/cleanup.ts'
import { bindSurface, detachBinding, exportBindings, listBindings, sealBindingBackup, type BindingBackup, type SurfaceBinding } from './bindings.ts'
import {
  createInMemoryObjectStore, createLocalFilesystemStore, restoreBindingBackup,
  sha256Hex, uploadBindingBackup,
} from './backup-store.ts'

const opened: OpenedDb[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  global.gc?.()
  await removeTempDirs(dirs)
})

async function database() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-store-'))
  dirs.push(dataDir)
  const result = await openDb({ dataDir, migrate: true })
  if (result instanceof Error) throw result
  opened.push(result)
  return { ...result, dataDir }
}

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kimaki-${label}-`))
  dirs.push(dir)
  return dir
}

const key = { hostId: 'host', endpointId: 'runtime', backendKind: 'codex', nativeSessionId: 'thread-1' }
const input = { session: key, serviceKind: 'discord', tenantId: 'guild-1', surfaceId: 'thread-1', idempotencyKey: 'request-1' }

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

function byId(rows: SurfaceBinding[]): Record<string, unknown> {
  return Object.fromEntries(rows.map((row) => [row.id, wire(row)]))
}

// One active surface, one detached surface, then a generation-2 rebind of it.
async function seededBackup(): Promise<{ backup: BindingBackup; sourceRows: SurfaceBinding[] }> {
  const { db } = await database()
  const first = await bindSurface({ db, ...input })
  if (first instanceof Error) throw first
  const second = await bindSurface({ db, ...input, surfaceId: 'thread-2', idempotencyKey: 'request-2' })
  if (second instanceof Error) throw second
  const detached = await detachBinding({ db, bindingId: second.id, tenantId: input.tenantId })
  if (detached instanceof Error) throw detached
  const rebound = await bindSurface({ db, ...input, surfaceId: 'thread-2', idempotencyKey: 'request-3' })
  if (rebound instanceof Error) throw rebound
  const backup = await exportBindings({ db, tenantId: input.tenantId })
  if (backup instanceof Error) throw backup
  const sourceRows = await listBindings({ db, tenantId: input.tenantId })
  if (sourceRows instanceof Error) throw sourceRows
  return { backup, sourceRows }
}

test('the local filesystem store is the same single JSON file, reached through the boundary', async () => {
  const { backup, sourceRows } = await seededBackup()
  const dir = tempDir('store-local')
  const store = createLocalFilesystemStore({ dir })
  const uploaded = await uploadBindingBackup({ store, key: 'bindings-2026.json', backup })
  if (uploaded instanceof Error) throw uploaded
  expect(uploaded.size).toBeGreaterThan(0)
  expect(uploaded.etag).toMatch(/^[0-9a-f]{64}$/)
  expect(uploaded.digest).toMatch(/^[0-9a-f]{64}$/)
  // The current behaviour, verbatim: one JSON file on disk under the store dir.
  const files = await store.list()
  if (files instanceof Error) throw files
  expect(files).toEqual(['bindings-2026.json'])
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'bindings-2026.json'), 'utf8')) as Record<string, unknown>
  expect(onDisk['version']).toBe(1)
  expect(onDisk['digest']).toBe(uploaded.digest)
  expect(onDisk['rows']).toHaveLength(3)

  const target = await database()
  const restored = await restoreBindingBackup({ store, key: 'bindings-2026.json', db: target.db })
  if (restored instanceof Error) throw restored
  expect(restored).toMatchObject({ imported: 3, skipped: 0, version: 1, digest: uploaded.digest })
  const after = await listBindings({ db: target.db, tenantId: input.tenantId })
  if (after instanceof Error) throw after
  expect(byId(after)).toEqual(byId(sourceRows))
})

test('a second upload to an existing key is refused unless the caller asks to replace it', async () => {
  const { backup } = await seededBackup()
  const store = createInMemoryObjectStore()
  const first = await uploadBindingBackup({ store, key: 'backup.json', backup })
  if (first instanceof Error) throw first

  // A conditional put on an existing key: the store refuses, and the digest it
  // already holds is untouched.
  const sameName = await uploadBindingBackup({ store, key: 'backup.json', backup: { ...backup, exportedAt: backup.exportedAt + 1 } })
  expect(sameName).toBeInstanceOf(Error)
  expect((sameName as Error).name).toBe('BackupStoreError')
  expect((sameName as Error).message).toContain('already exists')
  const held = await store.get('backup.json')
  if (held instanceof Error) throw held
  const heldJson = JSON.parse(Buffer.from(held.bytes).toString('utf8')) as Record<string, unknown>
  expect(heldJson['digest']).toBe(first.digest)
  expect(heldJson['exportedAt']).toBe(backup.exportedAt)

  // An explicit replace is the only way through, and it records the new digest.
  const replaced = await uploadBindingBackup({ store, key: 'backup.json', backup: { ...backup, exportedAt: backup.exportedAt + 1 }, replace: true })
  if (replaced instanceof Error) throw replaced
  expect(replaced.digest).not.toBe(first.digest)
  const reread = await store.get('backup.json')
  if (reread instanceof Error) throw reread
  expect(JSON.parse(Buffer.from(reread.bytes).toString('utf8'))).toMatchObject({ exportedAt: backup.exportedAt + 1, digest: replaced.digest })
})

test('a restore reads byte-identical rows back through the store boundary', async () => {
  const { backup, sourceRows } = await seededBackup()
  const store = createInMemoryObjectStore()
  const uploaded = await uploadBindingBackup({ store, key: 'byte-identical.json', backup })
  if (uploaded instanceof Error) throw uploaded
  const object = await store.get('byte-identical.json')
  if (object instanceof Error) throw object
  // A read returns a checksum over exactly the bytes it served.
  expect(object.checksum).toBe(sha256Hex(object.bytes))
  expect(object.checksum).toBe(uploaded.etag)

  const target = await database()
  expect(await restoreBindingBackup({ store, key: 'byte-identical.json', db: target.db })).toMatchObject({ imported: 3, skipped: 0 })
  const after = await listBindings({ db: target.db, tenantId: input.tenantId })
  if (after instanceof Error) throw after
  expect(after.map(wire)).toEqual(sourceRows.map(wire))
  expect(after.find((row) => row.surface_id === 'thread-2' && row.state === 'active')).toMatchObject({ generation: 2 })
})

test('a corrupted payload is refused by digest before any write, and leaves no residue', async () => {
  const { backup } = await seededBackup()
  const store = createInMemoryObjectStore()
  const uploaded = await uploadBindingBackup({ store, key: 'corrupt.json', backup })
  if (uploaded instanceof Error) throw uploaded

  // Alter one stored row in place: still valid JSON, so only the digest can catch it.
  expect(store.tamper('corrupt.json', (bytes) => {
    const sealed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { rows: { generation: number }[] }
    sealed.rows[0]!.generation += 1
    return new Uint8Array(Buffer.from(JSON.stringify(sealed), 'utf8'))
  })).toBe(true)

  const target = await database()
  const refused = await restoreBindingBackup({ store, key: 'corrupt.json', db: target.db })
  expect(refused).toBeInstanceOf(Error)
  expect((refused as Error).message).toContain(uploaded.digest)
  expect((refused as Error).message).toMatch(/does not match its content/)
  expect((refused as Error).message).toMatch(/truncated or altered/)
  // No partial write: the target database never saw a row.
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual([])

  // A truncation that breaks the JSON envelope is refused too, with no row.
  expect(store.tamper('corrupt.json', (bytes) => bytes.slice(0, bytes.byteLength - 25))).toBe(true)
  const truncated = await restoreBindingBackup({ store, key: 'corrupt.json', db: target.db })
  expect(truncated).toBeInstanceOf(Error)
  expect((truncated as Error).message).toMatch(/not readable JSON/)
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual([])

  // Replacing the object with an intact backup proves the refusals wrote nothing
  // and did not poison the key.
  const repaired = await uploadBindingBackup({ store, key: 'corrupt.json', backup, replace: true })
  if (repaired instanceof Error) throw repaired
  expect(await restoreBindingBackup({ store, key: 'corrupt.json', db: target.db })).toMatchObject({ imported: 3, skipped: 0 })
})

test('a backup produced from a different schema version is refused by name', async () => {
  const { backup } = await seededBackup()
  const store = createInMemoryObjectStore()
  // A version-2 envelope sealed honestly: its digest matches, so only the
  // version check can refuse it.
  const future = { ...backup, version: 2 as unknown as 1 }
  const sealedFuture = sealBindingBackup(future)
  if (sealedFuture instanceof Error) throw sealedFuture
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(sealedFuture), 'utf8'))
  const put = await store.put('future.json', bytes)
  if (put instanceof Error) throw put

  const target = await database()
  const refused = await restoreBindingBackup({ store, key: 'future.json', db: target.db })
  expect(refused).toBeInstanceOf(Error)
  expect((refused as Error).message).toContain('Unsupported binding backup version 2')
  expect((refused as Error).message).toMatch(/Only version 1 can be restored/)
  expect(await listBindings({ db: target.db, tenantId: input.tenantId })).toEqual([])

  // The version is also named when the seal is absent entirely.
  const unsealed = await store.put('unsealed.json', new Uint8Array(Buffer.from(JSON.stringify(backup), 'utf8')))
  if (unsealed instanceof Error) throw unsealed
  const noDigest = await restoreBindingBackup({ store, key: 'unsealed.json', db: target.db })
  expect(noDigest).toBeInstanceOf(Error)
  expect((noDigest as Error).message).toMatch(/no content digest/)
})

test('restoring the same store object twice skips rows already present', async () => {
  const { backup } = await seededBackup()
  const store = createInMemoryObjectStore()
  const uploaded = await uploadBindingBackup({ store, key: 'twice.json', backup })
  if (uploaded instanceof Error) throw uploaded
  const target = await database()
  expect(await restoreBindingBackup({ store, key: 'twice.json', db: target.db })).toMatchObject({ imported: 3, skipped: 0 })
  expect(await restoreBindingBackup({ store, key: 'twice.json', db: target.db })).toMatchObject({ imported: 0, skipped: 3 })
})

test('both stores refuse a key that would leave the store, and a missing key is an error', async () => {
  const { backup } = await seededBackup()
  const dir = tempDir('store-traversal')
  const local = createLocalFilesystemStore({ dir })
  const memory = createInMemoryObjectStore()
  for (const store of [local, memory]) {
    expect(await uploadBindingBackup({ store, key: '../escape.json', backup })).toBeInstanceOf(Error)
    expect(await uploadBindingBackup({ store, key: '', backup })).toBeInstanceOf(Error)
    const missing = await restoreBindingBackup({ store, key: 'absent.json', db: (await database()).db })
    expect(missing).toBeInstanceOf(Error)
    expect((missing as Error).message).toContain('no backup object')
  }
  expect(fs.existsSync(path.join(dir, '..', 'escape.json'))).toBe(false)
})
