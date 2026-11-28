// Pure decision table for the Phase 2 startup gate. Every combination of
// backend, thread count, export record and abandonment record is asserted here;
// no Discord, SQLite or OpenCode process is needed.

import { describe, expect, test } from 'vitest'

import { ABANDON_REMEDY, EXPORT_REMEDY, exportRequiredFailure, opencodeThreadDisposition, type BotBackend, type OpencodeThreadDisposition } from './backend-selection.ts'

type Input = {
  backend: BotBackend
  legacyThreadCount: number
  exported: boolean
  abandoned: boolean
}

const disposition = (input: Input): OpencodeThreadDisposition => opencodeThreadDisposition(input)

describe('opencodeThreadDisposition', () => {
  const cases: Array<{ name: string; input: Input; expected: OpencodeThreadDisposition }> = []
  for (const backend of ['opencode', 'jcode'] as const) {
    for (const legacyThreadCount of [0, 1, 3]) {
      for (const exported of [false, true]) {
        for (const abandoned of [false, true]) {
          const reason = legacyThreadCount === 0 ? 'no-legacy-threads' : exported ? 'exported' : abandoned ? 'abandoned' : null
          const expected: OpencodeThreadDisposition = backend === 'opencode'
            ? { kind: 'proceed', reason: 'no-legacy-threads', legacyThreadCount }
            : reason === null
              ? { kind: 'export-required', legacyThreadCount }
              : { kind: 'proceed', reason, legacyThreadCount }
          cases.push({
            name: `${backend} count=${legacyThreadCount} exported=${exported} abandoned=${abandoned}`,
            input: { backend, legacyThreadCount, exported, abandoned },
            expected,
          })
        }
      }
    }
  }
  test.each(cases)('$name', ({ input, expected }) => {
    expect(disposition(input)).toEqual(expected)
  })

  test('the opencode backend is never gated, whatever the records say', () => {
    for (const legacyThreadCount of [0, 1, 3]) {
      for (const exported of [false, true]) {
        for (const abandoned of [false, true]) {
          expect(disposition({ backend: 'opencode', legacyThreadCount, exported, abandoned }).kind).toBe('proceed')
        }
      }
    }
  })

  test('an abandoned jcode start reports the count the operator wrote off', () => {
    expect(disposition({ backend: 'jcode', legacyThreadCount: 3, exported: false, abandoned: true })).toEqual({ kind: 'proceed', reason: 'abandoned', legacyThreadCount: 3 })
  })
})

describe('exportRequiredFailure', () => {
  test('names both exact remedies and no deletion', () => {
    const error = exportRequiredFailure({ source: 'default', legacyThreadCount: 2 })
    expect(error.name).toBe('ConfigError')
    expect(error.message).toContain('2 legacy OpenCode threads')
    expect(error.message).toContain(EXPORT_REMEDY)
    expect(error.message).toContain(ABANDON_REMEDY)
    expect(error.message).toContain('kimaki export opencode --out <dir>')
    expect(error.message).toContain('kimaki export abandon-opencode --data-dir <dir>')
    expect(error.message).toContain('backend jcode (default)')
    expect(error.message).toMatch(/^jcode backend \(backend jcode \(default\)\)/)
  })

  test('names the surface the operator actually used', () => {
    expect(exportRequiredFailure({ source: 'env', legacyThreadCount: 1 }).message).toContain('KIMAKI_BACKEND=jcode')
    expect(exportRequiredFailure({ source: 'flag', legacyThreadCount: 1 }).message).toContain('--backend jcode')
  })
})
