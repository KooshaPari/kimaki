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

function validIdentifiers(values: unknown[]): boolean {
  return values.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !value.includes('\0'))
}

export async function bindSurface(input: BindSurfaceInput): Promise<SurfaceBinding | ConfigError | DbError> {
  const { db, session, serviceKind, tenantId, surfaceId, idempotencyKey } = input
  if (!session || !validIdentifiers([session.hostId, session.endpointId, session.backendKind, session.nativeSessionId, serviceKind, tenantId, surfaceId, idempotencyKey])) {
    return new ConfigError({ reason: 'Supply non-empty host, endpoint, backend, native session, service, tenant, surface and request IDs' })
  }
  if (input.mode !== undefined && input.mode !== 'observe') {
    return new ConfigError({ reason: 'Only metadata-only observe bindings are supported. Runtime control and transcript publication are disabled' })
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
