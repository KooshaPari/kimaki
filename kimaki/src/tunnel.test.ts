import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { expect, test } from 'vitest'
import { detectPortFromText, parseNetstatListeningPids, routeName, startHostProxy } from './tunnel.ts'

test('detects the dev server port and skips noise lines', () => {
  const vite = '\u001b[33mPort 5173 is in use, trying another one...\u001b[39m\n  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m5174\u001b[22m/\u001b[39m\n'
  expect({
    vite: detectPortFromText(vite),
    next: detectPortFromText('   - Local:        http://127.0.0.1:3000'),
    bare: detectPortFromText('Server running at 0.0.0.0:4321'),
    inspector: detectPortFromText('Debugger listening on ws://127.0.0.1:9229/abc\nready on http://localhost:4173'),
    outOfRange: detectPortFromText('listening on localhost:70000'),
    portOnly: detectPortFromText('Port 5173 is in use'),
  }).toMatchInlineSnapshot(`
    {
      "bare": 4321,
      "inspector": 4173,
      "next": 3000,
      "outOfRange": null,
      "portOnly": null,
      "vite": 5174,
    }
  `)
})

test('route name: explicit, then tuistory session, then random', () => {
  expect({
    explicit: routeName({ name: 'docs', tuistorySessionId: 'abc123' }),
    normalized: routeName({ name: '_My_App.dev_' }),
    invalid: String(routeName({ name: '___' })),
    tuistory: routeName({ tuistorySessionId: 'Holocron_Dev' }),
    tuistoryInvalid: String(routeName({ tuistorySessionId: '___' })).length,
    random: String(routeName({})).length,
  }).toMatchInlineSnapshot(`
    {
      "explicit": "docs",
      "invalid": "Error: Invalid tunnel ID "___": use letters, digits and dashes",
      "normalized": "my-app-dev",
      "random": 16,
      "tuistory": "holocron-dev",
      "tuistoryInvalid": 16,
    }
  `)
})

test('netstat listening pids on Windows', () => {
  const stdout = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1234',
    '  TCP    [::]:5173              [::]:0                 LISTENING       1234',
    '  TCP    127.0.0.1:51730        0.0.0.0:0              LISTENING       999',
    '  TCP    127.0.0.1:5173         127.0.0.1:60000        ESTABLISHED     777',
    '  UDP    0.0.0.0:5173           *:*                                    555',
  ].join('\r\n')
  expect(parseNetstatListeningPids({ stdout, port: 5173 })).toMatchInlineSnapshot(`
    [
      1234,
    ]
  `)
})

function request({ port, headers }: { port: number; headers: http.OutgoingHttpHeaders }): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers })
    req.on('response', (res) => {
      res.resume()
      resolve(String(res.statusCode))
      req.destroy()
    })
    req.on('upgrade', (res, socket) => {
      resolve(`${res.statusCode} ${res.headers['sec-websocket-protocol']}`)
      socket.destroy()
    })
    req.on('error', reject)
    req.end()
  })
}

test('host proxy lets the public tunnel host through Vite host check, HMR included', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-tunnel-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<p>hi</p>')
  const vite = await createServer({ root, configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('no vite address')
  const proxy = await startHostProxy({ host: '127.0.0.1', port: address.port })
  if (proxy instanceof Error) throw proxy
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('no proxy address')

  const publicHost = { host: 'docs.abc.opentunnel.xyz' }
  const hmr = { ...publicHost, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'vite-hmr' }
  try {
    expect({
      direct: await request({ port: address.port, headers: publicHost }),
      proxied: await request({ port: proxyAddress.port, headers: publicHost }),
      proxiedHmr: await request({ port: proxyAddress.port, headers: hmr }),
    }).toMatchInlineSnapshot(`
      {
        "direct": "403",
        "proxied": "200",
        "proxiedHmr": "101 vite-hmr",
      }
    `)
  } finally {
    proxy.close()
    await vite.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
