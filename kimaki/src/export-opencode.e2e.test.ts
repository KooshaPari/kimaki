// Phase 1.2 of docs/opencode-removal.md: the export every deletion is gated on. These
// cases drive the shipped CLI against a real SQLite file built with the real OpenCode
// schema, because a stub of the schema is exactly what would hide a drift failure.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { scratchDir } from './test/cleanup.ts'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts')
const dirs: string[] = []
const scratch = scratchDir('export-opencode')

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'case-'))
  dirs.push(dir)
  return dir
}
// SQLite and the spawned CLI can still hold a handle for a moment on Windows, so the
// cleanup retries instead of failing a passing case with EPERM.
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

/**
 * The real 0.169-era OpenCode schema, at the columns this export reads. The fixture is
 * built in a child process on purpose: `@libsql/client` holds the file handle past
 * `close()` on Windows, which makes the temp directory undeletable and turns cleanup
 * into a false failure.
 */
const createDb = (file: string, { omitPartData = false } = {}) => {
  const partColumns = omitPartData ? 'id, message_id, session_id, time_created, time_updated' : 'id, message_id, session_id, time_created, time_updated, data'
  const partValues = omitPartData ? "['prt_1','msg_1','ses_1',1300,1400]" : "['prt_1','msg_1','ses_1',1300,1400,JSON.stringify({type:'text',text:'hello'})]"
  const script = `
import { createClient } from '@libsql/client'
// Forward slashes and JSON quoting: a raw Windows path here would lose its
// backslashes to string escapes and silently build the fixture somewhere else.
const client = createClient({ url: ${JSON.stringify(`file:${file.replaceAll('\\', '/')}`)} })
await client.execute("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, model TEXT, cost REAL DEFAULT 0, time_created INTEGER, time_updated INTEGER)")
await client.execute("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
await client.execute("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER${omitPartData ? '' : ', data TEXT'})")
await client.execute("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)")
await client.execute({ sql: 'INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)', args: ['ses_1','proj_1',null,'C:/work','A real thread','anthropic/claude',0.12,1000,2000] })
await client.execute({ sql: 'INSERT INTO message VALUES (?,?,?,?,?)', args: ['msg_1','ses_1',1100,1200,JSON.stringify({role:'user'})] })
await client.execute({ sql: 'INSERT INTO part (${partColumns}) VALUES (?,?,?,?,?${omitPartData ? '' : ',?'})', args: ${partValues} })
await client.execute({ sql: 'INSERT INTO credential VALUES (?,?,?,?,?,?,?,?)', args: ['cred_1','openai','ChatGPT',JSON.stringify({access:'SECRET-TOKEN-VALUE',refresh:'SECRET-REFRESH'}),'chatgpt-browser',1,1500,1600] })
client.close()
`
  const built = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.dirname(cli), encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`fixture build failed: ${built.stderr || built.stdout}`)
}

const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: path.dirname(cli), shell: false })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
})

describe('export opencode', () => {
  it('writes every session, message and part, plus a manifest that verifies', async () => {
    const dir = tmp()
    const db = path.join(dir, 'opencode.db')
    await createDb(db)
    const out = path.join(dir, 'export')

    const result = await run(['export', 'opencode', '--db', db, '--out', out])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const printed = JSON.parse(result.stdout) as { kind: string; counts: { sessions: number; messages: number; parts: number; credentials: number }; files: Array<{ name: string; sha256: string }> }
    expect(printed.kind).toBe('opencode-export')
    expect(printed.counts).toEqual({ sessions: 1, messages: 1, parts: 1, credentials: 1 })

    const session = JSON.parse(fs.readFileSync(path.join(out, 'sessions.jsonl'), 'utf8')) as Record<string, unknown>
    expect(session).toMatchObject({ id: 'ses_1', title: 'A real thread' })
    const part = JSON.parse(fs.readFileSync(path.join(out, 'parts.jsonl'), 'utf8')) as Record<string, unknown>
    expect(String(part['data'])).toContain('hello')
    expect(printed.files.map((file) => file.name).sort()).toEqual(['credentials.metadata.jsonl', 'messages.jsonl', 'parts.jsonl', 'sessions.jsonl'])
    expect(printed.files.every((file) => file.sha256.startsWith('sha256:'))).toBe(true)

    const verified = await run(['export', 'verify', '--dir', out])
    expect(verified.code).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({ kind: 'opencode-export-verified', counts: { sessions: 1, messages: 1, parts: 1, credentials: 1 } })
  })

  it('never copies a credential token value, and says so in the manifest', async () => {
    const dir = tmp()
    const db = path.join(dir, 'opencode.db')
    await createDb(db)
    const out = path.join(dir, 'export')
    expect((await run(['export', 'opencode', '--db', db, '--out', out])).code).toBe(0)

    const credentialFile = fs.readFileSync(path.join(out, 'credentials.metadata.jsonl'), 'utf8')
    expect(credentialFile).not.toContain('SECRET-TOKEN-VALUE')
    expect(credentialFile).not.toContain('SECRET-REFRESH')
    expect(credentialFile).toContain('chatgpt-browser')
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as { redactions: string[] }
    expect(manifest.redactions.join(' ')).toMatch(/credential\.value/)
  })

  it('refuses a drifted schema without writing anything', async () => {
    const dir = tmp()
    const db = path.join(dir, 'opencode.db')
    await createDb(db, { omitPartData: true })
    const out = path.join(dir, 'export')

    const result = await run(['export', 'opencode', '--db', db, '--out', out])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('part')
    expect(result.stderr).toContain('nothing was written')
    expect(fs.existsSync(out)).toBe(false)
  })

  it('refuses to overwrite an earlier export, and verify catches a tampered file', async () => {
    const dir = tmp()
    const db = path.join(dir, 'opencode.db')
    await createDb(db)
    const out = path.join(dir, 'export')
    expect((await run(['export', 'opencode', '--db', db, '--out', out])).code).toBe(0)

    const second = await run(['export', 'opencode', '--db', db, '--out', out])
    expect(second.code).not.toBe(0)
    expect(second.stderr).toMatch(/already exists/)

    fs.writeFileSync(path.join(out, 'sessions.jsonl'), 'tampered\n')
    const verified = await run(['export', 'verify', '--dir', out])
    expect(verified.code).not.toBe(0)
    expect(verified.stderr).toMatch(/does not match its recorded digest/)
  })
})
