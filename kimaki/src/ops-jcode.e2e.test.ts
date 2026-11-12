// Opt-in acceptance against a real Jcode home. Metadata only: the assertion
// pins the exact emitted fields so a transcript or path can never slip in.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const exec = promisify(execFile)

test.skipIf(!process.env['KIMAKI_JCODE_HOME'])('discovers real Jcode sessions with metadata only', async () => {
  const home = process.env['KIMAKI_JCODE_HOME']!
  const cli = async (args: string[]) => {
    const run = await exec(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'discover', '--source', 'jcode', ...args], {
      timeout: 180_000,
      env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' },
    })
    return JSON.parse(run.stdout)
  }
  const first = await cli(['--jcode-home', home, '--host', 'acceptance-host', '--endpoint', 'acceptance-endpoint', '--limit', '2'])
  expect(first).toMatchObject({ source: 'jcode', coverage: 'explicit-jcode-home-metadata-page' })
  expect(first.endpoint).toEqual({ hostId: 'acceptance-host', endpointId: 'acceptance-endpoint', backendKind: 'jcode' })
  expect(Array.isArray(first.sessions)).toBe(true)
  for (const entry of first.sessions) {
    expect(Object.keys(entry).sort()).toEqual(['key', 'title'])
    expect(Object.keys(entry.key).sort()).toEqual(['backendKind', 'endpointId', 'hostId', 'nativeSessionId'])
    expect(entry.key.backendKind).toBe('jcode')
    expect(entry.key.nativeSessionId).toMatch(/^session_/)
    expect(typeof entry.title === 'string' || entry.title === null).toBe(true)
  }
  // The payload must never carry transcript, model or working-directory fields.
  const serialized = JSON.stringify(first)
  for (const forbidden of ['"messages"', '"working_dir"', '"provider_key"', '"model"']) {
    expect(serialized).not.toContain(forbidden)
  }
  if (first.cursor !== null) {
    const second = await cli(['--jcode-home', home, '--host', 'acceptance-host', '--endpoint', 'acceptance-endpoint', '--limit', '2', '--cursor', String(first.cursor)])
    expect(second.sessions.length).toBeGreaterThan(0)
    const firstIds = new Set(first.sessions.map((entry: { key: { nativeSessionId: string } }) => entry.key.nativeSessionId))
    for (const entry of second.sessions) expect(firstIds.has(entry.key.nativeSessionId)).toBe(false)
  }
}, 240_000)

test('refuses Jcode discovery without an explicit home', async () => {
  const run = exec(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'discover', '--source', 'jcode', '--host', 'h', '--endpoint', 'e'], {
    timeout: 120_000,
    env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' },
  })
  await expect(run).rejects.toMatchObject({ code: expect.any(Number) })
  await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('jcode-home') })
}, 240_000)
