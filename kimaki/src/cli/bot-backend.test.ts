import { describe, expect, test } from 'vitest'

import { ConfigError } from '../errors.ts'
import { BOT_BACKENDS, OPENCODE_ONLY_OPTIONS, resolveBotBackend } from './bot.ts'

// `resolveBotBackend` is the pure gate the start action runs before it spawns the
// supervisor child, binds the lock port, opens SQLite or logs into Discord. Testing
// it proves the refusals; wiring it into the action is covered by inspection.

describe('resolveBotBackend', () => {
  test('absence of --backend yields opencode', () => {
    expect(resolveBotBackend({ backend: undefined, argv: ['kimaki'] })).toEqual({ backend: 'opencode' })
  })

  test('an explicit opencode value yields opencode', () => {
    expect(resolveBotBackend({ backend: 'opencode', argv: ['kimaki', '--backend', 'opencode'] })).toEqual({ backend: 'opencode' })
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
    expect(resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode'] })).toEqual({ backend: 'jcode' })
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
    expect(resolveBotBackend({ backend: 'jcode', argv: ['kimaki', '--backend', 'jcode', '--coordinator', 'false'] })).toEqual({ backend: 'jcode' })
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
})
