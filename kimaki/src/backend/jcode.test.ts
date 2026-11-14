// Fake-client unit tests for the Jcode backend adapter. No real `jcode` runs
// here: every ACP method is replaced so the tests pin state, ordering and
// fail-closed behaviour only.

import { describe, expect, it } from 'vitest'

import { createJcodeBackend } from './jcode.js'
import type { AcpClient, AcpClientOptions, CreateJcodeBackend } from './acp/contracts.js'

type Input = Parameters<CreateJcodeBackend>[0]

type Calls = {
  options: AcpClientOptions[]
  initialize: number
  newSession: { cwd: string }[]
  setModel: { sessionId: string; model: string }[]
  prompt: { sessionId: string; text: string }[]
  cancel: { sessionId: string }[]
  close: number
}

function fakeAcp(overrides: Partial<AcpClient> = {}) {
  const calls: Calls = { options: [], initialize: 0, newSession: [], setModel: [], prompt: [], cancel: [], close: 0 }
  const client: AcpClient = {
    async initialize() {
      calls.initialize++
      return { protocolVersion: 1, agentName: 'jcode' }
    },
    async newSession(input) {
      calls.newSession.push(input)
      return { sessionId: 'sess-1' }
    },
    async setModel(input) {
      calls.setModel.push(input)
      return { model: input.model }
    },
    async prompt(input) {
      calls.prompt.push({ sessionId: input.sessionId, text: input.text })
      input.onChunk?.('hel')
      input.onChunk?.('lo')
      return { stopReason: 'end_turn', text: 'hello', updateCount: 2 }
    },
    async cancel(input) {
      calls.cancel.push(input)
      return undefined
    },
    async close() {
      calls.close++
    },
    ...overrides,
  }
  return { client, calls }
}

function backendWith(overrides: Partial<AcpClient> = {}, input: Partial<Input> = {}) {
  const fake = fakeAcp(overrides)
  const backend = createJcodeBackend({
    cwd: 'C:/work/project',
    ...input,
    createClient: (options) => {
      fake.calls.options.push(options)
      return fake.client
    },
  })
  return { backend, fake }
}

describe('createJcodeBackend', () => {
  it('declares exactly the contract capabilities', () => {
    const { backend } = backendWith()
    expect(backend.capabilities).toEqual({ prompt: true, streaming: true, cancel: true, replay: false, exclusiveControl: false })
  })

  it('initializes, creates one session and streams prompt chunks', async () => {
    const { backend, fake } = backendWith()

    expect(backend.sessionId()).toBe(null)

    const started = await backend.start()
    expect(started).toEqual({ sessionId: 'sess-1', model: null })
    expect(backend.sessionId()).toBe('sess-1')
    expect(fake.calls.initialize).toBe(1)
    expect(fake.calls.newSession).toEqual([{ cwd: 'C:/work/project' }])
    expect(fake.calls.setModel).toEqual([])

    const chunks: string[] = []
    const result = await backend.prompt('say hello', (text) => chunks.push(text))

    expect(result).toEqual({ stopReason: 'end_turn', text: 'hello', updateCount: 2 })
    expect(chunks).toEqual(['hel', 'lo'])
    expect(fake.calls.prompt).toEqual([{ sessionId: 'sess-1', text: 'say hello' }])
  })

  it('defaults to the jcode binary with the none tool profile and forwards overrides', async () => {
    const { backend, fake } = backendWith()
    await backend.start()
    expect(fake.calls.options).toEqual([{ command: 'jcode', args: ['acp', '--tool-profile', 'none'], cwd: 'C:/work/project' }])

    const custom = backendWith({}, { binary: 'C:/bin/jcode.exe', toolProfile: 'minimal', timeoutMs: 5_000 })
    await custom.backend.start()
    expect(custom.fake.calls.options).toEqual([{
      command: 'C:/bin/jcode.exe', args: ['acp', '--tool-profile', 'minimal'], cwd: 'C:/work/project', timeoutMs: 5_000,
    }])
  })

  it('returns the existing session on a second start without re-initializing', async () => {
    const { backend, fake } = backendWith()
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: null })
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: null })
    expect(fake.calls.initialize).toBe(1)
    expect(fake.calls.newSession).toHaveLength(1)
    expect(fake.calls.setModel).toEqual([])
  })

  it('resolves an Error for a prompt before start', async () => {
    const { backend, fake } = backendWith()
    const result = await backend.prompt('too early')
    expect(result).toBeInstanceOf(Error)
    expect(fake.calls.prompt).toEqual([])
  })

  it('resolves an Error for a cancel before start', async () => {
    const { backend, fake } = backendWith()
    const result = await backend.cancel()
    expect(result).toBeInstanceOf(Error)
    expect(fake.calls.cancel).toEqual([])
  })

  it('is idempotent on close and clears the session', async () => {
    const { backend, fake } = backendWith()
    await backend.start()
    await backend.close()
    await backend.close()
    expect(fake.calls.close).toBe(1)
    expect(backend.sessionId()).toBe(null)
  })

  it('resolves an Error for a prompt after close', async () => {
    const { backend, fake } = backendWith()
    await backend.start()
    await backend.close()
    const result = await backend.prompt('after close')
    expect(result).toBeInstanceOf(Error)
    expect(fake.calls.prompt).toEqual([])
  })

  it('propagates an initialize Error without creating a session', async () => {
    const failure = new Error('initialize failed')
    const { backend, fake } = backendWith({ initialize: async () => failure })
    const result = await backend.start()
    expect(result).toBe(failure)
    expect(fake.calls.newSession).toEqual([])
    expect(backend.sessionId()).toBe(null)
  })

  it('propagates a newSession Error and leaves the backend unstarted', async () => {
    const failure = new Error('newSession failed')
    const { backend, fake } = backendWith({ newSession: async () => failure })
    const result = await backend.start()
    expect(result).toBe(failure)
    expect(fake.calls.initialize).toBe(1)
    expect(backend.sessionId()).toBe(null)
    expect(await backend.prompt('no session')).toBeInstanceOf(Error)
  })

  it('selects the configured model over ACP after session/new and surfaces the echo', async () => {
    const { backend, fake } = backendWith({}, { model: 'beam-free' })
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: 'beam-free' })
    expect(fake.calls.setModel).toEqual([{ sessionId: 'sess-1', model: 'beam-free' }])
  })

  it('lets start() select a model that overrides the configured one', async () => {
    const { backend, fake } = backendWith({}, { model: 'beam-free' })
    expect(await backend.start({ model: 'deepseek-v4-pro' })).toEqual({ sessionId: 'sess-1', model: 'deepseek-v4-pro' })
    expect(fake.calls.setModel).toEqual([{ sessionId: 'sess-1', model: 'deepseek-v4-pro' }])
  })

  it('propagates a setModel Error and leaves the backend unstarted', async () => {
    const failure = new Error('model access is disabled')
    const seen: { sessionId: string; model: string }[] = []
    const { backend } = backendWith({
      setModel: async (input) => {
        seen.push(input)
        return failure
      },
    }, { model: 'deepseek-v4-pro' })
    expect(await backend.start()).toBe(failure)
    expect(seen).toEqual([{ sessionId: 'sess-1', model: 'deepseek-v4-pro' }])
    expect(backend.sessionId()).toBe(null)
  })

  it('passes prompt usage through unchanged when the agent reports it', async () => {
    const usage = { inputTokens: 30_754, outputTokens: 28, totalTokens: 30_782 }
    const { backend } = backendWith({ prompt: async (input) => {
      input.onChunk?.('ok')
      return { stopReason: 'end_turn', text: 'ok', updateCount: 1, usage }
    } })
    await backend.start()
    expect(await backend.prompt('hi')).toEqual({ stopReason: 'end_turn', text: 'ok', updateCount: 1, usage })
  })
})
