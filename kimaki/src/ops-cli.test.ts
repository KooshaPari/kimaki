// Public CLI workflow against a real, isolated Kimaki database, not a copied implementation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { openDb } from './db.ts'
import { removeTempDirs } from './test/cleanup.ts'

const exec = promisify(execFile)
const dirs: string[] = []
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  global.gc?.()
  await removeTempDirs(dirs)
})
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-ops-cli-'))
  dirs.push(dir)
  return dir
}
async function cli(args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), ...args], {
    timeout: 20_000,
    env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' },
  })
}

test('ops help discloses metadata-only scope without starting a bot', async () => {
  const result = await cli(['ops', '--help'])
  expect(result.stdout).toContain('ops bind')
  expect(result.stdout).toContain('metadata-only')
  expect(result.stdout).toContain('ops detach')
})

test('native discovery help exposes explicit source and endpoint without starting a bot', async () => {
  const result = await cli(['ops', 'discover', '--help'])
  expect(result.stdout).toContain('--source')
  expect(result.stdout).toContain('--service-file')
  expect(result.stdout).toContain('opencode')
})

test('native discovery refuses implicit endpoint selection before any runtime access', async () => {
  const result = await cli(['ops', 'discover', '--source', 'opencode']).catch((error: Error & { stderr: string }) => error)
  expect(result).toBeInstanceOf(Error)
  expect('stderr' in result && result.stderr).toContain('--service-file')
})

test('CLI bind/list/detach persists metadata across processes and never adopts legacy sessions', async () => {
  const dataDir = tempDir()
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  opened.close()
  const args = ['--data-dir', dataDir, '--tenant', 'guild-1']
  const bind = ['ops', 'bind', ...args, '--host', 'local-canary', '--endpoint', 'codex-isolated', '--backend', 'codex', '--native-session', 'external-canary', '--surface', 'thread-1', '--request', 'request-1']
  const first = JSON.parse((await cli(bind)).stdout)
  expect(first).toMatchObject({ mode: 'observe', publication_policy: 'none', state: 'active' })
  expect(JSON.parse((await cli(bind)).stdout)).toEqual(first)
  expect(JSON.parse((await cli(['ops', 'bindings', ...args])).stdout)).toEqual([first])
  await expect(cli(['ops', 'detach', first.id, '--data-dir', dataDir, '--tenant', 'wrong'])).rejects.toMatchObject({ code: 1 })
  expect(JSON.parse((await cli(['ops', 'detach', first.id, ...args])).stdout)).toMatchObject({ id: first.id, state: 'detached' })
  expect(JSON.parse((await cli(['ops', 'detach', first.id, ...args])).stdout)).toMatchObject({ state: 'detached' })
  const check = await openDb({ dataDir, migrate: false })
  if (check instanceof Error) throw check
  expect(await check.db.query.thread_sessions.findMany()).toEqual([])
  check.close()
}, 120_000)

test('ops subcommands never create or migrate a missing database', async () => {
  const dataDir = tempDir()
  await expect(cli(['ops', 'bindings', '--data-dir', dataDir, '--tenant', 'guild-1'])).rejects.toMatchObject({ code: 1 })
  expect(fs.existsSync(path.join(dataDir, 'kimaki.db'))).toBe(false)
})
