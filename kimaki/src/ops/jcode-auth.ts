// Read-only probe for jcode's native provider auth status. Kimaki never reads,
// copies or stores jcode credential material: this module only runs
// `jcode auth status`, parses its tab-separated report and returns metadata.
//
// Real output on this host (secrets are never printed by that command):
//   openai\tavailable\tOAuth\tOAuth (account: `openai-otter`)\treadiness: ...\tnot validated
//   opencode-go\tavailable\tAPI key\tAPI key (`OPENCODE_GO_API_KEY`)\treadiness: ...\tnot validated

import { spawn } from 'node:child_process'

export type JcodeProviderState = 'available' | 'not_configured' | 'unknown'
export type JcodeProviderStatus = {
  provider: string
  state: JcodeProviderState
  detail: string
}

export type JcodeAuthStatusInput = {
  binary?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  shell?: boolean
}

// Parses a single `jcode auth status` provider line. jcode emits six
// tab-separated columns (provider, state, method, source, readiness, validation);
// a line with only two columns is also accepted. Unknown lines are represented
// by state 'unknown' instead of throwing, so a jcode upgrade cannot break the
// probe: the caller sees the raw text as detail.
export function parseJcodeAuthLine(line: string): JcodeProviderStatus | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  // Real jcode output is tab-separated; split tabs first so details containing
  // spaces stay intact. A legacy space-separated line uses the fallback split.
  const columns = (trimmed.includes('\t') ? trimmed.split(/\t+/) : trimmed.split(/[\t ]+/))
    .map((column) => column.trim())
    .filter((column) => column.length > 0)
  if (columns.length < 2) return { provider: trimmed, state: 'unknown', detail: '' }
  const [provider, state, ...rest] = columns
  const normalized = state!.toLowerCase()
  const known: JcodeProviderState = normalized === 'available' || normalized === 'not_configured' ? normalized : 'unknown'
  // Preserve the whole report line, not just the extra columns, so validation
  // notes (e.g. "validation failed (stale)") stay visible to the caller.
  return { provider: provider!, state: known, detail: rest.join('\t') }
}

export function parseJcodeAuthStatus(output: string): JcodeProviderStatus[] {
  return output.split(/\r?\n/).map(parseJcodeAuthLine).filter((row): row is JcodeProviderStatus => row !== null)
}

// Runs `<binary> auth status` and resolves to parsed provider metadata.
// Every failure mode returns an Error so callers can fail() uniformly:
// missing binary, non-zero exit, timeout. A timeout kills the child and waits
// for exit before resolving, so no process is left behind.
export async function jcodeAuthStatus({ binary = 'jcode', timeoutMs = 10_000, env = process.env, shell = false }: JcodeAuthStatusInput = {}): Promise<JcodeProviderStatus[] | Error> {
  if (!binary.trim()) return new Error('jcode binary must not be empty')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return new Error(`Invalid jcode auth status timeout ${timeoutMs}`)

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, ['auth', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
        shell,
        // POSIX: run the child in its own process group so a wrapper script's
        // descendants (a shell that forked `sleep`, for example) can be killed
        // with it. A surviving grandchild holds the stdio pipes open, so `close`
        // would never fire and the timeout could not resolve.
        detached: process.platform !== 'win32',
      })
    } catch (cause) {
      resolve(new Error(`Cannot start ${binary} auth status: ${cause instanceof Error ? cause.message : String(cause)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: JcodeProviderStatus[] | Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })

    child.once('error', (cause) => {
      finish(new Error(`Cannot run ${binary} auth status: ${cause.message}`, { cause }))
    })

    child.once('close', (code, signal) => {
      if (timedOut) return finish(new Error(`${binary} auth status timed out after ${timeoutMs}ms`))
      if (signal) return finish(new Error(`${binary} auth status was killed by ${signal}`))
      if (code !== 0) {
        const reason = stderr.trim() || stdout.trim() || 'no output'
        return finish(new Error(`${binary} auth status exited with code ${code ?? 'unknown'}: ${reason}`))
      }
      finish(parseJcodeAuthStatus(stdout))
    })

    timer = setTimeout(() => {
      timedOut = true
      // Kill the child and its whole tree on Windows: a .cmd shim spawns a
      // grandchild that would otherwise survive the shell's death.
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('error', () => child.kill('SIGKILL'))
      } else if (child.pid === undefined) {
        child.kill('SIGKILL')
      } else {
        // Negative pid signals the whole process group, so descendants spawned
        // by a shell wrapper die with it.
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }, timeoutMs)
  })
}
