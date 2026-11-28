// Two approvals open at once, answered differently, against the real
// `codex app-server` binary. The single-decision CLI cannot express this: one policy
// answers every request the same way. So this pass drives `createCodexController`
// directly, accepts whichever request names `par-one` and declines the other, and
// then checks the model's own next input to see which command actually ran.
//
//   bun scripts/acceptance/codex-parallel-approvals.ts
//
// It starts its own witness model and temporary Codex home; no account credential is
// involved and the home is removed on exit.
import { modelOutputs, startWitness } from './codex-witness.ts'
import { startCodexAppServer } from '../../src/ops/runtime/codex-app-server.ts'
import { createCodexController } from '../../src/ops/runtime/codex.ts'
import fs from 'node:fs'
import path from 'node:path'

const binary = process.env['CODEX_BINARY'] ?? 'codex'
const witness = await startWitness('kimaki-codex-parallel-')
process.on('exit', () => witness.stop())

// Output is mirrored to a file as it happens: a stall then leaves a trail instead of
// a silent ten-minute wait.
const trace = path.join(path.dirname(witness.home), 'pass.log')
const say = (line: string) => {
  process.stdout.write(`${line}\n`)
  try { fs.appendFileSync(trace, `${new Date().toISOString()} ${line}\n`) } catch { /* best effort */ }
}
say(`trace ${trace}`)

// A hard stop, so a stalled run fails loudly rather than hanging.
const watchdog = setTimeout(() => {
  say('FAIL  watchdog: the pass did not finish in 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()
const failures: string[] = []
const check = (label: string, ok: boolean) => {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures.push(label)
}

const server = await startCodexAppServer({ binary, codexHome: witness.home, timeoutMs: 60_000, holdServerRequests: true })
if (server instanceof Error) {
  say(`FAIL  transport: ${server.message}`)
  process.exit(1)
}

type Seen = { requestId: number; command: string | null; decision: string; delivered: boolean; openWhenArrived: number }
const seen: Seen[] = []
let peakOpen = 0
let controller!: ReturnType<typeof createCodexController>

const instance = createCodexController({
  hostId: 'local',
  endpointId: 'explicit-app-server',
  request: server.request,
  subscribe: server.subscribe,
  timeoutMs: 60_000,
  turnTimeoutMs: 120_000,
  holdsServerRequests: true,
  serverRequests: { result: server.respond, error: server.respondError },
  approvals: {
    onRequest: (request) => {
      // The decision is keyed on the command text, so a swapped id shows up as the
      // wrong command running rather than as a bookkeeping detail.
      const decision = request.command?.includes('par-one') ? 'accept' : 'decline'
      const openWhenArrived = controller.pendingApprovals().length
      peakOpen = Math.max(peakOpen, openWhenArrived)
      // Answer asynchronously, so both requests are open at the same time.
      setTimeout(() => {
        const answer = controller.answerApproval({
          requestId: request.requestId,
          decision: decision === 'accept' ? 'accept' : 'decline',
          ...(decision === 'accept' ? { expectedDigest: request.digest } : {}),
        })
        seen.push({ requestId: request.requestId, command: request.command, decision, delivered: !(answer instanceof Error), openWhenArrived })
      }, 300)
    },
  },
})
if (instance instanceof Error) {
  say(`FAIL  controller: ${instance.message}`)
  await server.close()
  process.exit(1)
}
controller = instance

const started = await controller.startThread({ cwd: witness.work, approvalPolicy: 'untrusted' })
if (started instanceof Error) {
  say(`FAIL  thread: ${started.message}`)
  controller.close()
  await server.close()
  process.exit(1)
}

const result = await controller.sendTurn({ threadId: started.threadId, text: '__PAR__ run two commands at once' })
const outputs = modelOutputs(witness.dump)
const stillOpen = controller.pendingApprovals().length

check('two approvals requested', seen.length === 2)
check('request ids are distinct', new Set(seen.map((entry) => entry.requestId)).size === 2)
check('both were open at the same time', peakOpen === 2)
check('each answer was delivered', seen.every((entry) => entry.delivered))
check('the first command was accepted', seen.some((entry) => entry.command?.includes('par-one') && entry.decision === 'accept'))
check('the second command was declined', seen.some((entry) => entry.command?.includes('par-two') && entry.decision === 'decline'))
check('the accepted command ran', outputs.some((output) => output.includes('par-one') && output.includes('code 0')))
check('the declined command did not run', outputs.some((output) => output.includes('rejected by user')) && !outputs.some((output) => output.includes('par-two')))
check('the turn completed', !(result instanceof Error) && result.status === 'completed')
check('no approval left open', stillOpen === 0)

say(`\n${seen.length === 2 && failures.length === 0 ? 'ok' : 'failed'}: requests ${JSON.stringify(seen.map((entry) => ({ requestId: entry.requestId, command: entry.command, decision: entry.decision })))}`)

controller.close()
await server.close()
clearTimeout(watchdog)
// The witness model is a child with piped stdio, so it keeps the event loop alive
// until it is stopped. Without this the pass printed every result and then hung.
witness.stop()
if (failures.length > 0) {
  say(`failures: ${failures.join('; ')}`)
  process.exit(1)
}
process.exit(0)
