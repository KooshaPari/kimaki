// Opt-in acceptance: the Jcode backend drives a real `jcode acp` child process
// through ACP stdio (initialize, session/new, session/prompt) and the public
// `ops jcode run` CLI prints the assembled turn. Nothing here is mocked, so the
// suite stays dormant unless KIMAKI_JCODE_ACP_E2E=1.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { removeTempDirs } from './test/cleanup.ts'

const ENABLED = process.env['KIMAKI_JCODE_ACP_E2E'] === '1'

// Kept short and tool-free so a single ACP turn cannot wander.
const PROMPT = 'Reply with the single word ok and nothing else. Do not use tools.'

// The agent's configured default model (deepseek-v4-pro on this host) is denied
// for the operator credential, so a real turn only succeeds on an allowed model.
const MODEL = 'beam-free'

const CLI = path.join(import.meta.dirname, 'cli.ts')
const CLI_ENV = { ...process.env, KIMAKI_VITEST: '1', KIMAKI_STRADA_ENABLED: '0' }

type CliRun = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function startCli(args: string[], killAfterMs: number): { child: ChildProcess; done: Promise<CliRun> } {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: CLI_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  // Hard stop for a wedged ACP child; the test-level timeout is a second net.
  const timer = setTimeout(() => {
    timedOut = true
    stderr += `\n[acceptance harness] killed after ${killAfterMs}ms\n`
    child.kill()
  }, killAfterMs)
  const done = new Promise<CliRun>((resolve) => {
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(error)}`, timedOut })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
  return { child, done }
}

// tsx runs the CLI as a child of node, and the CLI in turn owns the `jcode acp`
// process. Killing the tree is the only reliable cleanup on Windows.
async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGKILL')
}

// `--json` streams the assistant text first, then appends a pretty-printed
// summary. The summary is therefore the last parseable JSON object in stdout,
// and everything before it is the streamed text.
function parseJsonOutput(stdout: string): { value: Record<string, unknown>; streamedText: string } {
  const trimmed = stdout.trim()
  try {
    return { value: JSON.parse(trimmed) as Record<string, unknown>, streamedText: '' }
  } catch {
    // Not the whole stream; fall through to the trailing document.
  }
  for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed.slice(index))
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    return { value: parsed as Record<string, unknown>, streamedText: trimmed.slice(0, index).trim() }
  }
  throw new Error(`stdout carried no JSON summary: ${JSON.stringify(trimmed.slice(0, 2000))}`)
}

test.skipIf(!ENABLED)('drives a real jcode ACP turn and prints stopReason plus text as JSON', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-jcode-acp-json-'))
  const tempDirs = [cwd]
  const run = startCli(
    ['ops', 'jcode', 'run', '--cwd', cwd, '--prompt', PROMPT, '--model', MODEL, '--json', '--timeout', '180000'],
    240_000,
  )
  try {
    const result = await run.done
    expect(result.timedOut, `the turn did not finish; stderr: ${result.stderr}`).toBe(false)
    expect(result.code, `exit code ${result.code}; stderr: ${result.stderr}`).toBe(0)

    const { value: summary, streamedText } = parseJsonOutput(result.stdout)
    const shown = JSON.stringify(summary)
    expect(typeof summary['stopReason'], `stopReason missing from ${shown}`).toBe('string')
    const stopReason = summary['stopReason'] as string
    expect(stopReason.length, 'stopReason must be non-empty').toBeGreaterThan(0)
    // start() reports the model it selected, so the turn proves which one ran.
    expect(summary['model'], `model missing from ${shown}`).toBe(MODEL)
    // The summary carries the turn's text as a length rather than the text, so
    // --json stdout stays a single parseable document. Streamed prose is the
    // non-JSON path's job, covered by the next test, so nothing is expected
    // before the summary here.
    if (typeof summary['text'] === 'string') {
      expect((summary['text'] as string).trim().length, 'text must be non-empty').toBeGreaterThan(0)
    } else {
      expect(summary['characters'], `characters missing from ${shown}`).toEqual(expect.any(Number))
      expect(summary['characters'] as number, 'the turn produced no text').toBeGreaterThan(0)
      expect(streamedText.length, '--json must not mix prose into its JSON output').toBe(0)
    }
  } finally {
    await killTree(run.child)
    await removeTempDirs(tempDirs)
  }
}, 240_000)

test.skipIf(!ENABLED)('streams a real jcode ACP turn without --json', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kimaki-jcode-acp-stream-'))
  const tempDirs = [cwd]
  const run = startCli(
    ['ops', 'jcode', 'run', '--cwd', cwd, '--prompt', PROMPT, '--model', MODEL, '--timeout', '180000'],
    240_000,
  )
  try {
    const result = await run.done
    expect(result.timedOut, `the turn did not finish; stderr: ${result.stderr}`).toBe(false)
    expect(result.code, `exit code ${result.code}; stderr: ${result.stderr}`).toBe(0)
    // Windows pipe buffering makes per-chunk timing flaky, so the acceptance is
    // exit 0 plus a non-empty stream rather than chunk arrival order.
    expect(result.stdout.trim().length, `stdout was empty; stderr: ${result.stderr}`).toBeGreaterThan(0)
  } finally {
    await killTree(run.child)
    await removeTempDirs(tempDirs)
  }
}, 240_000)

test.skipIf(ENABLED)('keeps the real ACP acceptance dormant without the opt-in flag', () => {
  // Fast guard so the file is meaningful when the env flag is unset: the gate
  // stays closed, so no CLI or jcode binary is spawned.
  expect(ENABLED).toBe(false)
  expect(process.env['KIMAKI_JCODE_ACP_E2E']).not.toBe('1')
})
