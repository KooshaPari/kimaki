// AC16 (first half): the launch claim is genuinely cross-process.
//
// The race below is two independent `node` processes, not two callers in one
// event loop: each opens the same kimaki.db file, waits for a shared barrier and
// then claims the same (instanceId, runId). Exactly one must win; the loser is
// refused by name. That property comes from the UNIQUE index on the fence table,
// so dropping that index breaks this test (see the mutation note in
// ac16-fence-v2.md).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../../db.js'
import { removeTempDirs } from '../../test/cleanup.js'
import { openLaunchFenceStore, type FenceStore } from './launch-fence-store.js'
import { createDurableLaunchFence, type DurableLaunchFence } from './launch-fence-durable.js'

const packageRoot = path.resolve(import.meta.dirname, '../../..')
const workerPath = path.join(import.meta.dirname, 'claim-worker.ts')
const scope = { instanceId: 'pc-instance', runId: 'run-1' }
const leaseMs = 60_000
const start = '2026-11-14T00:00:00.000Z'

const dataDirs: string[] = []
const stores: FenceStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  // libSQL can retain Windows handles for a moment after close; the shared
  // helper retries instead of failing an otherwise passing test.
  await removeTempDirs(dataDirs)
})

async function freshDbPath(): Promise<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-fence-'))
  dataDirs.push(dataDir)
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  opened.close()
  return path.join(dataDir, 'kimaki.db')
}

function openFence(dbPath: string, now?: () => Date): DurableLaunchFence {
  const store = openLaunchFenceStore({ dbPath })
  if (store instanceof Error) throw store
  stores.push(store)
  const fence = createDurableLaunchFence({ store, leaseMs, now })
  if (fence instanceof Error) throw fence
  return fence
}

type ChildOutcome = {
  ok: boolean
  kind?: string
  generation?: number
  launcher?: string
  refused?: string
  message?: string
}

async function runChild(dbPath: string, launcher: string, goAt: number): Promise<{
  code: number | null
  outcome: ChildOutcome
  stdout: string
  stderr: string
}> {
  const args = ['--import', 'tsx', workerPath, dbPath, launcher, scope.instanceId, scope.runId, String(goAt)]
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  const line = result.stdout.trim().split('\n').filter((text) => text.trim() !== '').at(-1)
  if (line === undefined) {
    throw new Error(`claim worker printed nothing (exit ${result.code})\nstdout:${result.stdout}\nstderr:${result.stderr}`)
  }
  return { ...result, outcome: JSON.parse(line) as ChildOutcome }
}

describe('durable launch fence across real processes', () => {
  it('lets exactly one of two real processes claim the run; the loser is refused by name', async () => {
    const dbPath = await freshDbPath()
    // Both children wait for the same instant, so their read-then-insert windows
    // overlap on the same file instead of racing process startup.
    const goAt = Date.now() + 1_500
    const [first, second] = await Promise.all([
      runChild(dbPath, 'paperclip:worker-a', goAt),
      runChild(dbPath, 'paperclip:worker-b', goAt),
    ])

    for (const child of [first, second]) {
      if (child.code !== 0) {
        throw new Error(`claim worker exited ${child.code}\nstdout:${child.stdout}\nstderr:${child.stderr}`)
      }
    }

    const winners = [first.outcome, second.outcome].filter((outcome) => outcome.ok)
    const losers = [first.outcome, second.outcome].filter((outcome) => !outcome.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(winners[0]).toMatchObject({ kind: 'claimed', generation: 1 })
    expect(losers[0]).toMatchObject({ refused: 'ConfigError' })
    expect(losers[0]?.message).toContain('run run-1 on instance pc-instance')
    expect(losers[0]?.message).toContain('already claimed by')
    // The refusal names the process that actually won, whichever it was.
    expect(losers[0]?.message).toContain(String(winners[0]?.launcher))

    // One row survives the race, and its digest verifies.
    const store = openLaunchFenceStore({ dbPath })
    if (store instanceof Error) throw store
    stores.push(store)
    const rows = store.all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ launcher: winners[0]?.launcher, generation: 1, state: 'claimed' })

    const fence = openFence(dbPath)
    expect(fence.inspect(scope)).toMatchObject({ launcher: winners[0]?.launcher, generation: 1 })
  }, 30_000)
})

describe('durable launch fence: takeover and hub lease', () => {
  it('advances the generation on a stale takeover and refuses the previous holder write', async () => {
    const dbPath = await freshDbPath()
    let now = new Date(start)
    const clock = () => now
    // Two separate store handles = two independent connections to one file.
    const fenceA = openFence(dbPath, clock)
    const fenceB = openFence(dbPath, clock)

    const claimed = fenceA.claim({ scope, launcher: 'paperclip:worker-a' })
    if (claimed instanceof Error) throw claimed
    expect(claimed.record).toMatchObject({ launcher: 'paperclip:worker-a', generation: 1, claimSeq: 1 })

    now = new Date(Date.parse(start) + leaseMs + 1)
    const taken = fenceB.claim({ scope, launcher: 'paperclip:worker-b' })
    if (taken instanceof Error) throw taken
    expect(taken.kind).toBe('claimed')
    expect(taken.record).toMatchObject({ launcher: 'paperclip:worker-b', generation: 2, claimSeq: 2 })

    // The previous holder's write is fenced out, naming the new holder.
    const stale = fenceA.authorizeWrite({ scope, launcher: 'paperclip:worker-a', generation: 1 })
    expect(stale).toBeInstanceOf(Error)
    if (!(stale instanceof Error)) throw new Error('expected a refusal')
    expect(stale.message).toContain('is claimed by')
    expect(stale.message).toContain('paperclip:worker-b')
    expect(stale.message).toContain('generation 2')
    expect(stale.message).toMatch(/was superseded|cannot write/)

    expect(fenceB.authorizeWrite({ scope, launcher: 'paperclip:worker-b', generation: 2 })).toMatchObject({
      kind: 'authorized', record: { generation: 2 },
    })
    // The takeover is durable: a third, fresh connection sees generation 2.
    expect(openFence(dbPath).inspect(scope)).toMatchObject({ launcher: 'paperclip:worker-b', generation: 2 })
  })

  it('still refuses a Paperclip claim while a hub holder owns the run', async () => {
    const dbPath = await freshDbPath()
    const fence = openFence(dbPath)

    const refused = fence.claim({ scope, launcher: 'paperclip:worker-a', hubHolder: 'hub:pid-4242' })
    expect(refused).toBeInstanceOf(Error)
    if (!(refused instanceof Error)) throw new Error('expected a refusal')
    expect(refused.message).toContain('Hub launcher hub:pid-4242 already holds')
    expect(refused.message).toContain('run run-1 on instance pc-instance')
    expect(fence.inspect(scope)).toBeUndefined()

    // The hub may claim as itself, and then Paperclip cannot take it over.
    const hubClaim = fence.claim({ scope, launcher: 'hub:pid-4242' })
    if (hubClaim instanceof Error) throw hubClaim
    expect(hubClaim.record).toMatchObject({ launcher: 'hub:pid-4242', generation: 1 })
    const blocked = fence.claim({ scope, launcher: 'paperclip:worker-a', hubHolder: 'hub:pid-4242' })
    expect(blocked).toBeInstanceOf(Error)
    if (!(blocked instanceof Error)) throw new Error('expected a refusal')
    expect(blocked.message).toContain('already holds')
    expect(fence.inspect(scope)).toMatchObject({ launcher: 'hub:pid-4242' })
  })
})
