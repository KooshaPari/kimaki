// Read-only jcode credential reporting. Tests use a `run` seam and fake
// executables, so no real jcode login is ever performed and no secret is read.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { removeTempDirs } from './test/cleanup.ts'
import {
  formatJcodeCredentialReport,
  JcodeCredentialsBinaryMissingError,
  JcodeCredentialsEmptyError,
  JcodeCredentialsUnusableError,
  parseJcodeCredentialOutput,
  readJcodeCredentials,
  type JcodeCredentialsRunResult,
} from './jcode-credentials.ts'

// Trimmed from a real `jcode auth status --json` capture of jcode v1.1.0-dev.
// The long health/last_refresh fields are deliberately absent: kimaki must not
// need, copy, or display those details.
const JSON_STATUS = JSON.stringify({
  any_available: true,
  providers: [
    {
      id: 'claude',
      display_name: 'Anthropic/Claude',
      status: 'expired',
      method: 'OAuth (expired) (account: `claude-otter`)',
      auth_kind: 'OAuth',
      credential_source: 'jcode-managed file',
      recommended: true,
    },
    {
      id: 'openai',
      display_name: 'OpenAI',
      status: 'available',
      method: 'OAuth (account: `openai-otter`)',
      auth_kind: 'OAuth',
      recommended: true,
    },
    {
      id: 'opencode-go',
      display_name: 'OpenCode Go',
      status: 'not_configured',
      method: 'not configured',
      auth_kind: 'API key',
      recommended: false,
    },
  ],
})

const fakeRun =
  (result: JcodeCredentialsRunResult | Error, calls: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv }>) =>
  async (input: { binary: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }) => {
    calls.push(input)
    return result
  }

const ok = (stdout: string, stderr = ''): JcodeCredentialsRunResult => ({ stdout, stderr, code: 0 })

test('parseJcodeCredentialOutput reads the real JSON shape without copying secrets', () => {
  const parsed = parseJcodeCredentialOutput(JSON_STATUS)
  expect(parsed).not.toBeInstanceOf(Error)
  if (parsed instanceof Error) return
  expect(parsed.format).toBe('json')
  expect(parsed.anyAvailable).toBe(true)
  expect(parsed.providers.map((provider) => [provider.id, provider.status, provider.available, provider.recommended])).toEqual([
    ['claude', 'expired', false, true],
    ['openai', 'available', true, true],
    ['opencode-go', 'not_configured', false, false],
  ])
  expect(JSON.stringify(parsed)).not.toContain('claude-otter')
  expect(JSON.stringify(parsed)).not.toContain('auth.json')
})

test('parseJcodeCredentialOutput accepts plain-text auth status', () => {
  const parsed = parseJcodeCredentialOutput(
    [
      'openai\t available \tOAuth\tOAuth account\treadiness: authenticated\tnot validated',
      'opencode-go\tnot_configured\tAPI key\tnot configured\treadiness: not configured\tnot validated',
      '',
    ].join('\n'),
  )
  expect(parsed).not.toBeInstanceOf(Error)
  if (parsed instanceof Error) return
  expect(parsed.format).toBe('text')
  expect(parsed.providers).toHaveLength(2)
  expect(parsed.providers[0]?.id).toBe('openai')
  expect(parsed.providers[0]?.authKind).toBe('OAuth')
  expect(parsed.anyAvailable).toBe(true)
})

test('parseJcodeCredentialOutput names empty and unparseable output', () => {
  expect(parseJcodeCredentialOutput('')).toBeInstanceOf(JcodeCredentialsUnusableError)
  expect(parseJcodeCredentialOutput('garbage')).toBeInstanceOf(JcodeCredentialsUnusableError)
  expect(parseJcodeCredentialOutput(JSON.stringify({ providers: [] }))).toBeInstanceOf(JcodeCredentialsEmptyError)
})

test('readJcodeCredentials runs only auth status --json with a scrubbed env', async () => {
  const calls: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }> = []
  const result = await readJcodeCredentials({
    binary: 'jcode',
    env: { PYTHONPATH: '/bad', PYTHONHOME: '/bad', HOME: '/home/test' },
    run: fakeRun(ok(JSON_STATUS), calls),
  })
  expect(result).not.toBeInstanceOf(Error)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.args).toEqual(['auth', 'status', '--json'])
  expect(calls[0]?.env).toEqual({ HOME: '/home/test' })
  expect(calls[0]?.timeoutMs).toBe(10_000)
})

test('readJcodeCredentials returns distinct named errors for missing binary, bad exit and no providers', async () => {
  const calls: never[] = []
  expect(await readJcodeCredentials({ binary: '/no/such/jcode', run: fakeRun(ok('{}'), calls) })).toBeInstanceOf(
    JcodeCredentialsBinaryMissingError,
  )
  expect(await readJcodeCredentials({ binary: 'jcode', run: fakeRun({ stdout: '', stderr: 'boom', code: 7 }, calls) })).toBeInstanceOf(
    JcodeCredentialsUnusableError,
  )
  const none = await readJcodeCredentials({
    binary: 'jcode',
    run: fakeRun(ok(JSON.stringify({ providers: [{ id: 'claude', status: 'not_configured', recommended: true }] })), calls),
  })
  expect(none).toBeInstanceOf(JcodeCredentialsEmptyError)
  expect((none as Error).message).toContain('jcode login claude')
  expect(calls).toHaveLength(2)
})

test('formatJcodeCredentialReport names the exact login command and stays bounded', () => {
  const parsed = parseJcodeCredentialOutput(JSON_STATUS)
  expect(parsed).not.toBeInstanceOf(Error)
  if (parsed instanceof Error) return
  const report = formatJcodeCredentialReport(parsed, 400)
  expect(report).toContain('jcode login opencode-go')
  expect(report).toContain('claude (Anthropic/Claude): expired')
  expect(report.length).toBeLessThanOrEqual(400)
  expect(report).not.toContain('claude-otter')
})

test('readJcodeCredentials actually runs a fake jcode executable without a login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-credentials-'))
  try {
    const binary = path.join(dir, process.platform === 'win32' ? 'fake-jcode.cmd' : 'fake-jcode')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nif "%1%2%3"=="authstatus--json" (echo ${JSON_STATUS.replace(/"/g, '""')})\r\nexit /b 0\r\n`
        : `#!/bin/sh\n[ "$1$2$3" = "authstatus--json" ] && printf '%s\\n' '${JSON_STATUS.replace(/'/g, `'\\''`)}'\nexit 0\n`
    fs.writeFileSync(binary, script, { mode: 0o755 })
    const result = await readJcodeCredentials({ binary, timeoutMs: 3_000 })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.binary).toBe(binary)
    expect(result.providers.find((provider) => provider.id === 'openai')?.available).toBe(true)
  } finally {
    await removeTempDirs([dir])
  }
})
