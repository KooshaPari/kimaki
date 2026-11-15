import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { expect, test } from 'vitest'

import { tempDataDir } from './test/harness.ts'
import { chatGPTCredential } from './voice.ts'

// libSQL keeps its file handles until its prepared statements are garbage
// collected (vitest.config.ts passes --expose-gc on Windows). Let go of them
// before removing the temp dir: a slow finalizer must not fail a test whose
// assertions already passed, but a real removal failure still throws.
async function releaseLibsqlHandles(): Promise<void> {
  global.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 20))
  global.gc?.()
}

test('chatGPTCredential skips token sharing and expired logins', async () => {
  const dir = tempDataDir()
  const file = path.join(dir, 'opencode.db')
  const client = createClient({ url: `file:${file}` })
  await client.execute('CREATE TABLE credential (id text PRIMARY KEY, integration_id text, value text NOT NULL, active integer, time_updated integer NOT NULL)')
  const rows = [
    // Active, but OpenAI rejects token sharing on dictation and GPT-Live.
    { id: 'sharing', active: 1, time: 3, value: { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'sharing', expires: 2_000_000 } },
    { id: 'expired', active: 0, time: 2, value: { type: 'oauth', methodID: 'chatgpt-browser', access: 'expired', expires: 1_000 } },
    { id: 'codex', active: 0, time: 1, value: { type: 'oauth', methodID: 'chatgpt-headless', access: 'codex', expires: 2_000_000 } },
  ]
  for (const row of rows) {
    await client.execute({
      sql: `INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, 'openai', ?, ?, ?)`,
      args: [row.id, JSON.stringify(row.value), row.active, row.time],
    })
  }
  client.close()
  expect(await chatGPTCredential({ dbFile: file, now: 1_000_000 })).toEqual({ accessToken: 'codex', accountId: null })
  await releaseLibsqlHandles()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
