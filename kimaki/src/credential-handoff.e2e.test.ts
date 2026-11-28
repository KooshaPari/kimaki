// Phase 1.4 acceptance: the Codex credential is copied once into kimaki's own table,
// the OpenCode db is never written, and voice keeps working after OpenCode is gone.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { openDb, type OpenedDb } from './db.ts'
import * as schema from './schema.ts'
import { importCodexCredential } from './credential-handoff.ts'
import { saveAudioKeys, transcribe } from './voice.ts'
import { removeTempDir } from './test/cleanup.ts'
import { startFakeChatGPT, startFakeOpenAI, tempDataDir, writeOpencodeCredential, type FakeChatGPT, type FakeOpenAI } from './test/harness.ts'

async function releaseLibsqlHandles(): Promise<void> {
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 20))
  global.gc?.()
}

function fileFingerprint(file: string) {
  const stat = fs.statSync(file)
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
}

const APP_ID = 'import-test-app'
const TOKEN = 'import-test-token'
let dir: string
let opencodeDbFile: string
let db: OpenedDb
let chatgpt: FakeChatGPT
let openai: FakeOpenAI
const ogg = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'voice.ogg'))

beforeAll(async () => {
  dir = tempDataDir()
  opencodeDbFile = path.join(dir, 'opencode.db')
  await Promise.all([
    writeOpencodeCredential({ file: opencodeDbFile, access: 'imported-token', expires: Date.now() + 3_600_000 }),
    (async () => {
      const opened = await openDb({ dataDir: dir, migrate: true })
      if (opened instanceof Error) throw opened
      await opened.db.insert(schema.bot_tokens).values({ app_id: APP_ID, token: TOKEN, bot_mode: 'self_hosted' })
      db = opened
    })(),
    (async () => {
      ;[chatgpt, openai] = await Promise.all([
        startFakeChatGPT({ text: 'Hello from imported Codex' }),
        startFakeOpenAI({ result: { transcription: 'Hello from OpenAI after expiry', route: 'steer' } }),
      ])
    })(),
  ])
}, 60_000)

afterAll(async () => {
  db?.close()
  await chatgpt?.stop()
  await openai?.stop()
  await releaseLibsqlHandles()
  await removeTempDir(dir)
}, 60_000)

test('imports one row, upserts it, and never writes to the OpenCode database', async () => {
  const before = fileFingerprint(opencodeDbFile)
  const first = await importCodexCredential({ db: db.db, appId: APP_ID, opencodeDbFile })
  expect(first).toMatchObject({ kind: 'imported', appId: APP_ID, accountId: null, tokenExpiresAt: expect.any(Number), importedFrom: opencodeDbFile })
  const rows = await db.db.select().from(schema.codex_credentials)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.access_token).toBe('imported-token')
  expect(await importCodexCredential({ db: db.db, appId: APP_ID, opencodeDbFile })).toMatchObject({ kind: 'imported' })
  expect(await db.db.select().from(schema.codex_credentials)).toHaveLength(1)
  expect(fileFingerprint(opencodeDbFile)).toEqual(before)
})

test('refuses a near-expiry credential and writes no row', async () => {
  const now = 1_000_000
  const nearFile = path.join(dir, 'opencode-near.db')
  await writeOpencodeCredential({ file: nearFile, access: 'near-expiry-token', expires: now + 30_000 })
  await db.db.delete(schema.codex_credentials)
  const result = await importCodexCredential({ db: db.db, appId: APP_ID, opencodeDbFile: nearFile, now })
  expect(result).toMatchObject({ kind: 'nothing-to-import' })
  expect(await db.db.select().from(schema.codex_credentials)).toHaveLength(0)
})

// The rest drives the real transcribe() path with a nonexistent OpenCode db, no bot.
async function runTranscription() {
  const nonexistentDbFile = path.join(dir, 'no-opencode-here.db')
  return transcribe({
    db: db.db,
    token: TOKEN,
    opencodeDbFile: nonexistentDbFile,
    baseUrls: { chatgpt: chatgpt.baseUrl, openai: openai.baseUrl },
    audio: ogg,
    mediaType: 'audio/ogg',
    directory: dir,
    agents: [],
    inSession: false,
  })
}

test('transcribes with the imported Codex token while the OpenCode db does not exist', async () => {
  const saved = await importCodexCredential({ db: db.db, appId: APP_ID, opencodeDbFile })
  expect(saved).toMatchObject({ kind: 'imported' })
  expect(fs.existsSync(path.join(dir, 'no-opencode-here.db'))).toBe(false)
  const result = await runTranscription()
  expect(result).toMatchObject({ transcription: 'Hello from imported Codex' })
  expect(chatgpt.requests.at(-1)?.authorization).toBe('Bearer imported-token')
})

test('an expired imported token degrades to the next route without throwing', async () => {
  await db.db.update(schema.codex_credentials).set({ token_expires_at: 1 }).where(eq(schema.codex_credentials.app_id, APP_ID))
  const saved = await saveAudioKeys({ db: db.db, token: TOKEN, openai: 'sk-import-expired-test' })
  expect(saved instanceof Error).toBe(false)
  const before = chatgpt.requests.length
  const result = await runTranscription()
  expect(result).toMatchObject({ transcription: 'Hello from OpenAI after expiry' })
  expect(chatgpt.requests.length).toBe(before)
})
