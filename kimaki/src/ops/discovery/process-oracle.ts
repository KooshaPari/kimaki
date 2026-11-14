// An independent process oracle for passive discovery. The inventory says which
// sessions exist; this module observes which processes exist and compares the two.
// Only process metadata is read: pid, a birth marker and a command name. No
// transcript text, terminal input or process environment is ever returned.
import childProcess from 'node:child_process'
import { ConfigError } from '../../errors.js'

const MAX_PROCESSES = 20_000
const MAX_BUFFER = 4 * 1024 * 1024
const MAX_SESSION_ID = 256

// A pid is never an identity on its own. Two processes can share a pid across a
// restart, so the birth marker (OS process start time) is the discriminator.
// `null` means the source did not expose a marker; that is unknown, not a match.
export type ProcessIdentity = {
  pid: number
  birthMarker: string | null
}

export type ProcessTable = {
  source: string
  observedAt: number
  // The table is already scoped by the caller (pid list or name filter). The
  // count below is the independent oracle count for that scope.
  coverage: string
  processes: ProcessIdentity[]
}

export type InventoryProcessEntry = {
  sessionId: string
  // Metadata only. `null` records a session whose process identity is unknown,
  // which must not be silently dropped from the inventory.
  process: ProcessIdentity | null
}

export type ProcessInventory = {
  source: string
  observedAt: number
  entries: InventoryProcessEntry[]
}

export type InventoryProcessMatch =
  | { kind: 'matched'; sessionId: string; pid: number }
  | { kind: 'reused'; sessionId: string; pid: number; recordedMarker: string; liveMarker: string; reason: string }
  | { kind: 'missing-process'; sessionId: string; pid: number; reason: string }
  | { kind: 'unknown'; sessionId: string; pid: number | null; reason: string }

export type UnobservedProcess = {
  kind: 'unobserved-process'
  pid: number
  birthMarker: string | null
  reason: string
}

export type ProcessReconciliation = {
  inventory: { source: string; observedAt: number; count: number }
  oracle: { source: string; observedAt: number; count: number }
  // Counts agree when the inventory and the oracle report the same number of
  // members. They can agree while identities still disagree, so `reconciled`
  // additionally requires every identity to match with no orphan process.
  countsAgree: boolean
  reconciled: boolean
  matches: InventoryProcessMatch[]
  unobserved: UnobservedProcess[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const nonblank = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value : undefined

const marker = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() && value.length <= 256) return value.trim()
  return null
}

function validateIdentity(value: unknown, where: string): ProcessIdentity | ConfigError {
  if (!isRecord(value)) return new ConfigError({ reason: `${where} must be a process identity object` })
  const pid = value.pid
  // Win32 reports the System Idle Process as PID 0; the table must accept it
  // even though a runtime session is never attributed to it.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0 || pid > 4_294_967_295) {
    return new ConfigError({ reason: `${where} pid must be a non-negative integer` })
  }
  if (value.birthMarker !== null && value.birthMarker !== undefined && marker(value.birthMarker) === null) {
    return new ConfigError({ reason: `${where} birthMarker must be a nonblank string, a finite number or null` })
  }
  return { pid, birthMarker: marker(value.birthMarker) }
}

function validateSnapshot(snapshot: ProcessTable): ProcessIdentity[] | ConfigError {
  if (!isRecord(snapshot)) return new ConfigError({ reason: 'Process oracle snapshot must be an object' })
  if (!nonblank(snapshot.source, 128)) return new ConfigError({ reason: 'Process oracle source must be a nonblank string' })
  if (typeof snapshot.observedAt !== 'number' || !Number.isFinite(snapshot.observedAt)) {
    return new ConfigError({ reason: 'Process oracle observedAt must be a finite timestamp' })
  }
  if (!nonblank(snapshot.coverage, 128)) return new ConfigError({ reason: 'Process oracle coverage must be a nonblank string' })
  if (!Array.isArray(snapshot.processes)) return new ConfigError({ reason: 'Process oracle processes must be an array' })
  if (snapshot.processes.length > MAX_PROCESSES) {
    return new ConfigError({ reason: `Process oracle saw more than ${MAX_PROCESSES} processes; refusing an unbounded table` })
  }
  const identities: ProcessIdentity[] = []
  const seen = new Set<number>()
  for (const [index, raw] of snapshot.processes.entries()) {
    const identity = validateIdentity(raw, `Process oracle process[${index}]`)
    if (identity instanceof Error) return identity
    if (seen.has(identity.pid)) {
      return new ConfigError({ reason: `Process oracle lists PID ${identity.pid} more than once; the table is not a snapshot` })
    }
    seen.add(identity.pid)
    identities.push(identity)
  }
  return identities
}

function validateInventory(inventory: ProcessInventory): Map<string, InventoryProcessEntry> | ConfigError {
  if (!isRecord(inventory)) return new ConfigError({ reason: 'Process inventory must be an object' })
  if (!nonblank(inventory.source, 128)) return new ConfigError({ reason: 'Process inventory source must be a nonblank string' })
  if (typeof inventory.observedAt !== 'number' || !Number.isFinite(inventory.observedAt)) {
    return new ConfigError({ reason: 'Process inventory observedAt must be a finite timestamp' })
  }
  if (!Array.isArray(inventory.entries)) return new ConfigError({ reason: 'Process inventory entries must be an array' })
  if (inventory.entries.length > MAX_PROCESSES) {
    return new ConfigError({ reason: `Process inventory has more than ${MAX_PROCESSES} entries` })
  }
  const entries = new Map<string, InventoryProcessEntry>()
  for (const [index, raw] of inventory.entries.entries()) {
    const sessionId = isRecord(raw) ? nonblank(raw.sessionId, MAX_SESSION_ID) : undefined
    if (sessionId === undefined) {
      return new ConfigError({ reason: `Process inventory entry[${index}] sessionId must be a nonblank string` })
    }
    if (entries.has(sessionId)) {
      return new ConfigError({ reason: `Process inventory lists session ${sessionId} more than once` })
    }
    const process = raw.process
    if (process === null || process === undefined) {
      entries.set(sessionId, { sessionId, process: null })
      continue
    }
    const identity = validateIdentity(process, `Process inventory entry[${index}] process`)
    if (identity instanceof Error) return identity
    entries.set(sessionId, { sessionId, process: identity })
  }
  return entries
}

/**
 * Classify one recorded identity against one live identity. A pid match alone is
 * never enough. A missing marker on either side is unknown, and differing
 * markers mean the pid was reused by a different process incarnation.
 */
export function classifyProcessIdentity({
  recorded,
  live,
}: {
  recorded: ProcessIdentity
  live: ProcessIdentity
}): InventoryProcessMatch['kind'] | 'unknown' {
  if (recorded.pid !== live.pid) return 'unknown'
  if (recorded.birthMarker === null) return 'unknown'
  if (live.birthMarker === null) return 'unknown'
  return recorded.birthMarker === live.birthMarker ? 'matched' : 'reused'
}

/**
 * Compare a discovery inventory with an independent process snapshot. Every
 * disagreement is reported explicitly instead of being silently reconciled.
 */
export function reconcileDiscovery({
  inventory,
  snapshot,
}: {
  inventory: ProcessInventory
  snapshot: ProcessTable
}): ProcessReconciliation | ConfigError {
  const entries = validateInventory(inventory)
  if (entries instanceof Error) return entries
  const observed = validateSnapshot(snapshot)
  if (observed instanceof Error) return observed

  const liveByPid = new Map(observed.map((identity) => [identity.pid, identity]))
  const claimedPids = new Set<number>()
  const matches: InventoryProcessMatch[] = []

  for (const entry of entries.values()) {
    const recorded = entry.process
    if (recorded === null) {
      matches.push({
        kind: 'unknown',
        sessionId: entry.sessionId,
        pid: null,
        reason: `Session ${entry.sessionId} has no recorded process identity; its process cannot be attributed`,
      })
      continue
    }
    claimedPids.add(recorded.pid)
    const live = liveByPid.get(recorded.pid)
    if (live === undefined) {
      matches.push({
        kind: 'missing-process',
        sessionId: entry.sessionId,
        pid: recorded.pid,
        reason: `Session ${entry.sessionId} records PID ${recorded.pid}, but the oracle does not see that process`,
      })
      continue
    }
    if (recorded.birthMarker === null) {
      matches.push({
        kind: 'unknown',
        sessionId: entry.sessionId,
        pid: recorded.pid,
        reason: `Session ${entry.sessionId} records PID ${recorded.pid} without a birth marker; a pid alone is not an identity`,
      })
      continue
    }
    if (live.birthMarker === null) {
      matches.push({
        kind: 'unknown',
        sessionId: entry.sessionId,
        pid: recorded.pid,
        reason: `PID ${recorded.pid} is alive but the oracle could not read a birth marker; refusing to trust the pid alone`,
      })
      continue
    }
    if (recorded.birthMarker !== live.birthMarker) {
      matches.push({
        kind: 'reused',
        sessionId: entry.sessionId,
        pid: recorded.pid,
        recordedMarker: recorded.birthMarker,
        liveMarker: live.birthMarker,
        reason: `PID ${recorded.pid} now has birth marker '${live.birthMarker}', not recorded '${recorded.birthMarker}'; the pid was reused, so this is unknown`,
      })
      continue
    }
    matches.push({ kind: 'matched', sessionId: entry.sessionId, pid: recorded.pid })
  }

  const unobserved: UnobservedProcess[] = observed
    .filter((identity) => !claimedPids.has(identity.pid))
    .map((identity) => ({
      kind: 'unobserved-process' as const,
      pid: identity.pid,
      birthMarker: identity.birthMarker,
      reason: `PID ${identity.pid} is running, but no inventory entry claims it`,
    }))

  const inventoryCount = entries.size
  const observedCount = observed.length
  const countsAgree = inventoryCount === observedCount
  const reconciled = countsAgree && unobserved.length === 0 && matches.every((match) => match.kind === 'matched')
  return {
    inventory: { source: inventory.source, observedAt: inventory.observedAt, count: inventoryCount },
    oracle: { source: snapshot.source, observedAt: snapshot.observedAt, count: observedCount },
    countsAgree,
    reconciled,
    matches,
    unobserved,
  }
}

// ---------------------------------------------------------------------------
// Real enumeration. The reconciler above is pure; this half only produces a
// scoped ProcessTable. Tests inject fixtures into the reconciler directly, and a
// separate test observes this real process, so no test shells out for the
// comparison itself.
// ---------------------------------------------------------------------------

export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<string | ConfigError>

export type ProcessOracle = {
  snapshot(options?: { pids?: number[]; nameIncludes?: string }): Promise<ProcessTable | ConfigError>
}

const defaultRunner: CommandRunner = (file, args, { timeoutMs }) =>
  new Promise<string | ConfigError>((resolve) => {
    childProcess.execFile(file, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      shell: false,
      windowsHide: true,
    }, (error, output) => {
      if (error) {
        const category = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'output limit exceeded'
          : error.killed ? 'timed out' : 'command failed'
        resolve(new ConfigError({
          reason: `Process oracle ${category}. Check the platform process listing command.`,
          cause: new Error(`Process oracle ${category}`),
        }))
        return
      }
      resolve(output)
    })
  })

const NAME_FILTER = /^[A-Za-z0-9._ -]{1,64}$/

const scoped = (identities: ProcessIdentity[], { pids }: {
  pids?: number[]
}): ProcessIdentity[] => {
  if (pids === undefined) return identities
  const wanted = new Set(pids)
  return identities.filter((identity) => wanted.has(identity.pid))
}

// Name filtering happens in the platform command because the table does not
// carry command names out of this module (metadata minimisation).
function validateScope(options: { pids?: number[]; nameIncludes?: string }): ConfigError | null {
  if (options.pids !== undefined) {
    if (!Array.isArray(options.pids) || options.pids.length === 0 || options.pids.length > MAX_PROCESSES) {
      return new ConfigError({ reason: 'Process oracle pids must be a nonempty bounded array' })
    }
    for (const pid of options.pids) {
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
        return new ConfigError({ reason: 'Process oracle pids must be positive integers' })
      }
    }
    if (options.nameIncludes !== undefined) {
      return new ConfigError({ reason: 'Process oracle accepts pids or nameIncludes, not both' })
    }
    return null
  }
  if (options.nameIncludes !== undefined) {
    if (typeof options.nameIncludes !== 'string' || !NAME_FILTER.test(options.nameIncludes)) {
      return new ConfigError({ reason: 'Process oracle nameIncludes must be 1-64 characters of letters, digits, dot, underscore, space or hyphen' })
    }
    return null
  }
  return new ConfigError({ reason: 'Process oracle needs an explicit scope: pids or nameIncludes' })
}

const powershellScript = (nameIncludes: string | undefined): string => {
  // A filter here is a plain single-quoted PowerShell string; NAME_FILTER has
  // already excluded quotes, NULs and escape characters.
  const condition = nameIncludes === undefined
    ? 'Select-Object ProcessId,CreationDate,Name'
    : `Where-Object { $_.Name -like '*${nameIncludes}*' } | Select-Object ProcessId,CreationDate,Name`
  return [
    "$ErrorActionPreference='Stop'",
    `@(Get-CimInstance Win32_Process | ${condition}) | ConvertTo-Json -Compress -Depth 3`,
  ].join('; ')
}

const parseWindows = (stdout: string): ProcessIdentity[] | ConfigError => {
  if (!stdout.trim()) return []
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return new ConfigError({ reason: 'Process oracle returned invalid Windows process JSON' })
  }
  const rows = Array.isArray(value) ? value : [value]
  const identities: ProcessIdentity[] = []
  for (const row of rows) {
    if (!isRecord(row)) return new ConfigError({ reason: 'Process oracle returned a malformed Windows process row' })
    const pid = row.ProcessId
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 0) {
      return new ConfigError({ reason: 'Process oracle returned a Windows row without a valid ProcessId' })
    }
    identities.push({ pid, birthMarker: marker(row.CreationDate) })
  }
  return identities
}

const parsePosix = (stdout: string, nameIncludes: string | undefined): ProcessIdentity[] | ConfigError => {
  const identities: ProcessIdentity[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // `ps -eo pid=,lstart=,comm=` prints: pid, five lstart tokens, command.
    const tokens = trimmed.split(/\s+/)
    if (tokens.length < 3) return new ConfigError({ reason: 'Process oracle returned a malformed ps row' })
    const pid = Number(tokens[0])
    if (!Number.isSafeInteger(pid) || pid < 1) {
      return new ConfigError({ reason: 'Process oracle returned a ps row without a valid pid' })
    }
    const comm = tokens[tokens.length - 1] ?? ''
    if (nameIncludes !== undefined && !comm.toLowerCase().includes(nameIncludes.toLowerCase())) continue
    // lstart is the five tokens between pid and comm; comm is not part of the
    // birth marker, because a renamed process is the same incarnation.
    identities.push({ pid, birthMarker: tokens.slice(1, -1).join(' ') })
  }
  return identities
}

export function createProcessOracle({
  platform = process.platform,
  runner = defaultRunner,
  timeoutMs = 10_000,
}: {
  platform?: NodeJS.Platform | string
  runner?: CommandRunner
  timeoutMs?: number
} = {}): ProcessOracle {
  return {
    async snapshot(options = {}) {
      const scopeError = validateScope(options)
      if (scopeError) return scopeError
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        return new ConfigError({ reason: 'Process oracle timeoutMs must be an integer between 1 and 60000' })
      }
      const observedAt = Date.now()
      if (platform === 'win32') {
        const stdout = await runner('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          powershellScript(options.nameIncludes),
        ], { timeoutMs })
        if (stdout instanceof Error) return stdout
        const parsed = parseWindows(stdout)
        if (parsed instanceof Error) return parsed
        const processes = scoped(parsed, options)
        return {
          source: 'process-oracle:win32',
          observedAt,
          coverage: options.pids ? 'explicit-pids' : `name-contains:${options.nameIncludes ?? ''}`,
          processes,
        }
      }
      if (platform === 'linux' || platform === 'darwin' || platform === 'freebsd') {
        const stdout = await runner('ps', ['-eo', 'pid=,lstart=,comm='], { timeoutMs })
        if (stdout instanceof Error) return stdout
        const parsed = parsePosix(stdout, options.nameIncludes)
        if (parsed instanceof Error) return parsed
        const processes = scoped(parsed, options)
        return {
          source: `process-oracle:${platform}`,
          observedAt,
          coverage: options.pids ? 'explicit-pids' : `name-contains:${options.nameIncludes ?? ''}`,
          processes,
        }
      }
      return new ConfigError({ reason: `Process oracle does not support platform ${platform}` })
    },
  }
}

/** Observe the real process table on this host with an explicit scope. */
export async function observeProcesses(options: {
  pids?: number[]
  nameIncludes?: string
  platform?: NodeJS.Platform | string
  timeoutMs?: number
  runner?: CommandRunner
} = {}): Promise<ProcessTable | ConfigError> {
  const oracle = createProcessOracle({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  })
  return oracle.snapshot({
    ...(options.pids === undefined ? {} : { pids: options.pids }),
    ...(options.nameIncludes === undefined ? {} : { nameIncludes: options.nameIncludes }),
  })
}

/** Reconcile an inventory against an oracle, for callers that hold an oracle. */
export async function reconcileAgainstOracle({
  inventory,
  oracle,
  scope,
}: {
  inventory: ProcessInventory
  oracle: ProcessOracle
  scope?: { pids?: number[]; nameIncludes?: string }
}): Promise<ProcessReconciliation | ConfigError> {
  const snapshot = await oracle.snapshot(scope ?? {})
  if (snapshot instanceof Error) return snapshot
  return reconcileDiscovery({ inventory, snapshot })
}
