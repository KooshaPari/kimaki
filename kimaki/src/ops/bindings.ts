// Metadata associations have no runtime adapter, transcript reader or lifecycle callback.
// Local trusted callers supply native identity explicitly. These rows confer no service authority.
import crypto from 'node:crypto'
import * as orm from 'drizzle-orm'
import type { KimakiDb } from '../db.ts'
import { ConfigError, DbError } from '../errors.ts'
import { ops_surface_bindings as bindings } from '../schema.ts'
import type { SessionKey } from './contracts.ts'
import { canonicalPayload } from './sync-back.ts'

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

// A sealed backup carries the content digest a restore checks before writing.
// The digest covers exactly the restore payload: version, creation timestamp and
// rows. Any other top-level property is ignored, so a hostile extra field cannot
// change what the digest attests.
export type SealedBindingBackup = BindingBackup & { digest: string }

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

// A backup digest attests the restore payload only: schema version, creation
// timestamp and rows. It is stable across key order and ignores any other
// top-level property, so an added field cannot change what the digest covers.
export function bindingBackupDigest(
  backup: Pick<BindingBackup, 'version' | 'exportedAt' | 'rows'>,
): string | ConfigError {
  const canonical = canonicalPayload({ version: backup.version, exportedAt: backup.exportedAt, rows: backup.rows })
  if (canonical === undefined) {
    return new ConfigError({ reason: 'The backup payload must be JSON-serializable before a digest can be computed or verified' })
  }
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

export function sealBindingBackup(backup: BindingBackup): SealedBindingBackup | ConfigError {
  const digest = bindingBackupDigest(backup)
  if (digest instanceof Error) return digest
  return { version: backup.version, exportedAt: backup.exportedAt, rows: backup.rows, digest }
}

// Order matters: the schema version is refused by name before the digest is
// examined, so a backup from another version fails for the real reason. A
// missing or mismatched digest is refused before any row is validated or written.
export function verifySealing(sealed: unknown): BindingBackup | ConfigError {
  if (typeof sealed !== 'object' || sealed === null || Array.isArray(sealed)) {
    return new ConfigError({ reason: 'Backup must be a versioned binding backup object' })
  }
  const envelope = sealed as Record<string, unknown>
  if (envelope['version'] !== 1) {
    return new ConfigError({ reason: `Unsupported binding backup version ${String(envelope['version'])}. Only version 1 can be restored` })
  }
  const digest = envelope['digest']
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    return new ConfigError({ reason: 'Backup carries no content digest. Re-export it before restoring so the payload can be verified' })
  }
  const payload = {
    version: envelope['version'],
    exportedAt: envelope['exportedAt'],
    rows: envelope['rows'],
  } as Pick<BindingBackup, 'version' | 'exportedAt' | 'rows'>
  const expected = bindingBackupDigest(payload)
  if (expected instanceof Error) return expected
  if (expected !== digest) {
    return new ConfigError({ reason: `Backup digest ${digest} does not match its content ${expected}. The payload is truncated or altered; refusing to restore it` })
  }
  return payload as BindingBackup
}

// AC22 sync-back lives in its own module (ops/sync-back.ts) because it owns a
// durable store (ops/sync-back-store.ts). Re-exported here so existing callers
// of the bindings module keep one import site.
export {
  canonicalPayload, createSyncBackLedger, flushSyncBackLedger, listWorkerResultSyncBacks,
  openSyncBackLedger, payloadDigest, reconcileSyncBack, recordWorkerResultSyncBack,
} from './sync-back.ts'
export type {
  ReconcileSyncBackResult, SyncBackDelivery, SyncBackLedger, SyncBackState, WorkerResultSyncBack,
} from './sync-back.ts'
