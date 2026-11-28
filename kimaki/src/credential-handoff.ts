// Phase 1.4 of docs/opencode-removal.md: copy the Codex OAuth credential OpenCode owns
// into kimaki's own table so voice transcription keeps working after OpenCode is gone.
// Kimaki never refreshes this token: a refresh rotates it and would log OpenCode out.
// The one read of OpenCode's db uses chatGPTCredential's read-only ATTACH, so the source
// database is never written to. An explicit CLI call performs the copy, not bot startup.

import type { KimakiDb } from './db.ts'
import { chatGPTCredential } from './voice.ts'
import * as schema from './schema.ts'

export type ImportCodexResult =
  | { kind: 'imported'; appId: string; accountId: string | null; tokenExpiresAt: number | null; importedFrom: string; importedAt: unknown }
  | { kind: 'nothing-to-import'; appId: string; reason: 'no-credential' | 'near-expiry' | 'expired' }
  | { kind: 'read-failure'; reason: string }

export type ImportCodexInput = {
  db: KimakiDb
  appId: string
  opencodeDbFile: string
  now?: number
}

// `now` is injectable so near-expiry and expiry are deterministic in tests.
export async function importCodexCredential({ db, appId, opencodeDbFile, now = Date.now() }: ImportCodexInput): Promise<ImportCodexResult | Error> {
  const credential = await chatGPTCredential({ dbFile: opencodeDbFile, now, includeExpiry: true })
  if (credential instanceof Error) return { kind: 'read-failure', reason: credential.message }
  if (!credential) return { kind: 'nothing-to-import', appId, reason: 'no-credential' }
  const expiresAt = credential.expiresAt ?? null
  if (expiresAt !== null && expiresAt <= now + 60_000) {
    return { kind: 'nothing-to-import', appId, reason: expiresAt <= now ? 'expired' : 'near-expiry' }
  }
  const [saved] = await db.insert(schema.codex_credentials).values({
    app_id: appId,
    access_token: credential.accessToken,
    account_id: credential.accountId,
    token_expires_at: expiresAt,
    imported_from: opencodeDbFile,
  }).onConflictDoUpdate({
    target: schema.codex_credentials.app_id,
    set: {
      access_token: credential.accessToken,
      account_id: credential.accountId,
      token_expires_at: expiresAt,
      imported_from: opencodeDbFile,
      imported_at: new Date(now),
    },
  }).returning()
  if (!saved) return new Error('inserting the imported Codex credential returned no row')
  return {
    kind: 'imported',
    appId,
    accountId: credential.accountId,
    tokenExpiresAt: expiresAt,
    importedFrom: saved.imported_from,
    importedAt: saved.imported_at,
  }
}
