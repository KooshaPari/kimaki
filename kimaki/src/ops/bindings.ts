// Metadata associations have no runtime adapter, transcript reader or lifecycle callback.
// Local trusted callers supply native identity explicitly. These rows confer no service authority.
import crypto from 'node:crypto'
import * as orm from 'drizzle-orm'
import type { KimakiDb } from '../db.ts'
import { ConfigError, DbError } from '../errors.ts'
import { ops_surface_bindings as bindings } from '../schema.ts'
import type { SessionKey } from './contracts.ts'

export type SurfaceBinding = typeof bindings.$inferSelect
export type BindSurfaceInput = {
  db: KimakiDb
  session: SessionKey
  serviceKind: string
  tenantId: string
  surfaceId: string
  idempotencyKey: string
  mode?: string
}

// Versioned, metadata-only backup. Rows carry identity, generations and route
// ownership; they never carry control or publication authority.
export type BindingBackup = {
  version: 1
  exportedAt: number
  rows: SurfaceBinding[]
}

export type ImportBindingsResult = {
  imported: number
  skipped: number
}

// Every stored column participates: a row is "identical" only when all of them match.
const BINDING_FIELDS = [
  'id', 'host_id', 'endpoint_id', 'backend_kind', 'native_session_id',
  'service_kind', 'tenant_id', 'surface_id', 'mode', 'publication_policy',
  'state', 'generation', 'idempotency_key', 'created_at',
] as const satisfies readonly (keyof SurfaceBinding)[]

const IDENTIFIER_FIELDS = [
  'id', 'host_id', 'endpoint_id', 'backend_kind', 'native_session_id',
  'service_kind', 'tenant_id', 'surface_id', 'idempotency_key',
] as const satisfies readonly (keyof SurfaceBinding)[]

// Shared with the cutover module (ops/cutover.ts) so identity checks stay one rule.
export function validIdentifiers(values: unknown[]): boolean {
  return values.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !value.includes('\0'))
}

function sameBinding(left: SurfaceBinding, right: SurfaceBinding): boolean {
  return BINDING_FIELDS.every((field) => left[field] === right[field])
}

// Rebuilds a row field by field so unknown properties in an untrusted backup can
// never reach the insert, and rejects values that would widen authority.
function validateBackupRow(value: unknown): SurfaceBinding | ConfigError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return new ConfigError({ reason: 'Every backup row must be an object' })
  }
  const row = value as Record<string, unknown>
  const label = typeof row['id'] === 'string' && row['id'].trim() ? `Backup row ${row['id']}` : 'Every backup row'
  for (const field of IDENTIFIER_FIELDS) {
    if (!validIdentifiers([row[field]])) {
      return new ConfigError({ reason: `${label} must have a nonblank ${field} of at most 2048 characters` })
    }
  }
  if (row['mode'] !== 'observe') {
    return new ConfigError({ reason: `${label} has mode ${String(row['mode'])}. Only metadata-only observe bindings can be restored` })
  }
  if (row['publication_policy'] !== 'none') {
    return new ConfigError({ reason: `${label} has publication policy ${String(row['publication_policy'])}. Restored bindings cannot publish transcripts` })
  }
  if (row['state'] !== 'active' && row['state'] !== 'detached') {
    return new ConfigError({ reason: `${label} has state ${String(row['state'])}. Only active or detached bindings can be restored` })
  }
  if (typeof row['generation'] !== 'number' || !Number.isSafeInteger(row['generation']) || row['generation'] <= 0) {
    return new ConfigError({ reason: `${label} must have a positive integer generation` })
  }
  if (typeof row['created_at'] !== 'number' || !Number.isFinite(row['created_at']) || !Number.isSafeInteger(row['created_at']) || row['created_at'] < 0) {
    return new ConfigError({ reason: `${label} must have a finite creation timestamp` })
  }
  return {
    id: row['id'] as string,
    host_id: row['host_id'] as string,
    endpoint_id: row['endpoint_id'] as string,
    backend_kind: row['backend_kind'] as string,
    native_session_id: row['native_session_id'] as string,
    service_kind: row['service_kind'] as string,
    tenant_id: row['tenant_id'] as string,
    surface_id: row['surface_id'] as string,
    mode: row['mode'],
    publication_policy: row['publication_policy'],
    state: row['state'],
    generation: row['generation'],
    idempotency_key: row['idempotency_key'] as string,
    created_at: row['created_at'],
  }
}

export async function exportBindings({ db, tenantId, serviceKind }: {
  db: KimakiDb
  tenantId?: string
  serviceKind?: string
}): Promise<BindingBackup | ConfigError | DbError> {
  const supplied = [tenantId, serviceKind].filter((value) => value !== undefined)
  if (!validIdentifiers(supplied)) return new ConfigError({ reason: 'Supply nonblank --tenant and service IDs when scoping a backup' })
  const conditions: orm.SQL[] = []
  if (tenantId !== undefined) conditions.push(orm.eq(bindings.tenant_id, tenantId))
  if (serviceKind !== undefined) conditions.push(orm.eq(bindings.service_kind, serviceKind))
  const rows = await db.select().from(bindings)
    .where(conditions.length > 0 ? orm.and(...conditions) : undefined)
    .orderBy(orm.asc(bindings.created_at), orm.asc(bindings.id))
    .catch((cause) => new DbError({ operation: 'export metadata bindings', cause }))
  if (rows instanceof Error) return rows
  return { version: 1, exportedAt: Date.now(), rows }
}

// Restore is atomic: validation happens before the transaction, and any same-id
// difference or unique-index collision aborts the transaction before commit.
export async function importBindings({ db, backup }: {
  db: KimakiDb
  backup: unknown
}): Promise<ImportBindingsResult | ConfigError | DbError> {
  if (typeof backup !== 'object' || backup === null || Array.isArray(backup)) {
    return new ConfigError({ reason: 'Backup must be a versioned binding backup object' })
  }
  const envelope = backup as Record<string, unknown>
  if (envelope['version'] !== 1) {
    return new ConfigError({ reason: `Unsupported binding backup version ${String(envelope['version'])}. Only version 1 can be restored` })
  }
  if (typeof envelope['exportedAt'] !== 'number' || !Number.isFinite(envelope['exportedAt'])) {
    return new ConfigError({ reason: 'Backup exportedAt must be a finite timestamp' })
  }
  if (!Array.isArray(envelope['rows'])) return new ConfigError({ reason: 'Backup rows must be an array' })

  const rows: SurfaceBinding[] = []
  const seen = new Map<string, SurfaceBinding>()
  for (const value of envelope['rows']) {
    const row = validateBackupRow(value)
    if (row instanceof Error) return row
    const earlier = seen.get(row.id)
    if (earlier && !sameBinding(earlier, row)) {
      return new ConfigError({ reason: `Backup contains conflicting rows with id ${row.id}` })
    }
    if (!earlier) seen.set(row.id, row)
    rows.push(row)
  }

  return db.transaction(async (tx) => {
    let imported = 0
    let skipped = 0
    for (const row of rows) {
      const existing = await tx.select().from(bindings).where(orm.eq(bindings.id, row.id)).limit(1)
      const current = existing[0]
      if (current) {
        if (sameBinding(current, row)) {
          skipped += 1
          continue
        }
        throw new ConfigError({ reason: `Binding ${row.id} already exists with different state, generation, route or request ID. Restore into a clean database instead of overwriting it` })
      }
      const keyed = await tx.select().from(bindings).where(orm.and(
        orm.eq(bindings.service_kind, row.service_kind),
        orm.eq(bindings.tenant_id, row.tenant_id),
        orm.eq(bindings.idempotency_key, row.idempotency_key),
      )).limit(1)
      if (keyed[0]) {
        throw new ConfigError({ reason: `Binding ${row.id} would collide with request ID ${row.idempotency_key} in tenant ${row.tenant_id}` })
      }
      if (row.state === 'active') {
        const occupied = await tx.select().from(bindings).where(orm.and(
          orm.eq(bindings.service_kind, row.service_kind),
          orm.eq(bindings.tenant_id, row.tenant_id),
          orm.eq(bindings.surface_id, row.surface_id),
          orm.eq(bindings.state, 'active'),
        )).limit(1)
        if (occupied[0]) {
          throw new ConfigError({ reason: `Binding ${row.id} would collide with the active binding of surface ${row.surface_id} in tenant ${row.tenant_id}` })
        }
      }
      try {
        await tx.insert(bindings).values(row)
      } catch (cause) {
        if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) {
          throw new ConfigError({ reason: `Binding ${row.id} collides with an existing unique binding index. Restore into a clean database instead of partially importing` })
        }
        throw cause
      }
      imported += 1
    }
    return { imported, skipped }
  }).catch((cause) => cause instanceof ConfigError ? cause : new DbError({ operation: 'restore metadata bindings', cause }))
}

export async function bindSurface(input: BindSurfaceInput): Promise<SurfaceBinding | ConfigError | DbError> {
  const { db, session, serviceKind, tenantId, surfaceId, idempotencyKey } = input
  if (!session || !validIdentifiers([session.hostId, session.endpointId, session.backendKind, session.nativeSessionId, serviceKind, tenantId, surfaceId, idempotencyKey])) {
    return new ConfigError({ reason: 'Supply non-empty host, endpoint, backend, native session, service, tenant, surface and request IDs' })
  }
  if (input.mode !== undefined && input.mode !== 'observe') {
    return new ConfigError({ reason: 'Only metadata-only observe bindings are supported. Runtime control and transcript publication are disabled' })
  }
  // A surface mid-cutover already has an owner: its paused source. Binding here
  // would create a second owner, so the cutover must complete or abort first.
  const midCutover = await db.select({ id: bindings.id }).from(bindings).where(orm.and(
    orm.eq(bindings.service_kind, serviceKind),
    orm.eq(bindings.tenant_id, tenantId),
    orm.eq(bindings.surface_id, surfaceId),
    orm.sql`${bindings.state} IN ('paused', 'staged')`,
  )).limit(1).catch((cause) => new DbError({ operation: 'read cutover state', cause }))
  if (midCutover instanceof Error) return midCutover
  if (midCutover.length > 0) {
    return new ConfigError({ reason: `Surface ${surfaceId} is mid-cutover. Complete or abort the cutover before binding it again` })
  }
  // Unique constraints and generation allocation execute in one SQLite statement, including across processes.
  const inserted = await db.insert(bindings).values({
    id: crypto.randomUUID(),
    host_id: session.hostId,
    endpoint_id: session.endpointId,
    backend_kind: session.backendKind,
    native_session_id: session.nativeSessionId,
    service_kind: serviceKind,
    tenant_id: tenantId,
    surface_id: surfaceId,
    mode: 'observe',
    publication_policy: 'none',
    state: 'active',
    generation: orm.sql`(SELECT COALESCE(MAX(generation), 0) + 1 FROM ops_surface_bindings WHERE service_kind = ${serviceKind} AND tenant_id = ${tenantId} AND surface_id = ${surfaceId})`,
    idempotency_key: idempotencyKey,
    created_at: Date.now(),
  }).onConflictDoNothing().returning().catch((cause) => new DbError({ operation: 'bind metadata surface', cause }))
  if (inserted instanceof Error) return inserted
  if (inserted[0]) return inserted[0]
  const existing = await db.query.ops_surface_bindings.findFirst({
    where: { service_kind: serviceKind, tenant_id: tenantId, idempotency_key: idempotencyKey },
  }).catch((cause) => new DbError({ operation: 'read binding request', cause }))
  if (existing instanceof Error) return existing
  if (existing && existing.host_id === session.hostId && existing.endpoint_id === session.endpointId && existing.backend_kind === session.backendKind && existing.native_session_id === session.nativeSessionId && existing.surface_id === surfaceId) return existing
  return new ConfigError({ reason: existing
    ? 'Request ID already records a different binding. Use a new --request ID for a new intent'
    : 'Surface already has an active binding. Detach it explicitly before rebinding' })
}

export async function listBindings({ db, tenantId, serviceKind = 'discord' }: {
  db: KimakiDb
  tenantId: string
  serviceKind?: string
}): Promise<SurfaceBinding[] | ConfigError | DbError> {
  if (!validIdentifiers([tenantId, serviceKind])) return new ConfigError({ reason: 'Supply --tenant and a non-empty service ID' })
  return db.query.ops_surface_bindings.findMany({
    where: { tenant_id: tenantId, service_kind: serviceKind },
    orderBy: { created_at: 'asc', id: 'asc' },
  }).catch((cause) => new DbError({ operation: 'list metadata bindings', cause }))
}

export async function detachBinding({ db, bindingId, tenantId, serviceKind = 'discord' }: {
  db: KimakiDb
  bindingId: string
  tenantId: string
  serviceKind?: string
}): Promise<SurfaceBinding | ConfigError | DbError> {
  if (!validIdentifiers([bindingId, tenantId, serviceKind])) return new ConfigError({ reason: 'Supply binding ID, --tenant and service ID to detach' })
  const updated = await db.update(bindings).set({ state: 'detached' }).where(orm.and(
    orm.eq(bindings.id, bindingId), orm.eq(bindings.tenant_id, tenantId), orm.eq(bindings.service_kind, serviceKind),
  )).returning().catch((cause) => new DbError({ operation: 'detach metadata binding', cause }))
  if (updated instanceof Error) return updated
  return updated[0] ?? new ConfigError({ reason: 'No binding found in this tenant and service. Run kimaki ops bindings --tenant <id> to inspect local associations' })
}

// AC22: a worker finished its task but the write-back to the coordinating surface
// did not land. The result is held as `pending-sync`, which is neither `synced`
// nor `failed`. Only an acknowledgement from the target surface may move a record
// to `synced`; a successful worker run alone is never proof of delivery.
//
// The ledger is coordination state, not worker state: it owns the digest, the
// target, the attempt count and the last error, so a replay can be decided
// without re-running the worker and without a second delivery.
export type SyncBackState = 'pending-sync' | 'synced'

export type WorkerResultSyncBack = {
  id: string
  worker_id: string
  target: string
  payload_digest: string
  attempts: number
  last_error: string | null
  state: SyncBackState
  ack_id: string | null
  acknowledged_at: number | null
  created_at: number
}

// One ledger per coordinating surface. Reconciliation never reorders work: each
// record settles on its own, so two pending results may land in any order.
export type SyncBackLedger = {
  records: Map<string, WorkerResultSyncBack>
  in_flight: Set<string>
}

export function createSyncBackLedger(): SyncBackLedger {
  return { records: new Map(), in_flight: new Set() }
}

// Deterministic JSON so the same result always yields the same digest, whatever
// key order the worker used. Values JSON cannot carry are refused, not coerced.
function canonicalPayload(value: unknown, seen: Set<object> = new Set()): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  let canonical: string | undefined
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalPayload(item, seen))
    canonical = items.some((item) => item === undefined) ? undefined : `[${items.join(',')}]`
  } else {
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => {
      const item = canonicalPayload((value as Record<string, unknown>)[key], seen)
      return item === undefined ? undefined : `${JSON.stringify(key)}:${item}`
    })
    canonical = entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(',')}}`
  }
  seen.delete(value)
  return canonical
}

export function payloadDigest(payload: unknown): string | ConfigError {
  const canonical = canonicalPayload(payload)
  if (canonical === undefined) return new ConfigError({ reason: 'The worker result payload must be JSON-serializable before it can be recorded for sync-back' })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return typeof cause === 'string' && cause.trim() ? cause : 'The write-back to the coordinating surface was not acknowledged'
}

export function recordWorkerResultSyncBack({ ledger, workerId, target, payload, cause }: {
  ledger: SyncBackLedger
  workerId: string
  target: string
  payload: unknown
  cause?: unknown
}): WorkerResultSyncBack | ConfigError {
  if (!validIdentifiers([workerId, target])) {
    return new ConfigError({ reason: 'Supply a non-empty worker ID and sync-back target' })
  }
  const digest = payloadDigest(payload)
  if (digest instanceof Error) return digest
  for (const existing of ledger.records.values()) {
    if (existing.worker_id !== workerId) continue
    // Same worker, same digest, same surface: this is the same result seen twice.
    if (existing.payload_digest === digest && existing.target === target) return existing
    if (existing.payload_digest !== digest) {
      return new ConfigError({ reason: `Worker ${workerId} already has a result with digest ${existing.payload_digest} for ${existing.target}. Refusing a different payload with digest ${digest} instead of overwriting it` })
    }
    return new ConfigError({ reason: `Worker ${workerId} already has a result with digest ${digest} destined for ${existing.target}. Refusing to re-record it against ${target}` })
  }
  const record: WorkerResultSyncBack = {
    id: crypto.randomUUID(),
    worker_id: workerId,
    target,
    payload_digest: digest,
    // A record exists because a delivery was attempted and not acknowledged.
    attempts: cause === undefined ? 0 : 1,
    last_error: cause === undefined ? null : errorText(cause),
    state: 'pending-sync',
    ack_id: null,
    acknowledged_at: null,
    created_at: Date.now(),
  }
  ledger.records.set(record.id, record)
  return record
}

export type SyncBackDelivery = (record: WorkerResultSyncBack) => Promise<unknown> | unknown

export type ReconcileSyncBackResult =
  | { status: 'synced'; record: WorkerResultSyncBack; delivered: true }
  | { status: 'duplicate'; record: WorkerResultSyncBack; delivered: false }
  | { status: 'pending-sync'; record: WorkerResultSyncBack; delivered: false; error: string }

function ackIdOf(delivered: unknown): string | undefined {
  if (typeof delivered !== 'object' || delivered === null) return undefined
  const ack = (delivered as Record<string, unknown>)['ackId']
  return typeof ack === 'string' && ack.trim().length > 0 ? ack : undefined
}

// Replays one pending sync-back. The delivery runs outside the ledger, and the
// record settles in a single write: there is no state where the record claims
// `synced` without holding the acknowledgement that proves it.
export async function reconcileSyncBack({ ledger, recordId, deliver }: {
  ledger: SyncBackLedger
  recordId: string
  deliver: SyncBackDelivery
}): Promise<ReconcileSyncBackResult | ConfigError> {
  const record = ledger.records.get(recordId)
  if (!record) return new ConfigError({ reason: `No worker result sync-back record ${recordId} is held by this ledger` })
  if (record.state === 'synced') return { status: 'duplicate', record, delivered: false }
  if (ledger.in_flight.has(record.id)) {
    return new ConfigError({ reason: `A sync-back for worker ${record.worker_id} to ${record.target} is already in flight. Wait for it instead of delivering the result twice` })
  }
  ledger.in_flight.add(record.id)
  let delivered: string | undefined
  let failure: string | undefined
  try {
    delivered = ackIdOf(await deliver(record))
    if (delivered === undefined) failure = 'The coordinating surface returned no acknowledgement for the write-back'
  } catch (cause) {
    failure = errorText(cause)
  } finally {
    ledger.in_flight.delete(record.id)
  }
  if (failure !== undefined) {
    // Still unacknowledged: the attempt is counted, the state stays pending-sync.
    const pending: WorkerResultSyncBack = { ...record, attempts: record.attempts + 1, last_error: failure, state: 'pending-sync' }
    ledger.records.set(pending.id, pending)
    return { status: 'pending-sync', record: pending, delivered: false, error: failure }
  }
  const synced: WorkerResultSyncBack = {
    ...record,
    attempts: record.attempts + 1,
    last_error: null,
    state: 'synced',
    ack_id: delivered as string,
    acknowledged_at: Date.now(),
  }
  ledger.records.set(synced.id, synced)
  return { status: 'synced', record: synced, delivered: true }
}

export function listWorkerResultSyncBacks({ ledger }: { ledger: SyncBackLedger }): WorkerResultSyncBack[] {
  // Insertion order is the record's creation order; equal timestamps must not
  // reshuffle the list by UUID. Settling a record keeps its key and its position.
  return [...ledger.records.values()].sort((left, right) => left.created_at - right.created_at)
}
