// Read-only status of the analytics event sink: the current source health and
// the delivery counters, printed by `kimaki ops analytics`.
//
// The sink is supplied by the caller. Nothing here emits, flushes or builds a
// collector: health() and counters() return fresh snapshots, so asking for the
// status can never send an event or move a counter. That is also why the live
// numbers are only available inside the process that owns the sink: this
// module renders, it does not reach into another process.
import type { Goke } from 'goke'

import type { EventSink, SourceCounters, SourceHealth } from '../analytics.ts'
import { printJson } from './shared.ts'

// A network failure and a non-2xx answer are named distinctly: the collector is
// unreachable in the first case and up but refusing in the second. Both clear
// to 'reachable' once a pass succeeds.
export type SinkState = 'reachable' | 'network-failure' | 'non-2xx'

export type SinkStatus = {
  state: SinkState
  reachable: boolean
  lastError: string | null
  // HTTP status of a non-2xx answer; null for a network failure or recovery.
  httpStatus: number | null
  failedSends: number
  firstFailureAt: number | null
  lastSuccessAt: number | null
  counters: SourceCounters
  // attempted == delivered + retained + dropped, checked at read time.
  balanced: boolean
}

export type StatusSink = Pick<EventSink, 'health' | 'counters'>

function nameState(health: SourceHealth): SinkState {
  if (health.reachable) return 'reachable'
  return health.lastErrorKind === 'status' ? 'non-2xx' : 'network-failure'
}

// Pure and read-only: no send, no mutation, no collector.
export function sinkStatus(sink: StatusSink): SinkStatus {
  const health = sink.health()
  const counters = sink.counters()
  return {
    state: nameState(health),
    reachable: health.reachable,
    lastError: health.reachable ? null : health.lastError,
    httpStatus: health.reachable ? null : health.lastErrorStatus,
    failedSends: health.failedSends,
    firstFailureAt: health.firstFailureAt,
    lastSuccessAt: health.lastSuccessAt,
    counters,
    balanced: counters.attempted === counters.delivered + counters.retained + counters.dropped,
  }
}

function at(value: number | null, empty: string): string {
  return value === null ? empty : String(value)
}

export function formatSinkStatus(status: SinkStatus): string[] {
  const head =
    status.state === 'non-2xx'
      ? `analytics sink: non-2xx (HTTP ${status.httpStatus ?? 'unknown'})`
      : `analytics sink: ${status.state}`
  const { attempted, delivered, retained, dropped } = status.counters
  const lines = [head]
  if (!status.reachable) {
    lines.push(`  error: ${status.lastError ?? 'unknown'}`)
    lines.push(`  failed sends: ${status.failedSends}`)
  }
  lines.push(`  first failure at: ${at(status.firstFailureAt, 'none')}`)
  lines.push(`  last success at: ${at(status.lastSuccessAt, 'never')}`)
  lines.push(`  counters: attempted ${attempted}, delivered ${delivered}, retained ${retained}, dropped ${dropped}`)
  lines.push(
    `  invariant: attempted = delivered + retained + dropped ${status.balanced ? 'holds' : 'violated'} (${attempted} = ${delivered} + ${retained} + ${dropped})`,
  )
  return lines
}

export type WriteLine = (line: string) => void

// The one print path shared by the command and its tests.
export function printSinkStatus({
  sink,
  json,
  write = (line) => process.stdout.write(`${line}\n`),
}: {
  sink: StatusSink
  json?: boolean
  write?: WriteLine
}): SinkStatus {
  const status = sinkStatus(sink)
  if (json) {
    write(JSON.stringify(status, null, 2))
    return status
  }
  for (const line of formatSinkStatus(status)) write(line)
  return status
}

// `sink` is the emitting process's sink. The CLI has none of its own, so the
// shipped command says so instead of printing zeros that look like real
// counters or standing up a collector it would then have to trust.
export function registerAnalyticsCommands(cli: Goke, { sink }: { sink?: () => StatusSink | null } = {}): void {
  cli
    .command('ops analytics', 'Read-only analytics sink status: named source health and delivery counters')
    .option('--json', 'Print the status as JSON')
    .action(async (options: { json?: boolean }) => {
      const attached = sink?.() ?? null
      if (attached === null) {
        const message = 'no analytics sink attached in this process; health and counters belong to the emitting process'
        if (options.json) return printJson({ attached: false, message })
        process.stdout.write(`${message}\n`)
        return
      }
      printSinkStatus({ sink: attached, json: options.json })
    })
}
