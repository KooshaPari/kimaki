// Collector outage and source health (AC40). Split from analytics.test.ts so
// each test file stays under the 500-line cap; that file keeps the fold tests.

import { expect, test } from 'vitest'

import { createEventSink, RETAIN_CAP, type AnalyticsEvent, type CollectorTransport, type EventSink, type SourceFailure } from './analytics.ts'

// A collector that answers from a script we control, and remembers every pass
// the sink presented, so re-delivery and ordering are observable.
type FakeCollector = {
  accepted: AnalyticsEvent[]
  passes: AnalyticsEvent[][]
  reply: 'ok' | 'down' | 'partial'
  status: number
  deliver: CollectorTransport['deliver']
}

function fakeCollector(): FakeCollector {
  const collector: FakeCollector = {
    accepted: [],
    passes: [],
    reply: 'ok',
    status: 503,
    deliver: async (events) => {
      collector.passes.push([...events])
      return events.map((analyticsEvent, index): SourceFailure | undefined => {
        if (collector.reply === 'down') return { kind: 'network', message: 'connect ECONNREFUSED 127.0.0.1' }
        // 'partial': takes the first two events of a pass and refuses the rest,
        // like a batch rejected after accepting a prefix.
        if (collector.reply === 'partial' && index >= 2) {
          return { kind: 'status', status: collector.status, message: `collector responded ${collector.status}` }
        }
        collector.accepted.push(analyticsEvent)
        return undefined
      })
    },
  }
  return collector
}

function event(seq: number): AnalyticsEvent {
  return { name: 'turn_started', properties: { seq } }
}

function seqs(events: readonly AnalyticsEvent[]): unknown[] {
  return events.map((analyticsEvent) => analyticsEvent.properties['seq'])
}

// Each event the sink accepted is in exactly one of these three piles.
function expectInvariant(sink: EventSink): void {
  const { attempted, delivered, retained, dropped } = sink.counters()
  expect(retained).toBe(sink.peek().length)
  expect(attempted).toBe(delivered + retained + dropped)
}

test('AC40 (a) a collector outage retains events in order and records source health', async () => {
  const collector = fakeCollector()
  collector.reply = 'down'
  let clock = 100
  const sink = createEventSink({ deliver: collector.deliver, now: () => clock })
  for (const seq of [1, 2, 3]) {
    clock += 1
    await sink.emit(event(seq))
    expectInvariant(sink)
  }
  // Nothing was accepted, nothing was lost, order is intact.
  expect(collector.accepted).toEqual([])
  expect(seqs(sink.peek())).toEqual([1, 2, 3])
  expect(sink.counters()).toEqual({ attempted: 3, delivered: 0, retained: 3, dropped: 0 })
  expect(sink.health()).toEqual({
    reachable: false,
    lastError: 'connect ECONNREFUSED 127.0.0.1',
    lastErrorKind: 'network',
    lastErrorStatus: null,
    // One failed delivery pass per emit; the outage began at the first one.
    failedSends: 3,
    firstFailureAt: 101,
    lastSuccessAt: null,
  })
})

test('AC40 (b) on recovery the retained events flush in order exactly once', async () => {
  const collector = fakeCollector()
  collector.reply = 'down'
  let clock = 0
  const sink = createEventSink({ deliver: collector.deliver, now: () => (clock += 1) })
  for (const seq of [1, 2, 3]) await sink.emit(event(seq))
  expect(sink.counters().retained).toBe(3)
  expect(sink.health().reachable).toBe(false)
  collector.reply = 'ok'
  collector.passes.length = 0
  await sink.flush()
  expect(collector.passes).toHaveLength(1)
  expect(seqs(collector.passes[0] ?? [])).toEqual([1, 2, 3])
  expect(seqs(collector.accepted)).toEqual([1, 2, 3])
  expect(sink.counters()).toEqual({ attempted: 3, delivered: 3, retained: 0, dropped: 0 })
  expect(sink.health()).toMatchObject({ reachable: true, lastError: null, lastErrorKind: null, lastErrorStatus: null, firstFailureAt: null })
  expect(sink.health().lastSuccessAt).not.toBeNull()
  expectInvariant(sink)
  // Nothing left to send: a second flush must not deliver anything again.
  await sink.flush()
  expect(collector.passes).toHaveLength(1)
  expect(seqs(collector.accepted)).toEqual([1, 2, 3])
  expectInvariant(sink)
})

test('AC40 (c) the retention cap drops the oldest events and counts them', async () => {
  const collector = fakeCollector()
  collector.reply = 'down'
  const sink = createEventSink({ deliver: collector.deliver, cap: 3 })
  for (const seq of [1, 2, 3, 4, 5]) {
    await sink.emit(event(seq))
    expectInvariant(sink)
  }
  expect(seqs(sink.peek())).toEqual([3, 4, 5])
  expect(sink.counters()).toEqual({ attempted: 5, delivered: 0, retained: 3, dropped: 2 })
  expect(RETAIN_CAP).toBe(256)
})

test('AC40 (d) a non-2xx answer is a status failure, distinct from a network error', async () => {
  const failure: SourceFailure = { kind: 'status', status: 500, message: 'Strada ingest /v1/batch responded 500' }
  const sink = createEventSink({ deliver: async () => [failure] })
  await sink.emit(event(1))
  const health = sink.health()
  expect(health).toMatchObject({
    reachable: false,
    lastError: 'Strada ingest /v1/batch responded 500',
    lastErrorKind: 'status',
    lastErrorStatus: 500,
    failedSends: 1,
    lastSuccessAt: null,
  })
  expect(health.firstFailureAt).toBeTypeOf('number')
  expect(health.lastErrorKind).not.toBe('network')
  expect(sink.counters()).toEqual({ attempted: 1, delivered: 0, retained: 1, dropped: 0 })
  expectInvariant(sink)
})

test('AC40 (e) a partial success does not re-deliver the accepted events', async () => {
  const collector = fakeCollector()
  collector.reply = 'down'
  const sink = createEventSink({ deliver: collector.deliver })
  for (const seq of [1, 2, 3]) await sink.emit(event(seq))
  expectInvariant(sink)
  collector.accepted.length = 0
  collector.passes.length = 0
  collector.reply = 'partial'
  await sink.flush()
  expect(seqs(collector.passes[0] ?? [])).toEqual([1, 2, 3])
  expect(seqs(collector.accepted)).toEqual([1, 2])
  expect(sink.counters()).toEqual({ attempted: 3, delivered: 2, retained: 1, dropped: 0 })
  expect(seqs(sink.peek())).toEqual([3])
  expect(sink.health()).toMatchObject({ reachable: false, lastErrorKind: 'status', lastErrorStatus: 503 })
  expectInvariant(sink)
  // Recovery sends only the event that failed, never 1 and 2 again.
  collector.reply = 'ok'
  collector.passes.length = 0
  await sink.flush()
  expect(seqs(collector.passes[0] ?? [])).toEqual([3])
  expect(seqs(collector.accepted)).toEqual([1, 2, 3])
  expect(sink.counters()).toEqual({ attempted: 3, delivered: 3, retained: 0, dropped: 0 })
  expect(sink.health().reachable).toBe(true)
  expectInvariant(sink)
})
