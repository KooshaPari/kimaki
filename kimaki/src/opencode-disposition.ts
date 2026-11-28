// Durable evidence for the Phase 2 startup gate. One additive table keeps two
// records: an export whose manifest can be verified, and an explicit abandonment.
// Both are written by explicit CLI commands, never by bot startup. Repeating a
// command cannot replace the first evidence (`INSERT ... ON CONFLICT DO NOTHING`),
// so the proof a start reads is the one the operator actually made.

import type { KimakiDb } from './db.ts'
import { opencodeThreadDisposition, type BotBackend, type OpencodeThreadDisposition } from './backend-selection.ts'
import { DbError } from './errors.ts'
import * as schema from './schema.ts'

export type OpencodeDispositionRow = {
  kind: 'export' | 'abandon'
  manifestPath: string | null
  sourceDbFile: string | null
  exportedAt: Date | null
  threadCount: number
  recordedAt: Date | null
}

/** Reads the durable records. Absence is not an inference: it is simply no row. */
export async function readOpencodeDispositions({ db }: { db: KimakiDb }): Promise<OpencodeDispositionRow[] | Error> {
  const rows = await db.select().from(schema.opencode_thread_dispositions).catch((cause) => new DbError({ operation: 'read opencode dispositions', cause }))
  if (rows instanceof Error) return rows
  return rows.map((row) => ({
    kind: row.kind,
    manifestPath: row.manifest_path,
    sourceDbFile: row.source_db_file,
    exportedAt: row.exported_at,
    threadCount: row.thread_count,
    recordedAt: row.recorded_at,
  }))
}

/**
 * The whole startup read: count persisted OpenCode threads and join that with the
 * durable records. Pure policy stays in backend-selection.ts; this is the only
 * place startup turns database rows into a disposition.
 */
export async function startupOpencodeDisposition({
  db,
  backend,
}: {
  db: KimakiDb
  backend: BotBackend
}): Promise<OpencodeThreadDisposition | Error> {
  if (backend === 'opencode') return opencodeThreadDisposition({ backend, legacyThreadCount: 0, exported: false, abandoned: false })
  const rows = await db.query.thread_sessions.findMany({ columns: { thread_id: true, backend: true } }).catch((cause) => new DbError({ operation: 'read thread sessions for startup gate', cause }))
  if (rows instanceof Error) return rows
  const records = await readOpencodeDispositions({ db })
  if (records instanceof Error) return records
  return opencodeThreadDisposition({
    backend,
    legacyThreadCount: rows.filter((row) => row.backend === 'opencode').length,
    exported: records.some((record) => record.kind === 'export'),
    abandoned: records.some((record) => record.kind === 'abandon'),
  })
}

/** The one message a jcode start prints when it proceeds over abandoned threads. */
export function abandonedNotice(count: number): string {
  return `${count} OpenCode thread${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} unserviceable by jcode: they were explicitly abandoned.`
}

/**
 * Records a completed export after its manifest was written and verified. The
 * manifest path, its exported-at time and its session-thread count are what make
 * the record auditable: a later reader can tell which export satisfies the gate
 * and what it covered. A second export keeps the first record and reports that.
 */
export async function recordOpencodeExport({
  db,
  manifestPath,
  exportedAt,
  threadCount,
  sourceDbFile,
  now = new Date(),
}: {
  db: KimakiDb
  manifestPath: string
  exportedAt: Date
  threadCount: number
  sourceDbFile: string
  now?: Date
}): Promise<{ kind: 'recorded' | 'already-recorded'; record: OpencodeDispositionRow } | Error> {
  const inserted = await db.insert(schema.opencode_thread_dispositions).values({
    id: 'export',
    kind: 'export',
    manifest_path: manifestPath,
    source_db_file: sourceDbFile,
    exported_at: exportedAt,
    thread_count: threadCount,
    recorded_at: now,
  }).onConflictDoNothing().returning().catch((cause) => new DbError({ operation: 'record opencode export', cause }))
  if (inserted instanceof Error) return inserted
  const row = inserted[0] ?? await db.query.opencode_thread_dispositions.findFirst({ where: { id: 'export' } })
  if (!row) return new Error('recording the opencode export returned no row')
  return {
    kind: inserted.length > 0 ? 'recorded' : 'already-recorded',
    record: {
      kind: 'export',
      manifestPath: row.manifest_path,
      sourceDbFile: row.source_db_file,
      exportedAt: row.exported_at,
      threadCount: row.thread_count,
      recordedAt: row.recorded_at,
    },
  }
}

/**
 * Records an explicit decision to write off the remaining OpenCode threads.
 * `threadCount` is what this call made unserviceable. A repeat records nothing
 * and reports zero, which is what makes the command idempotent.
 */
export async function recordOpencodeAbandonment({
  db,
  threadCount,
  now = new Date(),
}: {
  db: KimakiDb
  threadCount: number
  now?: Date
}): Promise<{ kind: 'recorded' | 'already-recorded'; unserviceableThreadCount: number; record: OpencodeDispositionRow } | Error> {
  const inserted = await db.insert(schema.opencode_thread_dispositions).values({
    id: 'abandon',
    kind: 'abandon',
    thread_count: threadCount,
    recorded_at: now,
  }).onConflictDoNothing().returning().catch((cause) => new DbError({ operation: 'record opencode abandonment', cause }))
  if (inserted instanceof Error) return inserted
  const row = inserted[0] ?? await db.query.opencode_thread_dispositions.findFirst({ where: { id: 'abandon' } })
  if (!row) return new Error('recording the opencode abandonment returned no row')
  return {
    kind: inserted.length > 0 ? 'recorded' : 'already-recorded',
    unserviceableThreadCount: inserted.length > 0 ? row.thread_count : 0,
    record: {
      kind: 'abandon',
      manifestPath: null,
      sourceDbFile: null,
      exportedAt: null,
      threadCount: row.thread_count,
      recordedAt: row.recorded_at,
    },
  }
}
