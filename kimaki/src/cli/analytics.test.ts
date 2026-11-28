// `kimaki ops analytics` prints the sink health and counters. Driven through
// createEventSink with a scripted transport, so the outage and recovery this
// checks are the sink's real state transitions, not a mock of the printer.
import { expect, test } from 'vitest'

import { createEventSink, type AnalyticsEvent, type CollectorTransport, type SourceFailure } from '../analytics.ts'
import { formatSinkStatus, printSinkStatus, sinkStatus, type SinkStatus } from './analytics.ts'

type Reply = 'ok' | 'down' | 'refuse'

function scripted(reply: Reply = 'ok'): { reply: Reply; passes: number; deliver: CollectorTransport['deliver'] } {
  const collector = {
    reply,
    passes: 0,
    deliver: async (events: readonly AnalyticsEvent[]) => {
      collector.passes += 1
      return events.map((): SourceFailure | undefined => {
        if (collector.reply === 'down') return { kind: 'network', message: 'connect ECONNREFUSED 127.0.0.1' }
        if (collector.reply === 'refuse') return { kind: 'status', status: 503, message: 'collector responded 503' }
        return undefined
      })
    },
  }
  return collector
}

function print(sink: Parameters<typeof sinkStatus>[0], json = false): { lines: string[]; status: SinkStatus } {
  const lines: string[] = []
  const status = printSinkStatus({ sink, json, write: (line) => lines.push(line) })
  return { lines, status }
}

function event(seq: number): AnalyticsEvent {
  return { name: 'turn_started', properties: { seq } }
}

// The counters line is the printed arithmetic, so the invariant is checked as
// the operator sees it, not only in the returned object.
function expectPrintedInvariant(status: SinkStatus): void {
  const line = formatSinkStatus(status).find((entry) => entry.includes('invariant:'))
  expect(line).toBeDefined()
  expect(line).toContain('holds')
  const { attempted, delivered, retained, dropped } = status.counters
  expect(line).toContain(`(${attempted} = ${delivered} + ${retained} + ${dropped})`)
  expect(attempted).toBe(delivered + retained + dropped)
}

test('status names a network failure, then non-2xx, and clears on recovery', async () => {
  const collector = scripted('down')
  const sink = createEventSink({ deliver: collector.deliver })

  await sink.emit(event(1))
  await sink.emit(event(2))
  const outage = print(sink)
  expect(outage.lines[0]).toBe('analytics sink: network-failure')
  expect(outage.lines).toContain('  error: connect ECONNREFUSED 127.0.0.1')
  expect(outage.lines).toContain('  failed sends: 2')
  expect(outage.lines).toContain('  counters: attempted 2, delivered 0, retained 2, dropped 0')
  expectPrintedInvariant(outage.status)
  expect(outage.status.httpStatus).toBeNull()

  collector.reply = 'ok'
  await sink.flush()
  const recovered = print(sink)
  expect(recovered.lines[0]).toBe('analytics sink: reachable')
  expect(recovered.lines.some((line) => line.includes('error:'))).toBe(false)
  expect(recovered.lines).toContain('  counters: attempted 2, delivered 2, retained 0, dropped 0')
  expectPrintedInvariant(recovered.status)
  expect(recovered.status.lastError).toBeNull()

  collector.reply = 'refuse'
  await sink.emit(event(3))
  const refused = print(sink)
  expect(refused.lines[0]).toBe('analytics sink: non-2xx (HTTP 503)')
  expect(refused.lines).toContain('  error: collector responded 503')
  expect(refused.lines).toContain('  counters: attempted 3, delivered 2, retained 1, dropped 0')
  expectPrintedInvariant(refused.status)
  expect(refused.status.httpStatus).toBe(503)

  collector.reply = 'ok'
  await sink.flush()
  const again = print(sink)
  expect(again.lines[0]).toBe('analytics sink: reachable')
  expect(again.lines).toContain('  counters: attempted 3, delivered 3, retained 0, dropped 0')
  expectPrintedInvariant(again.status)
})

test('--json prints every documented key and the same numbers as the human form', async () => {
  const collector = scripted('down')
  const sink = createEventSink({ deliver: collector.deliver, now: () => 42 })
  await sink.emit(event(1))

  const { lines, status } = print(sink, true)
  expect(lines).toHaveLength(1)
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
  for (const key of ['state', 'reachable', 'lastError', 'httpStatus', 'failedSends', 'firstFailureAt', 'lastSuccessAt', 'counters', 'balanced']) {
    expect(parsed).toHaveProperty(key)
  }
  expect(parsed['state']).toBe('network-failure')
  expect(parsed['counters']).toEqual({ attempted: 1, delivered: 0, retained: 1, dropped: 0 })
  expect(parsed['balanced']).toBe(true)
  expect(parsed['firstFailureAt']).toBe(42)
  // Same view the human form renders.
  expect(parsed).toEqual(JSON.parse(JSON.stringify(status)))
})

test('printing the status is read-only: no send, no counter or health change', async () => {
  const collector = scripted('down')
  const sink = createEventSink({ deliver: collector.deliver })
  await sink.emit(event(1))
  const passes = collector.passes
  const before = { health: sink.health(), counters: sink.counters(), peek: sink.peek() }

  print(sink)
  print(sink, true)

  expect(collector.passes).toBe(passes)
  expect(sink.health()).toEqual(before.health)
  expect(sink.counters()).toEqual(before.counters)
  expect(sink.peek()).toEqual(before.peek)
})
