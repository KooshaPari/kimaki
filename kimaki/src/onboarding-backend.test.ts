// Phase 1.5: the OpenCode install check is an onboarding gate only for the opencode
// backend. For jcode it is a legacy compatibility check: it runs only when a persisted
// OpenCode thread needs it. These tests exercise the production gate and the unchanged
// onboarding error contract, not a parallel test-only implementation.

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ConfigError, OpenCodeMissingError } from './errors.ts'
import { legacyOpencodeCheckFailure, shouldCheckOpencode } from './backend-selection.ts'

const checkOpencode = vi.hoisted(() => vi.fn())
const clackConfirm = vi.hoisted(() => vi.fn())

vi.mock('./opencode-server.ts', () => ({
  checkOpencode,
  findOpencodeBinary: vi.fn(),
  installedOpencodeBinary: vi.fn(() => '/fake/opencode'),
  OPENCODE_INSTALL_COMMAND: 'curl -fsSL https://opencode.ai/v2/install | bash',
}))

// The install question is the one place a legacy run talks to the user about
// OpenCode, so it is captured rather than typed at a terminal. Everything else
// (the logger's symbols) must stay real.
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  confirm: clackConfirm,
}))

// The prompt only exists on a host where the installer could run. This test host has
// no /bin/bash, so report it present; every other path is the real filesystem.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = ((target: Parameters<typeof actual.existsSync>[0]) =>
    target === '/bin/bash' ? true : actual.existsSync(target)) as typeof actual.existsSync
  const withDefault = actual as unknown as typeof actual & { default: Record<string, unknown> }
  return { ...actual, existsSync, default: { ...withDefault.default, existsSync } }
})

import { ensureOpencode, opencodeInstallReason } from './onboarding.ts'

beforeEach(() => {
  checkOpencode.mockReset()
  clackConfirm.mockReset()
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
      expect(clackConfirm).not.toHaveBeenCalled()
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
    expect(surfaced.message).toContain('1 legacy OpenCode thread still requires OpenCode 2')
    expect(surfaced.message).toContain((result as Error).message)

    const surfacedEnv = legacyOpencodeCheckFailure({ backend: 'jcode', source: 'env', legacyThreadCount: 2, error: result as Error })
    expect(surfacedEnv.message).toContain('jcode backend')
    expect(surfacedEnv.message).toContain('KIMAKI_BACKEND=jcode')
    expect(surfacedEnv.message).toContain('2 legacy OpenCode threads')
  })
})

// Step 1.5 wording: a legacy run must say WHY OpenCode is wanted. A user mid-migration
// should read "a thread needs it", never a bare "installing OpenCode".
describe('opencodeInstallReason', () => {
  test('the opencode backend keeps the original wording', () => {
    expect(opencodeInstallReason({ legacyThreadCount: 0 })).toBe('Kimaki requires OpenCode 2')
  })

  test('a legacy jcode start names the thread that still needs OpenCode', () => {
    const one = opencodeInstallReason({ legacyThreadCount: 1 })
    expect(one).toContain('1 existing Discord thread was created with OpenCode and still needs it')
    expect(one).toContain('new threads do not')
    expect(one).not.toBe('Kimaki requires OpenCode 2')

    const many = opencodeInstallReason({ legacyThreadCount: 3 })
    expect(many).toContain('3 existing Discord threads were created with OpenCode and still need it')
  })
})

describe('install question', () => {
  // The question is only shown on a TTY. Force it, and hide OPENCODE_PATH (which
  // short-circuits the prompt) so the exact string the user sees is captured.
  async function askOnTTY<T>(run: () => Promise<T>): Promise<T> {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const savedPath = process.env['OPENCODE_PATH']
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    delete process.env['OPENCODE_PATH']
    try {
      return await run()
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor)
      else Reflect.deleteProperty(process.stdin as unknown as Record<string, unknown>, 'isTTY')
      if (savedPath !== undefined) process.env['OPENCODE_PATH'] = savedPath
    }
  }

  test('a legacy run asks to install and names the thread that needs it', async () => {
    checkOpencode.mockResolvedValueOnce('missing')
    clackConfirm.mockResolvedValueOnce(false)
    const result = await askOnTTY(() => ensureOpencode({ legacyThreadCount: 1 }))
    expect(clackConfirm).toHaveBeenCalledTimes(1)
    const message = String((clackConfirm.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message)
    expect(message).toContain('1 existing Discord thread was created with OpenCode and still needs it')
    expect(message).toContain('Install it now with')
    // Declining leaves the caller with the documented missing error, nothing installed.
    expect(result).toBeInstanceOf(OpenCodeMissingError)
  })

  test('the opencode backend question keeps the original wording', async () => {
    checkOpencode.mockResolvedValueOnce('missing')
    clackConfirm.mockResolvedValueOnce(false)
    await askOnTTY(() => ensureOpencode({}))
    const message = String((clackConfirm.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message)
    expect(message.startsWith('Kimaki requires OpenCode 2. Install it now with')).toBe(true)
    expect(message).not.toContain('existing Discord thread')
  })
})
