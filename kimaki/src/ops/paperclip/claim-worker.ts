// Child entrypoint for the cross-process launcher-fence proof.
//
// Two of these run as *independent OS processes* on the same database file:
//
//   node --import tsx src/ops/paperclip/claim-worker.ts \
//     <dbPath> <launcher> <instanceId> <runId> <goAtEpochMs> [leaseMs]
//
// The `goAtEpochMs` barrier is what makes the race real: every child waits for
// the same instant, so their read-then-insert windows overlap on the same file
// instead of racing the process spawn. Output is one JSON line on stdout:
//
//   { ok: true, kind: "claimed", generation: 1, launcher: "paperclip:worker-a" }
//   { ok: false, refused: "ConfigError", message: "run run-1 on instance ... is already claimed by ..." }
//
// Exit code is 0 for both outcomes; a null byte or a crash is the failure signal.
import { openLaunchFenceStore } from './launch-fence-store.js'
import { createDurableLaunchFence } from './launch-fence-durable.js'
import type { PaperclipLaunchClaim } from './launch-claim.js'

type ChildResult =
  | { ok: true; kind: 'claimed' | 'unchanged' | 'released' | 'authorized'; generation: number; launcher: string }
  | { ok: false; refused: string; message: string }

function emit(result: ChildResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function failed(reason: string): never {
  emit({ ok: false, refused: 'ArgumentError', message: reason })
  process.exit(2)
}

async function main(): Promise<void> {
  const [dbPath, launcher, instanceId, runId, goAtRaw, leaseRaw] = process.argv.slice(2)
  if (dbPath === undefined || launcher === undefined || instanceId === undefined ||
      runId === undefined || goAtRaw === undefined) {
    failed('usage: claim-worker.ts <dbPath> <launcher> <instanceId> <runId> <goAtEpochMs> [leaseMs]')
  }
  const goAt = Number(goAtRaw)
  if (!Number.isFinite(goAt)) failed(`goAtEpochMs must be a number, got ${goAtRaw}`)
  const leaseMs = leaseRaw === undefined ? undefined : Number(leaseRaw)
  if (leaseMs !== undefined && !Number.isSafeInteger(leaseMs)) failed(`leaseMs must be an integer, got ${leaseRaw}`)

  // Wait for the shared barrier in small sleeps so both children arrive together.
  while (Date.now() < goAt) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  const store = openLaunchFenceStore({ dbPath })
  if (store instanceof Error) {
    emit({ ok: false, refused: 'ConfigError', message: store.message })
    return
  }
  try {
    const fence = createDurableLaunchFence({ store, leaseMs })
    if (fence instanceof Error) {
      emit({ ok: false, refused: 'ConfigError', message: fence.message })
      return
    }
    const outcome = fence.claim({ scope: { instanceId, runId }, launcher })
    if (outcome instanceof Error) {
      emit({ ok: false, refused: outcome.name, message: outcome.message })
      return
    }
    const record: PaperclipLaunchClaim = outcome.record
    emit({ ok: true, kind: outcome.kind, generation: record.generation, launcher: record.launcher })
  } finally {
    store.close()
  }
}

main().catch((cause) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  emit({ ok: false, refused: 'Thrown', message })
  process.exitCode = 1
})
