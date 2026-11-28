// The shipped CLI must reach the Paperclip enrolment and projection modules,
// including every refusal they already enforce. These cases run the real
// entrypoint as a child process so a command that exists only in the library
// cannot be mistaken for a shipped one.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

const exec = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(packageRoot, 'src/cli.ts')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-paperclip-cli-'))

const session = {
  hostId: 'host-a',
  endpointId: 'ep-a',
  backendKind: 'opencode',
  nativeSessionId: 'ses_1',
}
const enrolledAt = '2026-11-14T21:00:00.000Z'

// Every enrolment field is an explicit flag, including the literal action,
// surface, mode and publication policy the record carries.
function enrollArgs(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    action: 'enroll',
    host: session.hostId,
    endpoint: session.endpointId,
    backend: session.backendKind,
    'native-session': session.nativeSessionId,
    'runtime-backend-kind': session.backendKind,
    'runtime-endpoint': session.endpointId,
    'runtime-version': '2.0.29',
    surface: 'paperclip',
    mode: 'observe',
    publication: 'none',
    'created-at': enrolledAt,
    ...overrides,
  }
  return ['ops', 'paperclip', 'enroll', ...Object.entries(flags).flatMap(([flag, value]) => [`--${flag}`, value])]
}

function projectArgs(overrides: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    enrollment: path.join(workDir, 'enrollment.json'),
    host: session.hostId,
    endpoint: session.endpointId,
    backend: session.backendKind,
    'native-session': session.nativeSessionId,
    ...overrides,
  }
  return ['ops', 'paperclip', 'project', ...Object.entries(flags).flatMap(([flag, value]) => [`--${flag}`, value])]
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', cliPath, ...args], { cwd: packageRoot, env: process.env })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

// A refusal must keep the module's own message and leave stdout free of JSON,
// so a pipeline cannot read a failure as a record.
function expectRefused(result: { code: number; stdout: string; stderr: string }, message: string) {
  expect(result.code).not.toBe(0)
  expect(result.stdout.trim()).toBe('')
  expect(result.stderr).toContain(message)
}

beforeAll(() => { fs.mkdirSync(workDir, { recursive: true }) })
afterAll(() => { fs.rmSync(workDir, { recursive: true, force: true }) })

test('enroll prints the sealed record and project prints the observed entity', async () => {
  const enrolled = await run(enrollArgs())
  expect(enrolled.code).toBe(0)
  const record = JSON.parse(enrolled.stdout) as Record<string, any>
  expect(record).toMatchObject({
    kind: 'paperclip-enrollment',
    version: 1,
    session,
    runtime: { backendKind: session.backendKind, endpointId: session.endpointId, version: '2.0.29' },
    surface: 'paperclip',
    mode: 'observe',
    publication: 'none',
    createdAt: enrolledAt,
  })
  expect(record['enrollmentId']).toMatch(/^enr_[0-9a-f]{32}$/)
  expect(record['digest']).toMatch(/^sha256:[0-9a-f]{64}$/)
  fs.writeFileSync(path.join(workDir, 'enrollment.json'), JSON.stringify(record))

  const projected = await run(projectArgs({ 'runtime-version': '2.0.29', 'observed-at': '2026-11-15T01:02:03.000Z' }))
  expect(projected.code).toBe(0)
  const entity = JSON.parse(projected.stdout) as Record<string, any>
  expect(entity).toMatchObject({
    kind: 'paperclip-observed-session',
    externalRef: { system: 'kimaki', enrollmentId: record['enrollmentId'] },
    observed: { hostId: session.hostId, nativeSessionId: session.nativeSessionId, runtimeVersion: '2.0.29', enrolledAt },
    policy: { mode: 'observe', publication: 'none', writes: false, dispatch: false },
  })
  expect(entity['entityId']).toMatch(/^pc_[0-9a-f]{32}$/)
  expect(entity['digest']).toMatch(/^sha256:[0-9a-f]{64}$/)
}, 60_000)

test('a non-enrol action, a widened publication and a second different enrolment are refused', async () => {
  expectRefused(await run(enrollArgs({ action: 'observed' })), 'requires action "enroll"')
  expectRefused(await run(enrollArgs({ publication: 'all' })), 'publication must be none')
  expectRefused(await run(enrollArgs({ surface: 'discord' })), 'surface must be paperclip')
  expectRefused(await run(enrollArgs({ mode: 'control' })), 'mode must be observe')

  const first = await run(enrollArgs())
  expect(first.code).toBe(0)
  const existingPath = path.join(workDir, 'existing.json')
  fs.writeFileSync(existingPath, JSON.stringify([JSON.parse(first.stdout)]))
  expectRefused(await run([...enrollArgs({ 'runtime-version': '2.0.30' }), '--existing', existingPath]), 'already exists with a different runtime.version')
}, 60_000)

test('a missing field, a digest-less record and an unenrolled session are refused', async () => {
  expectRefused(await run(enrollArgs({ host: ' ' })), 'Supply --host explicitly')

  const enrolled = await run(enrollArgs())
  expect(enrolled.code).toBe(0)
  const record = JSON.parse(enrolled.stdout) as Record<string, unknown>
  const unsealed = { ...record }
  delete unsealed['digest']
  fs.writeFileSync(path.join(workDir, 'digest-less.json'), JSON.stringify({
    enrollment: unsealed,
    session,
  }))
  expectRefused(await run(['ops', 'paperclip', 'project', '--file', path.join(workDir, 'digest-less.json')]), 'Enrollment record has no content digest')

  fs.writeFileSync(path.join(workDir, 'enrollment.json'), JSON.stringify(record))
  expectRefused(await run(projectArgs({ 'native-session': 'ses_other' })), 'refusing to project an unenrolled session')
}, 60_000)
