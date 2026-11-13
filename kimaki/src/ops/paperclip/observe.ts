// Read-only observation of one Paperclip run over an explicitly supplied instance
// base URL. This performs a single GET and returns only allowlisted metadata:
// status, timestamps, exit code, runtime mode and a cost summary. Prompts,
// transcripts, run logs, result payloads and credentials are never read out, and
// no request ever writes to the instance.
import { ConfigError } from '../../errors.js'

export type PaperclipRunObservation = {
  kind: 'paperclip-run'
  instance: string
  companyId: string
  agentId: string
  runId: string
  status: string
  exitCode: number | null
  startedAt: string | null
  finishedAt: string | null
  runtimeMode: string | null
  cost: { status: string | null; usd: number | null }
  coverage: 'run-metadata-only'
}

/** What this surface does, and deliberately does not, do. */
export const paperclipObservationCapabilities = Object.freeze({
  runMetadataRead: true,
  transcriptRead: false,
  logRead: false,
  dispatch: false,
  cancellation: false,
  approval: false,
} as const)

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null

export async function readPaperclipRun(input: {
  baseUrl: string
  runId: string
  expected?: { companyId?: string | undefined; agentId?: string | undefined } | undefined
  fetch?: typeof globalThis.fetch | undefined
  timeoutMs?: number | undefined
}): Promise<PaperclipRunObservation | Error> {
  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch (cause) {
    return new ConfigError({ reason: 'Supply --base-url as an absolute Paperclip instance URL', cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return new ConfigError({ reason: 'Supply --base-url with an http or https scheme' })
  }
  if (url.username || url.password) {
    return new ConfigError({ reason: 'Credentials in --base-url are not accepted' })
  }
  const runId = input.runId?.trim()
  if (!runId) return new ConfigError({ reason: 'Supply --run-id explicitly. This command never infers a run' })

  const instance = url.origin
  const target = new URL(`/api/heartbeat-runs/${encodeURIComponent(runId)}`, instance)
  const call = input.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000)
  let response: Response
  try {
    response = await call(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (cause) {
    return new ConfigError({ reason: `Cannot read the Paperclip instance at ${instance}`, cause })
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) {
    return new ConfigError({ reason: `Paperclip refused the run read with status ${response.status}` })
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return new ConfigError({ reason: 'Paperclip returned a body that is not JSON', cause })
  }
  if (!record(body)) return new ConfigError({ reason: 'Paperclip returned an unexpected run shape' })

  const companyId = text(body['companyId'])
  const agentId = text(body['agentId'])
  const status = text(body['status'])
  const returnedId = text(body['id'])
  if (!companyId || !agentId || !status || !returnedId) {
    return new ConfigError({ reason: 'Paperclip run is missing id, company, agent or status' })
  }
  // Fail closed: the record must be the run that was asked for, in the tenant that
  // was asked for. A different run never counts as an observation of this one.
  if (returnedId !== runId) {
    return new ConfigError({ reason: 'Paperclip returned a different run than the one requested' })
  }
  if (input.expected?.companyId !== undefined && input.expected.companyId !== companyId) {
    return new ConfigError({ reason: 'Paperclip run belongs to a different company than the expected scope' })
  }
  if (input.expected?.agentId !== undefined && input.expected.agentId !== agentId) {
    return new ConfigError({ reason: 'Paperclip run belongs to a different agent than the expected scope' })
  }

  const usage = record(body['usageJson']) ? body['usageJson'] : undefined
  return {
    kind: 'paperclip-run',
    instance,
    companyId,
    agentId,
    runId: returnedId,
    status,
    exitCode: integer(body['exitCode']),
    startedAt: text(body['startedAt']),
    finishedAt: text(body['finishedAt']),
    runtimeMode: text(body['runtimeMode']),
    cost: {
      status: usage ? text(usage['costStatus']) : null,
      usd: usage ? (typeof usage['costUsdExact'] === 'number' ? usage['costUsdExact'] : null) : null,
    },
    coverage: 'run-metadata-only',
  }
}
