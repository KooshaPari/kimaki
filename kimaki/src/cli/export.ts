// `kimaki export opencode` and `kimaki export verify`. Phase 1.2 of
// docs/opencode-removal.md depends on this tool existing and being runnable before any
// OpenCode code or storage is deleted, so both the export and the proof of the export
// are shipped commands rather than a script in someone's notes.
import type { Goke } from 'goke'
import fs from 'node:fs'
import { ConfigError } from '../errors.ts'
import { fail, printJson } from './shared.ts'

export function registerExportCommands(cli: Goke) {
  cli.command('export opencode', 'Export OpenCode sessions, messages and parts before any OpenCode removal')
    .option('--out <dir>', 'New directory to write the export into; it must not exist yet')
    .option('--db <path>', 'Explicit OpenCode database (default: the XDG or LOCALAPPDATA opencode.db)')
    .example('kimaki export opencode --out ~/backups/opencode-2026-11-17')
    .action(async (options) => {
      const out = typeof options.out === 'string' ? options.out.trim() : ''
      if (!out) fail(new ConfigError({ reason: 'Supply --out <dir> explicitly. An export never picks its own destination' }))
      const { exportOpencode, opencodeDbCandidates } = await import('../ops/export-opencode.ts')
      const explicit = typeof options.db === 'string' ? options.db.trim() : ''
      const candidates = explicit ? [explicit] : opencodeDbCandidates()
      const dbFile = candidates.find((candidate) => fs.existsSync(candidate))
      if (!dbFile) {
        fail(new ConfigError({ reason: `No OpenCode database found. Tried: ${candidates.join(', ')}. Pass --db <path> if it lives elsewhere` }))
        return
      }
      const result = await exportOpencode({ dbFile, outDir: out })
      if (result instanceof Error) fail(result)
      printJson({
        kind: 'opencode-export',
        outDir: result.outDir,
        manifest: result.manifestPath,
        source: result.manifest.source.dbFile,
        counts: result.manifest.counts,
        files: result.manifest.files,
        redactions: result.manifest.redactions,
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
