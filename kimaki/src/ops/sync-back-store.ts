// Durable store for worker sync-back records, in the same kimaki.db the bindings
// use. The ledger in sync-back.ts is the in-process view; every record it creates
// or settles is written here, so a restart reloads the same pending-sync rows.
import * as orm from 'drizzle-orm'
import type { KimakiDb } from '../db.ts'
import { DbError } from '../errors.ts'
import { ops_worker_sync_back as syncBacks } from '../schema.ts'
import type { WorkerResultSyncBack } from './sync-back.ts'

type SyncBackRow = typeof syncBacks.$inferSelect

// The payload column holds the canonical JSON the digest attests, so a reloaded
// record carries exactly the result that was recorded, not a reserialization.
function recordFromRow(row: SyncBackRow): WorkerResultSyncBack {
  return {
    id: row.id,
    worker_id: row.worker_id,
    target: row.target,
    payload: JSON.parse(row.payload) as unknown,
    payload_digest: row.payload_digest,
    attempts: row.attempts,
    last_error: row.last_error,
    state: row.state,
    ack_id: row.ack_id,
    acknowledged_at: row.acknowledged_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// record() stores the parsed canonical JSON, so stringifying it again yields the
// same canonical text: key order is the sorted order the digest was taken over.
function rowFromRecord(record: WorkerResultSyncBack) {
  return {
    id: record.id,
    worker_id: record.worker_id,
    target: record.target,
    payload: JSON.stringify(record.payload),
    payload_digest: record.payload_digest,
    attempts: record.attempts,
    last_error: record.last_error,
    state: record.state,
    ack_id: record.ack_id,
    acknowledged_at: record.acknowledged_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

export async function loadWorkerSyncBacks({ db }: {
  db: KimakiDb
}): Promise<WorkerResultSyncBack[] | DbError> {
  const rows = await db.select().from(syncBacks)
    .orderBy(orm.asc(syncBacks.created_at), orm.asc(syncBacks.id))
    .catch((cause) => new DbError({ operation: 'load worker sync-back records', cause }))
  if (rows instanceof Error) return rows
  return rows.map(recordFromRow)
}

export async function insertWorkerSyncBack({ db, record }: {
  db: KimakiDb
  record: WorkerResultSyncBack
}): Promise<DbError | void> {
  const written = await db.insert(syncBacks).values(rowFromRecord(record))
    .catch((cause) => new DbError({ operation: 'insert worker sync-back record', cause }))
  if (written instanceof Error) return written
}

export async function updateWorkerSyncBack({ db, record }: {
  db: KimakiDb
  record: WorkerResultSyncBack
}): Promise<DbError | void> {
  const written = await db.update(syncBacks).set(rowFromRecord(record))
    .where(orm.eq(syncBacks.id, record.id))
    .catch((cause) => new DbError({ operation: 'update worker sync-back record', cause }))
  if (written instanceof Error) return written
}
