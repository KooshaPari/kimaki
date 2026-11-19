import { describe, expect, test } from 'vitest'

import { ConfigError } from '../errors.ts'
import { BOT_BACKEND_ENV, BOT_BACKENDS, OPENCODE_ONLY_OPTIONS, resolveBotBackend } from './bot.ts'

// `resolveBotBackend` is the pure gate the start action runs before it spawns the
// supervisor child, binds the lock port, opens SQLite or logs into Discord. Testing
// it proves the refusals; wiring it into the action is covered by inspection.

describe('resolveBotBackend', () => {
  test('absence of --backend yields opencode', () => {
    expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: {} })).toEqual({ backend: 'opencode', source: 'default' })
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
    expect(result.message).toBe(`Unknown --backend "jcode2". Use one of: ${BOT_BACKENDS.join(', ')}`)
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

    test('a blank value counts as unset', () => {
      expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: { [BOT_BACKEND_ENV]: '   ' } })).toEqual({ backend: 'opencode', source: 'default' })
    })

    test('an unknown value is refused by the name of the variable, not the flag', () => {
      const result = resolveBotBackend({ backend: undefined, argv: ['kimaki'], env: { [BOT_BACKEND_ENV]: 'jcode2' } })
      expect(result).toBeInstanceOf(ConfigError)
      if (!(result instanceof Error)) throw new Error('expected a refusal')
      expect(result.message).toContain(`Unknown ${BOT_BACKEND_ENV} "jcode2"`)
      expect(result.message).not.toContain('Unknown --backend')
    })

    test('an OpenCode-only option is refused when the environment selects jcode', () => {
      const result = resolveBotBackend({ backend: undefined, argv: ['kimaki', '--voice', 'cove'], env: { [BOT_BACKEND_ENV]: 'jcode' } })
      expect(result).toBeInstanceOf(Error)
      if (!(result instanceof Error)) throw new Error('expected a refusal')
      expect(result.message).toContain('--backend jcode cannot use --voice')
    })
  })
})
