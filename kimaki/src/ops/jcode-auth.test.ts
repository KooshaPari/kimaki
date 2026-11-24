// Read-only jcode auth status probe. Tests use fake executables on a temporary
// PATH, so no real jcode installation or credentials are involved.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { removeTempDirs } from '../test/cleanup.ts'
import { jcodeAuthStatus, parseJcodeAuthStatus } from './jcode-auth.ts'

const dirs: string[] = []
afterEach(async () => { await removeTempDirs(dirs) })

function fakeBinary(script: string): { binary: string; env: NodeJS.ProcessEnv; marker: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-auth-'))
  dirs.push(dir)
  const binary = path.join(dir, process.platform === 'win32' ? 'fake-jcode.cmd' : 'fake-jcode')
  const marker = path.join(dir, 'alive.marker')
  if (process.platform === 'win32') {
    // CMD /D disables AutoRun, /S /C runs the quoted script. The first quoted
    // argument after /C is treated as the command by cmd.exe on Windows.
    fs.writeFileSync(binary, `@echo off\r\n${script.replace(/\n/g, '\r\n')}\r\n`)
  } else {
    fs.writeFileSync(binary, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  }
  return { binary, env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env['PATH'] ?? ''}` }, marker }
}

test('parses two provider lines from a fake jcode auth status', async () => {
  // printf with a single-quoted literal emits the TABs verbatim on bash, dash
  // and zsh. An unquoted `echo a<TAB>b` lets the shell treat the TAB as a word
  // separator and echo rejoins the words with spaces.
  const { binary, env } = fakeBinary([
    `printf '%s\\n' 'openai\tavailable\tOAuth\tOAuth account\treadiness: authenticated\tnot validated'`,
    `printf '%s\\n' 'opencode-go\tnot_configured\tAPI key\tnot configured\treadiness: not configured\tnot validated'`,
  ].join('\n'))
  const status = await jcodeAuthStatus({ binary, timeoutMs: 3000, env, shell: process.platform === 'win32' })
  expect(status).toEqual([
    { provider: 'openai', state: 'available', detail: 'OAuth\tOAuth account\treadiness: authenticated\tnot validated' },
    { provider: 'opencode-go', state: 'not_configured', detail: 'API key\tnot configured\treadiness: not configured\tnot validated' },
  ])
})

test('returns an Error naming a non-zero exit code', async () => {
  const { binary, env } = fakeBinary('echo boom 1>&2\nexit 7')
  const result = await jcodeAuthStatus({ binary, timeoutMs: 3000, env, shell: process.platform === 'win32' })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain('exited with code 7')
  expect((result as Error).message).toContain('boom')
})

test('times out, kills the child, and leaves no process behind', async () => {
  const { binary, env, marker } = fakeBinary('')
  const pidPath = marker.split(path.sep).join('/')
  if (process.platform === 'win32') {
    const helper = binary + '.mjs'
    fs.writeFileSync(helper, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))\nawait new Promise(() => {})\n`)
    fs.writeFileSync(binary, `@echo off\r\nnode "${helper}"\r\n`)
  } else {
    fs.writeFileSync(binary, `#!/bin/sh\necho $$ > "${marker}"\nsleep 30\n`, { mode: 0o755 })
  }
  const started = Date.now()
  const result = await jcodeAuthStatus({ binary, timeoutMs: 400, env, shell: process.platform === 'win32' })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain('timed out after 400ms')
  expect(Date.now() - started).toBeLessThan(4000)
  // The PID file proves the fake child actually started. After the timeout
  // error resolves, that PID must no longer exist.
  const pid = Number(fs.readFileSync(marker, 'utf8').trim())
  expect(Number.isInteger(pid)).toBe(true)
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  expect(alive).toBe(false)
})

test('returns an Error for a missing binary', async () => {
  const { binary, env } = fakeBinary('echo unreachable')
  const result = await jcodeAuthStatus({ binary: binary + '-missing', timeoutMs: 3000, env, shell: false })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain('Cannot run')
})

test('parser does not throw on unexpected lines', () => {
  expect(parseJcodeAuthStatus([
    '# comment',
    '',
    'only-provider',
    'weird mystery-state something',
    'openai  available',
  ].join('\n'))).toEqual([
    { provider: 'only-provider', state: 'unknown', detail: '' },
    { provider: 'weird', state: 'unknown', detail: 'something' },
    { provider: 'openai', state: 'available', detail: '' },
  ])
})

