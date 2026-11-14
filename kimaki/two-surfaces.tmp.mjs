// Two surfaces on one served session, plus a tenant mismatch refusal.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { REST, Routes } from 'discord.js'

const repo = 'E:/koosh/CodeProjects/kimaki/kimaki'
const scratch = 'E:/koosh/Agents/scratch/two-surfaces'
fs.mkdirSync(scratch, { recursive: true })
const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts)
const run = (args, env = {}) =>
  spawn(process.execPath, ['--import', 'tsx', path.resolve(repo, 'src/cli.ts'), ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const waitExit = (child) => new Promise((resolve) => child.on('exit', (code) => resolve(code)))

const discord = new DigitalDiscord({ guild: { name: 'Multi' }, channels: [{ name: 'one', type: 0 }, { name: 'two', type: 0 }] })
await discord.start()
const channels = await discord.prisma.channel.findMany()
const [first, second] = channels.map((channel) => channel.id)
const rest = new REST({ api: discord.restUrl, version: '10' }).setToken(discord.botToken)
const env = { KIMAKI_DISCORD_REST_URL: discord.restUrl, KIMAKI_BOT_TOKEN: discord.botToken }
const count = async (channelId) => (await rest.get(Routes.channelMessages(channelId))).length
log('twin ready', discord.restUrl, 'channels', first, second)

const hub = run(['ops', 'codex', 'serve', '--binary', 'C:/Users/koosh/.bun/bin/codex.exe', '--codex-home', 'E:/koosh/Agents/scratch/codex-local-model/home', '--cwd', scratch, '--timeout-ms', '30000'])
const hubUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('hub start timeout')), 90_000)
  let buffer = ''
  hub.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    const match = buffer.match(/"url":\s*"([^"]+)"/)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  })
  hub.on('exit', (code) => { clearTimeout(timer); reject(new Error(`hub exited ${code}`)) })
})
log('hub', hubUrl)

const stateA = path.join(scratch, 'a.json')
const stateB = path.join(scratch, 'b.json')
const stateC = path.join(scratch, 'c.json')
for (const file of [stateA, stateB, stateC]) fs.rmSync(file, { force: true })

const viewA = run(['ops', 'discord', 'view', '--url', hubUrl, '--tenant', discord.guildId, '--surface', first, '--state', stateA, '--timeout', '120000'], env)
const viewB = run(['ops', 'discord', 'view', '--url', hubUrl, '--tenant', discord.guildId, '--surface', second, '--state', stateB, '--timeout', '120000'], env)
for (const view of [viewA, viewB]) view.stderr.on('data', (chunk) => log('view err', chunk.toString().trim()))
await new Promise((resolve) => setTimeout(resolve, 2500))

const turn = run(['ops', 'jcode', 'attach', '--url', hubUrl, '--client', 'multi', '--prompt', 'One turn, two surfaces', '--json', '--timeout', '90000'], env)
log('turn exit', await waitExit(turn))
for (let i = 0; i < 40; i++) {
  if ((await count(first)) >= 1 && (await count(second)) >= 1) break
  await new Promise((resolve) => setTimeout(resolve, 500))
}
log('channel one', await count(first), 'channel two', await count(second))
log('states', fs.existsSync(stateA) ? fs.readFileSync(stateA, 'utf8') : 'missing', fs.existsSync(stateB) ? fs.readFileSync(stateB, 'utf8') : 'missing')

const before = await count(first)
const viewC = run(['ops', 'discord', 'view', '--url', hubUrl, '--tenant', '000000000000000000', '--surface', first, '--state', stateC, '--timeout', '30000'], env)
let out = ''
viewC.stdout.on('data', (chunk) => { out += chunk })
viewC.stderr.on('data', (chunk) => { out += chunk })
const exitC = await waitExit(viewC)
log('tenant mismatch exit', exitC)
log('tenant mismatch output', out.trim().split('\n').slice(-1)[0])
log('channel one after refusal', await count(first), 'was', before, '| state C exists', fs.existsSync(stateC))

viewA.kill()
viewB.kill()
hub.kill()
await Promise.all([waitExit(viewA), waitExit(viewB), waitExit(hub)])
await discord.stop()
process.exit(0)
