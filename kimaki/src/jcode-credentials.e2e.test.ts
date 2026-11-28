// Real-binary acceptance for Phase 2.4: one bounded `jcode auth status --json`
// read, no login, no credential write, no secret copied into kimaki. Skips only
// when JCODE_BIN is unset and no installed jcode exists.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test, afterAll } from 'vitest'

import { findJcodeBinary } from './test/jcode-harness.ts'
import { removeTempDirs } from './test/cleanup.ts'
import {
  formatJcodeCredentialReport,
  JcodeCredentialsEmptyError,
  readJcodeCredentials,
  type JcodeCredentialSnapshot,
} from './jcode-credentials.ts'

const binary = findJcodeBinary()
const jcodeTest = binary === null ? test.skip : test
const dirs: string[] = []
afterAll(async () => { await removeTempDirs(dirs) })

jcodeTest('reads the installed jcode auth status as metadata only', async () => {
  const result = await readJcodeCredentials({ binary: binary!, timeoutMs: 15_000 })
  expect(result).not.toBeInstanceOf(Error)
  if (result instanceof Error) return
  const snapshot = result as JcodeCredentialSnapshot
  expect(snapshot.binary).toBe(binary)
  expect(['json', 'text']).toContain(snapshot.format)
  expect(snapshot.providers.length).toBeGreaterThan(0)
  const report = formatJcodeCredentialReport(snapshot, 1800)
  expect(report).toContain('Jcode already holds')
  expect(report).not.toMatch(/openai-otter|claude-otter|auth\.json|OPENCODE_GO_API_KEY/)
  expect(report.length).toBeLessThanOrEqual(1800)
})

jcodeTest('names a no-credential state when pointed at an empty jcode home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-empty-'))
  dirs.push(home)
  const result = await readJcodeCredentials({
    binary: binary!,
    timeoutMs: 15_000,
    env: { ...process.env, JCODE_HOME: home },
  })
  expect(result).toBeInstanceOf(JcodeCredentialsEmptyError)
  if (!(result instanceof Error)) return
  expect(result.message).toContain('jcode login')
})
