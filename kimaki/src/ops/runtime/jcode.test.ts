import { describe, expect, it } from 'vitest'
import { createJcodeObserver } from './jcode.js'

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
      expectedIdentity: 'kcode',
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

