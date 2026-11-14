// Adapts the Codex app-server controller to the hub's backend contract so one
// Codex thread can be served to several clients, the same way a Jcode ACP session
// is. Codex enforces one writer per thread natively, so the hub's single-writer
// rule matches the runtime rather than papering over it.
import type { HubBackend } from '../../backend/hub.ts'
import { ConfigError } from '../../errors.ts'

export type CodexHubController = {
  startThread(input: { cwd?: string }): Promise<{ threadId: string } | Error>
  resumeThread(input: { threadId: string; cwd?: string }): Promise<{ threadId: string } | Error>
  sendTurn(input: {
    threadId: string
    text: string
    onDelta?: (delta: { text: string }) => void
  }): Promise<{ threadId: string; turnId: string; status: string; text: string } | Error>
  cancel(input: { threadId: string }): Promise<unknown>
}

export function createCodexHubBackend({ controller, cwd, model = null, resumeThreadId }: {
  controller: CodexHubController
  cwd: string
  model?: string | null
  /** Resume an existing thread instead of starting a new one. */
  resumeThreadId?: string
}): HubBackend & { threadId(): string | null } {
  let threadId: string | null = null
  return {
    threadId: () => threadId,
    async start() {
      const started = resumeThreadId === undefined
        ? await controller.startThread({ cwd })
        : await controller.resumeThread({ threadId: resumeThreadId, cwd })
      if (started instanceof Error) return started
      threadId = started.threadId
      return { sessionId: started.threadId, model }
    },
    async prompt(text: string, onChunk?: (text: string) => void) {
      if (threadId === null) return new ConfigError({ reason: 'The Codex backend has not started a thread' })
      let updates = 0
      const result = await controller.sendTurn({
        threadId,
        text,
        onDelta: (delta) => {
          updates += 1
          onChunk?.(delta.text)
        },
      })
      if (result instanceof Error) return result
      return { stopReason: result.status, text: result.text, updateCount: updates }
    },
    async cancel() {
      if (threadId === null) return undefined
      const cancelled = await controller.cancel({ threadId })
      return cancelled instanceof Error ? cancelled : undefined
    },
    async close() {
      // The controller is owned by whoever built it; this adapter adds no state.
    },
  }
}
