import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createJcodeObserver, type JcodeObservedEvent } from './jcode.js'

// A synthetic Jcode home. The records deliberately carry transcript and tool
// content so the tests can prove none of it reaches the output.
function home(records: Record<string, unknown>) {
  const files = Object.fromEntries(Object.entries(records).map(([name, value]) => [`${name}.json`, JSON.stringify(value)]))
  return {
    readDir: async () => Object.keys(files),
    readFile: async (path: string) => {
      const name = path.split('/').pop() ?? ''
      if (!(name in files)) throw new Error(`missing ${name}`)
      return files[name]!
    },
  }
}

const session = (id: string, title: string | null, updated: string | null) => ({
  id,
  title,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: updated,
  provider_key: 'openai-api',
  model: 'some-model',
  working_dir: 'C:/private/project',
  messages: [{ role: 'user', content: 'SECRET TRANSCRIPT TEXT' }],
  tool_calls: [{ name: 'bash', input: 'rm -rf /' }],
})

const observer = (records: Record<string, unknown>, endpoints = { hostId: 'host', endpointId: 'endpoint' }) => {
  const result = createJcodeObserver({ jcodeHome: 'C:/jcode-home', ...endpoints, ...home(records) })
  if (result instanceof Error) throw result
  return result
}

describe('Jcode passive discovery', () => {
  it('emits only identity and title from a real session record shape', async () => {
    const page = await observer({ session_new: session('session_new', 'Visible title', '2026-02-02T00:00:00Z') }).discover()
    if (page instanceof Error) throw page
    expect(page.sessions).toEqual([
      { key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_new' }, title: 'Visible title' },
    ])
    expect(Object.keys(page.sessions[0]!).sort()).toEqual(['key', 'title'])
    expect(JSON.stringify(page)).not.toContain('SECRET TRANSCRIPT TEXT')
    expect(JSON.stringify(page)).not.toContain('rm -rf')
    expect(JSON.stringify(page)).not.toContain('private/project')
  })

  it('orders newest first, paginates deterministically and skips malformed records', async () => {
    const records = {
      session_a: session('session_a', 'older', '2026-01-01T00:00:00Z'),
      session_b: session('session_b', 'newer', '2026-03-01T00:00:00Z'),
      session_c: 'not json at all',
      session_d: { title: 'no id' },
    }
    const first = await observer(records).discover({ limit: 2 })
    if (first instanceof Error) throw first
    expect(first.sessions.map((entry) => entry.title)).toEqual(['newer', 'older'])
    expect(first.cursor).toBeNull()
    const paged = await observer({ ...records, session_e: session('session_e', 'newest', '2026-04-01T00:00:00Z') }).discover({ limit: 2 })
    if (paged instanceof Error) throw paged
    expect(paged.sessions.map((entry) => entry.title)).toEqual(['newest', 'newer'])
    expect(paged.cursor).toBe('2')
    const next = await observer({ ...records, session_e: session('session_e', 'newest', '2026-04-01T00:00:00Z') }).discover({ limit: 2, cursor: '2' })
    if (next instanceof Error) throw next
    expect(next.sessions.map((entry) => entry.title)).toEqual(['older'])
    expect(next.cursor).toBeNull()
  })

  it('reads one snapshot by identity and rejects mismatches', async () => {
    const target = observer({ session_a: session('session_a', 'titled', null) })
    expect(await target.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_a' } }))
      .toEqual({
        key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_a' },
        source: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', profileId: 'jcode' },
        session: { id: 'session_a', title: 'titled' },
      })
    expect(await target.readSnapshot({ key: { hostId: 'host', endpointId: 'other', backendKind: 'jcode', nativeSessionId: 'session_a' } })).toBeInstanceOf(Error)
    expect(await target.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_missing' } })).toBeInstanceOf(Error)
  })

  it('declares supported and unsupported capabilities and refuses an implicit home', () => {
    const supported = observer({})
    expect(supported.capabilities.discovery.kind).toBe('supported')
    expect(supported.capabilities.snapshot.kind).toBe('supported')
    expect(supported.capabilities.observe.kind).toBe('supported')
    expect(supported.capabilities.replay.kind).toBe('unsupported')
    expect(supported.capabilities.exclusiveControl.kind).toBe('unsupported')
    expect(createJcodeObserver({ jcodeHome: '  ', hostId: 'h', endpointId: 'e', readFile: async () => '', readDir: async () => [] })).toBeInstanceOf(Error)
    expect(createJcodeObserver({ jcodeHome: 'C:/home', hostId: '', endpointId: 'e', readFile: async () => '', readDir: async () => [] })).toBeInstanceOf(Error)
  })
})

describe('Jcode passive observation', () => {
  it('emits title and message-count changes without any content', async () => {
    let record: Record<string, unknown> = session('session_live', 'before', '2026-01-01T00:00:00Z')
    const live = createJcodeObserver({
      jcodeHome: 'C:/jcode-home', hostId: 'host', endpointId: 'endpoint', intervalMs: 10,
      readDir: async () => ['session_live.json'],
      readFile: async () => JSON.stringify(record),
    })
    if (live instanceof Error) throw live
    const events: unknown[] = []
    const controller = new AbortController()
    const observation = await live.observe({
      key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_live' },
      signal: controller.signal,
      onEvent: (event) => { events.push(event) },
    })
    if (observation instanceof Error) throw observation
    record = {
      ...session('session_live', 'after', '2026-01-01T00:00:01Z'),
      messages: [
        { role: 'user', content: 'SECRET TRANSCRIPT TEXT' },
        { role: 'assistant', content: 'more secret text' },
      ],
    }
    await expect.poll(() => events.length, { timeout: 5_000 }).toBe(2)
    observation.detach()
    expect(await observation.done).toBeNull()
    expect(events).toEqual([
      { schemaVersion: 1, key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_live' }, seq: 1, type: 'session.renamed', title: 'after' },
      { schemaVersion: 1, key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_live' }, seq: 2, type: 'session.appended', messageCount: 2 },
    ])
    expect(JSON.stringify(events)).not.toContain('SECRET')
  })

  it('rejects observation of a mismatched or missing session', async () => {
    const live = observer({})
    expect(await live.observe({ key: { hostId: 'host', endpointId: 'other', backendKind: 'jcode', nativeSessionId: 'session_x' }, onEvent: () => {} })).toBeInstanceOf(Error)
    expect(await live.observe({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_missing' }, onEvent: () => {} })).toBeInstanceOf(Error)
  })

  it('reads persisted state without writing to the home or reviving a session', async () => {
    const writes: string[] = []
    const reads: string[] = []
    const readOnly = createJcodeObserver({
      jcodeHome: 'C:/jcode-read-only',
      hostId: 'host',
      endpointId: 'endpoint',
      readDir: async (dir) => {
        reads.push(`dir:${dir}`)
        return ['session_a.json']
      },
      readFile: async (file) => {
        reads.push(`file:${file}`)
        return JSON.stringify({ id: 'session_a', title: 'Persisted', updated_at: '2026-01-01T00:00:00Z' })
      },
    })
    if (readOnly instanceof Error) throw readOnly
    const page = await readOnly.discover()
    if (page instanceof Error) throw page
    const snapshot = await readOnly.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_a' } })
    expect(snapshot).not.toBeInstanceOf(Error)
    // The whole surface is reads: no write, mkdir, unlink or spawn is reachable from it.
    expect(reads.length).toBeGreaterThan(0)
    expect(writes).toEqual([])
    expect(Object.keys(readOnly).sort()).toEqual(['capabilities', 'discover', 'observe', 'profile', 'readSnapshot'])
  })
})

// AC39: KCode shares the ACP surface and the sessions/session_*.json layout
// with stock jcode but owns a different executable, store and KCODE_*
// environment, and its reporter claims `jcode`. The profile, never the
// self-reported label, decides which store is read.
describe('Runtime profile identity', () => {
  const kcodeHome = (records: Record<string, unknown>) => {
    const files = Object.fromEntries(Object.entries(records).map(([name, value]) => [`${name}.json`, JSON.stringify(value)]))
    const reads: string[] = []
    return {
      reads,
      readDir: async (path: string) => {
        reads.push(`dir:${path}`)
        return Object.keys(files)
      },
      readFile: async (path: string) => {
        reads.push(`file:${path}`)
        const name = path.split('/').pop() ?? ''
        if (!(name in files)) throw new Error(`missing ${name}`)
        return files[name]!
      },
    }
  }

  it('preserves a kcode profile end to end: store, provenance and label are kcode', async () => {
    const source = kcodeHome({ session_k: session('session_k', 'KCode session', '2026-05-01T00:00:00Z') })
    const observer = createJcodeObserver({
      jcodeHome: 'C:/Users/koosh/.kcode',
      profile: 'kcode',
      hostId: 'host',
      endpointId: 'endpoint',
      ...source,
    })
    if (observer instanceof Error) throw observer

    // Provenance: the kcode profile, with the family label kept separate.
    expect(observer.profile).toEqual({
      id: 'kcode',
      executable: 'kcode',
      envPrefix: 'KCODE_',
      storeDir: '~/.kcode',
      expectedIdentity: { name: 'jcode', fork: true },
    })

    const page = await observer.discover()
    if (page instanceof Error) throw page
    expect(page.source).toEqual({ hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', profileId: 'kcode' })
    expect(page.sessions).toEqual([
      { key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_k' }, title: 'KCode session' },
    ])
    // Only the kcode store was read, never ~/.jcode.
    expect(source.reads.length).toBeGreaterThan(0)
    expect(source.reads.every((path) => path.includes('.kcode') && !path.includes('.jcode'))).toBe(true)

    const snapshot = await observer.readSnapshot({
      key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_k' },
    })
    if (snapshot instanceof Error) throw snapshot
    expect(snapshot.source.profileId).toBe('kcode')
  })

  it('exposes the stock jcode profile as provenance by default, not an inferred label', async () => {
    const stock = observer({ session_a: session('session_a', 'titled', null) })
    // The observer's own profile is the provenance a publication label must use;
    // an omitted profile resolves to stock jcode rather than to whatever the
    // session claims.
    expect(stock.profile.id).toBe('jcode')
    const snapshot = await stock.readSnapshot({ key: { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode', nativeSessionId: 'session_a' } })
    if (snapshot instanceof Error) throw snapshot
    expect(snapshot.source.profileId).toBe(stock.profile.id)
  })

  it('refuses an unknown profile without reading any store (observer path)', () => {
    const reads: string[] = []
    const refused = createJcodeObserver({
      jcodeHome: 'C:/Users/koosh/.kcode',
      profile: 'kcode-fork',
      hostId: 'host',
      endpointId: 'endpoint',
      readDir: async (path) => {
        reads.push(path)
        return []
      },
      readFile: async (path) => {
        reads.push(path)
        return ''
      },
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain("Unknown runtime profile 'kcode-fork'")
    expect((refused as Error).message).toContain('jcode, kcode')
    expect(reads).toEqual([])
  })

  it('refuses a kcode profile pointed at the stock .jcode store (publication label path)', () => {
    const reads: string[] = []
    const refused = createJcodeObserver({
      jcodeHome: 'C:/Users/koosh/.jcode',
      profile: 'kcode',
      hostId: 'host',
      endpointId: 'endpoint',
      readDir: async (path) => {
        reads.push(path)
        return []
      },
      readFile: async (path) => {
        reads.push(path)
        return ''
      },
    })
    expect(refused).toBeInstanceOf(Error)
    const message = (refused as Error).message
    expect(message).toContain('Runtime profile kcode expects store ~/.kcode')
    expect(message).toContain("ends in '.jcode'")
    // No fallback: the stock store is never read for a kcode identity.
    expect(reads).toEqual([])
  })

  it('refuses a jcode profile pointed at the kcode store', () => {
    const refused = createJcodeObserver({
      jcodeHome: 'C:/Users/koosh/.kcode',
      profile: 'jcode',
      hostId: 'host',
      endpointId: 'endpoint',
      readDir: async () => [],
      readFile: async () => '',
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('expects store ~/.jcode')
    expect((refused as Error).message).toContain("ends in '.kcode'")
  })

  it('refuses a missing store and names the profile it expected', () => {
    const refused = createJcodeObserver({
      profile: 'kcode',
      hostId: 'host',
      endpointId: 'endpoint',
      readDir: async () => [],
      readFile: async () => '',
    })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain('Runtime profile kcode needs an explicit store (expected ~/.kcode)')
  })
})

// AC37: a persisted session must not be mistaken for live, and a live turn's
// writes must not be mistaken for the session itself. These tests use a real
// directory that the test rewrites while the observer polls it, so a torn read
// is a real torn read rather than a mock.
describe('Jcode concurrent write consistency', () => {
  const homes: string[] = []

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const liveKey = { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode' as const, nativeSessionId: 'session_live' }

  const recordBytes = (title: string, messages = 1) => JSON.stringify({
    id: 'session_live',
    title,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    working_dir: 'C:/private/project',
    messages: Array.from({ length: messages }, () => ({ role: 'user', content: 'SECRET TRANSCRIPT TEXT' })),
    tool_calls: [{ name: 'bash', input: 'rm -rf /' }],
  })

  const makeHome = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jcode-concurrent-'))
    homes.push(dir)
    await mkdir(join(dir, 'sessions'), { recursive: true })
    return dir
  }

  const sessionPath = (dir: string) => join(dir, 'sessions', 'session_live.json')

  const realObserver = (dir: string, intervalMs = 5) => {
    const result = createJcodeObserver({
      jcodeHome: dir,
      hostId: 'host',
      endpointId: 'endpoint',
      intervalMs,
      readFile: (path) => readFile(path, 'utf8'),
      readDir: (path) => readdir(path),
    })
    if (result instanceof Error) throw result
    return result
  }

  // Bytes and mtime of the observed record. Reading does not change either, so
  // an unchanged fingerprint proves the observer never wrote to the store.
  const fingerprint = async (dir: string) => {
    const file = sessionPath(dir)
    const bytes = await readFile(file)
    const info = await stat(file)
    return { sha256: createHash('sha256').update(bytes).digest('hex'), mtimeMs: info.mtimeMs, size: info.size }
  }

  it('observes a complete real write as a consistent session', async () => {
    const dir = await makeHome()
    await writeFile(sessionPath(dir), recordBytes('Complete title', 2))
    const obs = realObserver(dir)

    const page = await obs.discover()
    if (page instanceof Error) throw page
    expect(page.observation).toEqual({ health: 'consistent', skippedTransient: 0 })
    expect(page.sessions).toEqual([{ key: liveKey, title: 'Complete title' }])

    const snapshot = await obs.readSnapshot({ key: liveKey })
    if (snapshot instanceof Error) throw snapshot
    expect(snapshot.session).toEqual({ id: 'session_live', title: 'Complete title' })
    expect(JSON.stringify(page)).not.toContain('SECRET')
  })

  it('never turns a half-written record into a session or a truncated title', async () => {
    const dir = await makeHome()
    await writeFile(sessionPath(dir), recordBytes('Complete title'))
    const obs = realObserver(dir)

    // A native turn is mid-append: the file currently ends inside the title.
    await writeFile(sessionPath(dir), '{"id":"session_live","title":"Torn ti')
    const midWrite = await fingerprint(dir)

    const torn = await obs.readSnapshot({ key: liveKey })
    expect(torn).toBeInstanceOf(Error)
    const message = (torn as Error).message
    expect(message).toContain('transient')
    // The torn bytes never become a title.
    expect(message).not.toContain('Torn ti')

    // Discovery skips the transient record instead of inventing a session.
    const tornPage = await obs.discover()
    if (tornPage instanceof Error) throw tornPage
    expect(tornPage.sessions).toEqual([])
    expect(tornPage.observation).toEqual({ health: 'transient', skippedTransient: 1 })

    // Reading, even of a torn record, is read-only.
    expect(await fingerprint(dir)).toEqual(midWrite)

    // The writer completes the append.
    await writeFile(sessionPath(dir), recordBytes('Final title'))
    const settled = await obs.readSnapshot({ key: liveKey })
    if (settled instanceof Error) throw settled
    expect(settled.session).toEqual({ id: 'session_live', title: 'Final title' })
  })

  it('observes an atomic replacement exactly once', async () => {
    const dir = await makeHome()
    await writeFile(sessionPath(dir), recordBytes('Alpha', 1))
    const obs = realObserver(dir)
    const events: JcodeObservedEvent[] = []
    const observation = await obs.observe({ key: liveKey, onEvent: (event) => { events.push(event) } })
    if (observation instanceof Error) throw observation

    // The turn replaces the whole record atomically: new title, one more message.
    const temp = join(dir, 'sessions', 'session_live.json.tmp')
    await writeFile(temp, recordBytes('Beta', 2))
    await rename(temp, sessionPath(dir))

    await expect.poll(() => events.length, { timeout: 3_000 }).toBe(2)
    // Give several more poll intervals: a re-read of the settled record must not
    // emit the replacement a second time.
    await new Promise((resolve) => setTimeout(resolve, 60))
    observation.detach()
    expect(await observation.done).toBeNull()

    expect(events.filter((event) => event.type === 'session.renamed')).toEqual([
      { schemaVersion: 1, key: liveKey, seq: 1, type: 'session.renamed', title: 'Beta' },
    ])
    expect(events.filter((event) => event.type === 'session.appended')).toEqual([
      { schemaVersion: 1, key: liveKey, seq: 2, type: 'session.appended', messageCount: 2 },
    ])
    expect(events.length).toBe(2)
  })

  it('reports transient while a native turn writes, then consistent with the final title', async () => {
    const dir = await makeHome()
    await writeFile(sessionPath(dir), recordBytes('Stable title', 1))
    const obs = realObserver(dir)
    const events: JcodeObservedEvent[] = []
    const healthChanges: string[] = []
    const observation = await obs.observe({
      key: liveKey,
      onEvent: (event) => { events.push(event) },
      onHealth: (health) => { healthChanges.push(health) },
    })
    if (observation instanceof Error) throw observation

    // The turn holds the record half-written long enough for several polls.
    await writeFile(sessionPath(dir), '{"id":"session_live","title":"Half-writ')
    await expect.poll(() => healthChanges.includes('transient'), { timeout: 3_000 }).toBe(true)
    // A torn read produced no event at all, so no truncated title escaped.
    expect(events).toEqual([])
    expect(observation.health()).toBe('transient')

    // The turn finishes the write, then stops.
    await writeFile(sessionPath(dir), recordBytes('Settled title', 1))
    await expect.poll(() => events.some((event) => event.type === 'session.renamed' && event.title === 'Settled title'), { timeout: 3_000 }).toBe(true)
    await expect.poll(() => observation.health(), { timeout: 3_000 }).toBe('consistent')
    const settledBytes = await fingerprint(dir)

    observation.detach()
    expect(await observation.done).toBeNull()

    // After the writer stops, the next read is consistent and names the final title.
    const snapshot = await obs.readSnapshot({ key: liveKey })
    if (snapshot instanceof Error) throw snapshot
    expect(snapshot.session).toEqual({ id: 'session_live', title: 'Settled title' })
    expect(healthChanges[healthChanges.length - 1]).toBe('consistent')
    expect(JSON.stringify(events)).not.toContain('Half-writ')
    expect(events.filter((event) => event.type === 'session.renamed').length).toBe(1)
    // The observer did not write to the store during the run.
    expect(await fingerprint(dir)).toEqual(settledBytes)
  })
})
