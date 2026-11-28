import childProcess from 'node:child_process'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConfigError } from '../../errors.js'
import {
  classifyProcessIdentity,
  createProcessOracle,
  observeProcesses,
  reconcileAgainstOracle,
  reconcileDiscovery,
  type InventoryProcessEntry,
  type ProcessIdentity,
  type ProcessInventory,
  type ProcessTable,
} from './process-oracle.js'

const table = (processes: ProcessIdentity[], source = 'oracle:fixture'): ProcessTable =>
  ({ source, observedAt: 1_700_000_000_000, coverage: 'explicit-pids', processes })

const inventory = (entries: InventoryProcessEntry[], source = 'inventory:fixture'): ProcessInventory =>
  ({ source, observedAt: 1_700_000_000_000, entries })

const identity = (pid: number, birthMarker: string | null = `born-${pid}`): ProcessIdentity => ({ pid, birthMarker })

afterEach(() => { vi.restoreAllMocks() })

describe('reconcileDiscovery', () => {
  test('AC01: agrees for real OpenCode, Codex and Jcode inventories when every birth marker matches', () => {
    const result = reconcileDiscovery({
      inventory: inventory([
        { sessionId: 'opencode-session', process: identity(101) },
        { sessionId: 'codex-thread', process: identity(202) },
        { sessionId: 'jcode-session', process: identity(303) },
      ]),
      snapshot: table([identity(101), identity(202), identity(303)]),
    })
    expect(result).toMatchObject({
      inventory: { count: 3 },
      oracle: { count: 3 },
      countsAgree: true,
      reconciled: true,
      unobserved: [],
    })
    expect(result instanceof Error ? [] : result.matches).toEqual([
      { kind: 'matched', sessionId: 'opencode-session', pid: 101 },
      { kind: 'matched', sessionId: 'codex-thread', pid: 202 },
      { kind: 'matched', sessionId: 'jcode-session', pid: 303 },
    ])
  })

  test('reports inventory sessions whose process the oracle cannot see', () => {
    const result = reconcileDiscovery({
      inventory: inventory([
        { sessionId: 'live-session', process: identity(101) },
        { sessionId: 'phantom-session', process: identity(404) },
      ]),
      snapshot: table([identity(101)]),
    })
    expect(result).toMatchObject({ countsAgree: false, reconciled: false })
    expect(result instanceof Error ? [] : result.matches).toEqual([
      { kind: 'matched', sessionId: 'live-session', pid: 101 },
      expect.objectContaining({ kind: 'missing-process', sessionId: 'phantom-session', pid: 404 }),
    ])
    expect(result instanceof Error ? '' : result.matches[1]).toMatchObject({
      reason: expect.stringContaining('the oracle does not see that process'),
    })
  })

  test('AC01: compares counts even when the inventory has no pid metadata', () => {
    const withoutProcesses = reconcileDiscovery({
      inventory: inventory([
        { sessionId: 'opencode-session', process: null },
        { sessionId: 'codex-thread', process: null },
        { sessionId: 'jcode-session', process: null },
      ]),
      snapshot: table([identity(11), identity(12)]),
    })
    expect(withoutProcesses).toMatchObject({
      inventory: { count: 3 },
      oracle: { count: 2 },
      countsAgree: false,
      reconciled: false,
    })
    // Every identity remains unknown: a count mismatch is visible, but the
    // missing per-session pid is never invented to make the numbers match.
    expect(withoutProcesses instanceof Error ? [] : withoutProcesses.matches.map((match) => match.kind))
      .toEqual(['unknown', 'unknown', 'unknown'])
  })

  test('reports an observable process that no inventory entry claims', () => {
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 'jcode-session', process: identity(101) }]),
      snapshot: table([identity(101), identity(909)]),
    })
    expect(result).toMatchObject({ countsAgree: false, reconciled: false })
    expect(result instanceof Error ? [] : result.unobserved).toEqual([
      { kind: 'unobserved-process', pid: 909, birthMarker: 'born-909', reason: expect.stringContaining('no inventory entry claims it') },
    ])
  })

  test('AC08: reports a reused pid instead of attributing the old identity', () => {
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 'old-jcode-session', process: identity(555, '2026-11-11T01:00:00Z') }]),
      snapshot: table([identity(555, '2026-11-14T09:00:00Z')]),
    })
    expect(result).toMatchObject({ countsAgree: true, reconciled: false })
    expect(result instanceof Error ? [] : result.matches).toEqual([{
      kind: 'reused',
      sessionId: 'old-jcode-session',
      pid: 555,
      recordedMarker: '2026-11-11T01:00:00Z',
      liveMarker: '2026-11-14T09:00:00Z',
      reason: expect.stringContaining('the pid was reused, so this is unknown'),
    }])
  })

  test('AC08: a recorded pid without a birth marker is unknown, never matched', () => {
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 'markerless', process: identity(777, null) }]),
      snapshot: table([identity(777, 'any-marker')]),
    })
    expect(result instanceof Error ? [] : result.matches).toEqual([{
      kind: 'unknown',
      sessionId: 'markerless',
      pid: 777,
      reason: expect.stringContaining('a pid alone is not an identity'),
    }])
    expect(result).toMatchObject({ reconciled: false })
  })

  test('AC08: a live pid without a birth marker is unknown, never matched', () => {
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 'recorded', process: identity(778, 'recorded-marker') }]),
      snapshot: table([identity(778, null)]),
    })
    expect(result instanceof Error ? [] : result.matches).toEqual([{
      kind: 'unknown',
      sessionId: 'recorded',
      pid: 778,
      reason: expect.stringContaining('could not read a birth marker'),
    }])
  })

  test('counts can agree while identities disagree, so agreement is not attribution', () => {
    const result = reconcileDiscovery({
      inventory: inventory([
        { sessionId: 'a', process: identity(1, 'old-a') },
        { sessionId: 'b', process: identity(2, 'old-b') },
      ]),
      snapshot: table([identity(1, 'new-a'), identity(2, 'new-b')]),
    })
    expect(result).toMatchObject({ countsAgree: true, reconciled: false })
    expect(result instanceof Error ? [] : result.matches.every((match) => match.kind === 'reused')).toBe(true)
  })

  test('an inventory entry with no process identity stays visible as unknown', () => {
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 'no-process-claim', process: null }]),
      snapshot: table([]),
    })
    expect(result).toMatchObject({ countsAgree: false, reconciled: false })
    expect(result instanceof Error ? [] : result.matches).toEqual([{
      kind: 'unknown',
      sessionId: 'no-process-claim',
      pid: null,
      reason: expect.stringContaining('no recorded process identity'),
    }])
  })

  test('emits only pid and birth metadata, never transcript or terminal fields', () => {
    const secret = {
      transcript: 'SECRET transcript text', terminalInput: 'SECRET keystrokes', cwd: 'C:\\SECRET',
      process: { ...identity(11), environment: 'SECRET=1', command: 'SECRET --token' },
    }
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 's1', ...secret } as InventoryProcessEntry]),
      snapshot: table([{ ...identity(11), command: 'SECRET' } as ProcessIdentity]),
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('transcript')
    expect(JSON.stringify(result)).not.toContain('environment')
  })

  test('rejects a table that lists the same pid twice and duplicate inventory sessions', () => {
    const duplicatePid = reconcileDiscovery({
      inventory: inventory([{ sessionId: 's1', process: identity(1) }]),
      snapshot: table([identity(1), identity(1)]),
    })
    expect(duplicatePid).toBeInstanceOf(ConfigError)
    expect(duplicatePid instanceof Error ? duplicatePid.message : '').toContain('more than once')

    const duplicateSession = reconcileDiscovery({
      inventory: inventory([
        { sessionId: 's1', process: identity(1) },
        { sessionId: 's1', process: identity(2) },
      ]),
      snapshot: table([identity(1), identity(2)]),
    })
    expect(duplicateSession).toBeInstanceOf(ConfigError)
  })

  test('does not shell out to compute the comparison', () => {
    const exec = vi.spyOn(childProcess, 'execFile')
    const result = reconcileDiscovery({
      inventory: inventory([{ sessionId: 's1', process: identity(1) }]),
      snapshot: table([identity(1)]),
    })
    expect(result).toMatchObject({ reconciled: true })
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('classifyProcessIdentity', () => {
  test.each([
    [{ recorded: identity(1, 'a'), live: identity(1, 'a') }, 'matched'],
    [{ recorded: identity(1, 'a'), live: identity(1, 'b') }, 'reused'],
    [{ recorded: identity(1, null), live: identity(1, 'a') }, 'unknown'],
    [{ recorded: identity(1, 'a'), live: identity(1, null) }, 'unknown'],
    [{ recorded: identity(1, 'a'), live: identity(2, 'a') }, 'unknown'],
  ] as const)('%j classifies as %s', (input, expected) => {
    expect(classifyProcessIdentity(input)).toBe(expected)
  })
})

describe('process oracle enumeration', () => {
  test('reads the real process table for this process and returns a birth marker', async () => {
    if (!['win32', 'linux', 'darwin', 'freebsd'].includes(process.platform)) return
    const snapshot = await observeProcesses({ pids: [process.pid], timeoutMs: 30_000 })
    expect(snapshot).not.toBeInstanceOf(ConfigError)
    const processes = snapshot instanceof Error ? [] : snapshot.processes
    expect(processes.map((entry) => entry.pid)).toEqual([process.pid])
    expect(processes[0]?.birthMarker).toEqual(expect.any(String))
  })

  test('win32 runner uses a noninteractive powershell and filters the explicit pid', async () => {
    const runner = vi.fn(async () => JSON.stringify([
      { ProcessId: 42, CreationDate: '/Date(1700000000000)/', Name: 'jcode.exe' },
      { ProcessId: 43, CreationDate: '/Date(1700000000001)/', Name: 'codex.exe' },
    ]))
    const oracle = createProcessOracle({ platform: 'win32', runner })
    const snapshot = await oracle.snapshot({ pids: [42] })
    expect(runner).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    ]), { timeoutMs: 10_000 })
    expect(snapshot).toMatchObject({
      source: 'process-oracle:win32',
      coverage: 'explicit-pids',
      processes: [{ pid: 42, birthMarker: '/Date(1700000000000)/' }],
    })
  })

  test('posix runner parses lstart and applies the name filter', async () => {
    const stdout = [
      '  101 Fri Nov 14 09:00:00 2026 jcode',
      '  102 Fri Nov 14 09:01:00 2026 codex',
    ].join('\n')
    const oracle = createProcessOracle({ platform: 'linux', runner: async () => stdout })
    expect(await oracle.snapshot({ nameIncludes: 'jcode' })).toMatchObject({
      processes: [{ pid: 101, birthMarker: 'Fri Nov 14 09:00:00 2026' }],
    })
  })

  test('rejects an absent scope, mixed scope, shell-metacharacter filter and unsupported platform', async () => {
    const oracle = createProcessOracle({ platform: 'win32', runner: async () => '[]' })
    expect(await oracle.snapshot({})).toBeInstanceOf(ConfigError)
    expect(await oracle.snapshot({ pids: [1], nameIncludes: 'jcode' })).toBeInstanceOf(ConfigError)
    expect(await oracle.snapshot({ nameIncludes: "jcode'; rm -rf /" })).toBeInstanceOf(ConfigError)
    expect(await createProcessOracle({ platform: 'aix', runner: async () => '' }).snapshot({ pids: [1] }))
      .toBeInstanceOf(ConfigError)
  })

  test('reconciliation through an oracle is a seam: the oracle is replaced, not shelled out', async () => {
    const exec = vi.spyOn(childProcess, 'execFile')
    const calls: Array<{ pids?: number[] } | undefined> = []
    const oracle = {
      async snapshot(options?: { pids?: number[] }) {
        calls.push(options)
        return table([identity(1)])
      },
    }
    const result = await reconcileAgainstOracle({
      inventory: inventory([{ sessionId: 's1', process: identity(1) }]),
      oracle,
      scope: { pids: [1] },
    })
    expect(result).toMatchObject({ countsAgree: true, reconciled: true })
    expect(calls).toEqual([{ pids: [1] }])
    expect(exec).not.toHaveBeenCalled()
  })
})
