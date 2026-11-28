// `kimaki export opencode` and `kimaki export verify`. Phase 1.2 of
// docs/opencode-removal.md depends on this tool existing and being runnable before any
// OpenCode code or storage is deleted, so both the export and the proof of the export
// are shipped commands rather than a script in someone's notes.
import type { Goke } from 'goke'
import fs from 'node:fs'
import { ConfigError, DbNotMigratedError } from '../errors.ts'
import { DB_FILE } from '../migrations.ts'
import { dataDirOrDefault, DATA_DIR_HELP, fail, printJson } from './shared.ts'

export function registerExportCommands(cli: Goke) {
  cli.command('export opencode', 'Export OpenCode sessions, messages and parts before any OpenCode removal')
    .option('--out <dir>', 'New directory to write the export into; it must not exist yet')
    .option('--db <path>', 'Explicit OpenCode database (default: the XDG or LOCALAPPDATA opencode.db)')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .example('kimaki export opencode --out ~/backups/opencode-2026-11-17')
    .action(async (options) => {
      const out = typeof options.out === 'string' ? options.out.trim() : ''
      if (!out) fail(new ConfigError({ reason: 'Supply --out <dir> explicitly. An export never picks its own destination' }))
      const { exportOpencode, opencodeDbCandidates, verifyOpencodeExport } = await import('../ops/export-opencode.ts')
      const explicit = typeof options.db === 'string' ? options.db.trim() : ''
      const candidates = explicit ? [explicit] : opencodeDbCandidates()
      const dbFile = candidates.find((candidate) => fs.existsSync(candidate))
      if (!dbFile) {
        fail(new ConfigError({ reason: `No OpenCode database found. Tried: ${candidates.join(', ')}. Pass --db <path> if it lives elsewhere` }))
        return
      }
      const result = await exportOpencode({ dbFile, outDir: out })
      if (result instanceof Error) fail(result)
      const verified = verifyOpencodeExport(out)
      if (verified instanceof Error) fail(verified)
      const dataDir = dataDirOrDefault(options.dataDir)
      // Only the bot start migrates. A missing kimaki DB means this install has
      // no persisted threads, so there is nothing to witness; an existing but
      // unmigrated DB is a real error and must not silently lose the evidence.
      const { openDb } = await import('../db.ts')
      const opened = await openDb({ dataDir, migrate: false })
      let recorded: Record<string, unknown>
      if (opened instanceof DbNotMigratedError && opened.missing === DB_FILE) {
        recorded = { kind: 'not-applicable', reason: 'no kimaki database', dataDir }
      } else {
        if (opened instanceof Error) fail(opened)
        const { recordOpencodeExport } = await import('../opencode-disposition.ts')
        const resultRecord = await recordOpencodeExport({
          db: opened.db,
          manifestPath: result.manifestPath,
          exportedAt: new Date(result.manifest.exportedAt),
          threadCount: result.manifest.counts.sessions,
          sourceDbFile: result.manifest.source.dbFile,
        })
        opened.close()
        if (resultRecord instanceof Error) fail(resultRecord)
        recorded = { kind: resultRecord.kind, dataDir, manifestPath: resultRecord.record.manifestPath, exportedAt: resultRecord.record.exportedAt, threadCount: resultRecord.record.threadCount, sourceDbFile: resultRecord.record.sourceDbFile }
      }
      printJson({
        kind: 'opencode-export',
        outDir: result.outDir,
        manifest: result.manifestPath,
        source: result.manifest.source.dbFile,
        counts: result.manifest.counts,
        files: result.manifest.files,
        redactions: result.manifest.redactions,
        recorded,
      })
    })

  cli.command('export abandon-opencode', 'Explicitly abandon unexported OpenCode threads so jcode can start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .example('kimaki export abandon-opencode --data-dir ~/.kimaki')
    .action(async (options) => {
      // This command records a decision; it never touches or deletes the threads.
      const { recordOpencodeAbandonment } = await import('../opencode-disposition.ts')
      const dataDir = dataDirOrDefault(options.dataDir)
      const { openDb } = await import('../db.ts')
      const opened = await openDb({ dataDir, migrate: false })
      if (opened instanceof Error) fail(opened)
      const rows = await opened.db.query.thread_sessions.findMany({ columns: { thread_id: true, backend: true } })
      const threadCount = rows.filter((row) => row.backend === 'opencode').length
      const recorded = await recordOpencodeAbandonment({ db: opened.db, threadCount })
      opened.close()
      if (recorded instanceof Error) fail(recorded)
      printJson({
        kind: 'opencode-abandoned',
        dataDir,
        unserviceableThreadCount: recorded.unserviceableThreadCount,
        recorded: recorded.kind,
        abandonedAt: recorded.record.recordedAt,
        message: `${recorded.unserviceableThreadCount} OpenCode thread${recorded.unserviceableThreadCount === 1 ? '' : 's'} ${recorded.unserviceableThreadCount === 1 ? 'is' : 'are'} now unserviceable by jcode`,
      })
    })

  cli.command('export verify', 'Re-check an OpenCode export against the digests in its manifest')
    .option('--dir <dir>', 'Directory produced by export opencode')
    .action(async (options) => {
      const dir = typeof options.dir === 'string' ? options.dir.trim() : ''
      if (!dir) fail(new ConfigError({ reason: 'Supply --dir <dir> explicitly' }))
      const { verifyOpencodeExport } = await import('../ops/export-opencode.ts')
      const verified = verifyOpencodeExport(dir)
      if (verified instanceof Error) fail(verified)
      printJson({ kind: 'opencode-export-verified', dir, counts: verified.manifest.counts, files: verified.manifest.files, exportedAt: verified.manifest.exportedAt })
    })
}
