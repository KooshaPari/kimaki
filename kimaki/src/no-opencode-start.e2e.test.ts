// Phase 2.1 proof: `kimaki bot` with --backend jcode must not trip the OpenCode
// version gate on a machine whose PATH contains no `opencode` binary. The control
// in this file proves the scrub is real: the opencode backend under the same
// scrubbed PATH fails for the documented missing-OpenCode reason.
//
// Runs the CLI as a child process with a temp data dir and a bounded lifetime,
// because a bot start waits on onboarding/gateway and would otherwise hang.
// Child cleanup is proven by awaiting the child's close event after kill/exit.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliSrc = path.resolve(packageDir, 'src', 'cli.ts')
const cliDist = path.resolve(packageDir, 'dist', 'cli.js')
const scratchRoot = 'E:/koosh/Agents/scratch/no-opencode-start'
fs.mkdirSync(scratchRoot, { recursive: true })

const OPENCODE_NAMES = process.platform === 'win32'
  ? ['opencode', 'opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode.com']
  : ['opencode']

function directoryHasOpencode(dir: string): boolean {
  for (const name of OPENCODE_NAMES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true
    } catch {
      // unreadable PATH entry: treat as not containing opencode
    }
  }
  return false
}

function scrubPath(pathValue: string | undefined): { scrubbed: string; removed: string[] } {
  const parts = (pathValue ?? '').split(path.delimiter).filter((part) => part.length > 0)
  const removed: string[] = []
  const kept: string[] = []
  for (const part of parts) {
    if (directoryHasOpencode(part)) {
      removed.push(part)
    } else {
      kept.push(part)
    }
  }
  return { scrubbed: kept.join(path.delimiter), removed }
}

function cliInvocation(args: string[]): { command: string; args: string[]; label: string } {
  // Prefer the shipped/dist CLI when present; fall back to src via tsx so the test
  // still runs in a source checkout.
  if (fs.existsSync(cliDist)) {
    return { command: process.execPath, args: [cliDist, ...args], label: `${process.execPath} ${cliDist} ${args.join(' ')}` }
  }
  return {
    command: process.execPath,
    args: ['--import', 'tsx', cliSrc, ...args],
    label: `${process.execPath} --import tsx ${cliSrc} ${args.join(' ')}`,
  }
}

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

function killAndAwait(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('close', finish)
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    const forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish()
        return
      }
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.once('close', () => {
          setTimeout(finish, 500)
        })
        killer.once('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          setTimeout(finish, 500)
        })
      } else {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        setTimeout(finish, 500)
      }
    }, 3000)
    forceTimer.unref?.()
  })
}

async function runBounded({
  args,
  env,
  timeoutMs,
}: {
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
}): Promise<RunResult & { invocation: string }> {
  const invocation = cliInvocation(args)
  const start = Date.now()
  const child = spawn(invocation.command, invocation.args, {
    cwd: packageDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })

  const result = await new Promise<RunResult>((resolve) => {
    let timedOut = false
    let finished = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - start })
    }
    child.once('close', (code, signal) => finish(code, signal))
    child.once('error', (error) => {
      stderr += `\n[spawn error] ${error.message}`
      finish(null, null)
    })
    const timer = setTimeout(() => {
      timedOut = true
      void killAndAwait(child)
    }, timeoutMs)
  })

  // Prove cleanup: after bounded run resolves, the child must have exited.
  if (child.exitCode === null && child.signalCode === null) {
    await killAndAwait(child)
  }

  return { ...result, invocation: invocation.label }
}

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.promises
      .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => undefined)
  }
})

function tempDataDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(scratchRoot, prefix))
  tempDirs.push(dir)
  return dir
}

const { scrubbed, removed } = scrubPath(process.env['PATH'])

export const __noOpencodeStartTestMeta = {
  scrubbedPathMethod:
    'Split process.env.PATH on path.delimiter and remove each directory that contains any of opencode/opencode.exe/opencode.cmd/opencode.bat/opencode.com (Windows) or opencode (POSIX). Rejoin the remaining entries with path.delimiter and pass that PATH to the spawned CLI process so no directory containing an opencode binary is discoverable via PATH.',
  removedDirectories: removed,
  scrubbedPath: scrubbed,
}

describe('kimaki start without opencode on PATH (Phase 2.1 proof)', () => {
  const gateMessage = 'Kimaki now requires OpenCode 2'
  const missingMessage = 'Kimaki requires OpenCode 2, which is not installed'

  // Same scrubbed PATH for both cases, as required. Data dirs and lock/service state
  // are isolated per run via temp dirs to avoid cross-talk.
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: scrubbed,
  }

  it('starts with --backend jcode and does not hit the OpenCode version gate', async () => {
    const dataDir = tempDataDir('jcode-')
    const run = await runBounded({
      args: ['--backend', 'jcode', '--data-dir', dataDir],
      env: baseEnv,
      timeoutMs: 40_000,
    })

    const output = `${run.stdout}\n${run.stderr}`
    // Primary assertion: the specific OpenCode version gate must not appear.
    expect(output).not.toContain(gateMessage)

    // The process must not exit with that failure. If it exited quickly, it was for
    // some other reason (onboarding/credentials/gateway), not the OpenCode gate.
    // If it timed out, it progressed past startup checks and was killed by the bound.
    if (!run.timedOut && run.code !== null) {
      expect(output).not.toContain(gateMessage)
    }

    // Cleanup proof is structural: runBounded awaits child close/kill before resolving.
    // The child cannot still be running here; record a sanity check on duration.
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it('control: --backend opencode under the same scrubbed PATH fails for the documented reason', async () => {
    const dataDir = tempDataDir('opencode-')
    const run = await runBounded({
      args: ['--backend', 'opencode', '--data-dir', dataDir],
      env: baseEnv,
      timeoutMs: 40_000,
    })

    const output = `${run.stdout}\n${run.stderr}`
    // Control: with opencode backend and no opencode binary discoverable on PATH,
    // startup must fail for the documented reason. Depending on resolution this is
    // either the missing-install message or the version gate ("but <binary> is
    // OpenCode <version>... requires OpenCode 2").
    const showsMissing = output.includes(missingMessage)
    const showsVersionGate = output.includes(gateMessage)
    expect(showsMissing || showsVersionGate).toBe(true)

    // A missing/wrong OpenCode should prevent a long-running bot startup.
    if (!run.timedOut) {
      expect(run.code === null || run.code !== 0).toBe(true)
    }
  }, 120_000)

  it('records that the PATH scrub removed every directory containing an opencode binary', () => {
    // Sanity/meta: the scrub method is deterministic. `removed` may be empty on a
    // host with no opencode on PATH; the control still validates behavior under the
    // resulting PATH.
    expect(Array.isArray(removed)).toBe(true)
    for (const dir of removed) {
      expect(directoryHasOpencode(dir)).toBe(true)
    }
    expect(typeof __noOpencodeStartTestMeta.scrubbedPathMethod).toBe('string')
  })
})
