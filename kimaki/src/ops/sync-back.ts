// AC22: a worker finished its task but the write-back to the coordinating surface
// did not land. The result is held as `pending-sync`, which is neither `synced`
// nor `failed`. Only an acknowledgement from the target surface may move a record
// to `synced`; a successful worker run alone is never proof of delivery.
//
// The ledger is coordination state, not worker state: it owns the digest, the
// target, the attempt count and the last error, so a replay can be decided
// without re-running the worker and without a second delivery. Records live in
// the ledger as an in-process view and are written through to sqlite
// (sync-back-store.ts), so a restart reopens the same pending-sync rows.
import crypto from 'node:crypto'
import type { KimakiDb } from '../db.ts'
import { ConfigError, DbError } from '../errors.ts'
import { insertWorkerSyncBack, loadWorkerSyncBacks, updateWorkerSyncBack } from './sync-back-store.ts'

export type SyncBackState = 'pending-sync' | 'synced'

export type WorkerResultSyncBack = {
  id: string
  worker_id: string
  target: string
  // The canonical JSON the digest attests. A replay after a restart delivers
  // this, so no worker rerun is needed to recover the result.
  payload: unknown
  payload_digest: string
  attempts: number
  last_error: string | null
  state: SyncBackState
  ack_id: string | null
  acknowledged_at: number | null
  created_at: number
  updated_at: number
}

// One ledger per coordinating surface. Reconciliation never reorders work: each
// record settles on its own, so two pending results may land in any order.
export type SyncBackLedger = {
  records: Map<string, WorkerResultSyncBack>
  in_flight: Set<string>
  // Absent for a purely in-process ledger; present when opened over kimaki.db.
  db: KimakiDb | null
  writes: Promise<void>
  write_error: DbError | undefined
}

export function createSyncBackLedger({ db }: { db?: KimakiDb } = {}): SyncBackLedger {
  return { records: new Map(), in_flight: new Set(), db: db ?? null, writes: Promise.resolve(), write_error: undefined }
}

// Reopens a ledger over an existing database: every persisted record is loaded
// before the first reconcile, which is what makes a restart keep unsynced work.
export async function openSyncBackLedger({ db }: { db: KimakiDb }): Promise<SyncBackLedger | DbError> {
  const persisted = await loadWorkerSyncBacks({ db })
  if (persisted instanceof Error) return persisted
  const ledger = createSyncBackLedger({ db })
  for (const record of persisted) ledger.records.set(record.id, record)
  return ledger
}

// Deterministic JSON so the same result always yields the same digest, whatever
// key order the worker used. Values JSON cannot carry are refused, not coerced.
export function canonicalPayload(value: unknown, seen: Set<object> = new Set()): string | undefined {
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

// Writes are serialized on one chain so an insert always precedes the update that
// settles it. A failed write is kept, not thrown inside the chain: the caller
// learns about it from flushSyncBackLedger or from the reconcile result.
function enqueueWrite(ledger: SyncBackLedger, write: (db: KimakiDb) => Promise<DbError | void>): void {
  const db = ledger.db
  if (db === null) return
  ledger.writes = ledger.writes.then(async () => {
    const failed = await write(db)
    if (failed instanceof Error) ledger.write_error ??= failed
  })
}

// Awaits every scheduled record write. A record is durable once this resolves.
export async function flushSyncBackLedger({ ledger }: { ledger: SyncBackLedger }): Promise<DbError | void> {
  await ledger.writes
  return ledger.write_error
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

export function recordWorkerResultSyncBack({ ledger, workerId, target, payload, cause }: {
  ledger: SyncBackLedger
  workerId: string
  target: string
  payload: unknown
  cause?: unknown
}): WorkerResultSyncBack | ConfigError {
  if (!validSyncBackIdentifiers([workerId, target])) {
    return new ConfigError({ reason: 'Supply a non-empty worker ID and sync-back target' })
  }
  const canonical = canonicalPayload(payload)
  if (canonical === undefined) {
    return new ConfigError({ reason: 'The worker result payload must be JSON-serializable before it can be recorded for sync-back' })
  }
  const digest = crypto.createHash('sha256').update(canonical).digest('hex')
  for (const existing of ledger.records.values()) {
    if (existing.worker_id !== workerId) continue
    // Same worker, same digest, same surface: this is the same result seen twice.
    if (existing.payload_digest === digest && existing.target === target) return existing
    if (existing.payload_digest !== digest) {
      return new ConfigError({ reason: `Worker ${workerId} already has a result with digest ${existing.payload_digest} for ${existing.target}. Refusing a different payload with digest ${digest} instead of overwriting it` })
    }
    return new ConfigError({ reason: `Worker ${workerId} already has a result with digest ${digest} destined for ${existing.target}. Refusing to re-record it against ${target}` })
  }
  const now = Date.now()
  const record: WorkerResultSyncBack = {
    id: crypto.randomUUID(),
    worker_id: workerId,
    target,
    // The parsed canonical form, so the in-memory record and the reloaded row agree.
    payload: JSON.parse(canonical) as unknown,
    payload_digest: digest,
    // A record exists because a delivery was attempted and not acknowledged.
    attempts: cause === undefined ? 0 : 1,
    last_error: cause === undefined ? null : errorText(cause),
    state: 'pending-sync',
    ack_id: null,
    acknowledged_at: null,
    created_at: now,
    updated_at: now,
  }
  ledger.records.set(record.id, record)
  enqueueWrite(ledger, (db) => insertWorkerSyncBack({ db, record }))
  return record
}

// Replays one pending sync-back. The delivery runs outside the ledger, and the
// record settles in a single write: there is no state where the record claims
// `synced` without holding the acknowledgement that proves it. The settlement is
// flushed to sqlite before the result is returned, so a synced result that the
// caller has seen also survives a restart.
export async function reconcileSyncBack({ ledger, recordId, deliver }: {
  ledger: SyncBackLedger
  recordId: string
  deliver: SyncBackDelivery
}): Promise<ReconcileSyncBackResult | ConfigError | DbError> {
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
    const pending: WorkerResultSyncBack = { ...record, attempts: record.attempts + 1, last_error: failure, state: 'pending-sync', updated_at: Date.now() }
    ledger.records.set(pending.id, pending)
    enqueueWrite(ledger, (db) => updateWorkerSyncBack({ db, record: pending }))
    const flushed = await flushSyncBackLedger({ ledger })
    if (flushed instanceof Error) return flushed
    return { status: 'pending-sync', record: pending, delivered: false, error: failure }
  }
  const synced: WorkerResultSyncBack = {
    ...record,
    attempts: record.attempts + 1,
    last_error: null,
    state: 'synced',
    ack_id: delivered as string,
    acknowledged_at: Date.now(),
    updated_at: Date.now(),
  }
  ledger.records.set(synced.id, synced)
  enqueueWrite(ledger, (db) => updateWorkerSyncBack({ db, record: synced }))
  const flushed = await flushSyncBackLedger({ ledger })
  if (flushed instanceof Error) return flushed
  return { status: 'synced', record: synced, delivered: true }
}

export function listWorkerResultSyncBacks({ ledger }: { ledger: SyncBackLedger }): WorkerResultSyncBack[] {
  // Insertion order is the record's creation order; equal timestamps must not
  // reshuffle the list by UUID. Settling a record keeps its key and its position.
  return [...ledger.records.values()].sort((left, right) => left.created_at - right.created_at)
}

// Same identity rule as the binding module, without importing it: the store is
// opened by both, so a one-way import keeps the modules acyclic.
function validSyncBackIdentifiers(values: unknown[]): boolean {
  return values.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !value.includes('\0'))
}
