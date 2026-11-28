// The jcode surface matrix, and the routing/refusal each surface performs.
//
// One file for the whole matrix on purpose: the point of this lane is that no
// surface answers with the generic "OpenCode service not reachable (not
// connected)". Every case here asserts either the real primitive was used
// (abort -> session/cancel) or the named refusal was returned before any
// OpenCode call could be attempted.
//
// The fakes are deliberately minimal: a jcode bot has no OpenCode endpoint, no
// db and no discord client, so a fake bot that lacks them proves the guard ran
// first. If a call site slipped past its guard, these tests would throw instead
// of returning an error.

import { describe, expect, test } from 'vitest'

import type { Bot, Conversation, ModelChoice } from './bot.ts'
import { OpenCodeUnavailableError } from './errors.ts'
import { JcodeBotBackendError } from './backend/jcode-bot-error.ts'
import {
  JCODE_SURFACES,
  JCODE_SURFACE_NAMES,
  abortJcode,
  conversationBackendKind,
  jcodeConnectionRefusal,
  jcodeSurfaceRefusal,
  type JcodeSurfaceName,
} from './jcode-surfaces.ts'
import { primaryAgents, fork, forkBtw } from './sessions.ts'
import { switchModel } from './commands/preference-commands.ts'
import { abort, clearQueue, prompt, redo, runInSession, shell, undo } from './prompt.ts'

type FakeOptions = {
  /** The bot's own connection. */
  kind?: 'jcode' | 'opencode'
  /** thread_sessions rows by thread id. */
  backends?: Record<string, string>
  /** roots by thread id. */
  roots?: Record<string, string>
  /** sessionThreads by session id. */
  sessionThreads?: Record<string, string>
  /** What the jcode connection's cancel answers. */
  cancel?: () => Promise<unknown>
}

// The smallest bot a guarded surface can run against: no OpenCode endpoint, no
// db, no discord. Anything that reaches past its guard fails loudly.
function fakeBot(options: FakeOptions = {}) {
  const kind = options.kind ?? 'jcode'
  const connection = {
    kind,
    endpoint: null,
    ...(options.cancel ? { cancel: options.cancel } : {}),
  }
  const bot = {
    opencode: connection,
    backends: { opencode: null, jcode: kind === 'jcode' ? connection : null },
    store: {
      getState: () => ({
        roots: options.roots ?? { thread_1: 'session_1' },
        threadBackends: options.backends ?? {},
        sessionThreads: options.sessionThreads ?? {},
        threads: {},
      }),
      setState: () => undefined,
    },
    features: { withSleepLock: ({ run }: { run: () => Promise<unknown> }) => run() },
    db: {
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      }),
    },
    clock: { now: () => 0 },
  }
  return bot as unknown as Bot
}

const conversation = { id: 'thread_1', name: 'thread', isThread: () => true } as unknown as Conversation
const author = { id: 'user_1', username: 'tester' }

const jcodeThread = (): Bot => fakeBot({ backends: { thread_1: 'jcode' } })
const opencodeThreadOnJcodeBot = (): Bot => fakeBot({ backends: { thread_1: 'opencode' } })

describe('the surface matrix', () => {
  test('every name has one row, and only abort is routed', () => {
    const routed = JCODE_SURFACE_NAMES.filter((name) => JCODE_SURFACES[name].decision === 'routed')
    expect(routed).toEqual(['abort'])
    for (const name of JCODE_SURFACE_NAMES) {
      const row = JCODE_SURFACES[name]
      expect(row.surface).toBe(name)
      expect(row.site).toMatch(/^kimaki\/src\/.+\(\)$|^kimaki\/src\/.+\/model$/)
      expect(row.opencode.length).toBeGreaterThan(10)
      expect(row.jcode.length).toBeGreaterThan(10)
    }
  })

  // A refusal that blames the connection is the bug this lane removes: every
  // refused row must name the missing capability instead.
  test('no refusal blames the transport', () => {
    for (const name of JCODE_SURFACE_NAMES) {
      const row = JCODE_SURFACES[name]
      if (row.decision !== 'refused') continue
      expect(row.jcode).not.toContain('not connected')
      expect(row.jcode).not.toContain('not reachable')
      expect(row.jcode).toMatch(/no |cannot |nothing |keeps /)
    }
  })
})

describe('the refusal decides on the conversation, not the bot default', () => {
  test('a jcode row refuses, and names the surface plus the missing capability', () => {
    const refusal = jcodeSurfaceRefusal(jcodeThread(), 'thread_1', 'undo')
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal?.message).toBe(
      `undo is unavailable on the jcode backend: ${JCODE_SURFACES.undo.jcode}`,
    )
  })

  test('a legacy OpenCode row on a jcode bot is never refused', () => {
    expect(jcodeSurfaceRefusal(opencodeThreadOnJcodeBot(), 'thread_1', 'undo')).toBeNull()
  })

  test('an unbound thread falls back to the bot connection', () => {
    expect(jcodeSurfaceRefusal(fakeBot({ kind: 'jcode' }), 'unbound', 'redo')).toBeInstanceOf(Error)
    expect(jcodeSurfaceRefusal(fakeBot({ kind: 'opencode' }), 'unbound', 'redo')).toBeNull()
  })

  test('a routed surface is never refused', () => {
    expect(jcodeSurfaceRefusal(jcodeThread(), 'thread_1', 'abort')).toBeNull()
    expect(jcodeConnectionRefusal(jcodeThread(), 'abort')).toBeNull()
  })

  test('conversationBackendKind reads the row first', () => {
    expect(conversationBackendKind(jcodeThread(), 'thread_1')).toBe('jcode')
    expect(conversationBackendKind(opencodeThreadOnJcodeBot(), 'thread_1')).toBe('opencode')
    expect(conversationBackendKind(fakeBot({ kind: 'opencode' }), 'unbound')).toBe('opencode')
  })
})

describe('each surface on a jcode thread', () => {
  test('undo refuses with the revert-history reason', async () => {
    const result = await undo(jcodeThread(), { threadId: 'thread_1' })
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('undo is unavailable on the jcode backend')
    expect((result as Error).message).toContain('no revert history')
  })

  test('redo refuses with the nothing-recorded reason', async () => {
    const result = await redo(jcodeThread(), { threadId: 'thread_1' })
    expect((result as Error).message).toContain('redo is unavailable on the jcode backend')
    expect((result as Error).message).toContain('nothing to restore')
  })

  test('clear-queue refuses with the no-inbox reason', async () => {
    const result = await clearQueue(jcodeThread(), { threadId: 'thread_1' })
    expect((result as Error).message).toContain('clear-queue is unavailable on the jcode backend')
    expect((result as Error).message).toContain('no queued message to cancel')
  })

  test('a queued prompt refuses with the no-inbox reason', async () => {
    const result = await prompt(jcodeThread(), {
      sessionId: 'session_1',
      threadId: 'thread_1',
      threadName: 'thread',
      text: 'queued',
      author,
      messageId: 'msg_1',
      delivery: 'queue',
    })
    expect((result as Error).message).toContain('queue is unavailable on the jcode backend')
    expect((result as Error).message).toContain('no inbox')
  })

  test('a `!cmd` shell refuses with the no-shell reason', () => {
    const result = shell(jcodeThread(), { threadId: 'thread_1', sessionId: 'session_1', command: 'ls' })
    expect((result as Error).message).toContain('shell is unavailable on the jcode backend')
    expect((result as Error).message).toContain('shell primitive')
  })

  test('a `/name` command refuses with the no-catalog reason', async () => {
    const result = await runInSession(jcodeThread(), {
      sessionId: 'session_1',
      threadId: 'thread_1',
      threadName: 'thread',
      directory: '/tmp',
      route: { kind: 'command', name: 'review', arguments: '', queue: false },
      author,
      messageId: 'msg_1',
      files: [],
    })
    expect((result as Error).message).toContain('command is unavailable on the jcode backend')
    expect((result as Error).message).toContain('no command catalog')
  })

  test('/btw refuses with the no-fork reason', async () => {
    const result = await forkBtw(jcodeThread(), { source: conversation, text: 'aside', author, messageId: 'msg_1' })
    expect((result as Error).message).toContain('btw is unavailable on the jcode backend')
    expect((result as Error).message).toContain('cannot fork')
  })

  test('/fork refuses with the no-fork reason', async () => {
    const result = await fork(jcodeThread(), { source: conversation, sessionId: 'session_1', author })
    expect((result as Error).message).toContain('fork is unavailable on the jcode backend')
    expect((result as Error).message).toContain('cannot fork')
  })

  test('/agent refuses with the no-catalog reason before any OpenCode call', async () => {
    const result = await primaryAgents(jcodeThread(), '/tmp')
    expect((result as Error).message).toContain('agent is unavailable on the jcode backend')
    expect((result as Error).message).toContain('no agent catalog')
  })

  test('/model refuses with the no-catalog reason', async () => {
    const model: ModelChoice = { providerID: 'p', id: 'm', variant: null }
    const result = await switchModel(fakeBot({ kind: 'jcode' }), { sessionId: 'session_unknown', model })
    expect((result as Error).message).toContain('model is unavailable on the jcode backend')
    expect((result as Error).message).toContain('no model catalog')
  })

  // The other half of the same decision: a legacy OpenCode thread still reaches
  // OpenCode. The fake has no endpoint, so the old generic error proves the guard
  // let it through rather than refusing it as jcode.
  test('/model on a legacy OpenCode session still reaches OpenCode', async () => {
    const model: ModelChoice = { providerID: 'p', id: 'm', variant: null }
    const bot = fakeBot({ kind: 'jcode', backends: { thread_1: 'opencode' }, sessionThreads: { session_1: 'thread_1' } })
    const result = await switchModel(bot, { sessionId: 'session_1', model })
    expect(result).toBeInstanceOf(OpenCodeUnavailableError)
  })
})

describe('/abort routes to the jcode cancel primitive', () => {
  test('a running turn is cancelled and the skipped parts are named', async () => {
    let cancelled = 0
    const bot = fakeBot({
      backends: { thread_1: 'jcode' },
      cancel: async () => {
        cancelled++
        return { sessionId: 'session_1', cancelled: true as const }
      },
    })
    const result = await abort(bot, { threadId: 'thread_1' })
    expect(cancelled).toBe(1)
    expect(result).toEqual({ cleared: 0, note: 'no queue, forms or shells to clear on the jcode backend' })
  })

  // An abort with nothing running asks for a state that already holds.
  test('a cancel with no turn running is an abort with nothing to do, not an error', async () => {
    const bot = fakeBot({
      backends: { thread_1: 'jcode' },
      cancel: async () => new JcodeBotBackendError({ stage: 'cancel-not-running', reason: 'nothing on the wire' }),
    })
    const result = await abort(bot, { threadId: 'thread_1' })
    expect(result).toEqual({ cleared: 0, note: 'no queue, forms or shells to clear on the jcode backend' })
  })

  // A refusal that is not "nothing running" is a real fault and is returned.
  test('a cancel refusal with no connection is returned by name', async () => {
    const bot = fakeBot({
      backends: { thread_1: 'jcode' },
      cancel: async () => new JcodeBotBackendError({ stage: 'cancel-no-connection', reason: 'no live ACP connection' }),
    })
    const result = await abort(bot, { threadId: 'thread_1' })
    expect(result).toBeInstanceOf(JcodeBotBackendError)
    expect((result as JcodeBotBackendError).stage).toBe('cancel-no-connection')
  })

  test('a thread that records jcode with no live jcode connection is refused by name', async () => {
    const bot = fakeBot({ kind: 'opencode', backends: { thread_1: 'jcode' } })
    const result = await abort(bot, { threadId: 'thread_1' })
    expect((result as Error).message).toContain('runs no jcode connection to cancel over')
  })

  test('abortJcode propagates a cancel that throws as an Error value', async () => {
    const outcome = await abortJcode({ cancel: async () => new JcodeBotBackendError({ stage: 'cancel-threw', reason: 'boom' }) })
    expect(outcome).toBeInstanceOf(JcodeBotBackendError)
  })
})

// Every refused surface name is reachable through the helper the call sites use;
// this is the matrix-level guard against a surface with no decision.
describe('the refusal is the same vocabulary everywhere', () => {
  test('each refused surface message starts with its own name', () => {
    for (const name of JCODE_SURFACE_NAMES as readonly JcodeSurfaceName[]) {
      const refusal = jcodeSurfaceRefusal(fakeBot({ kind: 'jcode' }), 'unbound', name)
      if (JCODE_SURFACES[name].decision === 'refused') expect(refusal?.surface).toBe(name)
      else expect(refusal).toBeNull()
    }
  })
})
