// Fixture-based tests for the OpenCode importer. Every fixture is a real
// SQLite database in a temp dir that copies the shapes observed in
// %LOCALAPPDATA%\opencode\opencode.db (session/message/part), with fake
// sanitised ids and placeholder JSON. Nothing here reads the real store.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'

import { openDb, type OpenedDb } from '../../db.ts'
import { importOpenCodeSessions, threadIdForSession, type ImportReport } from './opencode-import.ts'
import { removeTempDir } from '../../test/cleanup.ts'

const tempDirs: string[] = []

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-oc-import-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir)
  }
})

// The real tables, trimmed to the columns the importer reads, with the same
// NOT NULL shape. `data` stays JSON text exactly as OpenCode 2.x stores it.
const SOURCE_SCHEMA = `
  CREATE TABLE session (
    id text PRIMARY KEY,
    project_id text NOT NULL,
    workspace_id text,
    parent_id text,
    slug text NOT NULL,
    directory text NOT NULL,
    title text NOT NULL,
    version text NOT NULL,
    metadata text,
    time_created integer NOT NULL,
    time_updated integer NOT NULL
  );
  CREATE TABLE message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY,
    message_id text NOT NULL,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  );
`

const NOW = 1793313736140

function insertSession(sql: string[], { id, parent = null, title, metadata = null }: {
  id: string
  parent?: string | null
  title: string
  metadata?: string | null
}): void {
  sql.push(
    `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, title, version, metadata, time_created, time_updated)
     VALUES ('${id}', 'global', NULL, ${parent ? `'${parent}'` : 'NULL'}, 'slug', '/tmp/fixture', '${title}', '1.18.34', ${metadata ? `'${metadata}'` : 'NULL'}, ${NOW}, ${NOW});`,
  )
}

function insertMessage(sql: string[], { id, session, data }: { id: string; session: string; data: string }): void {
  sql.push(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES ('${id}', '${session}', ${NOW}, ${NOW}, '${data}');`,
  )
}

function insertPart(sql: string[], { id, message, session, data }: { id: string; message: string; session: string; data: string }): void {
  sql.push(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES ('${id}', '${message}', '${session}', ${NOW}, ${NOW}, '${data}');`,
  )
}

async function writeSource(sourceDir: string, statements: string[]): Promise<void> {
  fs.mkdirSync(sourceDir, { recursive: true })
  const client = createClient({ url: `file:${path.join(sourceDir, 'opencode.db')}` })
  try {
    await client.executeMultiple(SOURCE_SCHEMA)
    await client.executeMultiple(statements.join('\n'))
  } finally {
    client.close()
  }
}

function healthyStatements(): string[] {
  const sql: string[] = []
  insertSession(sql, { id: 'ses_aaa', title: 'fixture one' })
  insertSession(sql, { id: 'ses_bbb', parent: 'ses_aaa', title: 'fixture two', metadata: '{"fixture":true}' })
  insertSession(sql, { id: 'ses_ccc', title: 'fixture three' })
  insertMessage(sql, { id: 'msg_a1', session: 'ses_aaa', data: '{"role":"user","time":{"created":1}}' })
  insertMessage(sql, { id: 'msg_a2', session: 'ses_aaa', data: '{"role":"assistant","time":{"created":2}}' })
  insertMessage(sql, { id: 'msg_b1', session: 'ses_bbb', data: '{"role":"user","time":{"created":3}}' })
  insertMessage(sql, { id: 'msg_c1', session: 'ses_ccc', data: '{"role":"user","time":{"created":4}}' })
  insertPart(sql, { id: 'prt_a1', message: 'msg_a1', session: 'ses_aaa', data: '{"type":"text","text":"placeholder"}' })
  insertPart(sql, { id: 'prt_a2', message: 'msg_a2', session: 'ses_aaa', data: '{"type":"text","text":"placeholder"}' })
  insertPart(sql, { id: 'prt_b1', message: 'msg_b1', session: 'ses_bbb', data: '{"type":"step-start"}' })
  insertPart(sql, { id: 'prt_c1', message: 'msg_c1', session: 'ses_ccc', data: '{"type":"text","text":"placeholder"}' })
  return sql
}

function reportOf(value: ImportReport | Error): ImportReport {
  if (value instanceof Error) throw value
  return value
}

async function threadRows(opened: OpenedDb): Promise<Array<Record<string, unknown>>> {
  const result = await opened.client.execute('SELECT thread_id, session_id, source, parent_session_id, last_synced_name FROM thread_sessions ORDER BY thread_id')
  return result.rows.map((row) => ({ ...row }))
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

test('dry run reports planned writes and writes nothing', async () => {
  const root = tempRoot()
  const sourceDir = path.join(root, 'opencode')
  await writeSource(sourceDir, healthyStatements())
  const opened = await openDb({ dataDir: path.join(root, 'kimaki'), migrate: true })
  if (opened instanceof Error) throw opened
  try {
    const report = reportOf(await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun: true }))
    expect(report.dryRun).toBe(true)
    expect(report.counts).toMatchObject({ considered: 3, planned: 3, written: 0 })
    expect(report.sourceShapes).toEqual({ sessions: 3, messages: 4, parts: 4 })
    expect(await threadRows(opened)).toHaveLength(0)
  } finally {
    opened.close()
  }
})

test('real run imports one row per session and a second run is a no-op', async () => {
  const root = tempRoot()
  const sourceDir = path.join(root, 'opencode')
  await writeSource(sourceDir, healthyStatements())
  const opened = await openDb({ dataDir: path.join(root, 'kimaki'), migrate: true })
  if (opened instanceof Error) throw opened
  try {
    const first = reportOf(await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun: false }))
    expect(first.counts).toMatchObject({ considered: 3, planned: 3, written: 3, skipped: 0 })
    const rows = await threadRows(opened)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row['thread_id']).sort()).toEqual([
      threadIdForSession('ses_aaa'),
      threadIdForSession('ses_bbb'),
      threadIdForSession('ses_ccc'),
    ].sort())
    const child = rows.find((row) => row['session_id'] === 'ses_bbb')
    expect(child).toMatchObject({ source: 'external_poll', parent_session_id: 'ses_aaa' })

    const second = reportOf(await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun: false }))
    expect(second.counts).toMatchObject({ considered: 3, planned: 0, written: 0, skipped: 3, alreadyPresent: 3 })
    expect(await threadRows(opened)).toHaveLength(3)
  } finally {
    opened.close()
  }
})

test('an unreadable session is refused by name and nothing is written', async () => {
  const root = tempRoot()
  const sourceDir = path.join(root, 'opencode')
  const sql: string[] = []
  insertSession(sql, { id: 'ses_bad', title: 'fixture bad' })
  insertMessage(sql, { id: 'msg_bad', session: 'ses_bad', data: '{not json' })
  insertPart(sql, { id: 'prt_bad', message: 'msg_bad', session: 'ses_bad', data: '{"type":"text"}' })
  await writeSource(sourceDir, sql)
  const opened = await openDb({ dataDir: path.join(root, 'kimaki'), migrate: true })
  if (opened instanceof Error) throw opened
  try {
    const report = reportOf(await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun: false }))
    const bad = report.sessions.find((session) => session.sessionId === 'ses_bad')
    expect(bad).toMatchObject({ planned: false, reason: 'unreadable-message' })
    expect(report.counts).toMatchObject({ considered: 1, planned: 0, written: 0, unreadable: 1 })
    expect(await threadRows(opened)).toHaveLength(0)
  } finally {
    opened.close()
  }
})

test('nothing outside the temp directories is touched', async () => {
  const root = tempRoot()
  const sourceDir = path.join(root, 'opencode')
  await writeSource(sourceDir, healthyStatements())
  const sentinelDir = path.join(root, 'sentinel')
  fs.mkdirSync(sentinelDir)
  const sentinel = path.join(sentinelDir, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'untouched')

  const sourceDb = path.join(sourceDir, 'opencode.db')
  const sourceBefore = sha256(sourceDb)
  const sentinelBefore = sha256(sentinel)
  const sourceListing = fs.readdirSync(sourceDir).sort()

  const opened = await openDb({ dataDir: path.join(root, 'kimaki'), migrate: true })
  if (opened instanceof Error) throw opened
  try {
    reportOf(await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun: true }))
    reportOf(await importOpenCodeSessions({ db: opened.db, sourceDir, dryRun: false }))
  } finally {
    opened.close()
  }

  expect(sha256(sourceDb)).toBe(sourceBefore)
  expect(sha256(sentinel)).toBe(sentinelBefore)
  expect(fs.readdirSync(sourceDir).sort()).toEqual(sourceListing)
})
