import { spawn } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startOpencodeTestServer, startTwin, type OpencodeTestServer, type TestTwin } from './test/harness.js'

let server: OpencodeTestServer
let twin: TestTwin
beforeAll(async () => { [server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()]) }, 75_000)
afterAll(async () => { await Promise.all([server?.stop(), twin?.stop()]) }, 30_000)

test('follow publishes one fixed line only with consent', async () => {
  const native = await server.client()
  const created = await native.session.create({ location: { directory: server.projectDirectory }, title: 'External session' })
  const args = ['--service-file', server.serviceFile, '--host', 'host', '--endpoint', 'endpoint', '--native-session', created.id, '--tenant', twin.discord.guildId, '--surface', twin.channelId, '--timeout', '9000']
  const run = (extra: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'cli.ts'), 'ops', 'follow', ...args, ...extra], {
      env: { ...process.env, KIMAKI_TEST_LOGS: '1', KIMAKI_BOT_TOKEN: twin.discord.botToken, KIMAKI_DISCORD_REST_URL: twin.discord.restUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
    return { child, done, stderr: () => stderr }
  }
  const refused = await run([]).done
  expect(refused.code).not.toBe(0)
  await native.session.update({ sessionID: created.id, title: 'Without consent' })
  expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot('""')
  const follow = run(['--consent'])
  try {
    await expect.poll(() => follow.stderr(), { timeout: 20_000 }).toContain('Follow subscription ready')
    await native.session.update({ sessionID: created.id, title: 'Private rename @everyone' })
    await expect.poll(async () => (await twin.discord.channel(twin.channelId).getMessages()).length, { timeout: 8000 }).toBe(1)
    const result = await follow.done
    expect(await twin.discord.channel(twin.channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      -# External OpenCode session activity observed."
    `)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ sent: 1, denied: 0 })
    expect(await twin.discord.channel(twin.channelId).getMessages()).toHaveLength(1)
  } finally { follow.child.kill() }
}, 180_000)
