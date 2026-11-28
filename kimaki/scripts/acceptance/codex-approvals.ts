// One re-runnable pass over every Codex approval behaviour this repository claims,
// against the real `codex app-server` binary. It starts its own witness model
// (scripts/acceptance/codex-stub-model.mjs), writes an isolated Codex home that
// points at it, and then drives `ops codex turn` once per case. A case passes only
// when the CLI's own output and what the model was told next agree with the
// expectation; anything else prints FAIL.
//
//   bun scripts/acceptance/codex-approvals.ts
//
// Requirements: a real `codex` binary (CODEX_BINARY, default `codex` on PATH), bun,
// node, and no account credential. The home this script creates is temporary and
// removed on exit.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { bunBinary, modelOutputs as outputsFrom, packageRoot, startWitness } from './codex-witness.ts'

const binary = process.env['CODEX_BINARY'] ?? 'codex'
const witness = await startWitness()
process.on('exit', () => witness.stop())
const home = witness.home
const work = witness.work

type Case = {
  name: string
  prompt: string
  args: string[]
  approvals: number
  status: string
  modelOutputs: (outputs: string[]) => boolean
  writeFile?: { path: string; content: string }
  method?: string
}

const run = (args: string[]) => new Promise<{ code: number; stdout: string }>((resolve) => {
  const child = spawn(bunBinary, ['src/cli.ts', 'ops', 'codex', 'turn', '--binary', binary, '--codex-home', home, '--cwd', work, '--timeout-ms', '120000', ...args], { cwd: packageRoot, shell: false })
  let stdout = ''
  let settled = false
  const finish = (code: number) => {
    if (settled) return
    settled = true
    clearTimeout(bound)
    resolve({ code, stdout })
  }
  // A case that never finishes must fail loudly rather than stall the whole pass.
  // The bound is deliberately generous: codex start-up on a loaded host has taken
  // longer than three minutes, which is slow, not a hang.
  const bound = setTimeout(() => { child.kill(); finish(124) }, 300_000)
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stdout += chunk })
  child.on('error', (cause) => { stdout += `spawn failed: ${cause.message}\n`; finish(-1) })
  child.on('close', (code) => finish(code ?? -1))
})

const parse = (stdout: string) => {
  const objects: Array<Record<string, unknown>> = []
  for (const chunk of stdout.split(/\n(?=\{)/)) {
    try { objects.push(JSON.parse(chunk)) } catch { /* non-JSON line */ }
  }
  return objects
}

const modelOutputs = (): string[] => outputsFrom(witness.dump)

const cases: Case[] = [
  {
    name: 'accept runs the command',
    prompt: '__RUN__ run echo approval-ok',
    args: ['--approval', 'accept', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('approval-ok') && out[0].includes('code 0'),
  },
  {
    name: 'decline refuses the command',
    prompt: '__RUN__ run echo approval-ok',
    args: ['--approval', 'decline', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('rejected by user'),
  },
  {
    name: 'no approval channel fails closed',
    prompt: '__RUN__ run echo approval-ok',
    args: ['--approval-policy', 'untrusted'],
    approvals: 0,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('approval request failed'),
  },
  {
    name: 'cancel interrupts the turn',
    prompt: '__RUN__ run echo approval-ok',
    args: ['--approval', 'cancel', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'interrupted',
    modelOutputs: (out) => out.length === 0,
  },
  {
    name: 'acceptForSession collapses a repeated command',
    prompt: '__RUN2__ __SAME__ repeat the same command',
    args: ['--approval', 'acceptForSession', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'completed',
    modelOutputs: (out) => out.length === 2 && out.every((entry) => entry.includes('approval-ok')),
  },
  {
    name: 'acceptForSession re-asks for a different command',
    prompt: '__RUN2__ run two different commands',
    args: ['--approval', 'acceptForSession', '--approval-policy', 'untrusted'],
    approvals: 2,
    status: 'completed',
    modelOutputs: (out) => out.length === 2,
  },
  {
    name: 'acceptForSession re-asks when one argument is added',
    prompt: '__RUN2__ __PREFIX__ extend the approved command',
    args: ['--approval', 'acceptForSession', '--approval-policy', 'untrusted'],
    approvals: 2,
    status: 'completed',
    modelOutputs: (out) => out.length === 2,
  },
  {
    name: 'plain accept asks once per command',
    prompt: '__RUN2__ run two commands',
    args: ['--approval', 'accept', '--approval-policy', 'untrusted'],
    approvals: 2,
    status: 'completed',
    modelOutputs: (out) => out.length === 2,
  },
  {
    name: 'escalation accepted runs outside the sandbox',
    prompt: '__ESCALATE__ leave the sandbox',
    args: ['--approval', 'accept', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('escalated-ok'),
  },
  {
    name: 'escalation declined is refused',
    prompt: '__ESCALATE__ leave the sandbox',
    args: ['--approval', 'decline', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('rejected by user'),
  },
  {
    name: 'an unadvertised patch tool is rejected by the runtime',
    prompt: '__PATCH__ try a patch',
    args: ['--approval', 'accept', '--approval-policy', 'untrusted'],
    approvals: 0,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('unsupported call: apply_patch'),
  },
  {
    name: 'a shell write arrives as a command approval',
    prompt: '__WRITE__ write a file',
    args: ['--approval', 'accept', '--approval-policy', 'untrusted'],
    approvals: 1,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('code 0'),
    writeFile: { path: path.join(work, 'probe-write.txt'), content: 'written' },
    method: 'item/commandExecution/requestApproval',
  },
  {
    // This runtime offers request_user_input only in plan mode, so the client's
    // refusal of that server request cannot be reached from a default thread. The
    // case pins that limit instead of claiming the path is exercised.
    name: 'request_user_input is unavailable outside plan mode',
    prompt: '__ASK__ ask me a question',
    args: ['--approval', 'accept', '--approval-policy', 'untrusted'],
    approvals: 0,
    status: 'completed',
    modelOutputs: (out) => out.length === 1 && out[0].includes('unavailable in Default mode'),
  },
]

const failures: string[] = []
const say = (line: string) => process.stdout.write(`${line}\n`)
say(`acceptance: ${cases.length} cases, codex ${binary}, bun ${bunBinary}, witness model on 127.0.0.1:${witness.port}`)
for (const testCase of cases) {
  if (testCase.writeFile) { try { fs.rmSync(testCase.writeFile.path) } catch { /* absent */ } }
  say(`...   ${testCase.name}`)
  const startedAt = Date.now()
  const { code, stdout } = await run(['--prompt', testCase.prompt, ...testCase.args])
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (code !== 0) say(`      child said: ${stdout.trim().split('\n').slice(-2).join(' / ').slice(0, 300)}`)
  const objects = parse(stdout)
  const approvals = objects.filter((entry) => entry.kind === 'approval-request')
  const turn = objects.find((entry) => entry.kind === 'turn') as { status?: string } | undefined
  const outputs = modelOutputs()

  const checks: string[] = []
  const note = (label: string, ok: boolean) => { checks.push(`${label}${ok ? '' : ' FAIL'}`); if (!ok) failures.push(`${testCase.name}: ${label}`) }

  note(`exit ${code}`, code === 0)
  note(`approvals ${approvals.length}/${testCase.approvals}`, approvals.length === testCase.approvals)
  note(`status ${String(turn?.status)}`, turn?.status === testCase.status)
  note(`model outputs ${outputs.length}`, testCase.modelOutputs(outputs))
  if (testCase.method) note(`method ${testCase.method}`, approvals.every((entry) => entry.method === testCase.method))
  if (testCase.writeFile) {
    const content = (() => { try { return fs.readFileSync(testCase.writeFile.path, 'utf8').trim() } catch { return '' } })()
    note(`file content`, content === testCase.writeFile.content)
  }
  say(`${checks.some((entry) => entry.includes('FAIL')) ? 'FAIL' : 'PASS'}  ${testCase.name}  (${seconds}s)  ::  ${checks.join(' | ')}`)
}

say(`\n${cases.length - failures.length}/${cases.length} cases passed`)
if (failures.length > 0) {
  say('failures:')
  for (const failure of failures) say(`  - ${failure}`)
}
process.exit(failures.length === 0 ? 0 : 1)
