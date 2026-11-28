// Opt-in acceptance: the public ops CLI launches an isolated Codex app-server
// from an explicit state directory and prints metadata-only session keys.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

test.skipIf(!process.env.KIMAKI_CODEX_ACCEPTANCE)('ops discover lists Codex sessions from an explicit isolated state directory', async () => {
  const scratch = process.env.KIMAKI_CODEX_SCRATCH
  const binary = process.env.KIMAKI_CODEX_BINARY
  if (!scratch || !binary) throw new Error('Set KIMAKI_CODEX_SCRATCH and KIMAKI_CODEX_BINARY to run acceptance')
  const root = await fs.mkdtemp(path.join(scratch, 'codex-cli-acceptance-'))
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  try {
    const run = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'),
      'ops', 'discover', '--source', 'codex',
      '--binary', binary, '--codex-home', home,
      '--host', 'isolated-host', '--endpoint', 'isolated-endpoint',
    ], { timeout: 120_000, env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' } })
    expect(JSON.parse(run.stdout)).toEqual({
      source: 'codex',
      observedAt: expect.any(String),
      coverage: 'explicit-app-server-state-db-page',
      endpoint: { hostId: 'isolated-host', endpointId: 'isolated-endpoint', backendKind: 'codex' },
      sessions: [],
      cursor: null,
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 130_000)

test('rejects Codex discovery without an explicit state directory', async () => {
  const run = promisify(execFile)(process.execPath, [
    '--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'),
    'ops', 'discover', '--source', 'codex', '--binary', 'codex', '--host', 'h', '--endpoint', 'e',
  ], { timeout: 60_000, env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' } })
  await expect(run).rejects.toMatchObject({ code: expect.any(Number) })
  await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('codex-home') })
})
