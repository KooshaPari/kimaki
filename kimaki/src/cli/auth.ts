// `kimaki auth import-codex`: Phase 1.4 of docs/opencode-removal.md. An explicit,
// one-time copy of OpenCode's Codex OAuth credential into kimaki's own table, so voice
// keeps working after OpenCode is removed. The credential is never refreshed here.

import type { Goke } from 'goke'
import fs from 'node:fs'

import { ConfigError } from '../errors.ts'
import { opencodeDbFile } from '../opencode-server.ts'
import { DATA_DIR_HELP, dataDirOrDefault, fail, openCliDb, printJson } from './shared.ts'

export function registerAuthCommands(cli: Goke) {
  cli.command('auth import-codex', 'Copy the Codex OAuth credential from OpenCode into kimaki once, read-only')
    .option('--db <path>', 'OpenCode database (default: the resolved XDG or LOCALAPPDATA opencode.db)')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .example('kimaki auth import-codex')
    .action(async (options) => {
      const explicit = typeof options.db === 'string' ? options.db.trim() : ''
      const dbFile = explicit ? explicit : opencodeDbFile()
      if (!fs.existsSync(dbFile)) {
        fail(new ConfigError({ reason: `No OpenCode database found at ${dbFile}. Pass --db <path> if it lives elsewhere` }))
        return
      }
      const { importCodexCredential } = await import('../credential-handoff.ts')
      const { readSavedCredentials } = await import('../credentials.ts')
      const opened = await openCliDb(options.dataDir)
      const result = await (async () => {
        const credentials = await readSavedCredentials({ db: opened.db })
        if (credentials instanceof Error) return credentials
        if (!credentials) return new Error('No saved bot credentials. Start kimaki once to onboard.')
        return importCodexCredential({ db: opened.db, appId: credentials.appId, opencodeDbFile: dbFile })
      })()
      opened.close()
      if (result instanceof Error) fail(result)
      printJson({
        ...result,
        kind: result.kind === 'imported' ? 'codex-credential-imported' : result.kind === 'nothing-to-import' ? 'codex-credential-not-imported' : 'codex-credential-read-failure',
        db: dbFile,
        dataDir: dataDirOrDefault(options.dataDir),
      })
    })
}
