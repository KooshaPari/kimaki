import childProcess from 'node:child_process'
import * as errore from 'errore'
import { z } from 'zod'
import { ConfigError } from '../../errors.js'

// Qualified against KooshaPari/herdr 08f0d168c92b6eea8a3688edc0714cd40b34dea8:
// src/cli/agent.rs, src/cli.rs, src/session.rs and src/api/schema/agents.rs.
// `agent list` prints the complete response envelope, without a --json option.
const text = z.string().max(16_384)
const identifier = text.min(1)
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const sessionCandidateSchema = z.object({
  source: identifier,
  agent: identifier,
  kind: z.enum(['id', 'path']),
  value: identifier,
})
const agentSchema = z.object({
  terminal_id: identifier,
  agent: text.nullable().optional(),
  agent_status: z.enum(['idle', 'working', 'blocked', 'done', 'unknown']),
  workspace_id: identifier,
  tab_id: identifier,
  pane_id: identifier,
  revision: sequence,
  state_change_seq: sequence.default(0),
  completion_seq: sequence.nullable().optional(),
  cwd: text.nullable().optional(),
  foreground_cwd: text.nullable().optional(),
  agent_session: sessionCandidateSchema.nullable().optional(),
}).transform(({ agent_session, ...metadata }) => ({
  ...metadata,
  ...(agent_session ? { sessionCandidate: agent_session } : {}),
}))
const inventorySchema = z.object({
  id: text,
  error: z.never().optional(),
  result: z.object({
    type: z.literal('agent_list'),
    agents: z.array(agentSchema).max(10_000),
  }),
})

export type HerdrAgent = z.output<typeof agentSchema>
export type HerdrInventory = {
  source: 'herdr'
  observedAt: number
  coverage: 'herdr-managed-panes-only'
  agents: HerdrAgent[]
}

/**
 * Read only herdr's managed-pane inventory. All IDs are herdr-local observations.
 * sessionCandidate is an unverified reporter claim, not native endpoint identity.
 * Paths and cwd are returned as metadata, never opened, normalized or resolved.
 */
export async function discoverHerdr({
  binary = 'herdr',
  session,
  timeoutMs = 5000,
}: {
  binary?: string
  session?: string
  timeoutMs?: number
} = {}): Promise<HerdrInventory | ConfigError> {
  if (!binary.trim() || binary.includes('\0')) {
    return new ConfigError({ reason: 'Set a nonempty herdr executable path without NUL characters.' })
  }
  if (session !== undefined && (!session.trim() || session.includes('\0'))) {
    return new ConfigError({ reason: 'Set a nonempty herdr session name without NUL characters.' })
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return new ConfigError({ reason: 'Set herdr timeoutMs to an integer between 1 and 60000.' })
  }
  const args = [...(session === undefined ? [] : ['--session', session]), 'agent', 'list']
  const stdout = await new Promise<string | ConfigError>((resolve) => {
    childProcess.execFile(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    }, (error, output) => {
      if (error) {
        // Node's execFile errors include captured output and command text. Never
        // propagate them, including as cause. Retain only a fixed error category.
        const category = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'output limit exceeded'
          : error.killed ? 'timed out' : 'command failed'
        resolve(new ConfigError({
          reason: `Herdr inventory ${category}. Check the executable, session and herdr CLI compatibility.`,
          cause: new Error(`Herdr inventory ${category}`),
        }))
        return
      }
      resolve(output)
    })
  })
  if (stdout instanceof Error) return stdout

  const decoded = errore.try({
    try: () => inventorySchema.safeParse(JSON.parse(stdout) as unknown),
    catch: () => new ConfigError({
      reason: 'Herdr inventory returned invalid JSON. Check herdr CLI compatibility.',
      cause: new Error('Invalid herdr inventory JSON'),
    }),
  })
  if (decoded instanceof Error) return decoded
  const parsed = decoded
  if (!parsed.success) {
    return new ConfigError({
      reason: 'Herdr inventory returned an unsupported response. Check herdr CLI compatibility.',
      cause: new Error('Invalid herdr inventory metadata schema'),
    })
  }
  return {
    source: 'herdr',
    observedAt: Date.now(),
    coverage: 'herdr-managed-panes-only',
    agents: parsed.data.result.agents,
  }
}
