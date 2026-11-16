import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { openDb } from './db.ts'
import { removeDataDir } from './test/cleanup.ts'
import { JCODE_SKIP_NO_BINARY, startJcodeTestHub } from './test/jcode-harness.ts'
import { startTwin, tempDataDir, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let twin: TestTwin

// A restarted follow process must not replay events that were already delivered.
function startFollow(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'follow', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done, stderr: () => stderr, stdout: () => stdout }
}

// Honest skip: the jcode harness names the exact reason the runtime is absent,
// and that reason is asserted by identity rather than treated as a pass.
async function jcodeBinaryOrSkip(ctx: { skip(condition?: boolean, reason?: string): void }): Promise<string | null> {
  const harness = await startJcodeTestHub()
  const skipReason = harness.skipReason
  const binary = harness.binary
  await harness.close()
  if (skipReason !== null || binary === null) {
    expect(skipReason).toBe(JCODE_SKIP_NO_BINARY)
    ctx.skip(true, skipReason ?? JCODE_SKIP_NO_BINARY)
    return null
  }
  return binary
}

// A real session record, written by the real binary into an explicit home.
// The lifecycle tests read persisted state, so the seed has to be produced by
// the runtime itself; a hand-written JSON file would only test the test.
async function seedJcodeSession(binary: string, prompt: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-lifecycle-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  const env = { ...process.env, JCODE_HOME: home, JCODE_NO_TELEMETRY: '1' }
  await exec(binary, ['run', prompt, '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd], { env, timeout: 120_000 }).catch(() => undefined)
  const recordFile = path.join(home, 'sessions')
  const nativeId = fs.readdirSync(recordFile).find((name) => name.endsWith('.json'))!.replace(/\.json$/, '')
  const readRecord = () => JSON.parse(fs.readFileSync(path.join(recordFile, `${nativeId}.json`), 'utf8')) as { id: string; title?: string; custom_title?: string }
  // A rename through the product's own binary, the write the follower must notice.
  const rename = (title: string) => exec(binary, ['session', 'rename', nativeId, title, '--no-update', '--quiet', '-C', cwd], { env, timeout: 30_000 })
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return { root, home, cwd, env, nativeId, readRecord, rename, cleanup }
}

beforeAll(async () => {
  twin = await startTwin()
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  opened.close()
}, 180_000)

afterAll(async () => {
  await twin?.stop()
  global.gc?.()
  await removeDataDir(dataDir)
}, 180_000)

test('public ops lifecycle observes an external session without controlling it', async (ctx) => {
  const binary = await jcodeBinaryOrSkip(ctx)
  if (binary === null) return
  const seed = await seedJcodeSession(binary, 'External session')
  try {
    const identity = ['--host', 'pilot-host', '--endpoint', 'pilot-endpoint', '--native-session', seed.nativeId, '--tenant', twin.discord.guildId, '--surface', twin.channelId]
    const env: NodeJS.ProcessEnv = { ...process.env, KIMAKI_VITEST: '1', KIMAKI_TEST_LOGS: '1', KIMAKI_STRADA_ENABLED: '0', KIMAKI_DISCORD_REST_URL: twin.discord.restUrl }
    delete env.KIMAKI_BOT_TOKEN
    const cli = (args: string[]) => exec(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', ...args], { env, timeout: 180_000 })

    const discovered = JSON.parse((await cli(['discover', '--source', 'jcode', '--jcode-home', seed.home, '--host', 'pilot-host', '--endpoint', 'pilot-endpoint'])).stdout)
    expect(discovered.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ key: expect.objectContaining({ nativeSessionId: seed.nativeId }) })]))
    const bindArgs = ['bind', '--data-dir', dataDir, ...identity, '--backend', 'jcode', '--request', 'pilot-request']
    const binding = JSON.parse((await cli(bindArgs)).stdout)
    expect(binding).toMatchObject({ mode: 'observe', publication_policy: 'none', state: 'active' })
    expect(JSON.parse((await cli(bindArgs)).stdout)).toEqual(binding)

    const followArgs = ['follow', '--source', 'jcode', '--jcode-home', seed.home, ...identity, '--consent', '--timeout', '15000']
    await expect(cli(followArgs)).rejects.toMatchObject({ code: 1 })
    expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot('""')

    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', ...followArgs, '--token', twin.discord.botToken], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
    try {
      await expect.poll(() => stderr, { timeout: 180_000 }).toContain('Follow subscription ready')
      await seed.rename('Private renamed title')
      await expect.poll(async () => (await twin.discord.channel(twin.channelId).getMessages()).length, { timeout: 180_000 }).toBe(1)
      const result = await done
      expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        -# External Jcode session activity observed."
      `)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ sent: 1, denied: 0 })
      expect(await twin.discord.channel(twin.channelId).getMessages()).toHaveLength(1)
      const detached = JSON.parse((await cli(['detach', binding.id, '--data-dir', dataDir, '--tenant', twin.discord.guildId])).stdout)
      expect(detached).toMatchObject({ id: binding.id, state: 'detached' })
      // The native record still holds the rename the observer saw: the
      // lifecycle read it without ever controlling the runtime.
      expect(seed.readRecord()).toMatchObject({ id: seed.nativeId, custom_title: 'Private renamed title' })
    } finally {
      child.kill()
      await done
    }
  } finally {
    seed.cleanup()
  }
}, 300_000)

test('a restarted follow process republishes nothing it already delivered', async (ctx) => {
  const binary = await jcodeBinaryOrSkip(ctx)
  if (binary === null) return
  const seed = await seedJcodeSession(binary, 'Restart session')
  try {
    const identity = ['--source', 'jcode', '--jcode-home', seed.home, '--host', 'restart-host', '--endpoint', 'restart-endpoint', '--native-session', seed.nativeId, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--consent', '--timeout', '15000']
    const env: NodeJS.ProcessEnv = { ...process.env, KIMAKI_VITEST: '1', KIMAKI_TEST_LOGS: '1', KIMAKI_STRADA_ENABLED: '0', KIMAKI_DISCORD_REST_URL: twin.discord.restUrl, KIMAKI_BOT_TOKEN: twin.discord.botToken }
    const count = async () => (await twin.discord.channel(twin.channelId).getMessages()).length
    const before = await count()
    // A fresh channel surface for this test, so `before` measures this run only.
    const first = startFollow(identity, env)
    try {
      await expect.poll(() => first.stderr(), { timeout: 180_000 }).toContain('Follow subscription ready')
      await seed.rename('First rename')
      await expect.poll(count, { timeout: 60_000 }).toBe(before + 1)
      // Simulate a crash and restart while the same native session keeps living.
      first.child.kill()
      await first.done
      const second = startFollow(identity, env)
      try {
        await expect.poll(() => second.stderr(), { timeout: 180_000 }).toContain('Follow subscription ready')
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        expect(await count()).toBe(before + 1)
        await seed.rename('Second rename')
        await expect.poll(count, { timeout: 60_000 }).toBe(before + 2)
        const finished = await second.done
        expect(finished.code, finished.stderr).toBe(0)
        expect(JSON.parse(finished.stdout)).toMatchObject({ sent: 1, denied: 0 })
      } finally {
        second.child.kill()
        await second.done
      }
    } finally {
      first.child.kill()
    }
  } finally {
    seed.cleanup()
  }
}, 600_000)
