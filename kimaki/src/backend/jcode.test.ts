// Fake-client unit tests for the Jcode backend adapter. No real `jcode` runs
// here: every ACP method is replaced so the tests pin state, ordering and
// fail-closed behaviour only.

import { describe, expect, it } from 'vitest'

import { createJcodeBackend } from './jcode.js'
import type { JcodeBackendInput } from './jcode.js'
import type { AcpClient, AcpClientOptions } from './acp/contracts.js'

type Input = JcodeBackendInput

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
      return { protocolVersion: 1, agentName: 'jcode', agentVersion: '1.1.0', agentCapabilities: {}, supportsRetraction: false }
    },
    async newSession(input) {
      calls.newSession.push(input)
      return { sessionId: 'sess-1' }
    },
    async setModel(input) {
      calls.setModel.push(input)
      return { model: input.model }
    },
    async loadSession(input) {
      return { sessionId: input.sessionId, history: [], model: null }
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
    pendingServerRequests() {
      return []
    },
    answerServerRequest() {
      return { requestId: 0 }
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

// AC39: a profile, not the peer's self-reported label, resolves the executable
// and the environment. KCode claims `jcode` and so does stock jcode, so the only
// discriminator is the -k<digits> fork segment in the version: a kcode profile
// must refuse a stock `jcode` version instead of falling back to the stock binary.
describe('Runtime profile identity', () => {
  // A real kcode handshake: it names itself `jcode`, exactly like upstream, and
  // only its version marks the KooshaPari fork (BASEVERSION-k<semver>).
  const kcodeHandshake: Partial<AcpClient> = {
    async initialize() {
      return { protocolVersion: 1, agentName: 'jcode', agentVersion: '0.93.0-k0.1.0', agentCapabilities: {}, supportsRetraction: false }
    },
  }

  it('runs a kcode profile end to end: executable, env prefix and provenance', async () => {
    const { backend, fake } = backendWith(kcodeHandshake, { profile: 'kcode', store: 'C:/Users/koosh/.kcode' })

    expect(backend.profile).toEqual({
      id: 'kcode',
      executable: 'kcode',
      envPrefix: 'KCODE_',
      storeDir: '~/.kcode',
      expectedIdentity: { name: 'jcode', fork: true },
    })
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: null })

    const options = fake.calls.options[0]!
    expect(options.command).toBe('kcode')
    expect(options.env?.['KCODE_HOME']).toBe('C:/Users/koosh/.kcode')
    expect(options.env?.['JCODE_HOME']).toBeUndefined()
    expect(fake.calls.newSession).toEqual([{ cwd: 'C:/work/project' }])
  })

  it('defaults the executable from the profile and refuses no executable at all', async () => {
    const { backend: kcode, fake } = backendWith(kcodeHandshake, { profile: 'kcode' })
    await kcode.start()
    expect(fake.calls.options[0]!.command).toBe('kcode')

    const missing = backendWith(kcodeHandshake, { profile: 'kcode', binary: '   ' })
    const refused = await missing.backend.start()
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('Runtime profile kcode expects executable kcode, but no executable was supplied')
    expect(missing.fake.calls.options).toEqual([])
  })

  it('refuses to route a kcode profile through the stock jcode executable (backend path)', async () => {
    const { backend, fake } = backendWith(kcodeHandshake, { profile: 'kcode', binary: 'C:/bin/jcode.exe' })
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    const message = (refused as Error).message
    expect(message).toContain('Runtime profile kcode expects executable kcode')
    expect(message).toContain("'C:/bin/jcode.exe' is the jcode executable")
    // No fallback: no client was created and no ACP call was made.
    expect(fake.calls.options).toEqual([])
    expect(fake.calls.initialize).toBe(0)
    expect(fake.calls.newSession).toEqual([])
  })

  it('refuses a jcode profile handed the kcode executable (backend path)', async () => {
    const { backend, fake } = backendWith({}, { binary: 'C:/w6-install/bin/kcode.exe' })
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('Runtime profile jcode expects executable jcode')
    expect((refused as Error).message).toContain('is the kcode executable')
    expect(fake.calls.options).toEqual([])
  })

  it('refuses a stock jcode handshake for a kcode profile (ACP handshake)', async () => {
    // The default fake reports `jcode` 1.1.0, which is stock upstream, not kcode.
    const { backend, fake } = backendWith({}, { profile: 'kcode' })
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    const message = (refused as Error).message
    expect(message).toContain("Runtime profile kcode expects identity 'jcode' with a -k<digits> fork segment")
    expect(message).toContain("the ACP handshake reported identity 'jcode' version '1.1.0'")
    expect(message).toContain('does not carry a -k<digits> fork segment')
    // The label never selects the binary and never creates a session.
    expect(fake.calls.newSession).toEqual([])
    expect(fake.calls.options[0]!.command).toBe('kcode')
  })

  it('refuses a handshake that reports no identity at all', async () => {
    const silent: Partial<AcpClient> = {
      async initialize() {
        return { protocolVersion: 1, agentName: null, agentVersion: null, agentCapabilities: {}, supportsRetraction: false }
      },
    }
    const { backend, fake } = backendWith(silent, { profile: 'kcode' })
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain("Runtime profile kcode expects identity 'jcode' with a -k<digits> fork segment")
    expect((refused as Error).message).toContain('the ACP handshake reported no identity')
    expect(fake.calls.newSession).toEqual([])
  })

  // The fork segment is the whole discriminator, so each side is pinned on a
  // real measured pair: stock jcode 1.1.0 and kcode 0.93.0-k0.1.0.
  const handshake = (name: string | null, version: string | null): Partial<AcpClient> => ({
    async initialize() {
      return { protocolVersion: 1, agentName: name, agentVersion: version, agentCapabilities: {}, supportsRetraction: false }
    },
  })

  it('accepts stock jcode 1.1.0 for the jcode profile', async () => {
    const { backend, fake } = backendWith(handshake('jcode', '1.1.0'))
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: null })
    expect(fake.calls.newSession).toEqual([{ cwd: 'C:/work/project' }])
  })

  it('rejects stock jcode 1.1.0 for the kcode profile', async () => {
    const { backend } = backendWith(handshake('jcode', '1.1.0'), { profile: 'kcode' })
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain("version '1.1.0'")
    expect((refused as Error).message).toContain('refusing to route a kcode session')
  })

  it('accepts kcode 0.93.0-k0.1.0 for the kcode profile', async () => {
    const { backend, fake } = backendWith(handshake('jcode', '0.93.0-k0.1.0'), { profile: 'kcode' })
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: null })
    expect(fake.calls.newSession).toEqual([{ cwd: 'C:/work/project' }])
  })

  it('rejects kcode 0.93.0-k0.1.0 for the jcode profile', async () => {
    const { backend } = backendWith(handshake('jcode', '0.93.0-k0.1.0'))
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain("Runtime profile jcode expects identity 'jcode' without a -k<digits> fork segment")
    expect((refused as Error).message).toContain("version '0.93.0-k0.1.0'")
    expect((refused as Error).message).toContain('refusing to route a jcode session')
  })

  it('refuses a peer that names itself kcode for either profile', async () => {
    // Neither profile expects the literal name 'kcode': the fork reuses 'jcode'
    // and is identified by its version, so a 'kcode' name is not a match.
    const asJcode = backendWith(handshake('kcode', '1.1.0'))
    const jcodeRefused = await asJcode.backend.start()
    expect(jcodeRefused).toBeInstanceOf(Error)
    expect((jcodeRefused as Error).message).toContain("the ACP handshake reported identity 'kcode' version '1.1.0'")

    const asKcode = backendWith(handshake('kcode', '0.93.0-k0.1.0'), { profile: 'kcode' })
    const kcodeRefused = await asKcode.backend.start()
    expect(kcodeRefused).toBeInstanceOf(Error)
    expect((kcodeRefused as Error).message).toContain("Runtime profile kcode expects identity 'jcode'")
    expect((kcodeRefused as Error).message).toContain("reported identity 'kcode'")
  })

  it('never satisfies the kcode profile with a version that has no fork segment', async () => {
    for (const version of ['1.1.0', '0.93.0', '0.99.1+linux', '0.93.0-rc.1']) {
      const { backend } = backendWith(handshake('jcode', version), { profile: 'kcode' })
      const refused = await backend.start()
      expect(refused, `version ${version} must not satisfy kcode`).toBeInstanceOf(Error)
      expect((refused as Error).message).toContain('does not carry a -k<digits> fork segment')
    }
  })

  it('refuses an unknown profile id and records no provenance', async () => {
    const { backend, fake } = backendWith({}, { profile: 'kcode-fork' })
    expect(backend.profile).toBe(null)
    const refused = await backend.start()
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain("Unknown runtime profile 'kcode-fork'")
    expect((refused as Error).message).toContain('jcode, kcode')
    expect(fake.calls.options).toEqual([])
  })

  it('keeps the stock jcode profile as the explicit default', async () => {
    const { backend, fake } = backendWith()
    expect(backend.profile?.id).toBe('jcode')
    expect(await backend.start()).toEqual({ sessionId: 'sess-1', model: null })
    expect(fake.calls.options[0]!.command).toBe('jcode')
    expect(fake.calls.options[0]!.env).toBeUndefined()
  })
})
