// AC16: a SHIPPED command reaches the durable fence.
//
// These tests spawn the real CLI twice with the same --run-id against one
// migrated database: the first `ops jcode serve` takes the claim and starts
// serving, the second is refused by name and exits non-zero having spawned
// nothing. Only pids these tests spawn are killed.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openDb } from '../db.ts'
import { removeTempDirs } from '../test/cleanup.ts'

const dirs: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await removeTempDirs(dirs)
})

async function freshDataDir(): Promise<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-cli-fence-'))
  dirs.push(dataDir)
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  opened.close()
  return dataDir
}

const cliPath = path.join(import.meta.dirname, '..', 'cli.ts')

function serve(dataDir: string, runId: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [
    '--import', 'tsx', cliPath,
    'ops', 'jcode', 'serve',
    '--cwd', process.cwd(),
    '--data-dir', dataDir,
    '--run-id', runId,
  ], {
    env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' },
  })
  children.push(child)
  return child
}

// Resolves as soon as `predicate` matches the accumulated stdout, or rejects
// on process exit so a failure never hangs the suite.
function waitForStdout(child: ChildProcessWithoutNullStreams, predicate: (text: string) => boolean, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`timed out waiting for stdout; saw: ${text}`)), timeoutMs)
    const check = () => {
      if (predicate(text)) {
        clearTimeout(timer)
        resolve(text)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      text += chunk
      check()
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`process exited before matching (code=${code}, signal=${signal}); saw: ${text}`))
    })
  })
}

function collect(child: ChildProcessWithoutNullStreams): { stdout: () => string; stderr: () => string; done: Promise<{ code: number | null; signal: string | null }> } {
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { stdout: () => stdout, stderr: () => stderr, done }
}

test('the second serve for the same run is refused by name and spawns nothing', async () => {
  const dataDir = await freshDataDir()
  const runId = 'run-ac16'

  const first = serve(dataDir, runId)
  const firstOut = await waitForStdout(first, (text) => text.includes('"url"'))
  expect(JSON.parse(firstOut).url).toMatch(/^http:\/\//)

  const second = serve(dataDir, runId)
  const secondSaw = collect(second)
  // If the fence were not wired, the second launcher would serve instead of
  // exiting; that is a fast, literal failure rather than a suite timeout.
  const outcome = await Promise.race([
    secondSaw.done.then(() => 'exited' as const),
    waitForStdout(second, (text) => text.includes('"url"'), 30_000).then(() => 'served' as const).catch(() => 'exited' as const),
  ])
  expect(outcome).toBe('exited')
  // The refusal is the fence's own text and it names the holder (the first pid).
  expect(secondSaw.stderr()).toContain('is already claimed by')
  expect(secondSaw.stderr()).toContain(`kimaki-cli-serve:${first.pid}`)
  // Nothing was served: no hub URL was printed by the refused launcher.
  expect(secondSaw.stdout()).not.toContain('"url"')

  first.kill()
}, 120_000)
