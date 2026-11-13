import { describe, expect, it } from 'vitest'
import { readPaperclipRun } from './observe.ts'

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  companyId: 'company-1',
  agentId: 'agent-1',
  status: 'succeeded',
  exitCode: 0,
  startedAt: '2026-11-13T09:07:57.039Z',
  finishedAt: '2026-11-13T09:08:09.627Z',
  runtimeMode: 'legacy',
  usageJson: { costStatus: 'unpriced', costUsdExact: null },
  // Present in the real payload, must never be returned.
  resultJson: { transcript: 'secret prompt text' },
  error: 'secret failure text',
  ...overrides,
})

const fake = (body: unknown, init: { status?: number } = {}) => {
  const calls: { url: string; method: string | undefined }[] = []
  const fetchImpl = (async (input: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(input), method: options?.method })
    const status = init.status ?? 200
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { fetchImpl, calls }
}

describe('readPaperclipRun', () => {
  it('returns allowlisted metadata only', async () => {
    const { fetchImpl, calls } = fake(run())
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', fetch: fetchImpl })
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) throw result
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3199/api/heartbeat-runs/run-1', method: 'GET' }])
    expect(result).toEqual({
      kind: 'paperclip-run',
      instance: 'http://127.0.0.1:3199',
      companyId: 'company-1',
      agentId: 'agent-1',
      runId: 'run-1',
      status: 'succeeded',
      exitCode: 0,
      startedAt: '2026-11-13T09:07:57.039Z',
      finishedAt: '2026-11-13T09:08:09.627Z',
      runtimeMode: 'legacy',
      cost: { status: 'unpriced', usd: null },
      coverage: 'run-metadata-only',
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('transcript')
  })

  it('refuses a run that is not the requested run', async () => {
    const { fetchImpl } = fake(run({ id: 'other-run' }))
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses a company outside the expected scope', async () => {
    const { fetchImpl } = fake(run({ companyId: 'company-2' }))
    const result = await readPaperclipRun({
      baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', expected: { companyId: 'company-1' }, fetch: fetchImpl,
    })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses an agent outside the expected scope', async () => {
    const { fetchImpl } = fake(run({ agentId: 'agent-2' }))
    const result = await readPaperclipRun({
      baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', expected: { agentId: 'agent-1' }, fetch: fetchImpl,
    })
    expect(result).toBeInstanceOf(Error)
  })

  it('accepts a matching expected scope', async () => {
    const { fetchImpl } = fake(run())
    const result = await readPaperclipRun({
      baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', expected: { companyId: 'company-1', agentId: 'agent-1' }, fetch: fetchImpl,
    })
    expect(result).not.toBeInstanceOf(Error)
  })

  it('refuses a non-2xx response', async () => {
    const { fetchImpl } = fake({ error: 'not found' }, { status: 404 })
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses a body that is not JSON', async () => {
    const { fetchImpl } = fake('not json')
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses a run missing required fields', async () => {
    const { fetchImpl } = fake({ id: 'run-1', status: 'succeeded' })
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses a base URL that is not http or https', async () => {
    const { fetchImpl } = fake(run())
    const result = await readPaperclipRun({ baseUrl: 'file:///tmp/paperclip', runId: 'run-1', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses credentials embedded in the base URL', async () => {
    const { fetchImpl } = fake(run())
    const result = await readPaperclipRun({ baseUrl: 'http://user:pass@127.0.0.1:3199', runId: 'run-1', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
  })

  it('refuses an empty run id instead of inferring one', async () => {
    const { fetchImpl, calls } = fake(run())
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: '   ', fetch: fetchImpl })
    expect(result).toBeInstanceOf(Error)
    expect(calls).toEqual([])
  })

  it('reports an unreachable instance', async () => {
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const result = await readPaperclipRun({ baseUrl: 'http://127.0.0.1:3199', runId: 'run-1', fetch: failing })
    expect(result).toBeInstanceOf(Error)
  })
})
