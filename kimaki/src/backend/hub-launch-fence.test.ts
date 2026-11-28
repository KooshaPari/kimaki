// AC16 (second half): the SHIPPED managed launch takes the durable fence.
//
// These tests go through createSessionHub().start()/submit(), not the fence
// modules directly, so they prove the wiring rather than the store: a competing
// launcher is refused by name before the hub spawns a backend, and a launch that
// fails releases the claim so a retry can take it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../db.js'
import { removeTempDirs } from '../test/cleanup.js'
import { openLaunchFenceStore, type FenceStore } from '../ops/paperclip/launch-fence-store.js'
import { createDurableLaunchFence, type DurableLaunchFence } from '../ops/paperclip/launch-fence-durable.js'
import { createSessionHub, type HubBackend, type HubEvent } from './hub.js'

const scope = { instanceId: 'pc-instance', runId: 'run-1' }

const dataDirs: string[] = []
const stores: FenceStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  // libSQL can retain Windows handles briefly after close; the shared helper
  // retries instead of failing an otherwise passing test.
  await removeTempDirs(dataDirs)
})

async function freshDbPath(): Promise<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-fence-'))
  dataDirs.push(dataDir)
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  opened.close()
  return path.join(dataDir, 'kimaki.db')
}

// A separate store handle per hub, exactly like two independent processes.
function openFence(dbPath: string): DurableLaunchFence {
  const store = openLaunchFenceStore({ dbPath })
  if (store instanceof Error) throw store
  stores.push(store)
  const fence = createDurableLaunchFence({ store, leaseMs: 60_000 })
  if (fence instanceof Error) throw fence
  return fence
}

// Counts every spawn of the backend process; start() is the spawn.
function countingBackend(start: () => Promise<{ sessionId: string; model: string | null } | Error>) {
  const calls = { starts: 0 }
  const backend: HubBackend = {
    async start() {
      calls.starts += 1
      return start()
    },
    async prompt() {
      return { stopReason: 'end_turn', text: '', updateCount: 0 }
    },
    async cancel() {
      return undefined
    },
    async close() {},
  }
  return { backend, calls }
}

describe('hub managed launch takes the durable launch fence', () => {
  it('refuses a second launch for the same run by name before any process spawns', async () => {
    const dbPath = await freshDbPath()

    const first = countingBackend(async () => ({ sessionId: 'session-1', model: null }))
    const holder = createSessionHub({
      backend: first.backend,
      launchFence: { fence: openFence(dbPath), scope, launcher: 'hub:pid-a' },
    })
    if (holder instanceof Error) throw holder
    expect(await holder.start()).toMatchObject({ sessionId: 'session-1' })
    expect(first.calls.starts).toBe(1)

    const second = countingBackend(async () => ({ sessionId: 'session-2', model: null }))
    const rival = createSessionHub({
      backend: second.backend,
      launchFence: { fence: openFence(dbPath), scope, launcher: 'hub:pid-b' },
    })
    if (rival instanceof Error) throw rival
    const events: HubEvent[] = []
    rival.subscribe({ onEvent: (event) => events.push(event) })

    const refused = await rival.submit('hello')
    expect(refused).toBeInstanceOf(Error)
    const message = (refused as Error).message
    expect(message).toContain('run run-1 on instance pc-instance')
    expect(message).toContain('already claimed by')
    expect(message).toContain('hub:pid-a')

    // The refusal happened BEFORE the spawn and before any session.started event.
    expect(second.calls.starts).toBe(0)
    expect(events).toEqual([])

    await holder.close()
    await rival.close()
  })

  it('releases the fence when the backend launch fails so another launcher can claim', async () => {
    const dbPath = await freshDbPath()

    const failing = countingBackend(async () => new Error('backend died before acknowledging the session'))
    const hub = createSessionHub({
      backend: failing.backend,
      launchFence: { fence: openFence(dbPath), scope, launcher: 'hub:pid-a' },
    })
    if (hub instanceof Error) throw hub

    const failed = await hub.start()
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toBe('backend died before acknowledging the session')
    expect(failing.calls.starts).toBe(1)

    // The failed launch freed the run: a competing launcher now claims it.
    const retry = countingBackend(async () => ({ sessionId: 'session-2', model: null }))
    const other = createSessionHub({
      backend: retry.backend,
      launchFence: { fence: openFence(dbPath), scope, launcher: 'hub:pid-b' },
    })
    if (other instanceof Error) throw other
    expect(await other.start()).toMatchObject({ sessionId: 'session-2' })
    expect(retry.calls.starts).toBe(1)

    await hub.close()
    await other.close()
  })

  it('releases the fence when a launch acknowledges no session ID', async () => {
    const dbPath = await freshDbPath()

    const silent = countingBackend(async () => ({ sessionId: '   ', model: null }))
    const hub = createSessionHub({
      backend: silent.backend,
      launchFence: { fence: openFence(dbPath), scope, launcher: 'hub:pid-a' },
    })
    if (hub instanceof Error) throw hub

    const failed = await hub.start()
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toContain('no session ID')

    const retry = countingBackend(async () => ({ sessionId: 'session-2', model: null }))
    const other = createSessionHub({
      backend: retry.backend,
      launchFence: { fence: openFence(dbPath), scope, launcher: 'hub:pid-b' },
    })
    if (other instanceof Error) throw other
    expect(await other.start()).toMatchObject({ sessionId: 'session-2' })

    await hub.close()
    await other.close()
  })
})
