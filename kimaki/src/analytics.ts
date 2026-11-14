// Anonymous product analytics via Strada (docs/strada-product-analytics.md).
// Install-level only: no Discord IDs, paths, prompts or secrets. The install
// ID is a random UUID in <dataDir>/install-id, the same file V1 used, so an
// upgraded install keeps its identity.
//
//   bot_started         main.ts, once Discord and OpenCode are ready
//   project_registered  onboarding (default channel) and `project add`
//   session_created     sessions.ts startSession
//   turn_started        root session execution.started      ┐ foldAnalytics(),
//   turn_completed      root session execution.succeeded    │ fed by the event
//   tokens_used         every execution end, root and child ┘ loop
//
// tokens_used sums the durable session.step.ended usage of one execution. Each
// step is keyed by its durable log position (aggregateID:seq), so a reattach
// that replays history replaces the same entries instead of adding to them, and
// a retried attempt is counted once, for the attempt that billed it. A finished
// execution stays in state with the positions it already reported, so a replay
// of a completed turn emits nothing. session.usage.updated is cumulative and
// live-only, so a delta needs a baseline the bot does not have after a restart.
//
// Off with --no-analytics or KIMAKI_STRADA_ENABLED=0, and under vitest unless
// a test passes its own endpoint.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { flush, initStrada, track } from '@strada.sh/sdk'
import * as errore from 'errore'

import { ConfigError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { V2Event } from './opencode-server.ts'

const logger = createLogger('ANALYTICS')

// Public write-only ingest token of the production project `kimaki`.
const DEFAULT_PROJECT_ID = '01KYX3X6FEBBV5JV6Q8M97988C'
const DEFAULT_TOKEN = 'str_9eee60d24a444da78107f8780fe965c5f8cae422def44dcb9ee94d8035a5a14f'
const SCHEMA_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AnalyticsEventName =
  | 'bot_started'
  | 'project_registered'
  | 'session_created'
  | 'turn_started'
  | 'turn_completed'
  | 'tokens_used'

export type AnalyticsProps = Record<string, string | number | boolean>
export type AnalyticsEvent = { name: AnalyticsEventName; properties: AnalyticsProps }

// --- pure fold over OpenCode events of Kimaki sessions ---

// One billed step, keyed by the durable position of its terminal event.
type StepUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

type ExecutionUsage = {
  // Durable position of session.execution.started (null for an execution seen
  // only through its steps). Identical when a reattach replays the entry.
  executionId: string | null
  startedAt: number
  // false once the execution ended: later step events of it are history.
  active: boolean
  // Executions whose tokens_used was already reported, kept after they end so
  // a replayed turn stays silent.
  reported: readonly string[]
  steps: ReadonlyMap<string, StepUsage>
  model: string | null
  provider: string | null
}

export type UsageState = Readonly<Record<string, ExecutionUsage>>

// The durable position of an event. A replayed history entry keeps its
// aggregate and sequence, so this is what makes the fold idempotent.
function eventKey(event: Extract<V2Event, { durable: { aggregateID: string } }>): string {
  return `${event.durable.aggregateID}:${event.durable.seq}`
}

function totals(steps: ReadonlyMap<string, StepUsage>) {
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  for (const step of steps.values()) {
    input += step.input
    output += step.output
    reasoning += step.reasoning
    cacheRead += step.cacheRead
    cacheWrite += step.cacheWrite
    cost += step.cost
  }
  return { input, output, reasoning, cacheRead, cacheWrite, cost }
}

export function foldAnalytics({
  state,
  event,
  isRoot,
}: {
  state: UsageState
  event: V2Event
  // The thread's own session; false for subagent children.
  isRoot: boolean
}): { state: UsageState; events: AnalyticsEvent[] } {
  switch (event.type) {
    case 'session.execution.started': {
      const sessionID = event.data.sessionID
      const executionId = eventKey(event)
      const previous = state[sessionID]
      // A reattach replays this entry. Rebuild over what is already folded so
      // the accumulation survives, and do not announce the turn twice.
      if (previous && previous.executionId === executionId) {
        const usage: ExecutionUsage = { ...previous, active: true }
        return { state: { ...state, [sessionID]: usage }, events: [] }
      }
      const usage: ExecutionUsage = {
        executionId,
        startedAt: event.created,
        active: true,
        reported: previous?.reported ?? [],
        steps: new Map(),
        model: null,
        provider: null,
      }
      return { state: { ...state, [sessionID]: usage }, events: isRoot ? [{ name: 'turn_started', properties: {} }] : [] }
    }
    case 'session.step.started': {
      const current = state[event.data.sessionID]
      if (!current || !current.active) return { state, events: [] }
      const usage = { ...current, model: event.data.model.id, provider: event.data.model.providerID }
      return { state: { ...state, [event.data.sessionID]: usage }, events: [] }
    }
    // A failed step (abort, provider error) is billed too.
    case 'session.step.ended':
    case 'session.step.failed': {
      const sessionID = event.data.sessionID
      const current = state[sessionID]
      const { tokens, cost = 0 } = event.data
      if (!current || !current.active || !tokens) return { state, events: [] }
      // Same durable step replayed: overwrite it, do not add it again. A retry
      // is a new step at a new sequence, so it lands as its own entry.
      const steps = new Map(current.steps)
      steps.set(eventKey(event), {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        cost,
      })
      const usage: ExecutionUsage = {
        ...current,
        steps,
      }
      return { state: { ...state, [sessionID]: usage }, events: [] }
    }
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted': {
      const sessionID = event.data.sessionID
      const usage = state[sessionID]
      if (!usage) return { state, events: [] }
      const idle: ExecutionUsage = { ...usage, active: false }
      const next = { ...state, [sessionID]: idle }
      // Replay of a turn already reported: history, not new usage.
      if (usage.executionId !== null && usage.reported.includes(usage.executionId)) return { state: next, events: [] }
      // Not seen from the start (bot restarted mid-run), or no model step (compaction).
      if (!usage.active || usage.steps.size === 0) return { state: next, events: [] }
      const { input, output, reasoning, cacheRead, cacheWrite, cost } = totals(usage.steps)
      // OpenCode reports output without reasoning, but bills both.
      const total = input + output + reasoning + cacheRead + cacheWrite
      const tokensUsed: AnalyticsEvent = {
        name: 'tokens_used',
        properties: {
          tokens_input: input,
          tokens_output: output,
          tokens_reasoning: reasoning,
          tokens_cache_read: cacheRead,
          tokens_cache_write: cacheWrite,
          tokens_total: total,
          cost,
          assistant_message_count: usage.steps.size,
          is_subagent: !isRoot,
          ...(usage.model && { model: usage.model }),
          ...(usage.provider && { provider: usage.provider }),
        },
      }
      const completed: AnalyticsEvent[] =
        isRoot && event.type === 'session.execution.succeeded'
          ? [{ name: 'turn_completed', properties: { duration_sec: Math.round((event.created - usage.startedAt) / 1000) } }]
          : []
      // Zero-token executions are skipped, like V1.
      const reported = usage.executionId === null ? usage.reported : [...usage.reported, usage.executionId]
      return {
        state: { ...state, [sessionID]: { ...idle, reported } },
        events: [...(total > 0 || cost > 0 ? [tokensUsed] : []), ...completed],
      }
    }
    default:
      return { state, events: [] }
  }
}

// --- sink ---

export type Analytics = {
  // false: --no-analytics, KIMAKI_STRADA_ENABLED=0 or tests. `kimaki status` reports it.
  enabled: boolean
  track: (name: AnalyticsEventName, properties?: AnalyticsProps) => void
  // An OpenCode event of a Kimaki thread (event loop).
  observe: (event: V2Event, isRoot: boolean) => void
  flush: () => Promise<void>
}

export const disabledAnalytics: Analytics = {
  enabled: false,
  track: () => {},
  observe: () => {},
  flush: async () => {},
}

function readInstallId(dataDir: string): ConfigError | string {
  const file = path.join(dataDir, 'install-id')
  const existing = errore.try(
    () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''),
    (e) => new ConfigError({ reason: `Cannot read ${file}`, cause: e }),
  )
  if (existing instanceof Error) return existing
  if (UUID.test(existing)) return existing
  const id = crypto.randomUUID()
  const written = errore.try(
    () => fs.writeFileSync(file, `${id}\n`),
    (e) => new ConfigError({ reason: `Cannot write ${file}`, cause: e }),
  )
  if (written instanceof Error) return written
  return id
}

function kimakiVersion(): string {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  return pkg.version
}

export function createAnalytics({
  dataDir,
  botMode,
  enabled,
  endpoint,
}: {
  dataDir: string
  botMode: 'gateway' | 'self_hosted'
  // false: --no-analytics
  enabled: boolean
  // Tests: a local OTLP receiver.
  endpoint?: string
}): Analytics {
  const disabledByEnv = ['0', 'false'].includes(process.env['KIMAKI_STRADA_ENABLED'] ?? '')
  const underTest = process.env['KIMAKI_VITEST'] === '1' && !endpoint
  if (!enabled || disabledByEnv || underTest) return disabledAnalytics
  const installId = readInstallId(dataDir)
  if (installId instanceof Error) {
    logger.warn(`analytics off`, installId)
    return disabledAnalytics
  }
  const initialized = initStrada({
    projectId: process.env['KIMAKI_STRADA_PROJECT_ID'] || DEFAULT_PROJECT_ID,
    token: process.env['KIMAKI_STRADA_TOKEN'] || DEFAULT_TOKEN,
    service: 'kimaki-cli',
    environment: process.env['KIMAKI_STRADA_ENVIRONMENT'] || process.env['NODE_ENV'] || 'production',
    version: kimakiVersion(),
    userId: installId,
    enabled: true,
    // The bot handles its own crashes; the SDK must never exit the process.
    captureUncaughtErrors: false,
    ...(endpoint && { endpoint }),
  })
  if (initialized instanceof Error) {
    logger.warn(`analytics off`, initialized)
    return disabledAnalytics
  }
  const common = { install_id: installId, schema_version: SCHEMA_VERSION, bot_mode: botMode, platform: process.platform, arch: process.arch }
  const send = (name: AnalyticsEventName, properties: AnalyticsProps = {}) => {
    // Identity fields always win over caller props.
    const failed = track(name, { ...properties, ...common })
    if (failed instanceof Error) logger.warn(`track ${name}`, failed)
  }
  const usage: { state: UsageState } = { state: {} }
  return {
    enabled: true,
    track: send,
    observe: (event, isRoot) => {
      const folded = foldAnalytics({ state: usage.state, event, isRoot })
      usage.state = folded.state
      for (const tracked of folded.events) send(tracked.name, tracked.properties)
    },
    flush: async () => {
      const failed = await flush()
      if (failed instanceof Error) logger.warn(`flush`, failed)
    },
  }
}
