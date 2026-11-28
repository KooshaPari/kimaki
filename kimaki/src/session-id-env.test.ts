// Precedence and deprecation behavior for session ID env vars (Phase 2.6).
import { expect, test, vi } from 'vitest'

vi.mock('./logger.ts', () => {
  const warn = vi.fn()
  return {
    createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }
})

import { readSessionIdEnv, resetSessionIdEnvDeprecationForTests } from './session-id-env.ts'
import { createLogger } from './logger.ts'

test('old only -> read and deprecation logged once', () => {
  resetSessionIdEnvDeprecationForTests()
  const logger = createLogger('SESSION_ENV') as unknown as { warn: ReturnType<typeof vi.fn> }
  logger.warn.mockClear()

  const env = { OPENCODE_SESSION_ID: 'old-id' } as NodeJS.ProcessEnv
  expect(readSessionIdEnv(env)).toBe('old-id')
  expect(readSessionIdEnv(env)).toBe('old-id')
  expect(logger.warn).toHaveBeenCalledTimes(1)
  expect(logger.warn.mock.calls[0]?.[0]).toContain('deprecated')
})

test('new only -> read, no deprecation', () => {
  resetSessionIdEnvDeprecationForTests()
  const logger = createLogger('SESSION_ENV') as unknown as { warn: ReturnType<typeof vi.fn> }
  logger.warn.mockClear()

  const env = { KIMAKI_SESSION_ID: 'new-id' } as NodeJS.ProcessEnv
  expect(readSessionIdEnv(env)).toBe('new-id')
  expect(logger.warn).not.toHaveBeenCalled()
})

test('both different -> new wins', () => {
  resetSessionIdEnvDeprecationForTests()
  const logger = createLogger('SESSION_ENV') as unknown as { warn: ReturnType<typeof vi.fn> }
  logger.warn.mockClear()

  const env = { KIMAKI_SESSION_ID: 'new-id', OPENCODE_SESSION_ID: 'old-id' } as NodeJS.ProcessEnv
  expect(readSessionIdEnv(env)).toBe('new-id')
  expect(logger.warn).not.toHaveBeenCalled()
})

test('neither -> unchanged (undefined)', () => {
  resetSessionIdEnvDeprecationForTests()
  const logger = createLogger('SESSION_ENV') as unknown as { warn: ReturnType<typeof vi.fn> }
  logger.warn.mockClear()

  expect(readSessionIdEnv({} as NodeJS.ProcessEnv)).toBeUndefined()
  expect(logger.warn).not.toHaveBeenCalled()
})

import { sessionIdChildEnv } from './session-id-env.ts'

test('sessionIdChildEnv exports both names for spawned children', () => {
  expect(sessionIdChildEnv('sess-123')).toEqual({
    KIMAKI_SESSION_ID: 'sess-123',
    OPENCODE_SESSION_ID: 'sess-123',
  })
})
