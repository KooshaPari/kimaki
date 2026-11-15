// Local model endpoint used only by `scripts/acceptance/codex-approvals.ts`.
// It speaks the streaming Responses API that codex 0.169 uses, so a real codex
// app-server can run turns with no account credential. Prompt conventions:
//   __RUN__     ask for one exec_command
//   __RUN2__    ask for two commands in one turn (one per model round trip)
//   __SAME__    make the second command identical to the first
//   __PREFIX__  make the second command the first plus one argument
//   __ESCALATE__ ask for require_escalated with a justification
//   __PAR__     ask for two commands in a single model output
//   __PATCH__   name an apply_patch tool the runtime never offered
//   __WRITE__   write a file through the shell
import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.argv[2] ?? 0)
const dumpPath = process.env['STUB_DUMP'] ?? ''

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

const messageItem = (text) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

const call = (id, callId, command, extra = {}) => ({
  id,
  type: 'function_call',
  status: 'completed',
  name: 'exec_command',
  call_id: callId,
  arguments: JSON.stringify({ cmd: command, sandbox_permissions: 'use_default', ...extra }),
})

const patchItem = () => ({
  id: 'fc_stub_patch',
  type: 'function_call',
  status: 'completed',
  name: 'apply_patch',
  call_id: 'call_stub_patch',
  arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: probe.txt\n+hello\n*** End Patch' }),
})

const respond = (response, body) => {
  let parsed = null
  try { parsed = JSON.parse(body) } catch { parsed = null }
  if (dumpPath) { try { fs.writeFileSync(dumpPath, body) } catch { /* best effort */ } }

  const items = Array.isArray(parsed?.input) ? parsed.input : []
  const outputs = items.filter((item) => item?.type === 'function_call_output').length
  const first = outputs === 0
  const wantShell = body.includes('__RUN2__') ? 2 : body.includes('__RUN__') ? 1 : 0
  const secondCommand = body.includes('__SAME__')
    ? 'echo approval-ok'
    : body.includes('__PREFIX__')
    ? 'echo approval-ok two'
    : 'echo second-command'

  let output
  if (body.includes('__WRITE__') && first) {
    output = [messageItem('writing a file through the shell'), call('fc_stub', 'call_stub_1', "Set-Content -LiteralPath 'probe-write.txt' -Value written")]
  } else if (body.includes('__PATCH__') && first) {
    output = [messageItem('trying a patch tool the runtime did not offer'), patchItem()]
  } else if (body.includes('__PAR__') && first) {
    output = [messageItem('running two commands at once'), call('fc_stub', 'call_stub_1', 'echo par-one'), call('fc_stub_twin', 'call_stub_2', 'echo par-two')]
  } else if (body.includes('__ESCALATE__') && first) {
    output = [messageItem('asking to leave the sandbox'), call('fc_stub', 'call_stub_1', 'echo escalated-ok', { sandbox_permissions: 'require_escalated', justification: 'the sandbox blocks this write' })]
  } else if (wantShell > outputs) {
    output = [
      messageItem(`running command ${outputs + 1}`),
      call('fc_stub', `call_stub_${outputs + 1}`, first ? 'echo approval-ok' : secondCommand),
    ]
  } else {
    output = [messageItem(`stub-model-reply items=${items.length}`)]
  }

  const write = (type, payload) => { response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`) }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  write('response.created', { type: 'response.created', response: { id: 'resp_stub', object: 'response', created_at: 1, status: 'in_progress', model: 'stub-model', output: [] } })
  output.forEach((item, index) => {
    write('response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' } })
    if (item.type === 'message') {
      for (const part of item.content) {
        write('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: part.text })
      }
    }
    write('response.output_item.done', { type: 'response.output_item.done', output_index: index, item })
  })
  write('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_stub',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'stub-model',
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    },
  })
  response.end()
}

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    if (!request.url.includes('/responses')) {
      log(`${request.method} ${request.url} (ignored)`)
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    respond(response, body)
  })
})

server.listen(port, '127.0.0.1', () => log(`stub model on http://127.0.0.1:${server.address().port}/v1`))

process.on('SIGTERM', () => { server.close(); process.exit(0) })
setTimeout(() => { server.close(); process.exit(0) }, 3_600_000)
