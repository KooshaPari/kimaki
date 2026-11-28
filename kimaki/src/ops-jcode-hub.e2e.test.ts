// Opt-in acceptance: two independent clients watch one live Jcode session.
//
// `ops jcode serve` owns a single ACP session and exposes the event stream over
// loopback. This proves the fan-out claim with a real turn: both clients receive
// the same ordered sequence and the same assistant text, and only one of them
// submits the prompt. Nothing here is mocked, so the suite stays dormant unless
// KIMAKI_JCODE_HUB_E2E=1.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { removeTempDirs } from './test/cleanup.ts'

const ENABLED = process.env['KIMAKI_JCODE_HUB_E2E'] === '1'
const PROMPT = 'Reply with the single word ok and nothing else. Do not use tools.'
const MODEL = 'beam-free'
const CLI = path.join(import.meta.dirname, 'cli.ts')
const PACKAGE_ROOT = import.meta.dirname

type HubEvent = { seq: number; type: string; text?: string }

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGKILL')
}

async function waitForUrl(child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error('serve never announced a URL')), 60_000)
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      buffered += chunk
      // printJson pretty-prints, so wait for a complete document.
      const end = buffered.lastIndexOf('}')
      if (end < 0) return
      try {
        const parsed = JSON.parse(buffered.slice(0, end + 1)) as { url?: unknown }
        if (typeof parsed.url !== 'string') return
        clearTimeout(timer)
        resolve(parsed.url)
      } catch {
        // Incomplete document, keep buffering.
      }
    })
  })
}

// Reads the SSE stream until a terminal event arrives, reporting the ready frame.
async function collect(url: string, client: string, timeoutMs = 180_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(`${url}/events?cursor=0`, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: HubEvent[] = []
  let ready: { cursor: number; clipped: boolean } | undefined
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const line = frame.split('\n').find((part) => part.startsWith('data: '))
        if (!line) continue
        const payload = JSON.parse(line.slice('data: '.length)) as HubEvent | { cursor: number; clipped: boolean }
        if ('type' in payload) {
          events.push(payload as HubEvent)
          if (payload.type === 'prompt.finished' || payload.type === 'prompt.failed') {
            return { client, ready, events }
          }
        } else {
          ready ??= payload as { cursor: number; clipped: boolean }
        }
      }
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return { client, ready, events }
}

test.skipIf(!ENABLED)('fans one real jcode turn out to two clients', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-jcode-hub-'))
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CLI, 'ops', 'jcode', 'serve', '--cwd', cwd, '--model', MODEL, '--timeout', '180000'],
    { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    const url = await waitForUrl(child)
    const streams = [collect(url, 'first'), collect(url, 'second')]
    // Give both subscribers a moment to register before the turn starts.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const posted = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: PROMPT }),
    })
    expect(posted.status, `prompt refused: ${stderr}`).toBe(202)
    expect(await posted.json()).toEqual({ accepted: true, characters: PROMPT.length })

    const [first, second] = (await Promise.all(streams)) as [Awaited<ReturnType<typeof collect>>, Awaited<ReturnType<typeof collect>>]
    for (const stream of [first, second]) {
      expect(stream.ready, `${stream.client} never got a ready frame`).toMatchObject({ cursor: 0, clipped: false })
      const types = stream.events.map((event) => event.type)
      expect(types).toEqual(['session.started', 'prompt.started', 'prompt.chunk', 'prompt.finished'])
      expect(stream.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    }
    // Both clients must see the identical sequence and the same assistant text.
    expect(second.events.map((event) => [event.seq, event.type])).toEqual(first.events.map((event) => [event.seq, event.type]))
    const text = first.events.filter((event) => event.type === 'prompt.chunk').map((event) => event.text ?? '').join('')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(second.events.filter((event) => event.type === 'prompt.chunk').map((event) => event.text ?? '').join('')).toBe(text)

    const state = (await (await fetch(`${url}/state`)).json()) as { sessionId: unknown; model: unknown; busy: unknown; seq: unknown }
    expect(state.sessionId).toEqual(expect.any(String))
    expect(state.model).toBe(MODEL)
    expect(state.busy).toBe(false)
    expect(state.seq).toBe(4)
  } finally {
    killTree(child)
    await removeTempDirs([cwd])
  }
}, 240_000)

test.skipIf(ENABLED)('stays dormant without the opt-in flag', () => {
  expect(process.env['KIMAKI_JCODE_HUB_E2E']).not.toBe('1')
})

// Two refusals that matter for shared use: a second hub must not write the same
// log, and an unsupported model must be refused at submit time instead of
// half-starting a turn.
test.skipIf(!ENABLED)('refuses a second hub on the same log and an unsupported model', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-jcode-hub-refuse-'))
  const logFile = path.join(dir, 'events.jsonl')
  const startServe = (extra: string[], log = logFile) =>
    spawn(
      process.execPath,
      ['--import', 'tsx', CLI, 'ops', 'jcode', 'serve', '--cwd', dir, '--log', log, '--timeout', '180000', ...extra],
      { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
  const collectExit = (child: ChildProcess) => {
    let text = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      text += chunk
    })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      text += chunk
    })
    return new Promise<{ code: number | null; text: () => string }>((resolve) => {
      child.once('close', (code) => resolve({ code, text: () => text }))
      setTimeout(() => resolve({ code: null, text: () => text }), 60_000)
    })
  }
  let owner: ChildProcess | undefined
  let intruder: ChildProcess | undefined
  let badModel: ChildProcess | undefined
  try {
    owner = startServe(['--model', MODEL])
    const ownerUrl = await waitForUrl(owner)
    expect(ownerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    intruder = startServe(['--model', MODEL])
    const refused = await collectExit(intruder)
    expect(refused.code, 'a second hub must not keep running').not.toBe(0)
    expect(refused.text(), 'the refusal must name the lease').toMatch(/session lease/i)

    // A model the agent does not offer fails during start, so submit is refused.
    // Its own log keeps it clear of the lease held by the first hub.
    badModel = startServe(['--model', 'kimaki-nonexistent-model', '--port', '0'], path.join(dir, 'bad-model.jsonl'))
    const badUrl = await waitForUrl(badModel)
    const posted = await fetch(`${badUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: PROMPT }),
    })
    expect(posted.status, 'an unsupported model must be refused').toBe(409)
    const body = (await posted.json()) as { error?: unknown }
    expect(String(body.error)).toMatch(/model/i)
    const state = (await (await fetch(`${badUrl}/state`)).json()) as { busy: unknown; seq: unknown }
    expect(state).toMatchObject({ busy: false, seq: 0 })
  } finally {
    for (const child of [owner, intruder, badModel]) {
      if (child !== undefined && child.exitCode === null) killTree(child)
    }
    await removeTempDirs([dir])
  }
}, 240_000)

// A durable hub keeps its stream across a restart: the sequence, the session it
// recorded, and the events a client already saw are all readable again from the
// log, without replaying the turn or prompting the agent.
test.skipIf(!ENABLED)('resumes the same stream after the hub restarts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-jcode-hub-restart-'))
  const logFile = path.join(dir, 'events.jsonl')
  const startServe = () =>
    spawn(
      process.execPath,
      ['--import', 'tsx', CLI, 'ops', 'jcode', 'serve', '--cwd', dir, '--model', MODEL, '--log', logFile, '--timeout', '180000'],
      { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
  let current: ChildProcess | undefined
  try {
    current = startServe()
    const firstUrl = await waitForUrl(current)
    const firstStream = collect(firstUrl, 'first-run')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const posted = await fetch(`${firstUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: PROMPT }),
    })
    expect(posted.status).toBe(202)
    const firstTurn = await firstStream
    expect(firstTurn.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    const beforeRestart = (await (await fetch(`${firstUrl}/state`)).json()) as { sessionId: unknown; seq: unknown; durable: unknown }
    expect(beforeRestart).toMatchObject({ durable: true, seq: 4 })
    expect(beforeRestart.sessionId).toEqual(expect.any(String))

    killTree(current)
    await new Promise((resolve) => setTimeout(resolve, 500))

    current = startServe()
    const secondUrl = await waitForUrl(current)
    const afterRestart = (await (await fetch(`${secondUrl}/state`)).json()) as { sessionId: unknown; seq: unknown; durable: unknown; busy: unknown }
    expect(afterRestart).toMatchObject({ durable: true, seq: 4, busy: false })
    // The log carries the session identity forward rather than inventing a new one.
    expect(afterRestart.sessionId).toBe(beforeRestart.sessionId)

    const replayed = await collect(secondUrl, 'after-restart')
    expect(replayed.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(replayed.ready).toMatchObject({ cursor: 0, clipped: false })
  } finally {
    if (current !== undefined) killTree(current)
    await removeTempDirs([dir])
  }
}, 240_000)
