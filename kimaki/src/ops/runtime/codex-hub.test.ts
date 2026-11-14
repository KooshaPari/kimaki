import { describe, expect, it } from 'vitest'
import { createCodexHubBackend } from './codex-hub.ts'

function fake(behaviour: {
  start?: string
  resume?: string
  turn?: () => Promise<Error | { threadId: string; turnId: string; status: string; text: string }>
} = {}) {
  const calls: string[] = []
  const controller = {
    async startThread(input: { cwd?: string }) {
      calls.push(`startThread:${input.cwd ?? ''}`)
      return behaviour.start === undefined ? { threadId: 'thread-1' } : new Error(behaviour.start)
    },
    async resumeThread(input: { threadId: string; cwd?: string }) {
      calls.push(`resumeThread:${input.threadId}`)
      return behaviour.resume === undefined ? { threadId: input.threadId } : new Error(behaviour.resume)
    },
    async sendTurn(input: { threadId: string; text: string; onDelta?: (delta: { text: string }) => void }) {
      calls.push(`sendTurn:${input.threadId}`)
      if (behaviour.turn) return behaviour.turn()
      input.onDelta?.({ text: 'hel' })
      input.onDelta?.({ text: 'lo' })
      return { threadId: input.threadId, turnId: 'turn-1', status: 'completed', text: 'hello' }
    },
    async cancel(input: { threadId: string }) {
      calls.push(`cancel:${input.threadId}`)
      return {}
    },
  }
  return { controller, calls }
}

describe('Codex hub backend', () => {
  it('starts a thread, streams turns and reports the native status', async () => {
    const { controller, calls } = fake()
    const backend = createCodexHubBackend({ controller, cwd: 'C:/work' })
    expect(await backend.start()).toEqual({ sessionId: 'thread-1', model: null })
    expect(backend.threadId()).toBe('thread-1')
    const chunks: string[] = []
    const result = await backend.prompt('hi', (text) => chunks.push(text))
    expect(chunks).toEqual(['hel', 'lo'])
    expect(result).toEqual({ stopReason: 'completed', text: 'hello', updateCount: 2 })
    expect(await backend.cancel()).toBeUndefined()
    expect(calls).toEqual(['startThread:C:/work', 'sendTurn:thread-1', 'cancel:thread-1'])
  })

  it('resumes an existing thread instead of starting a new one', async () => {
    const { controller, calls } = fake()
    const backend = createCodexHubBackend({ controller, cwd: 'C:/work', resumeThreadId: 'thread-9' })
    expect(await backend.start()).toEqual({ sessionId: 'thread-9', model: null })
    expect(calls).toEqual(['resumeThread:thread-9'])
  })

  it('refuses a prompt before the thread exists and surfaces start failures', async () => {
    const { controller } = fake({ start: 'app-server refused' })
    const backend = createCodexHubBackend({ controller, cwd: 'C:/work' })
    expect(await backend.prompt('hi')).toBeInstanceOf(Error)
    const failure = await backend.start()
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/refused/)
    expect(backend.threadId()).toBeNull()
    // A cancel before a thread exists is a no-op rather than a fabricated success.
    expect(await backend.cancel()).toBeUndefined()
  })

  it('propagates a failed turn as an Error instead of a fake status', async () => {
    const { controller } = fake({ turn: async () => new Error('turn failed') })
    const backend = createCodexHubBackend({ controller, cwd: 'C:/work' })
    await backend.start()
    const result = await backend.prompt('hi')
    expect(result).toBeInstanceOf(Error)
  })
})
