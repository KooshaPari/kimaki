// Every SQLite migration of kimaki, in one place. Only the bot start runs it
// (openDb({ migrate: true })); subcommands never migrate.
//
//   <dataDir>/kimaki.db present without the DB_VERSION marker, next to a V1 file?
//     └─ not made by kimaki: rename it to kimaki.db.unknown-<time> (never deleted)
//   <dataDir>/kimaki.db missing?
//     └─ <dataDir>/discord-sessions.db (V1) present?
//          yes ─▶ build kimaki.db.import from schema.sql + the V1 rows of the
//                 tables kimaki uses, then rename it to kimaki.db (atomic: a
//                 crash leaves no half-imported kimaki.db, the next start retries)
//          no  ─▶ empty kimaki.db
//   then: schema.sql (CREATE ... IF NOT EXISTS) + the marker on kimaki.db
//
// The V1 file is opened read-only and never changed or deleted, so V1 keeps
// working on its own data. There is no downgrade: changes made by kimaki stay in
// kimaki.db. Future schema changes (ALTER TABLE ... ADD COLUMN) go in
// migrateSchema() below.
//
// The import renames a file it just wrote, so the connection that wrote it must
// be fully closed first: Windows refuses to rename a file that still has a
// handle open (`EBUSY`). That is why this module talks to SQLite through
// node:sqlite instead of the libSQL client used by the running bot: `close()`
// there returns the file handle immediately, while libSQL keeps the handle
// until its prepared statements are garbage collected. Renames also retry a
// bounded number of times, because an antivirus scanner or a backup tool can
// hold the target for a few milliseconds.

import fs from 'node:fs'
import path from 'node:path'
import * as errore from 'errore'

import { DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import { SCHEMA_SQL } from './schema-sql.ts'

const logger = createLogger('DB')

export const DB_FILE = 'kimaki.db'
export const LEGACY_DB_FILE = 'discord-sessions.db'

// PRAGMA user_version of every kimaki.db written by migrateSchema(). A stray
// kimaki.db without it (an empty file from another tool, a pre-marker dev
// build) must not block the V1 import: then the user gets onboarding again.
export const DB_VERSION = 1

// A rename can lose a race against an antivirus scanner, a backup or another
// tool holding the target for a moment. Retry a few times, then report.
const RENAME_ATTEMPTS = 5
const RENAME_BACKOFF_MS = 20

// Windows reports a held file as EBUSY or EPERM; POSIX uses EBUSY.
const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

// Parents first, so imported rows satisfy the foreign keys.
const IMPORTED_TABLES = [
  'bot_tokens',
  'bot_api_keys',
  'guild_categories',
  'channel_directories',
  'channel_models',
  'global_models',
  'channel_agents',
  'channel_worktrees',
  'channel_verbosity',
  'channel_mention_mode',
  'thread_sessions',
  'scheduled_tasks',
  'session_sleeps',
] as const

// V1 values kimaki reads differently. Old V1 rows can carry the DDL default
// 'self-hosted' (hyphen) or NULL; kimaki only knows 'self_hosted' | 'gateway'.
const IMPORT_EXPRESSIONS: Partial<Record<(typeof IMPORTED_TABLES)[number], Record<string, string>>> = {
  bot_tokens: { bot_mode: `CASE WHEN bot_mode = 'gateway' THEN 'gateway' ELSE 'self_hosted' END` },
}

export function schemaStatements(): string[] {
  return SCHEMA_SQL.split(';')
    .map((statement) => {
      return statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    })
    .filter((statement) => statement.length > 0)
}

type SqliteModule = typeof import('node:sqlite')

// Loaded lazily: node:sqlite is only needed for the one-time import, so a
// runtime without it (Node < 22.13) can still open an already migrated
// kimaki.db without this module throwing at import time.
let sqliteModule: Promise<SqliteModule> | undefined

function sqlite(): Promise<SqliteModule> {
  sqliteModule ??= import('node:sqlite').catch((cause) => {
    throw new DbError({ operation: 'load node:sqlite', cause })
  })
  return sqliteModule
}

type QueryRow = Record<string, unknown>

// One synchronous SQLite connection. close() releases the file handle before it
// returns, which is what makes the rename below safe on Windows.
type Db = {
  all: (sql: string) => QueryRow[]
  run: (sql: string) => { changes: number }
  exec: (sql: string) => void
  close: () => void
}

function firstValue(row: QueryRow | undefined): unknown {
  return row === undefined ? undefined : Object.values(row)[0]
}

function sqlString(value: string): string {
  return `'${value.replaceAll(`'`, `''`)}'`
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll(`"`, `""`)}"`
}

function isNotADatabase(e: unknown): boolean {
  // SQLITE_NOTADB. node:sqlite surfaces the raw code as `errcode`.
  return Reflect.get(e as object, 'errcode') === 26 || /not a database/i.test(String(Reflect.get(e as object, 'message') ?? ''))
}

function sleep({ ms }: { ms: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function openDbFile({ file }: { file: string }): Promise<DbError | Db> {
  const { DatabaseSync } = await sqlite()
  const opened = errore.try(
    () => new DatabaseSync(file, { enableForeignKeyConstraints: false }),
    (e) => new DbError({ operation: `open ${file}`, cause: e }),
  )
  if (opened instanceof Error) return opened
  return {
    all: (sql) => opened.prepare(sql).all() as QueryRow[],
    run: (sql) => opened.prepare(sql).run() as { changes: number },
    exec: (sql) => opened.exec(sql),
    close: () => opened.close(),
  }
}

function columnsOf({ db, schema, table }: { db: Db; schema: 'main' | 'legacy'; table: string }) {
  const rows = db.all(`PRAGMA ${schema}.table_info(${sqlIdentifier(table)})`)
  return rows.map((row) => ({ name: String(row['name']), notNull: Number(row['notnull']) === 1 || Number(row['pk']) > 0 }))
}

// One entry per FK column: the schema has only single-column foreign keys
// with an explicit parent column. A composite FK would need grouping by `id`.
function foreignKeysOf({ db, table }: { db: Db; table: string }) {
  const rows = db.all(`PRAGMA main.foreign_key_list(${sqlIdentifier(table)})`)
  return rows.map((row) => ({ column: String(row['from']), parent: String(row['table']), parentColumn: String(row['to']) }))
}

// Copies the V1 rows into `db` (an empty file with schema.sql applied).
// Most V1 tables have no foreign keys, so real installs hold rows that point
// at deleted channels or threads: a required reference skips the row, an
// optional one becomes NULL (like ON DELETE SET NULL).
function copyLegacyRows({ db, legacyFile }: { db: Db; legacyFile: string }): void {
  // mode=ro: the V1 file keeps working for V1, byte for byte.
  db.exec(`ATTACH DATABASE ${sqlString(`file:${legacyFile.replaceAll('\\', '/')}?mode=ro`)} AS legacy`)
  db.exec('BEGIN')
  try {
    for (const table of IMPORTED_TABLES) {
      const legacyColumns = columnsOf({ db, schema: 'legacy', table }).map((column) => column.name)
      if (legacyColumns.length === 0) {
        logger.log(`import ${table}: not in ${LEGACY_DB_FILE}, skipped`)
        continue
      }
      // Columns an older V1 file lacks get the kimaki default.
      const columns = columnsOf({ db, schema: 'main', table }).filter((column) => legacyColumns.includes(column.name))
      const foreignKeys = foreignKeysOf({ db, table }).filter((key) => legacyColumns.includes(key.column))
      const existsIn = (key: (typeof foreignKeys)[number]) => `"${key.column}" IN (SELECT "${key.parentColumn}" FROM main."${key.parent}")`
      const expressions = columns.map((column) => {
        const custom = IMPORT_EXPRESSIONS[table]?.[column.name]
        if (custom) return custom
        const key = foreignKeys.find((candidate) => candidate.column === column.name)
        if (key && !column.notNull) return `CASE WHEN ${existsIn(key)} THEN "${column.name}" END`
        return `"${column.name}"`
      })
      const required = foreignKeys.filter((key) => columns.some((column) => column.name === key.column && column.notNull))
      const where = required.length > 0 ? ` WHERE ${required.map(existsIn).join(' AND ')}` : ''
      const inserted = db.run(
        `INSERT INTO main."${table}" (${columns.map((column) => `"${column.name}"`).join(', ')}) SELECT ${expressions.join(', ')} FROM legacy."${table}"${where}`,
      )
      const skipped = Number(firstValue(db.all(`SELECT count(*) FROM legacy."${table}"`)[0]) ?? 0) - inserted.changes
      logger.log(`import ${table}: ${inserted.changes} rows${skipped > 0 ? `, ${skipped} skipped (missing parent row)` : ''}`)
    }
    db.exec('COMMIT')
  } catch (e) {
    errore.try(
      () => db.exec('ROLLBACK'),
      () => undefined,
    )
    throw e
  }
}

function applySchema({ db }: { db: Db }): void {
  db.exec(SCHEMA_SQL)
}

// Columns added after the first release. schema.sql only creates missing
// tables, so an existing thread_sessions needs its own ALTER. Guarded on
// table_info: a database that already has the column (or a second start)
// is left unchanged.
function addThreadSessionsBackend({ db }: { db: Db }): void {
  const columns = columnsOf({ db, schema: 'main', table: 'thread_sessions' })
  if (columns.some((column) => column.name === 'backend')) return
  db.run(`ALTER TABLE thread_sessions ADD COLUMN "backend" text DEFAULT 'opencode' NOT NULL`)
}

function markMigrated({ db }: { db: Db }): void {
  db.exec(`PRAGMA user_version = ${DB_VERSION}`)
}

async function readDbVersion({ file }: { file: string }): Promise<DbError | number> {
  const opened = await openDbFile({ file })
  if (opened instanceof Error) return opened
  const version = errore.try(
    () => Number(firstValue(opened.all('PRAGMA user_version')[0]) ?? 0),
    // Not an SQLite file at all: unmarked too, so it is set aside like any stray file.
    (e) => (isNotADatabase(e) ? 0 : new DbError({ operation: `read version of ${file}`, cause: e })),
  )
  opened.close()
  return version
}

function renameErrorCode(e: unknown): string | undefined {
  const code = Reflect.get(e as object, 'code')
  return typeof code === 'string' ? code : undefined
}

// Renames a file, retrying the transient Windows locks (`EBUSY`/`EPERM`).
// After the attempts run out the last failure still surfaces as a DbError.
async function renameFile({ from, to }: { from: string; to: string }): Promise<DbError | void> {
  let last: unknown
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      last = e
      const code = renameErrorCode(e)
      if (attempt === RENAME_ATTEMPTS || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) break
      await sleep({ ms: RENAME_BACKOFF_MS * attempt })
    }
  }
  const code = renameErrorCode(last)
  return new DbError({ operation: `rename ${from}${code ? ` (${code})` : ''}`, cause: last })
}

// Renames file and its WAL files. The WAL files go first and keep their
// suffix, so a crash never leaves a foreign -wal next to a new kimaki.db.
async function setAside({ file }: { file: string }): Promise<DbError | string> {
  const target = `${file}.unknown-${new Date().toISOString().replace(/[:.]/g, '-')}`
  for (const suffix of ['-wal', '-shm', '']) {
    if (!fs.existsSync(`${file}${suffix}`)) continue
    const renamed = await renameFile({ from: `${file}${suffix}`, to: `${target}${suffix}` })
    if (renamed instanceof Error) return renamed
  }
  return target
}

// Builds <file>.import and closes it. The caller renames it once the handle is
// gone; nothing here leaves a partially imported kimaki.db behind.
async function buildImportFile({ target, legacyFile }: { target: string; legacyFile: string }): Promise<DbError | void> {
  const opened = await openDbFile({ file: target })
  if (opened instanceof Error) return opened
  const imported = errore.try(
    () => {
      applySchema({ db: opened })
      copyLegacyRows({ db: opened, legacyFile })
      // The marker goes on last, so a crash mid-import leaves an unmarked file
      // that the next start sets aside and imports again.
      markMigrated({ db: opened })
    },
    (e) => new DbError({ operation: `import ${legacyFile}`, cause: e }),
  )
  opened.close()
  return imported
}

// Picks or creates the database file. Returns its path.
async function prepareDbFile({ dataDir }: { dataDir: string }): Promise<DbError | string> {
  const file = path.join(dataDir, DB_FILE)
  const legacyFile = path.join(dataDir, LEGACY_DB_FILE)
  const hasLegacy = fs.existsSync(legacyFile)
  if (fs.existsSync(file)) {
    // Without a V1 file there is nothing to import: keep it, migrateSchema() marks it.
    if (!hasLegacy) return file
    const version = await readDbVersion({ file })
    if (version instanceof Error) return version
    if (version >= DB_VERSION) return file
    const moved = await setAside({ file })
    if (moved instanceof Error) return moved
    logger.warn(`${file} was not made by kimaki (no version marker), moved it to ${moved}`)
  }
  if (!hasLegacy) return file
  logger.log(`first start of this version: importing ${legacyFile} into ${file}`)
  const target = `${file}.import`
  const removed = errore.try(
    () => fs.rmSync(target, { force: true }),
    (e) => new DbError({ operation: `remove stale ${target}`, cause: e }),
  )
  if (removed instanceof Error) return removed
  const imported = await buildImportFile({ target, legacyFile })
  if (imported instanceof Error) {
    fs.rmSync(target, { force: true })
    return imported
  }
  const renamed = await renameFile({ from: target, to: file })
  if (renamed instanceof Error) {
    // All or nothing: a failed rename must not leave the import behind.
    fs.rmSync(target, { force: true })
    return renamed
  }
  logger.log(`import done, ${legacyFile} is kept unchanged`)
  return file
}

// Schema of an open kimaki.db: schema.sql is idempotent. Add future
// ALTER TABLE migrations here, before schema.sql when a new index needs them.
function migrateSchema({ db }: { db: Db }): void {
  applySchema({ db })
  addThreadSessionsBackend({ db })
  markMigrated({ db })
}

export async function migrateDb({ dataDir }: { dataDir: string }): Promise<DbError | string> {
  const file = await prepareDbFile({ dataDir })
  if (file instanceof Error) return file
  const opened = await openDbFile({ file })
  if (opened instanceof Error) return opened
  const migrated = errore.try(
    () => migrateSchema({ db: opened }),
    (e) => new DbError({ operation: 'migrate schema', cause: e }),
  )
  opened.close()
  if (migrated instanceof Error) return migrated
  return file
}
