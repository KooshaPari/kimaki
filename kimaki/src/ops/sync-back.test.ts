// AC22 durability: a pending worker sync-back record must outlive the process.
// These tests close the store and reopen a fresh instance on the same libSQL
// file, exactly as a restart would, and require the record to still be there.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openDb, type OpenedDb } from '../db.ts'
import { removeTempDirs } from '../test/cleanup.ts'
import {
  flushSyncBackLedger, listWorkerResultSyncBacks, openSyncBackLedger, recordWorkerResultSyncBack,
  reconcileSyncBack, type WorkerResultSyncBack,
} from './sync-back.ts'

const opened: OpenedDb[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  // libSQL's native statements can retain Windows file handles until finalization.
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  global.gc?.()
  await removeTempDirs(dirs)
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-syncback-'))
  dirs.push(dir)
  return dir
}

// A fresh client on an existing file: migrate only on the first open, so the
// reopen proves the rows came from disk and not from a schema-creation trick.
async function open(dataDir: string, migrate: boolean) {
  const result = await openDb({ dataDir, migrate })
  if (result instanceof Error) throw result
  opened.push(result)
  return result
}

const target = 'discord:guild-1:thread-1'
const result = { summary: 'refactor complete', files: ['a.ts', 'b.ts'], ok: true }

test('a pending-sync record survives close and reopen, then reconciles exactly once', async () => {
  const dataDir = tempDir()
  const first = await open(dataDir, true)
  const ledger = await openSyncBackLedger({ db: first.db })
  if (ledger instanceof Error) throw ledger
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-restart', target, payload: result, cause: new Error('Discord send failed: 503') })
  if (record instanceof Error) throw record
  expect(await flushSyncBackLedger({ ledger })).toBeUndefined()
  // One failed replay before the restart: the attempt count must persist too.
  const refused = await reconcileSyncBack({ ledger, recordId: record.id, deliver: () => { throw new Error('still 503') } })
  if (refused instanceof Error) throw refused
  expect(refused.record).toMatchObject({ state: 'pending-sync', attempts: 2 })
  first.close()

  // Restart: a brand-new client and a brand-new ledger over the same file.
  const second = await open(dataDir, false)
  const reopened = await openSyncBackLedger({ db: second.db })
  if (reopened instanceof Error) throw reopened
  const persisted = listWorkerResultSyncBacks({ ledger: reopened })
  expect(persisted).toMatchObject([
    {
      id: record.id,
      worker_id: 'worker-restart',
      target,
      payload: result,
      attempts: 2,
      last_error: 'still 503',
      state: 'pending-sync',
      ack_id: null,
      acknowledged_at: null,
    },
  ])
  expect(persisted[0]?.payload_digest).toBe(record.payload_digest)
  expect(persisted[0]?.created_at).toBe(record.created_at)

  const deliveries: string[] = []
  const deliver = (pending: WorkerResultSyncBack) => {
    deliveries.push(pending.id)
    return { ackId: 'ack-restart' }
  }
  const synced = await reconcileSyncBack({ ledger: reopened, recordId: record.id, deliver })
  if (synced instanceof Error) throw synced
  expect(synced).toMatchObject({ status: 'synced', delivered: true })
  expect(synced.record).toMatchObject({ state: 'synced', attempts: 3, ack_id: 'ack-restart' })
  // The same reconciliation again delivers nothing: the record settled once.
  const replay = await reconcileSyncBack({ ledger: reopened, recordId: record.id, deliver })
  if (replay instanceof Error) throw replay
  expect(replay).toMatchObject({ status: 'duplicate', delivered: false })
  expect(deliveries).toEqual([record.id])
  second.close()

  // A second restart sees the settled record and never re-delivers it.
  const third = await open(dataDir, false)
  const settled = await openSyncBackLedger({ db: third.db })
  if (settled instanceof Error) throw settled
  expect(listWorkerResultSyncBacks({ ledger: settled })).toMatchObject([
    { id: record.id, state: 'synced', attempts: 3, ack_id: 'ack-restart', last_error: null },
  ])
  let afterRestart = 0
  const replayAfterRestart = await reconcileSyncBack({
    ledger: settled, recordId: record.id, deliver: () => { afterRestart += 1; return { ackId: 'ack-again' } },
  })
  if (replayAfterRestart instanceof Error) throw replayAfterRestart
  expect(replayAfterRestart).toMatchObject({ status: 'duplicate', delivered: false })
  expect(afterRestart).toBe(0)
  third.close()
})

test('the per-worker identity rules survive a restart and record nothing twice', async () => {
  const dataDir = tempDir()
  const first = await open(dataDir, true)
  const ledger = await openSyncBackLedger({ db: first.db })
  if (ledger instanceof Error) throw ledger
  const record = recordWorkerResultSyncBack({ ledger, workerId: 'worker-kept', target, payload: result, cause: 'surface unreachable' })
  if (record instanceof Error) throw record
  expect(await flushSyncBackLedger({ ledger })).toBeUndefined()
  first.close()

  const second = await open(dataDir, false)
  const reopened = await openSyncBackLedger({ db: second.db })
  if (reopened instanceof Error) throw reopened
  // The same result seen again is the same record, not a second row.
  expect(recordWorkerResultSyncBack({ ledger: reopened, workerId: 'worker-kept', target, payload: result })).toMatchObject({ id: record.id, attempts: 1 })
  // A different payload for that worker is still refused by name.
  const conflict = recordWorkerResultSyncBack({ ledger: reopened, workerId: 'worker-kept', target, payload: { ...result, summary: 'different task' } })
  expect(conflict).toBeInstanceOf(Error)
  expect((conflict as Error).message).toMatch(/Refusing a different payload/)
  // The same payload aimed at another surface is still refused by name.
  const retarget = recordWorkerResultSyncBack({ ledger: reopened, workerId: 'worker-kept', target: 'discord:guild-2:thread-9', payload: result })
  expect(retarget).toBeInstanceOf(Error)
  expect((retarget as Error).message).toContain(target)
  // An unknown id is refused, so a restart cannot invent a record to deliver.
  expect(await reconcileSyncBack({ ledger: reopened, recordId: 'missing-record', deliver: () => ({ ackId: 'ack-x' }) })).toBeInstanceOf(Error)
  expect(await flushSyncBackLedger({ ledger: reopened })).toBeUndefined()
  expect(listWorkerResultSyncBacks({ ledger: reopened })).toHaveLength(1)
  second.close()

  // The refusals wrote nothing: the file still holds exactly the one record.
  const third = await open(dataDir, false)
  const settled = await openSyncBackLedger({ db: third.db })
  if (settled instanceof Error) throw settled
  expect(listWorkerResultSyncBacks({ ledger: settled })).toMatchObject([
    { id: record.id, worker_id: 'worker-kept', state: 'pending-sync', attempts: 1 },
  ])
  third.close()
})
