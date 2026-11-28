// Durable row store for the Paperclip launcher fence.
//
// The fence's pure rules (launch-fence.ts) never guess who owns a run; they read
// one existing record. This module is where that record lives when more than one
// process can try to claim the same run: the `ops_paperclip_launch_fence` table
// in kimaki.db, with one row per (instance_id, run_id).
//
// The table DDL comes from the generated schema (src/schema-sql.ts), so this
// store cannot drift from db.ts/drizzle. The UNIQUE index is the exclusion
// primitive: two launchers that both read "no claim" both try to insert, and
// exactly one insert succeeds. The loser is told about the conflict and re-reads,
// after which the pure rules refuse it by name.
//
// Every write is a compare-and-set on (state, generation, claim_seq), so a
// takeover that lost a race can never overwrite a newer claim, and counters only
// ever move forward.
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ConfigError } from '../../errors.js'
import type { Scope } from './launch-claim.js'

export type FenceState = 'claimed' | 'released'

/** One fence row, exactly as stored. */
export type FenceRow = {
  instanceId: string
  runId: string
  state: FenceState
  launcher: string
  generation: number
  claimSeq: number
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  digest: string
  updatedAt: number
}

export type FenceStore = {
  read(scope: Scope): FenceRow | undefined
  all(): FenceRow[]
  insert(row: FenceRow): 'inserted' | 'conflict'
  replace(current: FenceRow, next: FenceRow): boolean
  close(): void
}

export const LAUNCH_FENCE_TABLE = 'ops_paperclip_launch_fence'

function isConstraintViolation(cause: unknown): boolean {
  const code = Reflect.get(cause as object, 'errcode')
  if (code === 19 || code === 2067) return true
  return /UNIQUE constraint failed|constraint failed/i.test(String(Reflect.get(cause as object, 'message') ?? ''))
}

type Row = Record<string, unknown>

function rowFromDb(row: Row): FenceRow {
  return {
    instanceId: String(row['instance_id']),
    runId: String(row['run_id']),
    state: String(row['state']) === 'released' ? 'released' : 'claimed',
    launcher: String(row['launcher']),
    generation: Number(row['generation']),
    claimSeq: Number(row['claim_seq']),
    acquiredAt: String(row['acquired_at']),
    heartbeatAt: String(row['heartbeat_at']),
    expiresAt: String(row['expires_at']),
    digest: String(row['digest']),
    updatedAt: Number(row['updated_at']),
  }
}

function columnsOf(row: FenceRow): unknown[] {
  return [
    row.instanceId, row.runId, row.state, row.launcher, row.generation, row.claimSeq,
    row.acquiredAt, row.heartbeatAt, row.expiresAt, row.digest, row.updatedAt,
  ]
}

function prepare(db: DatabaseSync): void {
  // busy_timeout first: two processes opening the same file must wait, not fail.
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    db.exec('PRAGMA journal_mode = WAL')
  } catch {
    // Another opener holds the mode change for a moment; the default journal is
    // still correct, and the UNIQUE index does the exclusion either way.
  }
}

/**
 * Open the fence table for reading and writing. The database must already exist
 * and be migrated: analytics and subcommands never create kimaki.db, and neither
 * does a fence.
 */
export function openLaunchFenceStore({ dbPath }: { dbPath: string }): FenceStore | ConfigError {
  if (!fs.existsSync(dbPath)) {
    return new ConfigError({ reason: `Launch fence database ${dbPath} does not exist` })
  }
  const opened = (() => {
    try {
      return new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
    } catch (cause) {
      return new ConfigError({ reason: `Cannot open launch fence database ${dbPath}`, cause })
    }
  })()
  if (opened instanceof ConfigError) return opened
  const db = opened
  try {
    prepare(db)
    const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(LAUNCH_FENCE_TABLE)
    if (present === undefined) {
      db.close()
      return new ConfigError({ reason: `Launch fence table ${LAUNCH_FENCE_TABLE} is missing from ${dbPath}` })
    }
  } catch (cause) {
    db.close()
    return new ConfigError({ reason: `Cannot prepare launch fence database ${dbPath}`, cause })
  }

  const select = db.prepare(`SELECT * FROM ${LAUNCH_FENCE_TABLE} WHERE instance_id = ? AND run_id = ?`)
  const selectAll = db.prepare(`SELECT * FROM ${LAUNCH_FENCE_TABLE} ORDER BY updated_at, instance_id, run_id`)
  const insert = db.prepare(
    `INSERT INTO ${LAUNCH_FENCE_TABLE} (instance_id, run_id, state, launcher, generation, claim_seq, acquired_at, heartbeat_at, expires_at, digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // Compare-and-set: only the row this caller just read may be replaced. A stale
  // read (another launcher already advanced the run) matches no row and changes 0.
  const replace = db.prepare(
    `UPDATE ${LAUNCH_FENCE_TABLE} SET state = ?, launcher = ?, generation = ?, claim_seq = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, digest = ?, updated_at = ? WHERE instance_id = ? AND run_id = ? AND state = ? AND generation = ? AND claim_seq = ?`,
  )

  return {
    read(scope) {
      const row = select.get(scope.instanceId, scope.runId) as Row | undefined
      return row === undefined ? undefined : rowFromDb(row)
    },
    all() {
      return (selectAll.all() as Row[]).map(rowFromDb)
    },
    insert(row) {
      try {
        insert.run(...(columnsOf(row) as never[]))
        return 'inserted'
      } catch (cause) {
        if (isConstraintViolation(cause)) return 'conflict'
        throw cause
      }
    },
    replace(current, next) {
      const result = replace.run(
        next.state, next.launcher, next.generation, next.claimSeq, next.acquiredAt,
        next.heartbeatAt, next.expiresAt, next.digest, next.updatedAt,
        next.instanceId, next.runId, current.state, current.generation, current.claimSeq,
      )
      return Number(result.changes) === 1
    },
    close() {
      db.close()
    },
  }
}
