// AC34: connector cutover. These rows move *ownership of a surface* from one
// binding to another. The cutover itself never starts, stops, reroutes or pauses
// a Discord or Paperclip connector; it moves the metadata a connector is fenced
// by. A running consumer claims the binding that names its own identity and asks
// writeSurface before every post (claimSurface, below), so a real consumer does
// stop posting through the pause and a real competitor does take over after the
// handover. A failed cutover never strands a surface.
import crypto from 'node:crypto'
import * as orm from 'drizzle-orm'
import type { KimakiDb } from '../db.ts'
import { ConfigError, DbError } from '../errors.ts'
import { ops_surface_bindings as bindings } from '../schema.ts'
import { validIdentifiers, type SurfaceBinding } from './bindings.ts'
import type { SessionKey } from './contracts.ts'

// active -> paused -> retired, with a staged target that owns nothing until the
// cutover completes. `paused`, `staged` and `retired` are written as SQL
// literals: the drizzle column enum predates cutover, and widening it would
// change the restore validator shared with backup imports.
export type CutoverState = 'active' | 'detached' | 'paused' | 'staged' | 'retired'

export type CutoverPhase = 'in-progress' | 'complete' | 'aborted'

export type CutoverRecord = {
  surface: string
  source_id: string
  target_id: string
  generation: number
  phase: CutoverPhase
  source_state: CutoverState
  target_state: CutoverState
  created_at: number
}

function stateValue(state: CutoverState): orm.SQL {
  // A closed string union, so raw interpolation cannot carry caller input.
  return orm.sql.raw(`'${state}'`)
}

function stateOf(row: SurfaceBinding): CutoverState {
  // The column's drizzle enum only knows the pre-cutover states; the stored text
  // is the authority.
  return row.state as CutoverState
}

function surfaceFilter(row: SurfaceBinding): orm.SQL {
  return orm.and(
    orm.eq(bindings.service_kind, row.service_kind),
    orm.eq(bindings.tenant_id, row.tenant_id),
    orm.eq(bindings.surface_id, row.surface_id),
  ) as orm.SQL
}

function surfaceLabel(row: SurfaceBinding): string {
  return `${row.service_kind}:${row.tenant_id}:${row.surface_id}`
}

function recordOf(source: SurfaceBinding, target: SurfaceBinding, phase: CutoverPhase): CutoverRecord {
  return {
    surface: surfaceLabel(source),
    source_id: source.id,
    target_id: target.id,
    generation: target.generation,
    phase,
    source_state: stateOf(source),
    target_state: stateOf(target),
    created_at: target.created_at,
  }
}

function stagedOf(rows: SurfaceBinding[]): SurfaceBinding[] {
  return rows.filter((row) => stateOf(row) === 'staged')
}

// Fencing and the cutover source check both concern rows that can still own the
// surface. A detached or retired row keeps its generation as history, so an
// abandoned target can never fence the owner that survived it.
function ownerGeneration(rows: SurfaceBinding[]): number {
  return rows
    .filter((row) => stateOf(row) !== 'detached' && stateOf(row) !== 'retired')
    .reduce((max, row) => Math.max(max, row.generation), 0)
}

// AC34.1: pause the source at its current generation and stage a target at the
// next generation. The source keeps ownership of the surface while paused, so
// no reader ever observes zero owners or two.
export async function beginCutover({ db, sourceId, target, idempotencyKey }: {
  db: KimakiDb
  sourceId: string
  target: SessionKey
  idempotencyKey: string
}): Promise<CutoverRecord | ConfigError | DbError> {
  if (!validIdentifiers([sourceId, idempotencyKey, target?.hostId, target?.endpointId, target?.backendKind, target?.nativeSessionId])) {
    return new ConfigError({ reason: 'Supply a source binding, a request ID and non-empty target host, endpoint, backend and native session IDs to cut over' })
  }
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(bindings).where(orm.eq(bindings.id, sourceId)).limit(1)
    if (!source) {
      throw new ConfigError({ reason: `No binding ${sourceId} found to cut over. Run kimaki ops bindings --tenant <id> to inspect local associations` })
    }
    // AC34.1: a cutover moves an observe row. It never hands over control.
    if (source.mode !== 'observe') {
      throw new ConfigError({ reason: `Source binding ${sourceId} has mode ${source.mode}. A cutover only moves an observe binding` })
    }
    const rows = await tx.select().from(bindings).where(surfaceFilter(source))
    const label = surfaceLabel(source)
    // A request ID already recorded for this cutover is a replay, not a new one.
    const keyed = await tx.select().from(bindings).where(orm.and(
      orm.eq(bindings.service_kind, source.service_kind),
      orm.eq(bindings.tenant_id, source.tenant_id),
      orm.eq(bindings.idempotency_key, idempotencyKey),
    )).limit(1)
    if (keyed[0]) {
      const replay = keyed[0]
      const sameTarget = keyed[0].surface_id === source.surface_id && keyed[0].host_id === target.hostId && keyed[0].endpoint_id === target.endpointId && keyed[0].backend_kind === target.backendKind && keyed[0].native_session_id === target.nativeSessionId && stateOf(keyed[0]) === 'staged'
      if (sameTarget) return recordOf(source, replay, 'in-progress')
      throw new ConfigError({ reason: `Request ID ${idempotencyKey} already records binding ${replay.id} of surface ${replay.service_kind}:${replay.tenant_id}:${replay.surface_id}. Use a new --request ID for a new cutover` })
    }
    // AC34.3: only one cutover may be in flight for a surface at a time.
    if (stagedOf(rows).length > 0) {
      throw new ConfigError({ reason: `A cutover of surface ${label} is already in progress. Complete it with completeCutover or restore it with abortCutover before starting another` })
    }
    const recorded = ownerGeneration(rows)
    // AC34.1: a binding behind the recorded generation is superseded, not a source.
    if (source.generation < recorded) {
      throw new ConfigError({ reason: `Source binding ${sourceId} is at generation ${source.generation} but surface ${label} already records generation ${recorded}. A superseded binding cannot be cut over` })
    }
    if (stateOf(source) !== 'active') {
      throw new ConfigError({ reason: `Source binding ${sourceId} is ${stateOf(source)}. Only the active binding of a surface can be cut over` })
    }
    const staged = await tx.insert(bindings).values({
      id: crypto.randomUUID(),
      host_id: target.hostId,
      endpoint_id: target.endpointId,
      backend_kind: target.backendKind,
      native_session_id: target.nativeSessionId,
      service_kind: source.service_kind,
      tenant_id: source.tenant_id,
      surface_id: source.surface_id,
      mode: 'observe',
      publication_policy: 'none',
      state: stateValue('staged'),
      generation: orm.sql`(SELECT COALESCE(MAX(generation), 0) + 1 FROM ops_surface_bindings WHERE service_kind = ${source.service_kind} AND tenant_id = ${source.tenant_id} AND surface_id = ${source.surface_id})`,
      idempotency_key: idempotencyKey,
      created_at: Date.now(),
    }).returning()
    const target_row = staged[0]
    if (!target_row) throw new ConfigError({ reason: `Could not stage a target binding for surface ${label}` })
    const paused = await tx.update(bindings).set({ state: stateValue('paused') })
      .where(orm.eq(bindings.id, source.id)).returning()
    const source_row = paused[0]
    if (!source_row) throw new ConfigError({ reason: `Could not pause source binding ${sourceId} for surface ${label}` })
    return recordOf(source_row, target_row, 'in-progress')
  }).catch((cause) => cause instanceof ConfigError ? cause : new DbError({ operation: 'begin metadata cutover', cause }))
}

// AC34.3: ownership moves to the target and the source retires. Repeating a
// completion returns the same record instead of moving anything twice.
export async function completeCutover({ db, sourceId }: {
  db: KimakiDb
  sourceId: string
}): Promise<CutoverRecord | ConfigError | DbError> {
  if (!validIdentifiers([sourceId])) return new ConfigError({ reason: 'Supply a source binding ID to complete a cutover' })
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(bindings).where(orm.eq(bindings.id, sourceId)).limit(1)
    if (!source) throw new ConfigError({ reason: `No binding ${sourceId} found to complete` })
    const rows = await tx.select().from(bindings).where(surfaceFilter(source))
    const label = surfaceLabel(source)
    if (stateOf(source) === 'retired') {
      const owner = rows.find((row) => stateOf(row) === 'active')
      if (!owner) throw new ConfigError({ reason: `Source binding ${sourceId} is retired but surface ${label} has no active owner` })
      // Idempotent: the second completion observes the finished cutover.
      return recordOf(source, owner, 'complete')
    }
    if (stateOf(source) !== 'paused') {
      throw new ConfigError({ reason: `Source binding ${sourceId} is ${stateOf(source)}. Only a paused source can complete a cutover` })
    }
    const staged = stagedOf(rows)
    if (staged.length !== 1) {
      throw new ConfigError({ reason: `Surface ${label} holds ${staged.length} staged targets, not 1. Abort the cutover instead of completing it` })
    }
    const target = staged[0]!
    // Both writes are one transaction: no reader sees the source and the target
    // owning the surface, and none sees neither.
    const promoted = await tx.update(bindings).set({ state: stateValue('active') })
      .where(orm.eq(bindings.id, target.id)).returning()
    const active = promoted[0]
    if (!active) throw new ConfigError({ reason: `Could not promote target binding ${target.id} for surface ${label}` })
    const retired = await tx.update(bindings).set({ state: stateValue('retired') })
      .where(orm.eq(bindings.id, source.id)).returning()
    const source_row = retired[0]
    if (!source_row) throw new ConfigError({ reason: `Could not retire source binding ${sourceId} for surface ${label}` })
    return recordOf(source_row, active, 'complete')
  }).catch((cause) => cause instanceof ConfigError ? cause : new DbError({ operation: 'complete metadata cutover', cause }))
}

// AC34.2/34.3: a failed cutover rolls back to the source at the same
// generation. The target keeps its identity, route and generation and returns to
// the non-owning form it had before the cutover, so the surface is never stranded.
export async function abortCutover({ db, sourceId }: {
  db: KimakiDb
  sourceId: string
}): Promise<CutoverRecord | ConfigError | DbError> {
  if (!validIdentifiers([sourceId])) return new ConfigError({ reason: 'Supply a source binding ID to abort a cutover' })
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(bindings).where(orm.eq(bindings.id, sourceId)).limit(1)
    if (!source) throw new ConfigError({ reason: `No binding ${sourceId} found to abort` })
    const rows = await tx.select().from(bindings).where(surfaceFilter(source))
    const label = surfaceLabel(source)
    if (stateOf(source) === 'retired') {
      throw new ConfigError({ reason: `Source binding ${sourceId} is retired. A completed cutover cannot be aborted; cut back to the previous binding instead` })
    }
    const staged = stagedOf(rows)
    if (stateOf(source) !== 'paused' || staged.length !== 1) {
      throw new ConfigError({ reason: `No cutover of surface ${label} is in progress, so there is nothing to abort. Cutovers are only aborted while their source binding is paused` })
    }
    const target = staged[0]!
    const released = await tx.update(bindings).set({ state: stateValue('detached') })
      .where(orm.eq(bindings.id, target.id)).returning()
    const released_row = released[0]
    if (!released_row) throw new ConfigError({ reason: `Could not release target binding ${target.id} for surface ${label}` })
    const restored = await tx.update(bindings).set({ state: stateValue('active') })
      .where(orm.eq(bindings.id, source.id)).returning()
    const source_row = restored[0]
    if (!source_row) throw new ConfigError({ reason: `Could not restore source binding ${sourceId} for surface ${label}` })
    return recordOf(source_row, released_row, 'aborted')
  }).catch((cause) => cause instanceof ConfigError ? cause : new DbError({ operation: 'abort metadata cutover', cause }))
}

// AC34.4: exactly one owner is observable at every step. A paused source still
// owns the surface; a staged target never does.
export async function readSurface({ db, tenantId, surfaceId, serviceKind = 'discord' }: {
  db: KimakiDb
  tenantId: string
  surfaceId: string
  serviceKind?: string
}): Promise<SurfaceBinding | ConfigError | DbError> {
  if (!validIdentifiers([tenantId, surfaceId, serviceKind])) {
    return new ConfigError({ reason: 'Supply --tenant, surface and service IDs to read a surface owner' })
  }
  const rows = await db.select().from(bindings).where(orm.and(
    orm.eq(bindings.service_kind, serviceKind),
    orm.eq(bindings.tenant_id, tenantId),
    orm.eq(bindings.surface_id, surfaceId),
  )).catch((cause) => new DbError({ operation: 'read metadata surface owner', cause }))
  if (rows instanceof Error) return rows
  const label = `${serviceKind}:${tenantId}:${surfaceId}`
  const active = rows.filter((row) => stateOf(row) === 'active')
  if (active.length > 1) return new ConfigError({ reason: `Surface ${label} has ${active.length} active bindings. Exactly one owner must be observable` })
  if (active[0]) return active[0]
  const paused = rows.filter((row) => stateOf(row) === 'paused')
  if (paused.length > 1) return new ConfigError({ reason: `Surface ${label} has ${paused.length} paused bindings. Exactly one owner must be observable` })
  if (paused[0]) return paused[0]
  return new ConfigError({ reason: `Surface ${label} has no owner binding. Bind the surface before writing to it` })
}

// AC34.2: the "competing consumer pause proof". A write carrying a generation
// the surface has superseded is refused by name, recorded, and never reaches the
// staged target. Nothing is written on refusal, so the refusal is the record.
export type CompetingWriteRefusal = {
  id: string
  binding_id: string
  surface: string
  generation: number
  surface_generation: number
  reason: string
  created_at: number
}

export type CutoverLedger = {
  refusals: CompetingWriteRefusal[]
}

export function createCutoverLedger(): CutoverLedger {
  return { refusals: [] }
}

export function listCutoverRefusals({ ledger }: { ledger: CutoverLedger }): CompetingWriteRefusal[] {
  return [...ledger.refusals]
}

export type SurfaceWriteResult =
  | { accepted: true; binding_id: string; generation: number; surface_generation: number }
  | { accepted: false; binding_id: string; generation: number; surface_generation: number; reason: string }

export async function writeSurface({ db, ledger, bindingId, generation }: {
  db: KimakiDb
  ledger: CutoverLedger
  bindingId: string
  generation: number
}): Promise<SurfaceWriteResult | ConfigError | DbError> {
  if (!validIdentifiers([bindingId]) || !Number.isSafeInteger(generation) || generation <= 0) {
    return new ConfigError({ reason: 'Supply a binding ID and a positive integer generation for a surface write' })
  }
  const found = await db.select().from(bindings).where(orm.eq(bindings.id, bindingId)).limit(1)
    .catch((cause) => new DbError({ operation: 'read write target binding', cause }))
  if (found instanceof Error) return found
  const binding = found[0]
  if (!binding) return new ConfigError({ reason: `No binding ${bindingId} is recorded, so the write has no surface to land on` })
  const rows = await db.select().from(bindings).where(surfaceFilter(binding))
    .catch((cause) => new DbError({ operation: 'read surface generation', cause }))
  if (rows instanceof Error) return rows
  const label = surfaceLabel(binding)
  const current = ownerGeneration(rows)
  const state = stateOf(binding)
  // Generation fencing comes first: a competing consumer is identified by the
  // generation it holds, whether or not the row it addresses is still active.
  const reason = generation < current
    ? `Generation ${generation} is superseded by generation ${current} on surface ${label}. A competing consumer on a superseded generation cannot write`
    : generation > current
      ? `Generation ${generation} is ahead of the recorded generation ${current} on surface ${label}. Unknown generations are not accepted`
      : state !== 'active'
        ? `Binding ${bindingId} is ${state}. Only the active owner of surface ${label} accepts writes`
        : undefined
  if (reason === undefined) return { accepted: true, binding_id: bindingId, generation, surface_generation: current }
  ledger.refusals.push({
    id: crypto.randomUUID(),
    binding_id: bindingId,
    surface: label,
    generation,
    surface_generation: current,
    reason,
    created_at: Date.now(),
  })
  return { accepted: false, binding_id: bindingId, generation, surface_generation: current, reason }
}

// AC34.5: a real consumer claims a surface through the binding row that names its
// own identity. The claim is not a second lock: the row's generation and state
// are the claim, and writeSurface is the same fence every other writer meets.
// A cutover pauses, supersedes or retires that row, which is what stops the
// consumer that held it. `retryable` separates a cutover window (the row is
// paused, or staged for this consumer) from a claim that can never write again,
// so a standby consumer can wait out a handover instead of treating it as loss.
export type SurfaceConsumer = {
  hostId: string
  endpointId: string
  backendKind: string
  nativeSessionId: string
}

export type SurfaceClaim =
  | { claimed: true; binding_id: string; generation: number; surface_generation: number; surface: string }
  | {
    claimed: false
    binding_id: string | null
    generation: number | null
    surface_generation: number | null
    surface: string
    reason: string
    retryable: boolean
  }

export async function claimSurface({ db, ledger, tenantId, surfaceId, consumer, serviceKind = 'discord' }: {
  db: KimakiDb
  ledger: CutoverLedger
  tenantId: string
  surfaceId: string
  consumer: SurfaceConsumer
  serviceKind?: string
}): Promise<SurfaceClaim | ConfigError | DbError> {
  if (!validIdentifiers([tenantId, surfaceId, serviceKind, consumer?.hostId, consumer?.endpointId, consumer?.backendKind, consumer?.nativeSessionId])) {
    return new ConfigError({ reason: 'Supply a consumer host, endpoint, backend and native session, plus tenant and surface IDs, to claim a surface' })
  }
  const label = `${serviceKind}:${tenantId}:${surfaceId}`
  const rows = await db.select().from(bindings).where(orm.and(
    orm.eq(bindings.service_kind, serviceKind),
    orm.eq(bindings.tenant_id, tenantId),
    orm.eq(bindings.surface_id, surfaceId),
  )).catch((cause) => new DbError({ operation: 'read surface claim bindings', cause }))
  if (rows instanceof Error) return rows
  const held = rows.filter((row) =>
    row.host_id === consumer.hostId && row.endpoint_id === consumer.endpointId
    && row.backend_kind === consumer.backendKind && row.native_session_id === consumer.nativeSessionId)
  // Identity names exactly one row. Zero rows means this consumer was never
  // bound; more than one means the store cannot say which row is the claim.
  if (held.length !== 1) {
    const consumerLabel = `${consumer.hostId}/${consumer.endpointId}/${consumer.backendKind}/${consumer.nativeSessionId}`
    return {
      claimed: false, binding_id: null, generation: null, surface_generation: null, surface: label, retryable: false,
      reason: held.length === 0
        ? `Consumer ${consumerLabel} holds no binding on surface ${label}, so it cannot claim the surface. Bind it with kimaki ops bind before it writes`
        : `Consumer ${consumerLabel} holds ${held.length} bindings on surface ${label}. Exactly one binding can name a consumer's claim`,
    }
  }
  const binding = held[0]!
  const written = await writeSurface({ db, ledger, bindingId: binding.id, generation: binding.generation })
  if (written instanceof Error) return written
  if (written.accepted) {
    return {
      claimed: true, binding_id: written.binding_id, generation: written.generation,
      surface_generation: written.surface_generation, surface: label,
    }
  }
  // The row's own state decides whether the refusal is a window or a loss; the
  // refusal text stays exactly the one writeSurface named, never rewritten here.
  const state = stateOf(binding)
  return {
    claimed: false, binding_id: written.binding_id, generation: written.generation,
    surface_generation: written.surface_generation, surface: label, reason: written.reason,
    retryable: state === 'paused' || state === 'staged',
  }
}
