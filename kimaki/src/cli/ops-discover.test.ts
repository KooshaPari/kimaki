// The jcode observer already distinguishes a settled read from one where a
// record was mid-write, but that verdict only reaches an operator if `ops
// discover` prints it. These tests spawn the real CLI over a temp home holding
// one valid session and one torn record, so the assertion is about shipped
// output rather than a reimplemented formatter.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { removeTempDirs } from '../test/cleanup.ts'
import { discoverHealthLine } from './ops.ts'

const exec = promisify(execFile)
const dirs: string[] = []
afterEach(async () => {
  await removeTempDirs(dirs)
})

function tempHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-discover-health-'))
  dirs.push(home)
  const sessions = path.join(home, 'sessions')
  fs.mkdirSync(sessions)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(sessions, name), body)
  return home
}

async function discover(home: string, extra: string[] = []) {
  const args = [
    '--import', 'tsx', path.join(import.meta.dirname, '..', 'cli.ts'),
    'ops', 'discover', '--source', 'jcode',
    '--jcode-home', home, '--host', 'health-host', '--endpoint', 'health-endpoint',
    ...extra,
  ]
  return exec(process.execPath, args, {
    timeout: 60_000,
    env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' },
  })
}

const valid = JSON.stringify({ id: 'session_valid', title: 'Valid session', updated_at: '2026-01-01T00:00:00Z', messages: [] })
// An unterminated object is stable across both reads, so it parses as
// 'unparsable' and lands on the transient path rather than missing.
const torn = '{"id":"session_torn","title":"Tor'

test('discover prints the transient health verdict for a home with a torn record', async () => {
  const home = tempHome({ 'session_valid.json': valid, 'session_torn.json': torn })
  const run = await discover(home)
  // Human-readable summary names the verdict and the skipped count.
  expect(run.stderr).toContain('health=transient')
  expect(run.stderr).toContain('skippedTransient=1')
  expect(run.stderr).toContain('mid-write')
  // The JSON document carries the same values as keys.
  const document = JSON.parse(run.stdout) as { health: string; skippedTransient: number; sessions: Array<{ key: { nativeSessionId: string } }> }
  expect(document.health).toBe('transient')
  expect(document.skippedTransient).toBe(1)
  // The torn record is never presented as a session.
  expect(document.sessions.map(({ key }) => key.nativeSessionId)).toEqual(['session_valid'])
})

test('--json keeps the health keys and suppresses the human summary', async () => {
  const home = tempHome({ 'session_valid.json': valid, 'session_torn.json': torn })
  const run = await discover(home, ['--json'])
  expect(run.stderr).not.toContain('discovery: health=')
  const document = JSON.parse(run.stdout) as { health: string; skippedTransient: number }
  expect(document.health).toBe('transient')
  expect(document.skippedTransient).toBe(1)
})

test('a home with only settled records reports a consistent page', async () => {
  const home = tempHome({ 'session_valid.json': valid })
  const run = await discover(home)
  expect(run.stderr).toContain('health=consistent')
  expect(run.stderr).toContain('skippedTransient=0')
  const document = JSON.parse(run.stdout) as { health: string; skippedTransient: number }
  expect(document.health).toBe('consistent')
  expect(document.skippedTransient).toBe(0)
})

test('discoverHealthLine names the transient reason and the page cursor', () => {
  expect(discoverHealthLine({ source: 'jcode', health: 'transient', skippedTransient: 2, sessions: 1, cursor: '3' }))
    .toBe('jcode discovery: health=transient skippedTransient=2 (2 record(s) were mid-write (unstable, unparsable or mismatched) and skipped, not treated as absent); sessions=1 cursor=3')
  expect(discoverHealthLine({ source: 'jcode', health: 'consistent', skippedTransient: 0, sessions: 4, cursor: null }))
    .toBe('jcode discovery: health=consistent skippedTransient=0 (every candidate record was read consistently); sessions=4 cursor=null')
})
