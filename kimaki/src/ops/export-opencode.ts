// Reads OpenCode's own SQLite and writes a self-contained export, because every
// deletion in docs/opencode-removal.md is gated on this running first (Phase 1.2).
//
// Rules that come from that plan, not from convenience:
//   - the OpenCode database is opened read-only (`mode=ro`), never migrated or written;
//   - a missing table or column is a loud failure, checked before anything is written,
//     so an export is never half a migration;
//   - credentials are metadata only: the token value is never copied, because copying a
//     live refresh token without refreshing it is the failure mode the plan calls out;
//   - the output directory is created fresh and its files are create-only, so a second
//     export cannot silently overwrite the first evidence.
import { createClient } from '@libsql/client'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../errors.ts'

export type OpenCodeExportManifest = {
  kind: 'opencode-export'
  version: 1
  exportedAt: string
  source: { dbFile: string; bytes: number }
  counts: { sessions: number; messages: number; parts: number; credentials: number }
  files: Array<{ name: string; bytes: number; sha256: string }>
  /** What was deliberately withheld, so a reader does not assume it is missing. */
  redactions: string[]
}

export type OpenCodeExportResult = {
  outDir: string
  manifest: OpenCodeExportManifest
  manifestPath: string
}

const SESSION_COLUMNS = ['id', 'title', 'time_created', 'time_updated', 'directory', 'parent_id', 'model', 'cost'] as const
const MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'data'] as const
const PART_COLUMNS = ['id', 'message_id', 'session_id', 'time_created', 'data'] as const
const CREDENTIAL_COLUMNS = ['id', 'integration_id', 'label', 'method_id', 'active', 'time_created', 'time_updated'] as const

const sha256 = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The OpenCode database this host would have. `opencodeDbFile()` answers for the XDG
 * layout; on Windows the real file lives under LOCALAPPDATA, and both are true for
 * different installs, so the candidates are returned in preference order.
 */
export function opencodeDbCandidates(): string[] {
  const candidates = [path.resolve(process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share'), 'opencode', process.env['OPENCODE_DB'] || 'opencode.db')]
  const local = process.env['LOCALAPPDATA']
  if (typeof local === 'string' && local.length > 0) candidates.push(path.resolve(local, 'opencode', process.env['OPENCODE_DB'] || 'opencode.db'))
  return [...new Set(candidates)]
}

const columnsOf = async (client: ReturnType<typeof createClient>, table: string): Promise<string[] | Error> => {
  try {
    const result = await client.execute(`PRAGMA opencode.table_info(${table})`)
    return result.rows.map((row) => String(row['name']))
  } catch (cause) {
    return new ConfigError({ reason: `the OpenCode database has no readable ${table} table`, cause })
  }
}

const requireColumns = (table: string, present: readonly string[], required: readonly string[]): Error | null => {
  const missing = required.filter((column) => !present.includes(column))
  if (missing.length === 0) return null
  return new ConfigError({ reason: `the OpenCode ${table} table is missing ${missing.join(', ')}, so this export cannot be trusted; nothing was written` })
}

export async function exportOpencode({ dbFile, outDir, now = Date.now() }: {
  dbFile: string
  outDir: string
  now?: number
}): Promise<OpenCodeExportResult | Error> {
  const source = path.resolve(dbFile)
  if (!fs.existsSync(source)) return new ConfigError({ reason: `${source} does not exist, so there is nothing to export` })
  const target = path.resolve(outDir)
  if (fs.existsSync(target)) return new ConfigError({ reason: `${target} already exists; an export never overwrites an earlier one` })

  const client = createClient({ url: ':memory:' })
  try {
    // Read-only attach: this must not be able to migrate or vacuum OpenCode's file.
    await client.execute({ sql: 'ATTACH DATABASE ? AS opencode', args: [`file:${source}?mode=ro`] })

    // Structure first: a drift check before a single byte is written.
    for (const [table, required] of [
      ['session', SESSION_COLUMNS],
      ['message', MESSAGE_COLUMNS],
      ['part', PART_COLUMNS],
    ] as const) {
      const present = await columnsOf(client, table)
      if (present instanceof Error) return present
      const missing = requireColumns(table, present, required)
      if (missing) return missing
    }
    const credentialColumns = await columnsOf(client, 'credential')
    if (credentialColumns instanceof Error) return credentialColumns
    const credentialSelection = CREDENTIAL_COLUMNS.filter((column) => credentialColumns.includes(column))

    const sessions = await client.execute(`SELECT ${SESSION_COLUMNS.join(', ')} FROM opencode.session ORDER BY time_created`)
    const messages = await client.execute(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM opencode.message ORDER BY time_created`)
    const parts = await client.execute(`SELECT ${PART_COLUMNS.join(', ')} FROM opencode.part ORDER BY time_created`)
    // Metadata only. `value` is deliberately absent from the selection, not filtered later.
    const credentials = credentialSelection.length === 0
      ? []
      : (await client.execute(`SELECT ${credentialSelection.join(', ')} FROM opencode.credential`)).rows

    const payloads = {
      'sessions.jsonl': sessions.rows.map((row) => JSON.stringify(Object.fromEntries(SESSION_COLUMNS.map((column) => [column, row[column]])))),
      'messages.jsonl': messages.rows.map((row) => JSON.stringify(Object.fromEntries(MESSAGE_COLUMNS.map((column) => [column, row[column]])))),
      'parts.jsonl': parts.rows.map((row) => JSON.stringify(Object.fromEntries(PART_COLUMNS.map((column) => [column, row[column]])))),
      'credentials.metadata.jsonl': credentials.map((row) => JSON.stringify(Object.fromEntries(credentialSelection.map((column) => [column, row[column]])))),
    }

    const files = Object.entries(payloads).map(([name, lines]) => {
      const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`
      return { name, content, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256(content) }
    })

    fs.mkdirSync(target, { recursive: true })
    for (const file of files) {
      // `wx`: create-only, so a racing export cannot blend into this one.
      fs.writeFileSync(path.join(target, file.name), file.content, { flag: 'wx' })
    }

    const manifest: OpenCodeExportManifest = {
      kind: 'opencode-export',
      version: 1,
      exportedAt: new Date(now).toISOString(),
      source: { dbFile: source, bytes: fs.statSync(source).size },
      counts: { sessions: sessions.rows.length, messages: messages.rows.length, parts: parts.rows.length, credentials: credentials.length },
      files: files.map(({ name, bytes, sha256: digest }) => ({ name, bytes, sha256: digest })),
      redactions: ['credential.value (tokens) is never copied; only its integration, label, method and timestamps are'],
    }
    const manifestPath = path.join(target, 'manifest.json')
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    return { outDir: target, manifest, manifestPath }
  } catch (cause) {
    return cause instanceof Error ? new ConfigError({ reason: `exporting ${source} failed`, cause }) : new ConfigError({ reason: `exporting ${source} failed` })
  } finally {
    client.close()
  }
}

/** Reads a manifest back and re-checks every digest, so a restore can prove what it got. */
export function verifyOpencodeExport(outDir: string): { manifest: OpenCodeExportManifest } | Error {
  const manifestPath = path.join(path.resolve(outDir), 'manifest.json')
  if (!fs.existsSync(manifestPath)) return new ConfigError({ reason: `${manifestPath} is missing, so this directory is not an export` })
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    return new ConfigError({ reason: `${manifestPath} is not valid JSON`, cause })
  }
  if (!record(parsed) || parsed['kind'] !== 'opencode-export' || !Array.isArray(parsed['files'])) {
    return new ConfigError({ reason: `${manifestPath} is not an opencode-export manifest` })
  }
  const manifest = parsed as unknown as OpenCodeExportManifest
  for (const file of manifest.files) {
    const filePath = path.join(path.resolve(outDir), file.name)
    if (!fs.existsSync(filePath)) return new ConfigError({ reason: `${filePath} named by the manifest is missing` })
    const content = fs.readFileSync(filePath, 'utf8')
    if (sha256(content) !== file.sha256) return new ConfigError({ reason: `${filePath} does not match its recorded digest` })
  }
  return { manifest }
}
