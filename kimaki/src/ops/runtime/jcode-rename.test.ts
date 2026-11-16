// Regression for df006ec9: `jcode session rename` writes `custom_title` and
// leaves the first prompt in `title`. The observer must prefer `custom_title`,
// fall back to a non-blank `title`, and never report an empty string. These
// tests drive the observer over a real temp JCODE_HOME the test writes, so the
// precedence is pinned at the unit level rather than only by the slow e2e.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createJcodeObserver, type JcodeObservedEvent } from './jcode.js'

const NATIVE_ID = 'session_rename'
const key = { hostId: 'host', endpointId: 'endpoint', backendKind: 'jcode' as const, nativeSessionId: NATIVE_ID }

type RecordShape = { title?: unknown; custom_title?: unknown; updatedAt?: string; messages?: number }

const record = ({ title, custom_title, updatedAt = '2026-01-01T00:00:00Z', messages = 1 }: RecordShape) => {
  const value: Record<string, unknown> = {
    id: NATIVE_ID,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
    working_dir: 'C:/private/project',
    messages: Array.from({ length: messages }, () => ({ role: 'user', content: 'SECRET TRANSCRIPT TEXT' })),
  }
  // Omit keys that are deliberately absent so "neither" is truly neither.
  if (title !== undefined) value.title = title
  if (custom_title !== undefined) value.custom_title = custom_title
  return JSON.stringify(value)
}

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const makeHome = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jcode-rename-'))
  homes.push(dir)
  await mkdir(join(dir, 'sessions'), { recursive: true })
  return dir
}

const sessionPath = (dir: string) => join(dir, 'sessions', `${NATIVE_ID}.json`)

const observerFor = (dir: string, intervalMs = 10) => {
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

const writeRecord = (dir: string, shape: RecordShape) => writeFile(sessionPath(dir), record(shape))

const reportedTitle = async (shape: RecordShape) => {
  const dir = await makeHome()
  await writeRecord(dir, shape)
  const snapshot = await observerFor(dir).readSnapshot({ key })
  if (snapshot instanceof Error) throw snapshot
  return snapshot.session.title
}

describe('Jcode custom_title precedence (df006ec9 regression)', () => {
  it('reports custom_title when a real rename leaves the prompt in title', async () => {
    // The real shape: rename writes custom_title, title still holds the prompt.
    expect(await reportedTitle({ title: 'orig prompt', custom_title: 'renamed name' })).toBe('renamed name')
  })

  it('reports title when no custom_title was ever written', async () => {
    expect(await reportedTitle({ title: 'orig prompt' })).toBe('orig prompt')
  })

  it('falls back to title when custom_title is whitespace only', async () => {
    expect(await reportedTitle({ title: 'orig prompt', custom_title: '   ' })).toBe('orig prompt')
  })

  it('reports null, never an empty string, when neither title is usable', async () => {
    // Neither key present at all.
    expect(await reportedTitle({})).toBeNull()
    // Both present but blank: still no title, never ''.
    const blank = await reportedTitle({ title: '  ', custom_title: '\t' })
    expect(blank).toBeNull()
    expect(blank).not.toBe('')
  })

  it('prefers custom_title in discovery too, not just snapshot', async () => {
    const dir = await makeHome()
    await writeRecord(dir, { title: 'orig prompt', custom_title: 'renamed name' })
    const page = await observerFor(dir).discover()
    if (page instanceof Error) throw page
    expect(page.sessions.map((entry) => entry.title)).toEqual(['renamed name'])
  })
})

describe('Jcode custom_title rename emission', () => {
  it('emits exactly one session.renamed with the new custom_title across polls', async () => {
    const dir = await makeHome()
    await writeRecord(dir, { title: 'orig prompt', custom_title: 'first name', messages: 1 })
    const obs = observerFor(dir)

    const events: JcodeObservedEvent[] = []
    const observation = await obs.observe({
      key,
      onEvent: (event) => { events.push(event) },
    })
    if (observation instanceof Error) throw observation

    // Second poll: the human renames the session. title is untouched.
    await writeRecord(dir, { title: 'orig prompt', custom_title: 'second name', messages: 1, updatedAt: '2026-01-01T00:00:01Z' })
    await expect.poll(() => events.filter((event) => event.type === 'session.renamed').length, { timeout: 3_000 }).toBe(1)

    // Third poll: another write with no title change must not emit again.
    await writeRecord(dir, { title: 'orig prompt', custom_title: 'second name', messages: 1, updatedAt: '2026-01-01T00:00:02Z' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    observation.detach()
    expect(await observation.done).toBeNull()

    const renamed = events.filter((event) => event.type === 'session.renamed')
    expect(renamed).toEqual([
      { schemaVersion: 1, key, seq: 1, type: 'session.renamed', title: 'second name' },
    ])
    expect(JSON.stringify(events)).not.toContain('orig prompt')
    expect(JSON.stringify(events)).not.toContain('SECRET')
  })
})
