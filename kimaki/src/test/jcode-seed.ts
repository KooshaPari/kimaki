// A seed session written by the REAL jcode binary, isolated to a throwaway home.
//
// Why a mock provider: `jcode run` on a cold home has no credentials, so provider
// auto-detection fails before any session record is written:
//
//   Error: No credentials configured for provider auto-detection; automatic
//   login/bootstrap is disabled during validation.
//
// Naming a model does not help (measured: `-m gpt-5.5`, and a copied config.toml
// naming a default provider/model, both fail with the message above), because the
// missing piece is credentials, not a model id. `-p openai-api` pointed at a
// loopback server that speaks the Responses API SSE gives jcode a provider it can
// authenticate to, so it persists the record itself: no paid call, no network
// beyond 127.0.0.1, and the transcript is written by the binary rather than by a
// test.
//
// Model choice: jcode validates `-m` against its catalog, so the default here is
// "no -m" (the binary's own configured default, accepted on a cold install).
// JCODE_MODEL overrides it for a host whose default is unusable.
//
// Fail-fast: a failed run reports the binary's own exit code and stderr. It never
// degrades to a downstream `ENOENT: scandir <home>/sessions`, which names neither
// the exit code nor the message a cold machine actually produces.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type MockProvider = { url: string; close: () => Promise<void> }

// Responses API SSE: one assistant message whose full text is "ok". This is the
// stream shape `jcode run -p openai-api` already parses.
export function startMockProvider(): Promise<MockProvider> {
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

export type JcodeSessionRecord = {
  id: string
  title?: string
  custom_title?: string
  provider_key?: string
  model?: string
  messages?: unknown[]
}

export type SeededJcodeSession = {
  /** Throwaway root; cleanup() removes all of it. */
  root: string
  /** The JCODE_HOME the record lives in, never the developer's ~/.jcode. */
  home: string
  cwd: string
  nativeId: string
  recordFile: string
  readRecord(): JcodeSessionRecord
  /** A rename through the product's own binary, the write a follower must notice. */
  rename(title: string): Promise<void>
  cleanup(): void
}

export type SeedJcodeSessionInput = {
  binary: string
  prompt: string
  /** Defaults to JCODE_MODEL; empty means the binary's own configured default. */
  model?: string
  timeoutMs?: number
  /** Defaults to a fresh directory under the OS temp root. */
  root?: string
}

// The XDG-style default jcode writes. A run that exits 0 but wrote nothing here
// is a real failure, reported with the run's own output.
function findSessionFile(sessionsDir: string): string | null {
  if (!fs.existsSync(sessionsDir)) return null
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = findSessionFile(path.join(sessionsDir, entry.name))
      if (nested !== null) return nested
      continue
    }
    if (/^session_[^/]*\.json$/.test(entry.name)) return path.join(sessionsDir, entry.name)
  }
  return null
}

// The record is settled once it parses and two reads a moment apart agree: the
// seed run has already exited, so this converges, and a half-written record is
// never handed to a test.
async function settleSessionFile(sessionsDir: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const file = findSessionFile(sessionsDir)
    if (file !== null) {
      const raw = fs.readFileSync(file, 'utf8')
      if (raw === last && raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as { id?: unknown }
          if (typeof parsed.id === 'string') return file
        } catch {
          // Still being written; read again.
        }
      }
      last = raw
    }
    await sleep(100)
  }
  throw new Error(`the jcode session store at ${sessionsDir} did not settle with a session record within ${timeoutMs}ms`)
}

// jcode reads its own JCODE_* configuration and the OpenAI-compatible client
// reads OPENAI_*. A developer's variables for either would silently replace the
// loopback provider, so both families are dropped before the isolated ones are set.
function seedEnv(home: string, url: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('JCODE_') && !key.startsWith('OPENAI_')),
  )
  return {
    ...inherited,
    JCODE_HOME: home,
    JCODE_NO_TELEMETRY: '1',
    OPENAI_BASE_URL: `${url}/v1`,
    OPENAI_API_BASE: `${url}/v1`,
    OPENAI_API_KEY: 'kimaki-seed-key',
  }
}

function exitDetail(error: unknown): string {
  const code = Reflect.get(error as object, 'code')
  const stderr = Reflect.get(error as object, 'stderr')
  const stdout = Reflect.get(error as object, 'stdout')
  const message = error instanceof Error ? error.message : String(error)
  const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : message
  const out = typeof stdout === 'string' && stdout.trim() !== '' ? ` stdout: ${stdout.trim()}` : ''
  return `exit ${String(code)}: ${detail}${out}`
}

/**
 * Write one real jcode session into an isolated home and return handles to it.
 *
 * Throws with the binary's own exit code and stderr when the run fails, and with
 * the run's output when it exits 0 but persists no record.
 */
export async function seedJcodeSession(input: SeedJcodeSessionInput): Promise<SeededJcodeSession> {
  const root = input.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-jcode-seed-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })

  const model = (input.model ?? process.env['JCODE_MODEL'] ?? '').trim()
  const modelArgs = model === '' ? [] : ['-m', model]
  const mock = await startMockProvider()
  const env = seedEnv(home, mock.url)
  let stderr = ''
  try {
    const result = await execFileAsync(
      input.binary,
      ['run', '-p', 'openai-api', ...modelArgs, '--tool-profile', 'none', '--no-update', '--quiet', '-C', cwd, input.prompt],
      { env, timeout: input.timeoutMs ?? 120_000 },
    )
    stderr = result.stderr
  } catch (error) {
    // Fail fast with jcode's message: a cold machine has no credentials, and that
    // sentence is the diagnosis. A downstream ENOENT names neither.
    throw new Error(`the jcode seed run for "${input.prompt}" failed (${exitDetail(error)})`)
  } finally {
    await mock.close()
  }

  const sessionsDir = path.join(home, 'sessions')
  let recordFile: string
  try {
    recordFile = await settleSessionFile(sessionsDir)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} (seed run exited 0; stderr: ${stderr.trim()})`)
  }
  const nativeId = path.basename(recordFile).replace(/\.json$/, '')
  const readRecord = () => JSON.parse(fs.readFileSync(recordFile, 'utf8')) as JcodeSessionRecord
  const rename = async (title: string): Promise<void> => {
    try {
      await execFileAsync(input.binary, ['session', 'rename', nativeId, title, '--no-update', '--quiet', '-C', cwd], { env, timeout: 30_000 })
    } catch (error) {
      throw new Error(`the jcode rename to "${title}" failed (${exitDetail(error)})`)
    }
  }
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return { root, home, cwd, nativeId, recordFile, readRecord, rename, cleanup }
}
