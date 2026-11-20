// Phase 1.5: the OpenCode install check is an onboarding gate only for the opencode
// backend. For jcode it is a legacy compatibility check: it runs only when a persisted
// OpenCode thread needs it. These tests exercise the production gate and the unchanged
// onboarding error contract, not a parallel test-only implementation.

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ConfigError, OpenCodeMissingError } from './errors.ts'
import { legacyOpencodeCheckFailure, shouldCheckOpencode } from './backend-selection.ts'

const checkOpencode = vi.hoisted(() => vi.fn())

vi.mock('./opencode-server.ts', () => ({
  checkOpencode,
  findOpencodeBinary: vi.fn(),
  installedOpencodeBinary: vi.fn(() => '/fake/opencode'),
  OPENCODE_INSTALL_COMMAND: 'curl -fsSL https://opencode.ai/v2/install | bash',
}))

import { ensureOpencode } from './onboarding.ts'

beforeEach(() => {
  checkOpencode.mockReset()
})

describe('shouldCheckOpencode', () => {
  test('jcode backend with no legacy thread does not check OpenCode', () => {
    expect(shouldCheckOpencode({ backend: 'jcode', legacyThreadCount: 0 })).toBe(false)
  })

  test('opencode backend always checks OpenCode, with or without threads', () => {
    expect(shouldCheckOpencode({ backend: 'opencode', legacyThreadCount: 0 })).toBe(true)
    expect(shouldCheckOpencode({ backend: 'opencode', legacyThreadCount: 2 })).toBe(true)
  })

  test('jcode backend with a legacy thread still runs the legacy check', () => {
    expect(shouldCheckOpencode({ backend: 'jcode', legacyThreadCount: 1 })).toBe(true)
    expect(shouldCheckOpencode({ backend: 'jcode', legacyThreadCount: 2 })).toBe(true)
  })
})

describe('legacy check', () => {
  test('jcode with no legacy thread never calls ensureOpencode or prints install text', async () => {
    const writes: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write)

    try {
      if (shouldCheckOpencode({ backend: 'jcode', legacyThreadCount: 0 })) {
        await ensureOpencode({})
      }
      expect(checkOpencode).not.toHaveBeenCalled()
      expect(writes.join('')).not.toContain('opencode.ai')
      expect(writes.join('')).not.toContain('Install it with')
    } finally {
      write.mockRestore()
    }
  })

  test('opencode backend calls the unchanged check once and keeps the original error', async () => {
    const error = new OpenCodeMissingError({ install: 'curl -fsSL https://opencode.ai/v2/install | bash' })
    checkOpencode.mockResolvedValueOnce(error)
    expect(shouldCheckOpencode({ backend: 'opencode', legacyThreadCount: 0 })).toBe(true)
    const result = await ensureOpencode({})
    expect(checkOpencode).toHaveBeenCalledTimes(1)
    expect(result).toBe(error)
    expect(result).toBeInstanceOf(OpenCodeMissingError)
    expect(result).not.toBeInstanceOf(ConfigError)
    expect((result as Error).message).toContain('Install it with: curl -fsSL https://opencode.ai/v2/install | bash')
    const surfaced = legacyOpencodeCheckFailure({ backend: 'opencode', source: 'default', legacyThreadCount: 0, error: result as Error })
    expect(surfaced).toBe(result)
    expect(surfaced.message).toBe((result as Error).message)
  })

  test('jcode backend with a legacy thread runs the same check once and names backend/surface in the refusal', async () => {
    const error = new OpenCodeMissingError({ install: 'curl -fsSL https://opencode.ai/v2/install | bash' })
    checkOpencode.mockResolvedValueOnce(error)
    expect(shouldCheckOpencode({ backend: 'jcode', legacyThreadCount: 1 })).toBe(true)
    const result = await ensureOpencode({})
    expect(checkOpencode).toHaveBeenCalledTimes(1)
    expect(result).toBe(error)
    expect(result).toBeInstanceOf(OpenCodeMissingError)
    expect(result).not.toBeInstanceOf(ConfigError)

    const surfaced = legacyOpencodeCheckFailure({ backend: 'jcode', source: 'flag', legacyThreadCount: 1, error: result as Error })
    expect(surfaced).toBeInstanceOf(ConfigError)
    expect(surfaced).not.toBe(result)
    expect(surfaced.message).toContain('jcode backend')
    expect(surfaced.message).toContain('--backend jcode')
    expect(surfaced.message).toContain('1 legacy OpenCode thread')
    expect(surfaced.message).toContain((result as Error).message)

    const surfacedEnv = legacyOpencodeCheckFailure({ backend: 'jcode', source: 'env', legacyThreadCount: 2, error: result as Error })
    expect(surfacedEnv.message).toContain('jcode backend')
    expect(surfacedEnv.message).toContain('KIMAKI_BACKEND=jcode')
    expect(surfacedEnv.message).toContain('2 legacy OpenCode threads')
  })
})
