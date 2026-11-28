// Phase 2 stopgap gate, driven through the real CLI against a real kimaki DB.
// The gate must refuse a jcode start over unexported threads, let an explicit
// abandonment through, and remain idempotent. Nothing here deletes a thread.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { removeDataDir, scratchDir } from './test/cleanup.ts'

const exec = promisify(execFile)
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts')
const dataDir = fs.mkdtempSync(path.join(scratchDir('opencode-disposition'), 'data-'))
const childEnv = { ...process.env, KIMAKI_VITEST: '1' }

function run(args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', cli, ...args, '--data-dir', dataDir], { env: childEnv })
}

function script(name: string, body: string): string {
  const file = path.join(dataDir, name)
  fs.writeFileSync(file, body)
  return file
}

beforeAll(async () => {
  // Seed through the real migration and libSQL client: this DB has a version
  // marker, one legacy OpenCode thread and one jcode thread.
  const file = script('seed.mjs', `
import { createRequire } from 'node:module'
import { migrateDb } from ${JSON.stringify(path.resolve('src/migrations.ts'))}
const require = createRequire(${JSON.stringify(path.resolve('package.json'))})
const { createClient } = require('@libsql/client')
const migrated = await migrateDb({ dataDir: ${JSON.stringify(dataDir)} })
if (migrated instanceof Error) throw migrated
const client = createClient({ url: ${JSON.stringify(`file:${path.join(dataDir, 'kimaki.db').replaceAll('\\', '/')}`)} })
await client.execute("INSERT INTO thread_sessions (thread_id, session_id, backend) VALUES ('t_old', 's_old', 'opencode')")
await client.execute("INSERT INTO thread_sessions (thread_id, session_id, backend) VALUES ('t_new', 's_new', 'jcode')")
client.close()
`)
  await exec(process.execPath, ['--import', 'tsx', file], { env: childEnv })
}, 60_000)

afterAll(async () => {
  await removeDataDir(dataDir)
})

test('a persisted OpenCode thread refuses a jcode start before Discord or a lock', async () => {
  const failure: Error & { code?: number; stderr?: string } = await run(['--backend', 'jcode']).then(
    () => new Error('unexpected success'),
    (error: unknown) => error as Error & { code?: number; stderr?: string },
  )
  expect(failure.code).toBe(1)
  expect(failure.stderr).toContain('1 legacy OpenCode thread has not been exported or explicitly abandoned')
  expect(failure.stderr).toContain('kimaki export opencode --out <dir>')
  expect(failure.stderr).toContain('kimaki export abandon-opencode --data-dir <dir>')
  expect(fs.existsSync(path.join(dataDir, 'lock-token'))).toBe(false)
}, 60_000)

test('abandonment is durable and idempotent', async () => {
  const first = JSON.parse((await run(['export', 'abandon-opencode'])).stdout) as { unserviceableThreadCount: number; recorded: string; dataDir: string }
  expect(first).toMatchObject({ unserviceableThreadCount: 1, recorded: 'recorded' })
  expect(first.dataDir).toBe(path.resolve(dataDir))
  const second = JSON.parse((await run(['export', 'abandon-opencode'])).stdout) as { unserviceableThreadCount: number; recorded: string }
  expect(second).toMatchObject({ unserviceableThreadCount: 0, recorded: 'already-recorded' })
  const file = script('startup.mjs', `
import { openDb } from ${JSON.stringify(path.resolve('src/db.ts'))}
import { startupOpencodeDisposition } from ${JSON.stringify(path.resolve('src/opencode-disposition.ts'))}
const opened = await openDb({ dataDir: ${JSON.stringify(dataDir)}, migrate: false })
if (opened instanceof Error) throw opened
console.log(JSON.stringify(await startupOpencodeDisposition({ db: opened.db, backend: 'jcode' })))
opened.close()
`)
  const result = (await exec(process.execPath, ['--import', 'tsx', file], { env: childEnv })).stdout
  expect(JSON.parse(result)).toEqual({ kind: 'proceed', reason: 'abandoned', legacyThreadCount: 1 })
}, 60_000)

test('no start writes a disposition record', async () => {
  // Another refused start must leave the operator's single record untouched.
  await run(['--backend', 'jcode']).catch(() => undefined)
  const file = script('records.mjs', `
import { openDb } from ${JSON.stringify(path.resolve('src/db.ts'))}
import * as schema from ${JSON.stringify(path.resolve('src/schema.ts'))}
const opened = await openDb({ dataDir: ${JSON.stringify(dataDir)}, migrate: false })
if (opened instanceof Error) throw opened
console.log(JSON.stringify(await opened.db.select().from(schema.opencode_thread_dispositions)))
opened.close()
`)
  const result = (await exec(process.execPath, ['--import', 'tsx', file], { env: childEnv })).stdout
  const rows = JSON.parse(result) as Array<{ id: string; kind: string }>
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 'abandon', kind: 'abandon' })
}, 60_000)
