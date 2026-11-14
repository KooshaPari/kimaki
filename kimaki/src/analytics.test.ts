// foldAnalytics over recorded OpenCode event streams (spec 29.3): which
// product events one Kimaki thread produces, for the root and its subagents.

import type { V2Event } from '@opencode/client'
import { expect, test } from 'vitest'

import { foldAnalytics, type AnalyticsEvent, type UsageState } from './analytics.ts'
import { eventSessionId } from './thread-reducer.ts'
import { loadFixture, rootSessionId } from './test/replay.ts'

function foldFixture(file: string, { reasoning = 0 }: { reasoning?: number } = {}): AnalyticsEvent[] {
  // The recorded model reports no reasoning; add some to every step to check the total.
  const events = loadFixture(file).map((event): V2Event => {
    if (event.type === 'session.step.ended') return { ...event, data: { ...event.data, tokens: { ...event.data.tokens, reasoning } } }
    if (event.type === 'session.step.failed' && event.data.tokens) return { ...event, data: { ...event.data, tokens: { ...event.data.tokens, reasoning } } }
    return event
  })
  const root = rootSessionId(events)
  const result = events.reduce<{ state: UsageState; events: AnalyticsEvent[] }>(
    (acc, event) => {
      const folded = foldAnalytics({ state: acc.state, event, isRoot: eventSessionId(event) === root })
      return { state: folded.state, events: [...acc.events, ...folded.events] }
    },
    { state: {}, events: [] },
  )
  return result.events
}

test('a turn with a foreground subagent: tokens per execution, one completed turn', () => {
  expect(foldFixture('task-subagent.events.jsonl')).toMatchInlineSnapshot(`
    [
      {
        "name": "turn_started",
        "properties": {},
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 3,
          "cost": 0,
          "is_subagent": true,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 50176,
          "tokens_cache_write": 0,
          "tokens_input": 35597,
          "tokens_output": 92,
          "tokens_reasoning": 0,
          "tokens_total": 85865,
        },
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 3,
          "cost": 0,
          "is_subagent": false,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 72192,
          "tokens_cache_write": 0,
          "tokens_input": 3100,
          "tokens_output": 118,
          "tokens_reasoning": 0,
          "tokens_total": 75410,
        },
      },
      {
        "name": "turn_completed",
        "properties": {
          "duration_sec": 13,
        },
      },
    ]
  `)
})

test('an interrupted turn reports the tokens of its failed step but does not complete; reasoning is billed', () => {
  expect(foldFixture('abort.events.jsonl', { reasoning: 100 })).toMatchInlineSnapshot(`
    [
      {
        "name": "turn_started",
        "properties": {},
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 1,
          "cost": 0,
          "is_subagent": false,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 24064,
          "tokens_cache_write": 0,
          "tokens_input": 836,
          "tokens_output": 22,
          "tokens_reasoning": 100,
          "tokens_total": 25022,
        },
      },
      {
        "name": "turn_started",
        "properties": {},
      },
      {
        "name": "tokens_used",
        "properties": {
          "assistant_message_count": 1,
          "cost": 0,
          "is_subagent": false,
          "model": "gpt-6-luna",
          "provider": "openai",
          "tokens_cache_read": 24064,
          "tokens_cache_write": 0,
          "tokens_input": 897,
          "tokens_output": 8,
          "tokens_reasoning": 100,
          "tokens_total": 25069,
        },
      },
      {
        "name": "turn_completed",
        "properties": {
          "duration_sec": 1,
        },
      },
    ]
  `)
})

// --- usage across reattach and retry (AC28) ---
//
// Every event below carries the durable position (aggregateID:seq) of a real
// log entry. A reattach replays entries with the same positions, and a retry is
// a new step at a new position, which is exactly what the fold dedupes on.

const SESSION = 'ses_usage'

type StepTokens = { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }

function started({ sessionID = SESSION, seq, created = 0 }: { sessionID?: string; seq: number; created?: number }): V2Event {
  return {
    id: `evt_${sessionID}_${seq}`,
    created,
    type: 'session.execution.started',
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: { sessionID },
  }
}

function succeeded({ sessionID = SESSION, seq, created = 0 }: { sessionID?: string; seq: number; created?: number }): V2Event {
  return {
    id: `evt_${sessionID}_${seq}`,
    created,
    type: 'session.execution.succeeded',
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: { sessionID },
  }
}

function stepStarted({ sessionID = SESSION, seq, message }: { sessionID?: string; seq: number; message: string }): V2Event {
  return {
    id: `evt_${sessionID}_${seq}`,
    created: seq,
    type: 'session.step.started',
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: { sessionID, assistantMessageID: message, agent: 'build', model: { id: 'gpt-6-luna', providerID: 'openai' }, started: seq },
  }
}

function stepEnded({
  sessionID = SESSION,
  seq,
  message,
  tokens,
  cost = 0,
}: {
  sessionID?: string
  seq: number
  message: string
  tokens: StepTokens
  cost?: number
}): V2Event {
  return {
    id: `evt_${sessionID}_${seq}`,
    created: seq,
    type: 'session.step.ended',
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: {
      sessionID,
      assistantMessageID: message,
      finish: 'stop',
      cost,
      tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning ?? 0, cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 } },
    },
  }
}

function stepFailed({
  sessionID = SESSION,
  seq,
  message,
  tokens,
}: {
  sessionID?: string
  seq: number
  message: string
  tokens?: StepTokens
}): V2Event {
  return {
    id: `evt_${sessionID}_${seq}`,
    created: seq,
    type: 'session.step.failed',
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: {
      sessionID,
      assistantMessageID: message,
      error: { type: 'provider', message: 'upstream 500' },
      ...(tokens && {
        tokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning ?? 0, cache: { read: tokens.cacheRead ?? 0, write: tokens.cacheWrite ?? 0 } },
      }),
    },
  }
}

function retryScheduled({ sessionID = SESSION, seq, message, attempt }: { sessionID?: string; seq: number; message: string; attempt: number }): V2Event {
  return {
    id: `evt_${sessionID}_${seq}`,
    created: seq,
    type: 'session.retry.scheduled',
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: { sessionID, assistantMessageID: message, attempt, at: seq + 1000, error: { type: 'provider', message: 'upstream 500' } },
  }
}

// Folds a stream from a given state, the way the event loop feeds one thread.
function foldFrom(state: UsageState, events: V2Event[], isRoot: boolean = true): { state: UsageState; events: AnalyticsEvent[] } {
  return events.reduce<{ state: UsageState; events: AnalyticsEvent[] }>(
    (acc, event) => {
      const folded = foldAnalytics({ state: acc.state, event, isRoot })
      return { state: folded.state, events: [...acc.events, ...folded.events] }
    },
    { state, events: [] },
  )
}

// Independent evidence: what the emitted tokens_used events add up to.
function usageTotals(events: AnalyticsEvent[]) {
  const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, count: 0, cost: 0, rows: 0 }
  for (const event of events) {
    if (event.name !== 'tokens_used') continue
    total.input += Number(event.properties['tokens_input'])
    total.output += Number(event.properties['tokens_output'])
    total.reasoning += Number(event.properties['tokens_reasoning'])
    total.cacheRead += Number(event.properties['tokens_cache_read'])
    total.cacheWrite += Number(event.properties['tokens_cache_write'])
    total.total += Number(event.properties['tokens_total'])
    total.count += Number(event.properties['assistant_message_count'])
    total.cost += Number(event.properties['cost'])
    total.rows += 1
  }
  return total
}

test('AC28 (a) a reattach that replays a completed turn adds no usage', () => {
  const turn = [
    started({ seq: 1, created: 1_000 }),
    stepStarted({ seq: 2, message: 'msg_a' }),
    stepEnded({ seq: 3, message: 'msg_a', tokens: { input: 100, output: 10, cacheRead: 200 }, cost: 0.001 }),
    succeeded({ seq: 4, created: 4_000 }),
  ]
  const attached = foldFrom({}, turn)
  expect(attached.events.map((event) => event.name)).toEqual(['turn_started', 'tokens_used', 'turn_completed'])
  // Detached, then reattached: the durable log replays from the start.
  const reattached = foldFrom(attached.state, turn)
  expect(reattached.events).toEqual([])
  expect(Object.keys(reattached.state)).toEqual([SESSION])
  expect(reattached.state[SESSION]?.steps.size).toBe(1)
  expect(usageTotals([...attached.events, ...reattached.events])).toEqual({
    input: 100,
    output: 10,
    reasoning: 0,
    cacheRead: 200,
    cacheWrite: 0,
    total: 310,
    count: 1,
    cost: 0.001,
    rows: 1,
  })
})

test('AC28 (b) a retry that consumed tokens is counted exactly once', () => {
  const turn = [
    started({ seq: 1 }),
    stepStarted({ seq: 2, message: 'msg_a' }),
    // Attempt 1 died in the provider before billing: no tokens.
    stepFailed({ seq: 3, message: 'msg_a' }),
    retryScheduled({ seq: 4, message: 'msg_a', attempt: 1 }),
    // Attempt 2 is the one that consumed tokens.
    stepEnded({ seq: 5, message: 'msg_a', tokens: { input: 100, output: 10, cacheRead: 200 }, cost: 0.002 }),
    succeeded({ seq: 6, created: 6_000 }),
  ]
  const first = foldFrom({}, turn)
  expect(usageTotals(first.events)).toEqual({
    input: 100,
    output: 10,
    reasoning: 0,
    cacheRead: 200,
    cacheWrite: 0,
    total: 310,
    count: 1,
    cost: 0.002,
    rows: 1,
  })
  // The reattach replays the retried turn: the billed attempt is still one.
  const replay = foldFrom(first.state, turn)
  expect(replay.events).toEqual([])
  expect(usageTotals([...first.events, ...replay.events])).toEqual({
    input: 100,
    output: 10,
    reasoning: 0,
    cacheRead: 200,
    cacheWrite: 0,
    total: 310,
    count: 1,
    cost: 0.002,
    rows: 1,
  })
})

test('AC28 (c) attach, detach, reattach, continue: totals match independently computed usage', () => {
  const attach = [
    started({ seq: 1, created: 1_000 }),
    stepStarted({ seq: 2, message: 'msg_a' }),
    stepEnded({ seq: 3, message: 'msg_a', tokens: { input: 1_000, output: 100, cacheRead: 500 }, cost: 0.01 }),
    succeeded({ seq: 4, created: 10_000 }),
  ]
  const detached = foldFrom({}, attach)
  const reattached = foldFrom(detached.state, attach)
  const continued = foldFrom(reattached.state, [
    started({ seq: 5, created: 20_000 }),
    stepStarted({ seq: 6, message: 'msg_b' }),
    stepEnded({ seq: 7, message: 'msg_b', tokens: { input: 40, output: 4, cacheRead: 60 }, cost: 0.002 }),
    succeeded({ seq: 8, created: 20_500 }),
  ])
  expect([...detached.events, ...reattached.events, ...continued.events]).toEqual([
    { name: 'turn_started', properties: {} },
    {
      name: 'tokens_used',
      properties: {
        tokens_input: 1_000,
        tokens_output: 100,
        tokens_reasoning: 0,
        tokens_cache_read: 500,
        tokens_cache_write: 0,
        tokens_total: 1_600,
        cost: 0.01,
        assistant_message_count: 1,
        is_subagent: false,
        model: 'gpt-6-luna',
        provider: 'openai',
      },
    },
    { name: 'turn_completed', properties: { duration_sec: 9 } },
    { name: 'turn_started', properties: {} },
    {
      name: 'tokens_used',
      properties: {
        tokens_input: 40,
        tokens_output: 4,
        tokens_reasoning: 0,
        tokens_cache_read: 60,
        tokens_cache_write: 0,
        tokens_total: 104,
        cost: 0.002,
        assistant_message_count: 1,
        is_subagent: false,
        model: 'gpt-6-luna',
        provider: 'openai',
      },
    },
    { name: 'turn_completed', properties: { duration_sec: 1 } },
  ])
  expect(usageTotals([...detached.events, ...reattached.events, ...continued.events])).toEqual({
    input: 1_040,
    output: 104,
    reasoning: 0,
    cacheRead: 560,
    cacheWrite: 0,
    total: 1_704,
    count: 2,
    cost: 0.012,
    rows: 2,
  })
  expect(reattached.state[SESSION]?.reported.length).toBe(1)
  expect(continued.state[SESSION]?.reported.length).toBe(2)
})

test('AC28 (d) per-session rows stay separate across a reattach', () => {
  const root = 'ses_root_usage'
  const child = 'ses_child_usage'
  const childTurn = [
    started({ sessionID: child, seq: 1 }),
    stepStarted({ sessionID: child, seq: 2, message: 'msg_c1' }),
    stepEnded({ sessionID: child, seq: 3, message: 'msg_c1', tokens: { input: 20, output: 2 }, cost: 0.002 }),
    succeeded({ sessionID: child, seq: 4, created: 1_000 }),
  ]
  const opening = [
    started({ sessionID: root, seq: 1 }),
    started({ sessionID: child, seq: 1 }),
    stepStarted({ sessionID: root, seq: 2, message: 'msg_r1' }),
    stepStarted({ sessionID: child, seq: 2, message: 'msg_c1' }),
    stepEnded({ sessionID: root, seq: 3, message: 'msg_r1', tokens: { input: 10, output: 1 }, cost: 0.001 }),
    stepEnded({ sessionID: child, seq: 3, message: 'msg_c1', tokens: { input: 20, output: 2 }, cost: 0.002 }),
  ]
  const running = foldFrom({}, opening)
  expect(Object.keys(running.state).sort()).toEqual([child, root])
  expect(running.state[root]?.steps.size).toBe(1)
  expect(running.state[child]?.steps.size).toBe(1)
  const childDone = foldFrom(running.state, childTurn.slice(3))
  expect(childDone.events).toEqual([
    {
      name: 'tokens_used',
      properties: {
        tokens_input: 20,
        tokens_output: 2,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_total: 22,
        cost: 0.002,
        assistant_message_count: 1,
        is_subagent: false,
        model: 'gpt-6-luna',
        provider: 'openai',
      },
    },
    { name: 'turn_completed', properties: { duration_sec: 1 } },
  ])
  // The root row is neither merged with nor dropped by the child's completion.
  expect(Object.keys(childDone.state).sort()).toEqual([child, root])
  expect(childDone.state[root]?.active).toBe(true)
  expect(childDone.state[root]?.steps.size).toBe(1)
  // Replaying the child's history after a reattach stays silent and separate.
  const replay = foldFrom(childDone.state, childTurn)
  expect(replay.events).toEqual([])
  expect(Object.keys(replay.state).sort()).toEqual([child, root])
  expect(replay.state[root]?.steps.size).toBe(1)
  expect(replay.state[child]?.steps.size).toBe(1)
})
