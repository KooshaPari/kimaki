// Two evidence witnesses that were missing from the acceptance map:
//
// AC02 "Passive observe": the observer is read-only by construction, but the map
// wants a recorded proof that discovery, snapshot, observation and detach leave
// the native session byte-identical. The session here is written by the real
// `jcode` binary into an isolated JCODE_HOME, so hashing the store is stable
// (the developer's own ~/.jcode is appended to continuously by a live session,
// so it can never be hashed reliably).
//
// AC35 "Clean restart": the hub restart from a stopped state is already covered;
// this drives the full bot stack through the product's own supervisor: the
// `restart` lock route makes the bot exit with RESTART_EXIT_CODE (75),
// `supervise()` in cli/bot.ts spawns a new bot, and onboarding/cli emits `ready`
// again. The last assertion is that nothing spawned here is left running.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createJcodeObserver } from './ops/runtime/jcode.ts'
import { removeTempDir } from './test/cleanup.ts'
import {
  freePort,
  startOpencodeTestServer,
  startTwin,
  tempDataDir,
  TEST_USER_ID,
  textParts,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const execFileAsync = promisify(execFile)
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

// --- AC02 helpers: the real jcode binary and a hash of its session store.

// The binary this host actually has; never a wrapper that might resolve elsewhere.
function findJcode(): string | null {
  const candidates = [
    process.env['JCODE_BIN'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'jcode', 'bin', 'jcode.exe'),
    path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'jcode', 'bin', 'jcode.exe'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const jcodeBinary = findJcode()

type SessionFileState = { path: string; bytes: number; sha256: string; mtimeMs: number }

// Every file under sessions/ (recursively), relative path first so two snapshots
// can be compared even if readdir order changes.
function hashSessionStore(sessionsDir: string): SessionFileState[] {
  const files: SessionFileState[] = []
  const walk = (directory: string, relative: string) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, next)
        continue
      }
      const stats = fs.statSync(full)
      files.push({
        path: next,
        bytes: stats.size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        mtimeMs: stats.mtimeMs,
      })
    }
  }
  walk(sessionsDir, '')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

// The record settles only after the run that wrote it has exited; poll until two
// reads a moment apart agree, so a half-written record is never the baseline.
async function settleSessionStore(sessionsDir: string, timeoutMs = 30_000): Promise<SessionFileState[]> {
  const deadline = Date.now() + timeoutMs
  let previous = hashSessionStore(sessionsDir)
  while (Date.now() < deadline) {
    await sleep(500)
    const next = hashSessionStore(sessionsDir)
    if (next.length > 0 && JSON.stringify(next) === JSON.stringify(previous)) return next
    previous = next
  }
  throw new Error(`the jcode session store at ${sessionsDir} did not settle within ${timeoutMs}ms (files: ${previous.length})`)
}

// One real session, written by the real binary. The provider call is incidental:
// jcode persists the session record before it talks to a model, and the isolated
// home has no provider credentials of the developer's, so the run exits without
// spending anyone's quota or touching the live ~/.jcode store.
async function createRealJcodeSession({ binary, home, cwd }: { binary: string; home: string; cwd: string }): Promise<number> {
  const run = await new Promise<{ code: number | null }>((resolve) => {
    const child = spawn(binary, ['run', 'Reply with only: ok', '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd], {
      env: { ...process.env, JCODE_HOME: home, JCODE_NO_TELEMETRY: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === null) process.stderr.write(`jcode run left stderr: ${stderr}\n`)
      resolve({ code })
    })
  })
  return run.code ?? 1
}

function removeTree(target: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (!fs.existsSync(target)) return
    // A file handle can outlive the process by a moment on Windows.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  if (fs.existsSync(target)) throw new Error(`cannot remove ${target}: files are still held open`)
}

const skipJcode = jcodeBinary === null
const ac02Name = skipJcode
  ? 'AC02 passive observe: SKIPPED, no jcode executable found (set JCODE_BIN or install jcode)'
  : 'AC02 passive observe leaves the native session byte-identical (real jcode binary writing an isolated JCODE_HOME)'

test.skipIf(skipJcode)(ac02Name, async () => {
  const binary = jcodeBinary!
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-ac02-store-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-ac02-cwd-'))
  try {
    await createRealJcodeSession({ binary, home, cwd })
    const sessionsDir = path.join(home, 'sessions')
    const before = await settleSessionStore(sessionsDir)
    const sessionFile = before.find((file) => /(^|\/)session_[^/]*\.json$/.test(file.path))
    expect(sessionFile, `no session_*.json under ${sessionsDir}`).toBeDefined()
    const nativeSessionId = sessionFile!.path.split('/').pop()!.replace(/\.json$/, '')

    // The store digest the witness pins: names, sizes, SHA-256 and mtimes.
    const digestBefore = JSON.stringify(before)

    // 1. The CLI surface users run: `kimaki ops discover --source jcode`.
    const discovered = await execFileAsync(
      process.execPath,
      ['--import', tsx, path.resolve('src/cli.ts'), 'ops', 'discover', '--source', 'jcode', '--jcode-home', home, '--host', 'witness-host', '--endpoint', 'witness-endpoint', '--limit', '5'],
      { timeout: 180_000, env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' } },
    )
    const page = JSON.parse(discovered.stdout) as {
      coverage: string
      sessions: Array<{ key: { nativeSessionId: string } }>
    }
    expect(page.coverage).toBe('explicit-jcode-home-metadata-page')
    expect(page.sessions.map((entry) => entry.key.nativeSessionId)).toContain(nativeSessionId)

    // 2. In-process observer: discover, snapshot, then attach a read client and detach it.
    const readFile = (file: string) => fs.promises.readFile(file, 'utf8')
    const readDir = (directory: string) => fs.promises.readdir(directory)
    const observer = createJcodeObserver({ store: home, hostId: 'witness-host', endpointId: 'witness-endpoint', readFile, readDir, intervalMs: 50 })
    if (observer instanceof Error) throw observer
    const localPage = await observer.discover({ limit: 5 })
    if (localPage instanceof Error) throw localPage
    expect(localPage.observation).toEqual({ health: 'consistent', skippedTransient: 0 })
    const key = localPage.sessions.find((entry) => entry.key.nativeSessionId === nativeSessionId)?.key
    expect(key).toBeDefined()

    const snapshot = await observer.readSnapshot({ key: key! })
    if (snapshot instanceof Error) throw snapshot
    expect(snapshot.session.id).toBe(nativeSessionId)

    const controller = new AbortController()
    const observed: string[] = []
    const attached = await observer.observe({
      key: key!,
      signal: controller.signal,
      onEvent: (event) => { observed.push(event.type) },
    })
    if (attached instanceof Error) throw attached
    // Several poll intervals: the observer reads the record repeatedly while attached.
    await sleep(400)
    expect(attached.health()).toBe('consistent')
    attached.detach()
    expect(await attached.done).toBeNull()

    // 3. A second, independent read client: attach, read the record, detach.
    const reader = createJcodeObserver({ store: home, hostId: 'witness-host', endpointId: 'witness-endpoint', readFile, readDir, intervalMs: 50 })
    if (reader instanceof Error) throw reader
    const readerSnapshot = await reader.readSnapshot({ key: key! })
    if (readerSnapshot instanceof Error) throw readerSnapshot
    expect(readerSnapshot.session.id).toBe(nativeSessionId)
    const readerAttached = await reader.observe({ key: key!, onEvent: () => undefined })
    if (readerAttached instanceof Error) throw readerAttached
    await sleep(200)
    readerAttached.detach()
    expect(await readerAttached.done).toBeNull()

    // Every read above is done; nothing else can write this isolated store.
    const afterFirst = await settleSessionStore(sessionsDir)
    await sleep(500)
    const afterSecond = hashSessionStore(sessionsDir)
    expect(JSON.stringify(afterFirst)).toBe(digestBefore)
    expect(JSON.stringify(afterSecond)).toBe(digestBefore)
    // Named explicitly, so a report can quote the files the witness covered.
    expect(before.map((file) => file.path)).toEqual(afterSecond.map((file) => file.path))
    expect(observed).toEqual([])
    // Printed so the report can quote the exact files, hashes and mtimes proven stable.
    for (const file of before) {
      process.stdout.write(`AC02 store: ${file.path} bytes=${file.bytes} sha256=${file.sha256} mtimeMs=${file.mtimeMs}\n`)
    }
    process.stdout.write(`AC02 witness: ${before.length} store file(s), session ${nativeSessionId}, unchanged after CLI discover + observer discover/snapshot/observe/detach\n`)
  } finally {
    removeTree(home)
    removeTree(cwd)
  }
})

// --- AC35: a real supervised bot-stack restart.

let server: OpencodeTestServer
let twin: TestTwin
let website: http.Server
let websiteUrl: string
let dataDir: string
let supervisor: ChildProcessWithoutNullStreams | null = null
let supervisorPid: number | null = null
// Every bot pid observed, so cleanup can prove none of them survives.
const botPids = new Set<number>()

beforeAll(async () => {
  dataDir = tempDataDir()
  // Onboarding `git init`s dataDir/projects/kimaki; pin the branch the footer prints.
  const defaultProject = path.join(dataDir, 'projects', 'kimaki')
  fs.mkdirSync(defaultProject, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['init', '-q', '-b', 'main'], { cwd: defaultProject }, (error) => (error ? reject(error) : resolve()))
  })
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers: [
        {
          id: 'restart-witness-greeting',
          priority: 50,
          when: { latestUserTextIncludes: 'This is the Kimaki onboarding thread' },
          then: { parts: textParts('Ready for a restart.') },
        },
      ],
    }),
    startTwin({ gateway: true }),
  ])
  await warmUp({ server })
  // The fake kimaki.dev: installs the bot on the CLI's first status poll.
  website = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/onboarding/status') {
      response.writeHead(404).end()
      return
    }
    twin.discord.authorizeGatewayClient({
      token: `${url.searchParams.get('client_id')}:${url.searchParams.get('secret')}`,
      guildIds: [twin.discord.guildId],
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ guild_id: twin.discord.guildId, discord_user_id: TEST_USER_ID }))
  })
  const port = await freePort()
  await new Promise<void>((resolve) => website.listen(port, '127.0.0.1', resolve))
  websiteUrl = `http://127.0.0.1:${port}`
}, 120_000)

afterAll(async () => {
  await stopSupervisor()
  for (const pid of botPids) await waitForPidGone(pid, 10_000)
  await new Promise<void>((resolve) => website?.close(() => resolve()))
  await twin?.stop()
  await server?.stop()
  if (dataDir) {
    await removeTempDir(dataDir)
    expect(fs.existsSync(dataDir), `the witness left ${dataDir} behind`).toBe(false)
  }
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the PID exists but belongs to another user; treat it as alive.
    return Reflect.get(error, 'code') === 'EPERM'
  }
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await sleep(100)
  }
  return !pidAlive(pid)
}

async function stopSupervisor(): Promise<void> {
  const child = supervisor
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(20_000)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, sleep(5_000)])
  }
}

function sseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>)
}

// The same failure shape as onboarding-cli.e2e.test.ts: a stopped process cannot
// emit another event, so the budget must not keep waiting on it.
async function waitForEvent({
  label,
  timeoutMs = 150_000,
  check,
  diagnose,
  stopped,
}: {
  label: string
  timeoutMs?: number
  check: () => boolean
  diagnose: () => string
  stopped: () => string | null
}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    const reason = stopped()
    if (reason) throw new Error(`${label} can no longer arrive (${reason}; ${diagnose()})`)
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms (${diagnose()})`)
}

test('AC35 a supervised bot restart exits 75, respawns a new pid, emits ready again and leaves no orphan (real cli.ts + supervise)', async () => {
  const proxy = new URL('/', twin.discord.restUrl).toString()
  const lockPort = await freePort()
  supervisor = spawn(
    process.execPath,
    ['--import', tsx, path.resolve('src/cli.ts'), '--data-dir', dataDir, '--gateway', '--machine-name', 'witness-machine'],
    {
      env: {
        ...process.env,
        KIMAKI_WEBSITE_URL: websiteUrl,
        KIMAKI_GATEWAY_PROXY_URL: proxy,
        KIMAKI_LOCK_PORT: String(lockPort),
        KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile,
        OPENCODE_CONFIG_DIR: server.configDir,
        KIMAKI_STRADA_ENABLED: '0',
      },
    },
  )
  supervisorPid = supervisor.pid ?? null
  expect(supervisorPid, 'the supervisor must have a pid to witness').toBeTypeOf('number')
  const output = { stdout: '', stderr: '' }
  supervisor.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()))
  supervisor.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()))
  const stopped = () => (supervisor && supervisor.exitCode !== null ? `the supervisor exited ${supervisor.exitCode}` : null)
  const diagnose = () => `stdout: ${output.stdout.slice(-800)} stderr: ${output.stderr.slice(-800)} exit: ${supervisor?.exitCode}`
  const readyCount = () => sseEvents(output.stdout).filter((event) => event['type'] === 'ready').length
  const cli = (args: string[]) => execFileAsync(
    process.execPath,
    ['--import', tsx, path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir],
    { timeout: 120_000, env: { ...process.env, KIMAKI_LOCK_PORT: String(lockPort), KIMAKI_STRADA_ENABLED: '0' } },
  )
  const status = async () => JSON.parse((await cli(['status', '--json'])).stdout) as { pid: number; running: boolean }

  await waitForEvent({
    label: 'the first ready event',
    check: () => readyCount() === 1,
    diagnose,
    stopped,
  })
  const before = await status()
  botPids.add(before.pid)
  expect(before.running).toBe(true)

  // The product path: `kimaki restart` -> lock route sets exit code 75 and stops.
  const restarted = await cli(['restart'])
  expect(restarted.stdout).toContain(`Restarting bot (pid ${before.pid})`)

  await waitForEvent({
    label: 'the second ready event after the restart',
    check: () => readyCount() === 2,
    diagnose,
    stopped,
  })
  const after = await status()
  botPids.add(after.pid)

  // The supervisor prints this only when the child exited with RESTART_EXIT_CODE.
  expect(output.stderr).toContain('Restarting kimaki...')
  expect({
    botPidChanged: after.pid !== before.pid,
    // The supervisor itself is not replaced: it is the loop that respawns the bot.
    supervisorUnchanged: supervisorPid === supervisor.pid && supervisor.exitCode === null,
    readyEvents: readyCount(),
  }).toEqual({ botPidChanged: true, supervisorUnchanged: true, readyEvents: 2 })

  // Stop the supervisor the way a user or lock eviction does, then prove nothing
  // spawned here survives the test.
  await stopSupervisor()
  const supervisorGone = await waitForPidGone(supervisorPid!, 20_000)
  const beforeGone = await waitForPidGone(before.pid, 20_000)
  const afterGone = await waitForPidGone(after.pid, 20_000)
  expect({ supervisorGone, beforeGone, afterGone }).toEqual({ supervisorGone: true, beforeGone: true, afterGone: true })
  // The lock port no longer answers a real bot: one process, and it is gone.
  const noLongerRunning = await cli(['status', '--json']).then(
    () => null,
    (error: { stdout?: string }) => error.stdout ?? '',
  )
  expect(noLongerRunning).toContain('"running":false')
  process.stdout.write(`AC35 witness: bot pid ${before.pid} -> ${after.pid}, supervisor ${supervisorPid} unchanged, ready events 2, orphans 0\n`)
}, 300_000)
