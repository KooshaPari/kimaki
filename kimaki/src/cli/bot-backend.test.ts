import { describe, expect, test } from 'vitest'

import { ConfigError } from '../errors.ts'
import { BOT_BACKEND_CHOICES, BOT_BACKEND_ENV, OPENCODE_ONLY_OPTIONS, resolveBotBackend, shouldCheckOpencode } from './bot.ts'

// `resolveBotBackend` is the pure gate the start action runs before it spawns the
// supervisor child, binds the lock port, opens SQLite or logs into Discord. Testing
// it proves the refusals; wiring it into the action is covered by inspection.

describe('resolveBotBackend', () => {
  test('absence of --backend yields jcode', () => {
    expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: {} })).toEqual({ backend: 'jcode', source: 'default' })
  })

  test('an explicit opencode value yields opencode', () => {
    expect(resolveBotBackend({ backend: 'opencode', argv: ['kimaki', '--backend', 'opencode'], env: {} })).toEqual({ backend: 'opencode', source: 'flag' })
  })

  test('an unknown backend value is refused before anything starts', () => {
    const result = resolveBotBackend({ backend: 'jcode2', argv: ['kimaki', '--backend', 'jcode2'] })
    expect(result).toBeInstanceOf(ConfigError)
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('expected a refusal')
    expect(result.name).toBe('ConfigError')
    expect(result.message).toBe(`Unknown --backend "jcode2". Use one of: ${BOT_BACKEND_CHOICES}`)
    // The refusal names the default so a mistyped value does not read as a hint
    // that opencode is still what a bare start gets.
    expect(result.message).toContain('jcode (default)')
  })

  test('jcode alone is accepted', () => {
    expect(resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode'], env: {} })).toEqual({ backend: 'jcode', source: 'flag' })
  })

  test.each(OPENCODE_ONLY_OPTIONS)('jcode plus %s is refused with a named message', (flag) => {
    const result = resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode', flag] })
    expect(result).toBeInstanceOf(ConfigError)
    if (!(result instanceof Error)) throw new Error('expected a refusal')
    expect(result.message).toContain(`--backend jcode cannot use ${flag}`)
    expect(result.message).toContain('OpenCode-only option')
    // The flag surface keeps its original advice, byte-identical.
    expect(result.message).toContain('or drop --backend jcode')
  })

  test('jcode plus an = form of an OpenCode-only option is refused', () => {
    const result = resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend=jcode', '--disable-skills=all'] })
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('expected a refusal')
    expect(result.message).toContain('--backend jcode cannot use --disable-skills')
  })

  test('jcode plus --coordinator false is accepted because jcode has no coordinator', () => {
    expect(resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode', '--coordinator', 'false'], env: {} })).toEqual({ backend: 'jcode', source: 'flag' })
  })

  test('jcode plus --coordinator true is refused', () => {
    const result = resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode', '--coordinator', 'true'] })
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('expected a refusal')
    expect(result.message).toContain('--backend jcode cannot use --coordinator')
  })

  test('jcode plus several OpenCode-only options lists all of them', () => {
    const result = resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode', '--worktrees', '--voice', 'cove'] })
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('expected a refusal')
    expect(result.message).toContain('--worktrees, --voice')
  })

  // The environment half of step 0.1 in docs/opencode-removal.md. Without it a bot
  // started with no flag still routes to OpenCode no matter what the operator sets.
  describe('KIMAKI_BACKEND', () => {
    test('selects jcode when no flag is given', () => {
      expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: { [BOT_BACKEND_ENV]: 'jcode' } })).toEqual({ backend: 'jcode', source: 'env' })
    })

    test('the flag wins over the environment', () => {
      expect(resolveBotBackend({ backend: 'opencode', argv: ['kimaki', '--backend', 'opencode'], env: { [BOT_BACKEND_ENV]: 'jcode' } })).toEqual({ backend: 'opencode', source: 'flag' })
    })

    test('a blank value counts as unset, so the default applies', () => {
      expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: { [BOT_BACKEND_ENV]: '   ' } })).toEqual({ backend: 'jcode', source: 'default' })
    })

    test('selects opencode when no flag is given', () => {
      expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: { [BOT_BACKEND_ENV]: 'opencode' } })).toEqual({ backend: 'opencode', source: 'env' })
    })

    test('an unknown value is refused by the name of the variable, not the flag', () => {
      const result = resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: { [BOT_BACKEND_ENV]: 'jcode2' } })
      expect(result).toBeInstanceOf(ConfigError)
      if (!(result instanceof Error)) throw new Error('expected a refusal')
      expect(result.message).toContain(`Unknown ${BOT_BACKEND_ENV} "jcode2"`)
      expect(result.message).not.toContain('Unknown --backend')
    })

    test('an OpenCode-only option is refused when the environment selects jcode, naming the variable', () => {
      const result = resolveBotBackend({ backend: undefined, argv: ['kimaki', '--voice', 'cove'], env: { [BOT_BACKEND_ENV]: 'jcode' } })
      expect(result).toBeInstanceOf(Error)
      if (!(result instanceof Error)) throw new Error('expected a refusal')
      expect(result.message).toBe(`KIMAKI_BACKEND=jcode cannot use --voice: it is an OpenCode-only option with no jcode equivalent. Remove it, or unset KIMAKI_BACKEND to keep it.`)
    })
  })

  // A bare start resolves to jcode (Phase 1). Its refusal must not tell the operator
  // to drop a flag they never passed.
  test('an OpenCode-only option in a bare start names the default and offers --backend opencode', () => {
    const result = resolveBotBackend({ backend: undefined, argv: ['kimaki', '--voice', 'cove'], env: {} })
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) throw new Error('expected a refusal')
    expect(result.message).toBe(`The default backend (jcode) cannot use --voice: it is an OpenCode-only option with no jcode equivalent. Remove it, or pass --backend opencode.`)
  })

  // Phase 1.5: a stored OpenCode thread still needs OpenCode even when this start
  // resolved to jcode by default. The rule lives in shouldCheckOpencode, so both
  // halves are asserted together here.
  test('a legacy thread forces the OpenCode preflight when the backend resolved to jcode by default', () => {
    const choice = resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: {} })
    if (choice instanceof Error) throw choice
    expect(choice).toEqual({ backend: 'jcode', source: 'default' })
    expect(shouldCheckOpencode({ backend: choice.backend, legacyThreadCount: 0 })).toBe(false)
    expect(shouldCheckOpencode({ backend: choice.backend, legacyThreadCount: 1 })).toBe(true)
  })
})
