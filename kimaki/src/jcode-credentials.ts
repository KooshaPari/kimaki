// Phase 2.4: a read-only view of the credentials jcode already owns.
//
// The only command this module runs is `jcode auth status --json`. Kimaki never
// asks for a secret, never calls `jcode login`, never writes a credential file
// and never refreshes a token. The snapshot is status metadata: provider id,
// auth kind and method, plus an availability flag for each provider.
//
// Probe of the real binary on this host, jcode v1.1.0-dev (0672d64):
//   jcode auth status --json -> exit 0, JSON with `any_available` and `providers`.
//   Every provider row carries id, display_name, status, method, auth_kind,
//   credential_source, refresh_support and validation_method. No secret is in it.
// The human form (`jcode auth status`, exit 0) is tab separated:
//   claude\t expired \tOAuth\tOAuth (expired) (account: `claude-otter`)\treadiness: ...\tnot validated
//   openai\t available \tOAuth\tOAuth (account: `openai-otter`)\treadiness: ...\tnot validated
// It is kept as a fallback so a jcode build without --json still reports
// something useful; the exact lines this parser depends on are quoted above.

import { spawn } from 'node:child_process'
import fs from 'node:fs'

import * as errore from 'errore'

export class JcodeCredentialsBinaryMissingError extends errore.createTaggedError({
  name: 'JcodeCredentialsBinaryMissingError',
  message: 'Jcode credential reader cannot run: $reason',
}) {}

export class JcodeCredentialsUnusableError extends errore.createTaggedError({
  name: 'JcodeCredentialsUnusableError',
  message: 'Jcode auth status was not usable: $reason',
}) {}

export class JcodeCredentialsEmptyError extends errore.createTaggedError({
  name: 'JcodeCredentialsEmptyError',
  message: 'Jcode holds no provider credentials: $reason',
}) {}

export type JcodeProviderCredential = {
  /** Provider id as jcode spells it, e.g. `openai` or `opencode-go`. */
  id: string
  displayName: string
  /** Raw jcode status: available, not_configured, expired, ... */
  status: string
  authKind: string
  method: string
  /** True only for jcode's exact `available` status. */
  available: boolean
  recommended: boolean
}

export type JcodeCredentialSnapshot = {
  binary: string
  format: 'json' | 'text'
  anyAvailable: boolean
  providers: JcodeProviderCredential[]
}

export type JcodeCredentialsRunResult = {
  stdout: string
  stderr: string
  code: number | null
  signal?: NodeJS.Signals | null
}

export type JcodeCredentialsRun = (input: {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
}) => Promise<JcodeCredentialsRunResult | Error>

export type JcodeCredentialsInput = {
  /** Explicit executable path; defaults to JCODE_BIN, then a bare `jcode` on PATH. */
  binary?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Test seam. Production always uses the bounded child process below. */
  run?: JcodeCredentialsRun
}

const KNOWN_TEXT_STATUSES = new Set(['available', 'not_configured', 'expired', 'unknown'])
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const scrubEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const clean = { ...env }
  // Keep an inherited Python installation from injecting a different runtime
  // into a wrapper script, as the repo's other child-process seams do.
  delete clean.PYTHONPATH
  delete clean.PYTHONHOME
  return clean
}

const credential = (input: {
  id: string
  displayName?: unknown
  status: string
  authKind?: unknown
  method?: unknown
  recommended?: unknown
}): JcodeProviderCredential => ({
  id: input.id,
  displayName: typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName : input.id,
  status: input.status,
  authKind: typeof input.authKind === 'string' ? input.authKind : '',
  method: sanitizeMethod(input.method),
  available: input.status === 'available',
  recommended: input.recommended === true,
})

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

// jcode's `method` field can embed an account label (for example
// `OAuth (account: `openai-otter`)`). Kimaki keeps auth kind and expiry words
// but never copies an account label or a credential path into its snapshot.
const sanitizeMethod = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/\(account:\s*[^)]*\)/gi, '')
        .replace(/`[^`]*`/g, '')
        .replace(/\(\s*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : ''

function parseJsonOutput(output: string): JcodeCredentialSnapshot | null | JcodeCredentialsEmptyError {
  const root = errore.try(() => JSON.parse(output) as unknown)
  if (root instanceof Error || !Array.isArray(asRecord(root)['providers'])) return null
  const rows = asRecord(root)['providers'] as unknown[]
  if (rows.length === 0) return new JcodeCredentialsEmptyError({ reason: 'jcode reported an empty provider list' })
  const providers = rows
    .map((row) => {
      const value = asRecord(row)
      const id = typeof value['id'] === 'string' ? value['id'].trim() : ''
      const status = typeof value['status'] === 'string' ? value['status'].trim().toLowerCase() : ''
      if (!id || !status) return null
      return credential({
        id,
        displayName: value['display_name'],
        status,
        authKind: value['auth_kind'],
        method: value['method'],
        recommended: value['recommended'],
      })
    })
    .filter((row): row is JcodeProviderCredential => row !== null)
  if (providers.length === 0) return null
  return { binary: '', format: 'json', anyAvailable: providers.some((row) => row.available), providers }
}

function parseTextOutput(output: string): JcodeCredentialSnapshot | null {
  const providers = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const columns = line.split('\t').map((column) => column.trim())
      if (columns.length < 2) return null
      const [id, rawStatus, authKind = '', method = ''] = columns
      const status = (rawStatus ?? '').toLowerCase()
      if (!id || !KNOWN_TEXT_STATUSES.has(status)) return null
      return credential({ id, status, authKind, method })
    })
    .filter((row): row is JcodeProviderCredential => row !== null)
  if (providers.length === 0) return null
  return { binary: '', format: 'text', anyAvailable: providers.some((row) => row.available), providers }
}

/** Parse captured output. Returns a named error rather than an empty snapshot. */
export function parseJcodeCredentialOutput(
  output: string,
): JcodeCredentialSnapshot | JcodeCredentialsUnusableError | JcodeCredentialsEmptyError {
  if (!output.trim()) return new JcodeCredentialsUnusableError({ reason: 'jcode printed no output' })
  const parsed = parseJsonOutput(output) ?? parseTextOutput(output)
  if (parsed instanceof Error) return parsed
  if (!parsed) return new JcodeCredentialsUnusableError({ reason: 'unparseable auth status output; expected JSON providers or tab-separated provider statuses' })
  return parsed
}

const runChild = ({ binary, args, env, timeoutMs }: Parameters<JcodeCredentialsRun>[0]): Promise<JcodeCredentialsRunResult | Error> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
        // A Windows .cmd shim needs cmd.exe to resolve its extension; on POSIX
        // the executable is spawned directly.
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary),
        // Own process group: a wrapper that forked a child must not keep the
        // pipes open after the timeout kills the process this call spawned.
        detached: process.platform !== 'win32',
      })
    } catch (cause) {
      resolve(new JcodeCredentialsUnusableError({ reason: `cannot start ${binary}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: JcodeCredentialsRunResult | Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    const append = (stream: 'stdout' | 'stderr', chunk: string) => {
      const bucket = stream === 'stdout' ? stdout : stderr
      const next = bucket.length + chunk.length > MAX_OUTPUT_BYTES ? bucket : bucket + chunk
      if (stream === 'stdout') stdout = next
      else stderr = next
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk))
    child.once('error', (cause) => finish(new JcodeCredentialsUnusableError({ reason: `cannot run ${binary}: ${cause.message}`, cause })))
    child.once('close', (code, signal) => {
      if (timedOut) return finish(new JcodeCredentialsUnusableError({ reason: `${binary} did not answer within ${timeoutMs}ms` }))
      finish({ stdout, stderr, code: code ?? null, signal })
    })
    timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.once('error', () => child.kill('SIGKILL'))
      } else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
  })

const holdsCredential = (provider: JcodeProviderCredential): boolean => provider.status !== 'not_configured'

const recommendedLoginCommands = (snapshot: JcodeCredentialSnapshot): string[] =>
  snapshot.providers
    .filter((provider) => provider.recommended && !holdsCredential(provider))
    .slice(0, 4)
    .map((provider) => `jcode login ${provider.id}`)

/**
 * One bounded, non-interactive read of jcode's own credential state.
 * Errors are returned, never thrown: missing binary, bad exit, timeout and
 * unparseable output all have distinct named classes or reasons.
 */
export async function readJcodeCredentials({
  binary = process.env['JCODE_BIN'] ?? 'jcode',
  timeoutMs = 10_000,
  env = process.env,
  run = runChild,
}: JcodeCredentialsInput = {}): Promise<
  | JcodeCredentialSnapshot
  | JcodeCredentialsBinaryMissingError
  | JcodeCredentialsUnusableError
  | JcodeCredentialsEmptyError
> {
  const executable = binary.trim()
  if (!executable) return new JcodeCredentialsBinaryMissingError({ reason: 'no binary path was supplied' })
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return new JcodeCredentialsUnusableError({ reason: `invalid timeout ${timeoutMs}ms` })
  }
  // A path the caller named must exist. A bare executable name is left to the
  // runner so PATH lookup still works on Windows and Linux alike.
  if ((executable.includes('/') || executable.includes('\\')) && !fs.existsSync(executable)) {
    return new JcodeCredentialsBinaryMissingError({ reason: `no jcode executable at ${executable}` })
  }

  const result = await run({ binary: executable, args: ['auth', 'status', '--json'], env: scrubEnv(env), timeoutMs })
  if (result instanceof Error) {
    return result instanceof JcodeCredentialsUnusableError ||
      result instanceof JcodeCredentialsBinaryMissingError ||
      result instanceof JcodeCredentialsEmptyError
      ? result
      : new JcodeCredentialsUnusableError({ reason: result.message, cause: result })
  }
  if (result.signal) return new JcodeCredentialsUnusableError({ reason: `jcode was killed by ${result.signal}` })
  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || 'no output'
    return new JcodeCredentialsUnusableError({ reason: `jcode auth status --json exited ${result.code}: ${reason}` })
  }
  const parsed = parseJcodeCredentialOutput(result.stdout)
  if (parsed instanceof Error) return parsed
  if (!parsed.providers.some(holdsCredential)) {
    const commands = recommendedLoginCommands(parsed)
    return new JcodeCredentialsEmptyError({
      reason: `${parsed.providers.length} providers reported, none signed in${commands.length ? `; run ${commands.join(' or ')}` : ''}`,
    })
  }
  return { ...parsed, binary: executable }
}

/** Short, bounded text for Discord and CLI. No credential material is included. */
export function formatJcodeCredentialReport(snapshot: JcodeCredentialSnapshot, maxChars = 1800): string {
  const held = snapshot.providers.filter(holdsCredential)
  // Recommended providers first, so an exact `jcode login <id>` command for
  // the useful choices survives the character cap.
  const missing = snapshot.providers
    .filter((provider) => !holdsCredential(provider))
    .sort((a, b) =>
      Number(b.recommended && !b.method.includes('not configured')) - Number(a.recommended && !a.method.includes('not configured')) ||
      a.id.localeCompare(b.id),
    )
  const lines = [`Jcode already holds ${held.length} provider sign-in${held.length === 1 ? '' : 's'} (read-only):`]
  for (const provider of held) {
    // jcode often repeats the auth kind in `method` (OAuth / OAuth). Show the
    // more specific method once, without printing an account label.
    const detail = provider.method
      ? provider.authKind && provider.method.toLowerCase().includes(provider.authKind.toLowerCase())
        ? provider.method
        : `${provider.authKind}, ${provider.method}`
      : provider.authKind
    lines.push(`- ${provider.id} (${provider.displayName}): ${provider.status}${detail ? `; ${detail}` : ''}`)
  }
  lines.push('Run in a shell to sign in:')
  if (missing.length === 0) lines.push('  (every provider jcode knows is available)')
  for (const provider of missing.slice(0, 20)) lines.push(`  jcode login ${provider.id}`)
  if (missing.length > 20) lines.push(`  ... ${missing.length - 20} more; run \`jcode auth status --json\` for the full list.`)
  let text = lines.join('\n')
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 80).trimEnd()}\n  ... truncated; run \`jcode auth status --json\` for the full list.`
  }
  return text
}
