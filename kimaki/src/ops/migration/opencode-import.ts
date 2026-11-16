// Import OpenCode session/thread data into kimaki's own store.
//
// OpenCode 2.x keeps its state in one SQLite database,
// `<opencode-data-dir>/opencode.db` (plus a WAL). Observed on this host at
// %LOCALAPPDATA%\opencode\opencode.db: tables `project`, `workspace`,
// `session`, `message`, `part`. A session row carries id, project_id,
// workspace_id, parent_id, slug, directory, title, metadata (JSON text).
// A message row carries id, session_id, data (JSON text, `role` among the
// keys) and a part row carries id, message_id, session_id, data (JSON text,
// `type` among the keys).
//
// What this imports: one `thread_sessions` row per OpenCode session, so the
// session survives the move to jcode. `thread_id` is a synthetic, stable
// `opencode:<session id>` because an OpenCode session has no Discord thread.
// `source` reuses the schema's existing non-kimaki enum value `external_poll`
// (there is no `opencode` value and adding one would rewrite the enum).
// `parent_session_id` keeps the fork chain. The title is stored as
// `last_synced_name`; it is never logged.
//
// What this does NOT import: message and part bodies (kimaki has no table that
// mirrors turn content - `session-events.ts` reads transcripts from OpenCode on
// demand, so there is nowhere to put them and inventing a parallel schema is
// out of scope). Credentials, `account`, `control_account` and `credential`
// rows stay out of this lane by design.
//
// Safety: the source database is never opened in place. A snapshot (db + wal +
// shm) is copied into a temp dir, read there, and deleted. Nothing under the
// OpenCode directory is written, renamed or checkpointed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import * as orm from 'drizzle-orm'
import * as errore from 'errore'

import type { KimakiDb, OpenedDb } from '../../db.ts'
import { openDb } from '../../db.ts'
import * as schema from '../../schema.ts'

export class OpenCodeImportError extends errore.createTaggedError({
  name: 'OpenCodeImportError',
  message: 'OpenCode import failed: $reason',
}) {}

export type SkipReason =
  | 'already-present'
  | 'missing-session-id'
  | 'unreadable-metadata'
  | 'unreadable-message'
  | 'unreadable-part'

export type SessionImport = {
  sessionId: string
  threadId: string
  /** True when this run (or a dry run) would write the row. */
  planned: boolean
  /** Set when the row was refused; absent on a planned write. */
  reason?: SkipReason
}

export type ImportCounts = {
  considered: number
  planned: number
  written: number
  skipped: number
  alreadyPresent: number
  unreadable: number
}

export type ImportReport = {
  dryRun: boolean
  sourceDb: string
  sessions: SessionImport[]
  counts: ImportCounts
  /** Message/part rows read for shape validation only; nothing is stored. */
  sourceShapes: { sessions: number; messages: number; parts: number }
}

type SourceSession = {
  sessionId: string
  parentSessionId: string | null
  title: string | null
  skipReason?: SkipReason
}

const SOURCE_DB = 'opencode.db'

// OpenCode 2.x layout per platform: %LOCALAPPDATA% on Windows, XDG data dir
// elsewhere. `--source` always wins; this is only a convenience default.
export function defaultOpenCodeSourceDir(): string | null {
  const candidates: string[] = []
  const localAppData = process.env['LOCALAPPDATA']
  if (localAppData) candidates.push(path.join(localAppData, 'opencode'))
  const xdg = process.env['XDG_DATA_HOME']
  if (xdg) candidates.push(path.join(xdg, 'opencode'))
  candidates.push(path.join(os.homedir(), '.local', 'share', 'opencode'))
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, SOURCE_DB))) return candidate
  }
  return null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// A JSON text column is readable only when it parses to an object. An absent
// value is fine (metadata is nullable); a non-object or broken value is not.
function jsonObject(value: string | null): Record<string, unknown> | null | undefined {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

async function tableNames(client: Client): Promise<Set<string>> {
  const rows = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
  return new Set(rows.rows.map((row) => String(row['name'])))
}

// Copy db, wal and shm together so a snapshot recovers the same state a live
// reader would see, without touching the source.
function snapshotSource(sourceDir: string): OpenCodeImportError | { dir: string; db: string } {
  const sourceDb = path.join(sourceDir, SOURCE_DB)
  if (!fs.existsSync(sourceDb)) {
    return new OpenCodeImportError({ reason: `no ${SOURCE_DB} under ${sourceDir}` })
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-import-'))
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${sourceDb}${suffix}`
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, `${SOURCE_DB}${suffix}`))
    }
  } catch (cause) {
    fs.rmSync(dir, { recursive: true, force: true })
    return new OpenCodeImportError({ reason: `could not snapshot ${sourceDb}: ${(cause as Error).message}` })
  }
  return { dir, db: path.join(dir, SOURCE_DB) }
}

async function readSessions(client: Client): Promise<SourceSession[]> {
  const rows = await client.execute('SELECT id, parent_id, title, metadata FROM session ORDER BY time_created')
  return rows.rows.map((row) => {
    const sessionId = text(row['id'])
    const metadata = text(row['metadata'])
    const session: SourceSession = {
      sessionId: sessionId ?? '',
      parentSessionId: text(row['parent_id']),
      title: text(row['title']),
    }
    if (!sessionId) session.skipReason = 'missing-session-id'
    else if (jsonObject(metadata) === undefined) session.skipReason = 'unreadable-metadata'
    return session
  })
}

// Validate every message/part belonging to a session; a single unreadable
// record refuses the whole session rather than importing a half record.
async function markUnreadable(client: Client, sessions: SourceSession[]): Promise<{ messages: number; parts: number }> {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const messageRows = await client.execute('SELECT session_id, data FROM message')
  for (const row of messageRows.rows) {
    const session = byId.get(text(row['session_id']) ?? '')
    if (!session) continue
    const parsed = jsonObject(text(row['data']))
    if (!parsed || typeof parsed['role'] !== 'string') session.skipReason ??= 'unreadable-message'
  }
  const partRows = await client.execute('SELECT session_id, data FROM part')
  for (const row of partRows.rows) {
    const session = byId.get(text(row['session_id']) ?? '')
    if (!session) continue
    const parsed = jsonObject(text(row['data']))
    if (!parsed || typeof parsed['type'] !== 'string') session.skipReason ??= 'unreadable-part'
  }
  return { messages: messageRows.rows.length, parts: partRows.rows.length }
}

// libSQL can hold the file handle for a moment after close() on Windows, so
// deletion is retried instead of turning a finished read into an EPERM.
async function removeSnapshot(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

async function readSource(sourceDir: string): Promise<OpenCodeImportError | {
  sessions: SourceSession[]
  messages: number
  parts: number
}> {
  const snapshot = snapshotSource(sourceDir)
  if (snapshot instanceof Error) return snapshot
  const client = createClient({ url: `file:${snapshot.db}` })
  try {
    const tables = await tableNames(client)
    if (!tables.has('session')) {
      return new OpenCodeImportError({ reason: `${snapshot.db} has no session table` })
    }
    const sessions = await readSessions(client)
    const shapes = tables.has('message') && tables.has('part')
      ? await markUnreadable(client, sessions)
      : { messages: 0, parts: 0 }
    return { sessions, messages: shapes.messages, parts: shapes.parts }
  } catch (cause) {
    return new OpenCodeImportError({ reason: `could not read ${snapshot.db}: ${(cause as Error).message}` })
  } finally {
    client.close()
    await removeSnapshot(snapshot.dir)
  }
}

export function threadIdForSession(sessionId: string): string {
  return `opencode:${sessionId}`
}

async function existingThreadIds(db: KimakiDb, threadIds: string[]): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set()
  const rows = await db
    .select({ threadId: schema.thread_sessions.thread_id })
    .from(schema.thread_sessions)
    .where(orm.inArray(schema.thread_sessions.thread_id, threadIds))
  return new Set(rows.map((row) => row.threadId))
}

function countSessions(sessions: SessionImport[], written: number): ImportCounts {
  return {
    considered: sessions.length,
    planned: sessions.filter((session) => session.planned).length,
    written,
    skipped: sessions.filter((session) => !session.planned).length,
    alreadyPresent: sessions.filter((session) => session.reason === 'already-present').length,
    unreadable: sessions.filter((session) => session.reason !== undefined && session.reason !== 'already-present').length,
  }
}

export async function importOpenCodeSessions({
  db,
  sourceDir,
  dryRun,
}: {
  db: KimakiDb
  sourceDir: string
  dryRun: boolean
}): Promise<OpenCodeImportError | ImportReport> {
  const source = await readSource(sourceDir)
  if (source instanceof Error) return source

  const threadIds = source.sessions
    .filter((session) => session.sessionId.length > 0)
    .map((session) => threadIdForSession(session.sessionId))
  const existing = await existingThreadIds(db, threadIds).catch((cause) => cause as Error)
  if (existing instanceof Error) {
    // A failed lookup must not look like "everything already present".
    return new OpenCodeImportError({ reason: `could not read thread_sessions: ${existing.message}` })
  }

  const sessions: SessionImport[] = source.sessions.map((session) => {
    const threadId = threadIdForSession(session.sessionId)
    if (session.skipReason) return { sessionId: session.sessionId, threadId, planned: false, reason: session.skipReason }
    if (existing.has(threadId)) return { sessionId: session.sessionId, threadId, planned: false, reason: 'already-present' }
    return { sessionId: session.sessionId, threadId, planned: true }
  })

  let written = 0
  if (!dryRun) {
    const byId = new Map(source.sessions.map((session) => [session.sessionId, session]))
    const values = sessions.flatMap((session) => {
      const sourceRow = byId.get(session.sessionId)
      if (!session.planned || !sourceRow) return []
      return [{
        thread_id: session.threadId,
        session_id: session.sessionId,
        source: 'external_poll' as const,
        parent_session_id: sourceRow.parentSessionId,
        last_synced_name: sourceRow.title,
      }]
    })
    if (values.length > 0) {
      const inserted = await db
        .insert(schema.thread_sessions)
        .values(values)
        .onConflictDoNothing()
        .returning({ threadId: schema.thread_sessions.thread_id })
        .catch((cause) => cause as Error)
      if (inserted instanceof Error) {
        return new OpenCodeImportError({ reason: `could not write thread_sessions: ${inserted.message}` })
      }
      written = inserted.length
    }
  }

  return {
    dryRun,
    sourceDb: path.join(sourceDir, SOURCE_DB),
    sessions,
    counts: countSessions(sessions, written),
    sourceShapes: { sessions: source.sessions.length, messages: source.messages, parts: source.parts },
  }
}

// `--dry-run` prints the plan and writes nothing; without it the planned rows
// are inserted. Use: tsx src/ops/migration/opencode-import.ts --data-dir <kimaki>
//   [--source <opencode data dir>] [--dry-run]
export async function main(
  argv: readonly string[],
  io: { stdout: { write: (text: string) => unknown }; stderr: { write: (text: string) => unknown } } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let dataDir: string | undefined
  let sourceDir: string | undefined
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--data-dir') dataDir = argv[++index]
    else if (arg === '--source') sourceDir = argv[++index]
    else if (arg === '--help' || arg === '-h') {
      io.stdout.write('usage: opencode-import [--data-dir <dir>] [--source <dir>] [--dry-run]\n')
      return 0
    }
  }
  if (!sourceDir) sourceDir = defaultOpenCodeSourceDir() ?? undefined
  if (!sourceDir) {
    io.stderr.write('no OpenCode data directory found; pass --source\n')
    return 1
  }
  if (!dataDir) dataDir = path.join(os.homedir(), '.kimaki')
  const opened = await openDb({ dataDir, migrate: false })
  if (opened instanceof Error) {
    io.stderr.write(`${opened.message}\n`)
    return 1
  }
  try {
    const report = await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun })
    if (report instanceof Error) {
      io.stderr.write(`${report.message}\n`)
      return 1
    }
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.counts.unreadable > 0 ? 2 : 0
  } finally {
    opened.close()
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
