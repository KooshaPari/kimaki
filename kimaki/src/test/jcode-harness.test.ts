// Self-test for ./jcode-harness.ts. Both branches are asserted:
// - the real binary, when present, must produce an isolated hub, a session ID
//   that matches what the hub reports, and one observed turn;
// - an absent binary must surface the named skip reason instead of passing.
// The absent path is forced through the `binary: null` seam, so it is exercised
// on every host rather than only where jcode is not installed.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { JCODE_SKIP_BY_OVERRIDE, startJcodeTestHub } from './jcode-harness.ts'

describe('jcode harness', () => {
  it('drives one real jcode turn in an isolated home', async (ctx) => {
    const runtime = await startJcodeTestHub()
    try {
      if (runtime.skipReason !== null) {
        // Honest skip, not a pass: the reason is the skip message itself.
        ctx.skip(true, runtime.skipReason)
        return
      }
      expect(runtime.skipReason).toBeNull()
      expect(runtime.binary).toMatch(/jcode(\.exe)?$/i)
      // Never the developer's store.
      expect(path.resolve(runtime.home)).not.toBe(path.resolve(path.join(process.env['USERPROFILE'] ?? '', '.jcode')))
      expect(runtime.home.startsWith(runtime.root)).toBe(true)

      // The session identity the hub reports is the one the harness exposes.
      const started = runtime.events.find((event) => event.type === 'session.started')
      expect(started).toBeDefined()
      expect(started?.type === 'session.started' ? started.sessionId : null).toBe(runtime.sessionId)
      expect(runtime.hub?.snapshot().sessionId).toBe(runtime.sessionId)

      // One real turn, observed end to end.
      const turn = await runtime.prompt('Reply with the single word OK.')
      expect(turn.stopReason).toBe('end_turn')
      expect(turn.text.trim().length).toBeGreaterThan(0)

      const finished = [...runtime.events].reverse().find((event) => event.type === 'prompt.finished')
      expect(finished?.type === 'prompt.finished' ? finished.stopReason : null).toBe('end_turn')
      expect(runtime.events.some((event) => event.type === 'prompt.chunk')).toBe(true)
    } finally {
      await runtime.close()
    }
  }, 240_000)

  it('reports the named skip reason when the binary is absent', async () => {
    const runtime = await startJcodeTestHub({ binary: null })
    try {
      expect(runtime.skipReason).toBe(JCODE_SKIP_BY_OVERRIDE)
      expect(runtime.hub).toBeNull()
      expect(runtime.sessionId).toBeNull()
      await expect(runtime.prompt('hello')).rejects.toThrow(JCODE_SKIP_BY_OVERRIDE)
    } finally {
      await runtime.close()
    }
  }, 30_000)
})
