// Shared setup for the Codex acceptance scripts: a witness model, an isolated Codex
// home that points at it, and a working directory whose writes the cases can check.
// Nothing here touches the user's own Codex home or credentials.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const packageRoot = path.resolve(import.meta.dir, '../..')

// This host has a stale `bun.exe` earlier on PATH than the working shim, and one of
// them fails to spawn at all, so the shim is preferred explicitly. `BUN_BINARY`
// overrides both.
const bunCandidates = [
  process.env['BUN_BINARY'],
  path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
  'bun',
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
export const bunBinary = bunCandidates.find((candidate) => candidate === 'bun' || fs.existsSync(candidate)) ?? 'bun'

export type Witness = {
  home: string
  work: string
  port: number
  /** Absolute path of the last request the model received, as JSON. */
  dump: string
  stop: () => void
}

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address() as net.AddressInfo
    server.close(() => resolve(address.port))
  })
})

const waitForListener = async (port: number) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
    })
    if (reachable) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`witness model did not listen on ${port}`)
}

export async function startWitness(prefix = 'kimaki-codex-acceptance-'): Promise<Witness> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const home = path.join(scratch, 'home')
  const work = path.join(scratch, 'work')
  const dump = path.join(scratch, 'last-request.json')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(work, { recursive: true })

  const port = await freePort()
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "stub-model"
model_provider = "stub"

[model_providers.stub]
name = "stub"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "PATH"
wire_api = "responses"
`)

  const stub = spawn(process.execPath, [path.join(import.meta.dir, 'codex-stub-model.mjs'), String(port)], {
    env: { ...process.env, STUB_DUMP: dump },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  stub.stdout.on('data', () => {})
  stub.stderr.on('data', (chunk) => process.stderr.write(`[stub] ${chunk}`))

  await waitForListener(port)

  const stop = () => {
    stub.kill()
    fs.rmSync(scratch, { recursive: true, force: true })
  }

  // A cancelled run must not leave its temporary Codex home behind: two such
  // directories survived an interrupted session before this existed.
  let stopped = false
  const stopOnce = () => {
    if (stopped) return
    stopped = true
    stop()
  }
  process.once('SIGINT', () => { stopOnce(); process.exit(130) })
  process.once('SIGTERM', () => { stopOnce(); process.exit(143) })
  process.once('exit', stopOnce)

  return { home, work, port, dump, stop: stopOnce }
}

/** The `function_call_output` entries the model was given, which is what proves a command ran. */
export const modelOutputs = (dump: string): string[] => {
  try {
    const body = JSON.parse(fs.readFileSync(dump, 'utf8'))
    const items = Array.isArray(body.input) ? body.input : []
    return items
      .filter((item: { type?: string }) => item?.type === 'function_call_output')
      .map((item: { output?: unknown }) => String(item.output ?? ''))
  } catch {
    return []
  }
}
