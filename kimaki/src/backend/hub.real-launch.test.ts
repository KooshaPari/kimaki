// AC15, real runtime: the pre-ACK launch bound has to hold when the managed
// child is the actual `jcode.exe`, not a synthetic node stand-in.
//
// The child here is the real binary, spoken to through the real ACP transport
// (src/backend/acp/client.ts) with a fresh temp JCODE_HOME, so nothing touches
// the developer's own store. The kill lands mid-handshake: only once the child
// has answered `initialize` and before it can answer `session/new`. That leaves
// the hub with a launch that was partly acknowledged and then died, which is the
// exact shape the bound exists for.
//
// Measured on this host: spawn -> initialize response ~55ms, initialize ->
// session/new response ~130ms. Killing on the initialize response therefore
// lands inside the handshake with room to spare rather than racing it.
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAcpClient } from './acp/client.ts'
import { createSessionHub, type HubBackend, type HubEvent } from './hub.ts'

// The binary this host actually has; never a wrapper that might resolve elsewhere.
function findJcode(): string | null {
  const candidates = [
    process.env['JCODE_BIN'],
    path.join(process.env['LOCALAPPDATA'] ?? '', 'jcode', 'bin', 'jcode.exe'),
    path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'jcode', 'bin', 'jcode.exe'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const jcodeBinary = findJcode()

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForDead = async (pid: number, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !isAlive(pid)
}

// Observation only: the transport spawns the child, so the test records the
// spawn it already performs and mutates nothing about how it is performed. The
// returned restore() puts the real spawn function back.
const watchSpawns = (onSpawn: (child: childProcess.ChildProcess, spawnedAt: number) => void) => {
  const target = childProcess as unknown as { spawn: typeof childProcess.spawn }
  const realSpawn = target.spawn
  target.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = realSpawn(...args)
    onSpawn(child, Date.now())
    return child
  }) as typeof childProcess.spawn
  return () => {
    target.spawn = realSpawn
  }
}

describe('AC15 pre-ACK launch bound', () => {
  it('reports the death of the real jcode runtime killed mid-handshake', async (ctx) => {
    if (jcodeBinary === null) {
      ctx.skip(true, 'real jcode binary not found at %LOCALAPPDATA%\\jcode\\bin\\jcode.exe (set JCODE_BIN instead)')
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-hub-real-jcode-'))
    const home = path.join(dir, 'home')
    fs.mkdirSync(home, { recursive: true })

    let pid = 0
    let spawnedAt = 0
    let killedAt = 0
    let spawned = 0
    let sawInitializeAck = false
    let acp: ReturnType<typeof createAcpClient> | null = null
    // Read through a call so the finally block sees the assigned client rather
    // than the null the control-flow analysis can prove at declaration.
    const openClient = () => acp

    // Arming the kill at spawn time means the process is the transport's own
    // child and the pid is the exact one it will talk to. The listener is
    // attached before the transport's readline, so the kill is synchronous with
    // the initialize response: the child is provably mid-handshake, not pre-start.
    const restoreSpawn = watchSpawns((child, at) => {
      if (spawned > 0) return
      spawned += 1
      spawnedAt = at
      pid = child.pid ?? 0
      let seen = ''
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (killedAt !== 0) return
        seen += String(chunk)
        // Only the initialize result carries agentCapabilities. Answering it
        // proves the handshake had begun; session/new has not been answered yet.
        if (!seen.includes('agentCapabilities')) return
        sawInitializeAck = true
        killedAt = Date.now()
        process.kill(pid, 'SIGKILL')
      })
    })

    const backend: HubBackend = {
      async start() {
        acp ??= createAcpClient({
          command: jcodeBinary,
          args: ['acp', '--tool-profile', 'none'],
          cwd: dir,
          env: { ...process.env, JCODE_HOME: home, JCODE_NO_TELEMETRY: '1' },
        })
        const initialized = await acp.initialize()
        if (initialized instanceof Error) return initialized
        const session = await acp.newSession({ cwd: dir })
        if (session instanceof Error) return session
        return { sessionId: session.sessionId, model: null }
      },
      async prompt() {
        return new Error('a killed launch must never reach a prompt')
      },
      async cancel() {
        return undefined
      },
      async close() {
        await acp?.close()
      },
    }

    try {
      const launchTimeoutMs = 30_000
      const hub = createSessionHub({ backend, launchTimeoutMs })
      if (hub instanceof Error) throw hub
      const events: HubEvent[] = []
      hub.subscribe({ onEvent: (event) => events.push(event) })

      const began = Date.now()
      const started = await hub.start()
      const failureAt = Date.now()

      // The process spawned by the real transport was killed, mid-handshake.
      expect(spawned).toBe(1)
      expect(pid).toBeGreaterThan(0)
      expect(sawInitializeAck).toBe(true)
      expect(killedAt).toBeGreaterThanOrEqual(spawnedAt)
      // Death is reported by the launch itself, in the transport's literal text.
      expect(started).toBeInstanceOf(Error)
      expect((started as Error).message).toBe('The ACP agent process exited before responding')
      // And reported long before the launch timeout, not because of it.
      const elapsed = failureAt - began
      expect(elapsed).toBeLessThan(5_000)
      expect(elapsed).toBeLessThan(launchTimeoutMs / 4)

      // No session is invented from a process that died before acknowledging one.
      expect(hub.snapshot()).toMatchObject({ sessionId: null, model: null, busy: false, seq: 0 })
      expect(events.map((event) => event.type)).not.toContain('session.started')
      expect(events).toEqual([])

      // The exact pid this test killed is gone, not left running behind the hub.
      expect(await waitForDead(pid)).toBe(true)

      // A later submit fails closed against the same dead transport: no new
      // process, no turn, no sequence advance.
      const submitted = await hub.submit('hello')
      expect(submitted).toBeInstanceOf(Error)
      expect(spawned).toBe(1)
      expect(hub.snapshot()).toMatchObject({ sessionId: null, busy: false, seq: 0 })
      expect(events.map((event) => event.type)).not.toContain('prompt.started')
      expect(events).toEqual([])

      await hub.close()
    } finally {
      restoreSpawn()
      await openClient()?.close().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // The companion half of the same bound: the ACP transport answers every method
  // with either an Error or a result, so a dead child can only ever surface as an
  // Error (the case above). The other shape the guard rejects is a launch that
  // resolves with a result but no session ID at all. That is still not a session.
  it('refuses a launch that resolves without a session ID', async () => {
    const backend: HubBackend = {
      async start() {
        // A backend that misreports success: there is no id to name a session.
        return { model: null } as unknown as { sessionId: string; model: string | null }
      },
      async prompt() {
        return new Error('a no-id launch must never reach a prompt')
      },
      async cancel() {
        return undefined
      },
      async close() {},
    }
    const hub = createSessionHub({ backend })
    if (hub instanceof Error) throw hub
    const events: HubEvent[] = []
    hub.subscribe({ onEvent: (event) => events.push(event) })

    const started = await hub.start()
    expect(started).toBeInstanceOf(Error)
    expect((started as Error).message).toBe('Backend launch returned no session ID before acknowledging the session')
    expect(hub.snapshot()).toMatchObject({ sessionId: null, model: null, busy: false, seq: 0 })
    expect(events).toEqual([])
  })
})
