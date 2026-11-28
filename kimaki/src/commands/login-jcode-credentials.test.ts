// Phase 2.4 wiring: the Discord /login preamble must add a read-only jcode
// report when the bot's backend is jcode, and stay byte-identical for the
// OpenCode path that Phase 2 deletes later.
import type { Bot } from '../bot.ts'
import { parseJcodeCredentialOutput } from '../jcode-credentials.ts'
import { expect, test } from 'vitest'

import { loginIntro } from './login-commands.ts'

const bot = (backendKind: 'jcode' | 'opencode'): Pick<Bot, 'backendKind' | 'jcodeStore'> => ({
  backendKind,
  jcodeStore: { binary: '/opt/jcode', home: '/tmp/jcode-home' },
})

const SNAPSHOT = parseJcodeCredentialOutput(
  JSON.stringify({
    any_available: true,
    providers: [
      { id: 'claude', display_name: 'Anthropic/Claude', status: 'expired', auth_kind: 'OAuth', method: 'OAuth (expired)', recommended: true },
      { id: 'openai', display_name: 'OpenAI', status: 'available', auth_kind: 'OAuth', method: 'OAuth', recommended: true },
      { id: 'opencode-go', display_name: 'OpenCode Go', status: 'not_configured', auth_kind: 'API key', method: 'not configured', recommended: false },
    ],
  }),
)

test('loginIntro keeps the OpenCode preamble unchanged and never reads jcode', async () => {
  let calls = 0
  const intro = await loginIntro(bot('opencode'), async () => {
    calls += 1
    throw new Error('must not be called')
  })
  expect(intro).toBe('Connect a provider. Credentials are stored by OpenCode, not Kimaki.')
  expect(calls).toBe(0)
})

test('loginIntro adds a read-only jcode report with exact login commands', async () => {
  expect(SNAPSHOT).not.toBeInstanceOf(Error)
  if (SNAPSHOT instanceof Error) return
  const seen: Array<Parameters<NonNullable<Parameters<typeof loginIntro>[1]>>[0]> = []
  const intro = await loginIntro(bot('jcode'), async (input) => {
    seen.push(input)
    return SNAPSHOT
  })
  expect(intro).toContain('Jcode holds its own credentials; Kimaki never copies them.')
  expect(intro).toContain('Jcode already holds 2 provider sign-ins (read-only):')
  expect(intro).toContain('claude (Anthropic/Claude): expired')
  expect(intro).toContain('jcode login opencode-go')
  expect(intro).not.toContain('openai-otter')
  expect(seen).toHaveLength(1)
  expect(seen[0]?.binary).toBe('/opt/jcode')
  expect(seen[0]?.env?.['JCODE_HOME']).toBe('/tmp/jcode-home')
})

test('loginIntro names a failed jcode read instead of pretending none exists', async () => {
  const intro = await loginIntro(bot('jcode'), async () => new Error('no jcode executable at /opt/jcode'))
  expect(intro).toContain('Jcode credential read unavailable (Error): no jcode executable at /opt/jcode')
})
