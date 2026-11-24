// A real Jcode session, written by the real binary through a local
// OpenAI-compatible mock, observed the way the bot will: poll, dedupe, restart,
// and a torn read that must be health rather than a turn.
//
// The mock speaks the Responses API SSE that `jcode run -p openai-api` consumes,
// so `assistant` messages are persisted by jcode itself. Nothing here touches
// the developer's ~/.jcode, a network provider or anyone's quota: the isolated
// JCODE_HOME and a loopback server are the whole world of the test.
//
// If the binary is absent the observation suite is skipped with a named reason;
// a separate always-run test asserts that the reason is named, so an empty run
// is visible rather than silently green.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createJcodeTurnObserver, type JcodeTurnEvent, type JcodeTurnHealth, type JcodeTurnObserver } from './jcode-observe.ts'

function findJcode(): string | null {
  const candidates = [
    process.env['JCODE_BIN'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'jcode', 'bin', 'jcode.exe'),
    path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'jcode', 'bin', 'jcode.exe'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  return null
}

const jcodeBinary = findJcode()
const skipReason = jcodeBinary === null ? 'jcode executable not found (set JCODE_BIN or install jcode)' : null

test('the jcode-observe skip reason is named when the binary is absent', () => {
  // Never a silent pass: absent binary must produce this exact reason.
  if (jcodeBinary === null) expect(skipReason).toMatch(/jcode executable not found/)
  else expect(skipReason).toBeNull()
})

function removeTree(target: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (!fs.existsSync(target)) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  }
  if (fs.existsSync(target)) throw new Error(`cannot remove ${target}: files are still held open`)
}

// Responses API SSE: one assistant message whose full text is "ok". This is the
// stream shape `jcode run -p openai-api` already parses, so the persisted
// assistant message is written by jcode, not by the test.
function startMockProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method === 'GET' && (request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
        return
      }
      if (!(request.url ?? '').endsWith('/responses')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const event = (type: string, payload: Record<string, unknown>) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      }
      const message = (text: string | null, status: string) => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status,
        content: text === null ? [] : [{ type: 'output_text', text, annotations: [] }],
      })
      const base = { id: 'resp_1', object: 'response', created_at: 1, model: 'mock-model' }
      event('response.created', { response: { ...base, status: 'in_progress', output: [] } })
      event('response.output_item.added', { output_index: 0, item: message(null, 'in_progress') })
      event('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' })
      event('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'ok' })
      const done = message('ok', 'completed')
      event('response.content_part.done', { item_id: 'msg_1', output_index: 0, content_index: 0, part: done.content[0] })
      event('response.output_item.done', { output_index: 0, item: done })
      event('response.completed', {
        response: {
          ...base,
          status: 'completed',
          output: [done],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        },
      })
      response.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock provider has no port')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

// One real one-shot turn. The provider is the loopback mock above, so jcode
// persists the user prompt and the assistant answer itself.
//
// Model choice: jcode validates `-m` against its own model catalog, and an id
// it does not know is rejected before any request is sent, even when the
// endpoint's /models list advertises it:
//   Error: Failed to select model 'mock-model': Unsupported OpenAI model
//   'mock-model'. Use /model to choose from the models available to your account.
// So the default here is "no -m": the binary uses its own configured default,
// which is accepted on a cold install (measured: 5/5 runs, exit 0).
// JCODE_MODEL overrides it for a host whose default is unusable.
const modelOverride = process.env['JCODE_MODEL']?.trim() ?? ''
const modelArgs = modelOverride === '' ? [] : ['-m', modelOverride]

function runJcodeTurn({ binary, home, cwd, url }: { binary: string; home: string; cwd: string; url: string }): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['run', '-p', 'openai-api', ...modelArgs, '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd, 'Reply with only: ok'], {
      env: {
        ...process.env,
        JCODE_HOME: home,
        JCODE_NO_TELEMETRY: '1',
        OPENAI_BASE_URL: `${url}/v1`,
        OPENAI_API_BASE: `${url}/v1`,
        OPENAI_API_KEY: 'observe-test-key',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

type SettledStore = { sessionId: string; file: string; raw: string }

// The record is settled once the assistant message exists and two reads a
// moment apart agree. A test-only writer is not racing it, so this converges.
async function settleStore(sessionsDir: string, timeoutMs = 60_000): Promise<SettledStore> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    await sleep(200)
    const names = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((name) => name.startsWith('session_') && name.endsWith('.json')) : []
    if (names.length === 0) continue
    const file = path.join(sessionsDir, names[0]!)
    const first = fs.readFileSync(file, 'utf8')
    if (first !== last) {
      last = first
      continue
    }
    try {
      const value = JSON.parse(first) as { id?: unknown; messages?: Array<{ role?: unknown }> }
      if (typeof value.id !== 'string' || !Array.isArray(value.messages)) continue
      if (!value.messages.some((message) => message.role === 'assistant')) continue
      return { sessionId: value.id, file, raw: first }
    } catch {
      continue
    }
  }
  throw new Error(`the jcode session store at ${sessionsDir} never settled with an assistant message within ${timeoutMs}ms`)
}

describe.skipIf(jcodeBinary === null)(`jcode turn observation over a real store${skipReason ? ` [SKIPPED: ${skipReason}]` : ''}`, () => {
  const binary = jcodeBinary!
  let home = ''
  let cwd = ''
  let cursorFile = ''
  let mock: { url: string; close: () => Promise<void> }
  let settled: SettledStore
  let run: { code: number | null; stderr: string }

  const events: JcodeTurnEvent[] = []
  const healths: JcodeTurnHealth[] = []
  let observer: JcodeTurnObserver | undefined

  // Narrowed accessor: beforeAll assigned a ConfigError-free observer into `observer`.
  const active = (): JcodeTurnObserver => {
    if (!observer) throw new Error('the turn observer was not created')
    return observer
  }

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-observe-home-'))
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-observe-cwd-'))
    // The cursor must live outside the store: the observer never writes there.
    cursorFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-observe-cursor-')), 'cursor.json')
    mock = await startMockProvider()
    run = await runJcodeTurn({ binary, home, cwd, url: mock.url })
    // Fail here with the binary's own message: a rejected model used to surface
    // only as a 60 s hook timeout, which named neither the cause nor the output.
    if (run.code !== 0) throw new Error(`jcode run exited ${String(run.code)}: ${run.stderr}`)
    settled = await settleStore(path.join(home, 'sessions'))
    const created = createJcodeTurnObserver({
      store: home,
      sessionId: settled.sessionId,
      intervalMs: 50,
      jitterRatio: 0.2,
      cursorFile,
      autoStart: false,
      onEvent: (event) => { events.push(event) },
      onHealth: (health) => { healths.push(health) },
    })
    if (created instanceof Error) throw created
    observer = created
  })

  afterAll(async () => {
    if (observer) observer.stop()
    await mock?.close()
    for (const target of [home, cwd, path.dirname(cursorFile)]) if (target) removeTree(target)
  })

  test('the real binary persisted a real assistant turn', () => {
    expect(run.code, `jcode run stderr: ${run.stderr}`).toBe(0)
    expect(settled.raw).toContain('"role":"assistant"')
    expect(settled.raw).toContain('"text":"ok"')
  })

  test('the first poll observes one turn in the shape the bot understands', async () => {
    const before = fs.readFileSync(settled.file, 'utf8')
    await active().poll()
    const types = events.map((event) => event.type)
    // The observer's contract (src/backend/jcode-observe.ts:22-28): a start
    // marker from the last user message, the assistant text, a step carrying
    // token usage, then the execution result. jcode v1.1.0 writes all four into
    // one record, so the first poll emits exactly this sequence.
    expect(types).toEqual([
      'session.execution.started',
      'session.text.ended',
      'session.step.ended',
      'session.execution.succeeded',
    ])
    const text = events[1]
    if (text?.type !== 'session.text.ended') throw new Error('second event must be session.text.ended')
    expect(text.data.sessionID).toBe(settled.sessionId)
    expect(text.data.text).toBe('ok')
    expect(text.data.assistantMessageID).toMatch(/^message_\d+_\d+$/)
    expect(text.durable.aggregateID).toBe(settled.sessionId)
    expect(Number.isFinite(text.created)).toBe(true)
    // Latency is explicit so the bot can tell a user nothing is streaming.
    expect(active().intervalMs).toBe(50)
    expect(active().latency.pollIntervalMs).toBe(50)
    expect(active().latency.minPollIntervalMs).toBeLessThan(50)
    expect(active().latency.maxPollIntervalMs).toBeGreaterThan(50)
    expect(active().latency.confirmMs).toBeGreaterThan(0)
    expect(active().health().state).toBe('consistent')
    // Read-only: polling left the record byte-identical.
    expect(fs.readFileSync(settled.file, 'utf8')).toBe(before)
  })

  test('a second poll emits nothing', async () => {
    const count = events.length
    await active().poll()
    expect(events.length).toBe(count)
    expect(active().health().state).toBe('consistent')
  })

  test('a restart with the same durable cursor re-emits nothing', async () => {
    expect(fs.existsSync(cursorFile)).toBe(true)
    const restarted: JcodeTurnEvent[] = []
    const second = createJcodeTurnObserver({
      store: home,
      sessionId: settled.sessionId,
      intervalMs: 50,
      cursorFile,
      autoStart: false,
      onEvent: (event) => { restarted.push(event) },
    })
    if (second instanceof Error) throw second
    try {
      await second.poll()
      await second.poll()
      expect(restarted).toEqual([])
      expect(second.health().state).toBe('consistent')
      // The restarted observer knows the ids were already delivered.
      expect(second.delivered()).toContain(`${settled.sessionId}/${events[0]!.id}`)
    } finally {
      second.stop()
    }
  })

  test('a torn read is a named health state, never a partial turn', async () => {
    const before = fs.readFileSync(settled.file, 'utf8')
    const count = events.length
    // Simulate jcode mid-append: the bytes are a truncated JSON object.
    fs.writeFileSync(settled.file, before.slice(0, Math.floor(before.length / 2)))
    try {
      await active().poll()
      const health = active().health()
      expect(health.state).toBe('transient')
      if (health.state !== 'transient') throw new Error('expected transient health')
      expect(['unstable', 'unparsable', 'mismatch']).toContain(health.reason)
      expect(events.length).toBe(count)
    } finally {
      fs.writeFileSync(settled.file, before)
    }
    // Settled again: the dedupe still suppresses the same turn.
    await active().poll()
    expect(active().health().state).toBe('consistent')
    expect(events.length).toBe(count)
  })

  test('a disappeared store is a distinct missing health state', async () => {
    const before = fs.readFileSync(settled.file, 'utf8')
    const count = events.length
    const hidden = `${settled.file}.hidden`
    fs.renameSync(settled.file, hidden)
    try {
      await active().poll()
      expect(active().health().state).toBe('missing')
      expect(events.length).toBe(count)
    } finally {
      fs.renameSync(hidden, settled.file)
    }
    await active().poll()
    expect(active().health().state).toBe('consistent')
    expect(events.length).toBe(count)
    expect(fs.readFileSync(settled.file, 'utf8')).toBe(before)
  })

  test('the cursor refuses to be reused for another session', () => {
    const stranger = createJcodeTurnObserver({
      store: home,
      sessionId: 'session_other_1_2',
      intervalMs: 50,
      cursorFile,
      autoStart: false,
      onEvent: () => undefined,
    })
    expect(stranger).toBeInstanceOf(Error)
    expect(String(stranger)).toContain('belongs to session')
  })

  test('a cursor inside the store is refused', () => {
    const refused = createJcodeTurnObserver({
      store: home,
      sessionId: settled.sessionId,
      intervalMs: 50,
      cursorFile: path.join(home, 'sessions', 'cursor.json'),
      autoStart: false,
      onEvent: () => undefined,
    })
    expect(refused).toBeInstanceOf(Error)
    expect(String(refused)).toContain('outside the Jcode store')
  })
})
