// AC34 live proof: the cutover is observed on a running surface, not only in the
// bindings store.
//
// Two real `kimaki ops discord view` processes are spawned against one real
// loopback hub and one Discord channel (the digital twin's REST surface). Each
// view claims the surface through the binding row its own identity names, and
// asks the same writeSurface fence a cutover moves before it posts. So:
// - a consumer with no binding is refused by name while the owner posts;
// - a consumer whose binding is still staged is idle through the pause;
// - the owner's binding is paused and then retired, which stops it by name;
// - the promoted consumer posts the next turn exactly once.
// No second lock exists: the generation and state of the binding row are the
// claim.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createSessionHub, type HubBackend, type SessionHub } from './backend/hub.ts'
import { startHubServer } from './backend/hub-server.ts'
import { openDb, type OpenedDb } from './db.ts'
import { bindSurface } from './ops/bindings.ts'
import { beginCutover, completeCutover, type SurfaceConsumer } from './ops/cutover.ts'
import { removeDataDir } from './test/cleanup.ts'
import { startTwin, tempDataDir, type TestTwin } from './test/harness.ts'

const dataDir = tempDataDir()
const cli = path.join(import.meta.dirname, 'cli.ts')
const stateDir = path.join(dataDir, 'view-state')
let twin: TestTwin
let hub: SessionHub
let server: { url: string; close: () => Promise<void> }
let opened: OpenedDb
const children: ChildProcess[] = []

const owner: SurfaceConsumer = { hostId: 'host-a', endpointId: 'view-a', backendKind: 'discord-view', nativeSessionId: 'session-a' }
const standby: SurfaceConsumer = { hostId: 'host-b', endpointId: 'view-b', backendKind: 'discord-view', nativeSessionId: 'session-b' }

type ViewProcess = {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  done: Promise<{ code: number | null; stdout: string; stderr: string }>
}

// The hub answers every prompt with `answer:<prompt>`, so a post identifies the
// turn that produced it and a duplicate would be visible.
function echoBackend(): HubBackend {
  return {
    async start() { return { sessionId: 'cutover-session', model: null } },
    async prompt(prompt, onChunk) {
      const text = `answer:${prompt}`
      onChunk?.(text)
      return { stopReason: 'end_turn', text, updateCount: 1 }
    },
    async cancel() { return undefined },
    async close() {},
  }
}

// A shipped CLI process, not an in-process call: two consumers are two OS
// processes contending for one SQLite-backed claim and one REST surface.
function startView({ client, state, consumer }: { client: string; state: string; consumer: SurfaceConsumer }): ViewProcess {
  const child = spawn(process.execPath, [
    '--import', 'tsx', cli, 'ops', 'discord', 'view',
    '--url', server.url,
    '--tenant', twin.discord.guildId,
    '--surface', twin.channelId,
    '--token', twin.discord.botToken,
    '--state', state,
    '--client', client,
    '--host', consumer.hostId,
    '--endpoint', consumer.endpointId,
    '--backend', consumer.backendKind,
    '--native-session', consumer.nativeSessionId,
    '--data-dir', dataDir,
    '--timeout', '180000',
  ], {
    env: { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0', KIMAKI_DISCORD_REST_URL: twin.discord.restUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let out = ''
  let err = ''
  child.stdout?.on('data', (chunk) => { out += chunk })
  child.stderr?.on('data', (chunk) => { err += chunk })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout: out, stderr: err }))
  })
  return { child, stdout: () => out, stderr: () => err, done }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const posts = (view: ViewProcess) => view.stdout().split('"kind": "posted"').length - 1

beforeAll(async () => {
  fs.mkdirSync(stateDir, { recursive: true })
  twin = await startTwin()
  const created = createSessionHub({ backend: echoBackend() })
  if (created instanceof Error) throw created
  hub = created
  const started = await startHubServer({ hub, port: 0 })
  if (started instanceof Error) throw started
  server = started
  const db = await openDb({ dataDir, migrate: true })
  if (db instanceof Error) throw db
  opened = db
}, 180_000)

afterAll(async () => {
  for (const child of children) child.kill()
  await sleep(500)
  opened?.close()
  await server?.close()
  await hub?.close()
  await twin?.stop()
  global.gc?.()
  await removeDataDir(dataDir)
}, 180_000)

test('a cutover hands one live Discord surface from one running view to another', async () => {
  const count = async () => (await twin.discord.channel(twin.channelId).getMessages()).length
  const text = async () => twin.discord.channel(twin.channelId).text()
  // The hub is busy while a turn runs; a new submit would be refused, not queued.
  const turn = async (prompt: string) => {
    await expect.poll(() => hub.snapshot().busy, { timeout: 60_000 }).toBe(false)
    expect(await hub.submit(prompt)).not.toBeInstanceOf(Error)
  }

  // The owner's binding is what makes this process a consumer of the surface.
  const source = await bindSurface({ db: opened.db, session: owner, serviceKind: 'discord', tenantId: twin.discord.guildId, surfaceId: twin.channelId, idempotencyKey: 'bind-owner' })
  if (source instanceof Error) throw source

  const first = startView({ client: 'consumer-owner', state: path.join(stateDir, 'owner.json'), consumer: owner })
  await expect.poll(() => first.stdout(), { timeout: 180_000 }).toContain('"claimed": true')
  await expect.poll(() => hub.snapshot().subscribers, { timeout: 180_000 }).toBe(1)

  await turn('turn-one')
  await expect.poll(count, { timeout: 180_000 }).toBe(1)
  expect(await text()).toContain('answer:turn-one')
  // The post lands before the cursor write and the callback, so the view's own
  // "posted" line is awaited rather than read in the same instant as the REST write.
  await expect.poll(() => posts(first), { timeout: 60_000 }).toBe(1)

  // A second real consumer that no binding names cannot claim the surface while
  // the first owns it. It stops by name instead of posting over the owner.
  const unbound = startView({ client: 'consumer-unbound', state: path.join(stateDir, 'unbound.json'), consumer: standby })
  const refused = await unbound.done
  expect(refused.code, refused.stderr).toBe(1)
  expect(refused.stderr).toContain('holds no binding on surface discord')
  expect(refused.stderr).toContain(`discord:${twin.discord.guildId}:${twin.channelId}`)
  expect(posts(unbound)).toBe(0)
  expect(await count()).toBe(1)

  // The cutover moves the surface: the owner's row is paused, the standby's row
  // is staged at the next generation. Nothing is rerouted by the metadata move
  // itself; the two live consumers are what makes the pause observable.
  const begun = await beginCutover({ db: opened.db, sourceId: source.id, target: standby, idempotencyKey: 'cutover-live' })
  if (begun instanceof Error) throw begun
  expect(begun).toMatchObject({ phase: 'in-progress', source_state: 'paused', target_state: 'staged', generation: 2 })

  // The standby joins the live stream at the cursor the operator observed, so a
  // replay of the owner's first turn cannot be posted twice after the handover.
  const live = hub.snapshot()
  fs.writeFileSync(path.join(stateDir, 'standby.json'), JSON.stringify({ sessionId: live.sessionId, seq: live.seq }))
  const second = startView({ client: 'consumer-standby', state: path.join(stateDir, 'standby.json'), consumer: standby })
  await expect.poll(() => hub.snapshot().subscribers, { timeout: 180_000 }).toBe(2)
  // The second consumer is idle through the pause: its staged binding cannot
  // write, and the refusal is the writeSurface one, naming the surface.
  await expect.poll(() => second.stdout(), { timeout: 180_000 }).toContain('is staged')
  await expect.poll(() => second.stdout(), { timeout: 180_000 }).toContain('"retryable": true')

  // A whole turn during the pause is posted by nobody: the source's generation
  // is already superseded by the staged target.
  await turn('turn-two')
  await expect.poll(() => first.stdout(), { timeout: 180_000 }).toContain('superseded by generation 2')
  // The refusal is a live-process refusal, but a wrong post would land a moment
  // later over REST, so the pause gets the same settle window as the handover.
  await sleep(1_000)
  expect(await count()).toBe(1)
  expect(posts(first)).toBe(1)
  expect(posts(second)).toBe(0)

  const done = await completeCutover({ db: opened.db, sourceId: source.id })
  if (done instanceof Error) throw done
  expect(done).toMatchObject({ phase: 'complete', source_state: 'retired', target_state: 'active', generation: 2 })

  // The promoted consumer posts the next turn exactly once, and the retired
  // consumer stops by the same named fence instead of writing through it.
  await turn('turn-three')
  await expect.poll(count, { timeout: 180_000 }).toBe(2)
  const messages = await twin.discord.channel(twin.channelId).getMessages()
  expect(messages.map((message) => message.content)).toEqual(['answer:turn-one', 'answer:turn-three'])
  await expect.poll(() => posts(second), { timeout: 60_000 }).toBe(1)

  const stopped = await first.done
  expect(stopped.code, stopped.stderr).toBe(1)
  expect(stopped.stderr).toContain('superseded by generation 2')
  expect(posts(first)).toBe(1)

  // No duplicate across the handover: exactly one post per turn, and the losing
  // consumer left the hub instead of staying attached and racing the winner.
  await sleep(2_000)
  expect(await count()).toBe(2)
  await expect.poll(() => hub.snapshot().subscribers, { timeout: 60_000 }).toBe(1)
}, 300_000)
