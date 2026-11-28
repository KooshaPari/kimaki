// AC01: `ops discover` must compare discovered sessions against a REAL process
// enumeration. These tests spawn the real CLI over a temp jcode home and a
// record whose pid is a live node child, a dead pid, or absent entirely, so the
// assertions are about shipped output and a live process table, not a fixture.
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { removeTempDirs } from '../test/cleanup.ts'

const exec = promisify(execFile)
const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await removeTempDirs(dirs)
})

type Identity = {
  observedProcessCount: number | null
  discoveredWithPid: number
  discoveredWithoutPid: number
  countsAgree: boolean | null
  countsReason: string
  disagreeingPids: number[]
  disagreeingSessions: Array<{ sessionId: string; pid: number; reason: string }>
}

const valid = JSON.stringify({ id: 'session_valid', title: 'Valid session', updated_at: '2026-01-01T00:00:00Z', messages: [] })

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-discover-identity-'))
  dirs.push(home)
  const sessions = path.join(home, 'sessions')
  fs.mkdirSync(sessions)
  fs.writeFileSync(path.join(sessions, 'session_valid.json'), valid)
  return home
}

function writePidMap(home: string, entries: Record<string, number | { pid: number }>): string {
  const file = path.join(home, 'pid-map.json')
  fs.writeFileSync(file, JSON.stringify(entries))
  return file
}

/** A real node child that stays alive until the test kills it. */
async function livePid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('the node child did not report a pid')
  return pid
}

/** A real node child that has been killed, so its pid is dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('the node child did not report a pid')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill()
  })
  return pid
}

async function discover(home: string, extra: string[] = []) {
  const args = [
    '--import', 'tsx', path.join(import.meta.dirname, '..', 'cli.ts'),
    'ops', 'discover', '--source', 'jcode',
    '--jcode-home', home, '--host', 'identity-host', '--endpoint', 'identity-endpoint',
    ...extra,
  ]
  return exec(process.execPath, args, {
    timeout: 60_000,
    env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' },
  })
}

test('a discovered pid that is a live real process agrees in one enumeration', async () => {
  const home = tempHome()
  const pid = await livePid()
  const map = writePidMap(home, { session_valid: pid })
  const run = await discover(home, ['--pid-map', map, '--json'])
  const document = JSON.parse(run.stdout) as { identity: Identity }
  expect(document.identity.countsAgree).toBe(true)
  expect(document.identity.observedProcessCount).toBe(1)
  expect(document.identity.discoveredWithPid).toBe(1)
  expect(document.identity.discoveredWithoutPid).toBe(0)
  expect(document.identity.disagreeingPids).toEqual([])
  expect(document.identity.countsReason).toContain('one live enumeration')
})

test('a recorded pid that is dead disagrees and is named in human and JSON output', async () => {
  const home = tempHome()
  const pid = await deadPid()
  const map = writePidMap(home, { session_valid: pid })
  const run = await discover(home, ['--pid-map', map])
  const document = JSON.parse(run.stdout) as { identity: Identity }
  expect(document.identity.countsAgree).toBe(false)
  expect(document.identity.observedProcessCount).toBe(0)
  expect(document.identity.discoveredWithPid).toBe(1)
  expect(document.identity.disagreeingPids).toEqual([pid])
  expect(document.identity.disagreeingSessions).toEqual([
    expect.objectContaining({ sessionId: 'session_valid', pid }),
  ])
  // The human line names the session and the pid, so a reader never has to
  // parse the JSON document to see which record disagrees.
  expect(run.stderr).toContain(`session_valid@${pid}`)
  expect(run.stderr).toContain('countsAgree=false')
})

test('a source with no pid metadata reports countsAgree null with a named reason, never true', async () => {
  const home = tempHome()
  const run = await discover(home, ['--json'])
  const document = JSON.parse(run.stdout) as { identity: Identity }
  expect(document.identity.countsAgree).toBeNull()
  expect(document.identity.observedProcessCount).toBeNull()
  expect(document.identity.discoveredWithPid).toBe(0)
  expect(document.identity.discoveredWithoutPid).toBe(1)
  expect(document.identity.countsReason).toContain('no pid metadata')
  expect(document.identity.countsReason).toContain('null, not true')

  const human = await discover(home)
  expect(human.stderr).toContain('countsAgree=null')
  expect(human.stderr).toContain('no pid metadata')
})
