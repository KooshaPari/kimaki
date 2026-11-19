// Bot lifecycle and setup: the root command (start + onboarding), provider
// login, tools (tunnel, tts), and bot status, logs, credentials and keys.
// main.ts, onboarding.ts, tunnel.ts, SQLite and voice are loaded only by the
// commands that run them (see the note in shared.ts).

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import dedent from 'string-dedent'
import { wrapJsonSchema, type Goke } from 'goke'

import { distCliEntry, removeAutostartScript, stableNodePath, writeAutostartScript } from '../autostart.ts'
import { parseDisabledPromptSections, parseDisabledSkills, PROMPT_SECTIONS } from '../builtin-skills.ts'
import { callBot, DEFAULT_LOCK_PORT, RESTART_EXIT_CODE, startLockServer } from '../lock-server.ts'
import { ConfigError } from '../errors.ts'
import { parseDuration } from '../duration.ts'
import { createLogger, setLogFile } from '../logger.ts'
import { action, DATA_DIR_HELP, dataDirOrDefault, discordApi, fail, openCliDb, printJson } from './shared.ts'

const logger = createLogger('CLI')

// The two bot backends the root command can start. `opencode` is the default and
// keeps the existing path byte-identical; `jcode` drives the native Jcode observer
// in backend/jcode-bot-backend.ts instead of discovering an OpenCode service.
export type BotBackend = 'opencode' | 'jcode'
export const BOT_BACKENDS = ['opencode', 'jcode'] as const
// The environment half of the selection. A flag wins over it, and a refusal names
// whichever surface the operator actually used, so a bad env var is not reported as
// a bad flag.
export const BOT_BACKEND_ENV = 'KIMAKI_BACKEND'

// Root-command options that only the OpenCode path can honor: they configure
// OpenCode sessions, their skills and prompts, coordinator threads, or voice
// (which reads OpenCode credentials and config). The Jcode observer has no
// equivalent, so passing one with --backend jcode is refused instead of ignored.
export const OPENCODE_ONLY_OPTIONS = ['--worktrees', '--disable-skills', '--disable-prompt', '--coordinator', '--voice'] as const

// Reads an explicitly passed option without relying on goke's parsed defaults, so
// an option that defaults to on (--coordinator) only counts when the operator
// actually typed it. Handles both `--flag value` and `--flag=value`.
function explicitOption(argv: readonly string[], flag: string): { present: boolean; value?: string } {
  const prefix = `${flag}=`
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === flag) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) return { present: true, value: next }
      return { present: true }
    }
    if (arg.startsWith(prefix)) return { present: true, value: arg.slice(prefix.length) }
  }
  return { present: false }
}

// Pure so the refusal can be tested without spawning a child or touching Discord.
// Returns the resolved backend, or a ConfigError the caller fails with before any
// supervisor child, lock port, database or Discord connection starts.
export function resolveBotBackend({ backend, argv, env = process.env }: {
  backend: string | undefined
  argv: readonly string[]
  env?: Readonly<Record<string, string | undefined>>
}): ConfigError | { backend: BotBackend; source: 'flag' | 'env' | 'default' } {
  const fromEnv = env[BOT_BACKEND_ENV]?.trim()
  const source: 'flag' | 'env' | 'default' = backend !== undefined ? 'flag' : fromEnv !== undefined && fromEnv !== '' ? 'env' : 'default'
  const requested = backend ?? (source === 'env' ? fromEnv! : 'opencode')
  if (!(BOT_BACKENDS as readonly string[]).includes(requested)) {
    const surface = source === 'env' ? BOT_BACKEND_ENV : '--backend'
    return new ConfigError({ reason: `Unknown ${surface} ${JSON.stringify(requested)}. Use one of: ${BOT_BACKENDS.join(', ')}` })
  }
  if (requested === 'opencode') return { backend: 'opencode', source }
  const conflicts = OPENCODE_ONLY_OPTIONS.filter((flag) => {
    const found = explicitOption(argv, flag)
    if (!found.present) return false
    // A jcode bot has no coordinator either, so `--coordinator false` asks for
    // exactly what jcode does. Every other form turns an OpenCode feature on.
    if (flag === '--coordinator' && found.value === 'false') return false
    return true
  })
  if (conflicts.length > 0) {
    return new ConfigError({
      reason: `--backend jcode cannot use ${conflicts.join(', ')}: ${conflicts.length === 1 ? 'it is an OpenCode-only option' : 'they are OpenCode-only options'} with no jcode equivalent. Remove ${conflicts.length === 1 ? 'it' : 'them'}, or drop --backend jcode`,
    })
  }
  return { backend: 'jcode', source }
}

// null when the file vanished meanwhile (bot restart).
async function readRange({ file, start, end }: { file: string; start: number; end: number }): Promise<Buffer | null> {
  const handle = await fs.promises.open(file, 'r').catch(() => null)
  if (!handle) return null
  const buffer = Buffer.alloc(end - start)
  const read = await handle.read(buffer, 0, buffer.length, start).catch(() => null)
  await handle.close().catch(() => undefined)
  return read ? buffer.subarray(0, read.bytesRead) : null
}

// tail -f that survives the bot truncating the file on restart.
async function followFile(file: string): Promise<never> {
  const position = { offset: 0 }
  while (true) {
    const size = await fs.promises.stat(file).then((stat) => stat.size).catch(() => 0)
    if (size < position.offset) position.offset = 0
    if (size > position.offset) {
      const chunk = await readRange({ file, start: position.offset, end: size })
      if (chunk) process.stdout.write(chunk)
      position.offset = size
    }
    await sleep(300)
  }
}

// The root command runs the bot in a child process and starts it again when it
// exits with RESTART_EXIT_CODE (`kimaki restart`), so a restart loads new code:
//
//   kimaki (supervisor) ──spawn, same argv, KIMAKI_SUPERVISED=1──▶ bot
//        ▲                                                         │
//        └──────────── exit 75: spawn again; other code: exit ─────┘
//
// The child shares the terminal (stdio inherit), so onboarding prompts work.
// The IPC channel only exists so the child sees `disconnect` if the supervisor dies.
async function supervise(): Promise<never> {
  const state: { child: ChildProcess | null } = { child: null }
  // Ctrl+C reaches both processes; `kill <supervisor pid>` reaches only this one.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => state.child?.kill('SIGTERM'))
  }
  // Resolved before any Node upgrade: `kimaki restart` must not spawn the deleted binary.
  const node = stableNodePath()
  while (true) {
    const child = spawn(node, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, KIMAKI_SUPERVISED: '1' },
    })
    state.child = child
    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        process.stderr.write(`Cannot start the kimaki bot process: ${error.message}\n`)
        resolve(1)
      })
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
    })
    if (code !== RESTART_EXIT_CODE) process.exit(code)
    process.stderr.write('Restarting kimaki...\n')
  }
}

// `kimaki` with no subcommand.
export function registerStartCommand(cli: Goke) {
  cli.command('', 'Start the bot. Runs onboarding on first start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--backend <name>', 'Bot backend: opencode (default) or jcode. jcode drives a native Jcode session and needs no OpenCode install; KIMAKI_BACKEND sets the same choice when the flag is absent')
    .option('-g, --guild <guildId>', 'Server to onboard when the bot is in several')
    .option('--gateway', 'Use the shared Kimaki bot, no Discord app needed')
    .option('--gateway-callback-url <url>', 'Redirect here after the gateway install (appends ?guild_id=<id>)')
    .option('--install-url', 'Print the install URL and exit (non-interactive onboarding)')
    .option('--machine-name <name>', 'Name in this machine\'s category "Kimaki <name>" (default: hostname)')
    .option('--restart-onboarding', 'Choose credentials again')
    .option('--worktrees', 'Use a fresh Git worktree for new sessions unless the channel overrides it')
    .option('--allow-all-users', 'Every server member can use the bot (role "no-kimaki" still denies; provider login stays admin-only)')
    .option('--voice <name>', 'Voice of voice calls, saved for later starts (e.g. cove, juniper, sol). "default" resets it')
    .option('--disable-skills <list>', 'Built-in Kimaki skills to turn off: "all" or a comma separated list (kimaki-debug,kimaki-tunnel)')
    .option('--disable-prompt <section>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: `System prompt section to remove from new sessions (repeatable): ${PROMPT_SECTIONS.join(', ')}` }))
    .option('--no-analytics', 'Disable anonymous usage analytics (same as KIMAKI_STRADA_ENABLED=0)')
    .option('--coordinator [enabled]', wrapJsonSchema<boolean>({ type: 'boolean', default: true, description: 'Channel messages go to one long coordinator session that starts threads for the work. "false" turns it off (/toggle-coordinator sets one channel)' }))
    .option('--no-autostart', 'Do not open a terminal with the bot when the agent service starts (for bots run by launchd, systemd or pm2)')
    .option('--if-not-running', 'Start only if no bot runs; never stop the running one (used by autostart)')
    .action(async (options) => {
      // Before the supervisor child (which spawns this same argv) and before any
      // Discord or database work, so a bad flag never leaves a process behind.
      const backendChoice = resolveBotBackend({ backend: options.backend, argv: process.argv })
      if (backendChoice instanceof Error) fail(backendChoice)
      const backend = backendChoice.backend
      // The IPC check ignores a KIMAKI_SUPERVISED leaked into a shell by an older bot.
      if (process.env['KIMAKI_SUPERVISED'] !== '1' || !process.connected) return supervise()
      // OpenCode and agent shells inherit process.env: a bot started from a
      // session (tests) would otherwise think it is supervised and SIGTERM itself on restart.
      delete process.env['KIMAKI_SUPERVISED']
      // Bot code loads only here: the other subcommands start without it.
      const [
        { startBot },
        { ensureOpencode, runOnboarding, startCaffeinate },
        { emitEvent, gatewayCredentials, gatewayUrlsFromEnv, installUrlFor, readSavedCredentials, resolveCredentials, restApiUrl },
        { openDb },
        { createAnalytics },
        { opencodeConfigDir, opencodeDbFile },
        { defaultMachineName },
        { ensureVoiceChannels, parseRealtimeVoice, saveVoiceCallVoice },
      ] = await Promise.all([
        import('../main.ts'),
        import('../onboarding.ts'),
        import('../credentials.ts'),
        import('../db.ts'),
        import('../analytics.ts'),
        import('../opencode-server.ts'),
        import('../project.ts'),
        import('../voice-call.ts'),
      ])
      // Non-TTY hosts get the failure as an `error` event too (programmatic onboarding).
      // Explicit type: TS narrows after a `never` call only for annotated consts.
      const failStartup: (error: Error, installUrl?: string) => never = (error, installUrl) => {
        if (!process.stdin.isTTY) emitEvent({ type: 'error', message: error.message, ...(installUrl && { install_url: installUrl }) })
        fail(error)
      }
      const dataDir = dataDirOrDefault(options.dataDir)
      const urls = gatewayUrlsFromEnv()
      const disabledSkills = parseDisabledSkills(options.disableSkills)
      if (disabledSkills instanceof Error) fail(disabledSkills)
      const disabledPrompt = parseDisabledPromptSections(options.disablePrompt)
      if (disabledPrompt instanceof Error) fail(disabledPrompt)
      const machine = options.machineName ?? defaultMachineName()
      // Validated before the lock, so a typo never stops the running bot. null: reset to the default.
      const voice = (() => {
        if (!options.voice) return undefined
        if (options.voice.trim().toLowerCase() === 'default') return null
        const parsed = parseRealtimeVoice(options.voice)
        if (parsed instanceof Error) fail(parsed)
        return parsed.voice
      })()

      if (options.installUrl) {
        const opened = await openDb({ dataDir, migrate: true })
        if (opened instanceof Error) fail(opened)
        const credentials = options.gateway
          ? await gatewayCredentials({ db: opened.db, urls })
          : await readSavedCredentials({ db: opened.db })
        opened.close()
        if (credentials instanceof Error) fail(credentials)
        if (!credentials) fail(new Error('No bot configured yet. Run kimaki first, or pass --gateway.'))
        process.stdout.write(`${installUrlFor({ credentials, website: urls.website, callbackUrl: options.gatewayCallbackUrl })}\n`)
        if (credentials.mode === 'gateway') process.stderr.write('This URL contains your client credentials. Do not share it.\n')
        return
      }

      // Stops a running bot of this port (V1 or V2) before the migration and
      // onboarding, which must not run while it still writes. Before the log
      // reset, so the stopped bot (or the one --if-not-running leaves running) keeps its kimaki.log.
      const lock = await startLockServer({ port: Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT), dataDir, supervised: true, evict: !options.ifNotRunning })
      if (lock instanceof Error) {
        // Another bot won the race after the plugin's health check.
        if (options.ifNotRunning && lock.cause instanceof Error && Reflect.get(lock.cause, 'code') === 'EADDRINUSE') {
          process.stderr.write(`Kimaki already runs on port ${lock.port}. Nothing to start.\n`)
          process.exit(0)
        }
        failStartup(lock)
      }
      const logFile = setLogFile({ dataDir })
      if (logFile instanceof Error) failStartup(logFile)
      // A crash goes to kimaki.log too (Node still prints it and exits).
      process.on('uncaughtExceptionMonitor', (error, origin) => logger.error(`crash (${origin})`, error))
      const opened = await openDb({ dataDir, migrate: true })
      if (opened instanceof Error) failStartup(opened)

      // Before onboarding: without OpenCode the OpenCode backend cannot start, so fail
      // (or install it) before the Discord install. The jcode backend needs no OpenCode.
      if (backend === 'opencode') {
        const opencodeCheck = await ensureOpencode({ serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })
        if (opencodeCheck instanceof Error) {
          opened.close()
          failStartup(opencodeCheck)
        }
      }

      startCaffeinate()
      const resolved = await resolveCredentials({
        db: opened.db,
        gateway: Boolean(options.gateway),
        restartOnboarding: Boolean(options.restartOnboarding),
        urls,
        callbackUrl: options.gatewayCallbackUrl,
      })
      // Saved in SQLite, so restarts, crashes and autostart keep it without the flag.
      const savedVoice = resolved instanceof Error || voice === undefined ? undefined : await saveVoiceCallVoice({ db: opened.db, appId: resolved.credentials.appId, voice })
      opened.close()
      if (resolved instanceof Error) failStartup(resolved)
      if (savedVoice instanceof Error) failStartup(savedVoice)
      if (voice !== undefined) logger.log(`voice calls use ${voice === null ? 'the default voice' : `the voice ${voice}`}`)
      const { credentials, install } = resolved
      const installUrl = installUrlFor({ credentials, website: urls.website, callbackUrl: options.gatewayCallbackUrl })
      // The agent calls this same install. Prefer the built dist entry, so agent
      // commands skip the tsx loader also when the bot runs from src.
      const distCli = distCliEntry()
      const node = stableNodePath()
      const kimakiArgv = fs.existsSync(distCli)
        ? [node, distCli]
        : [node, ...process.execArgv, process.argv[1] ?? 'kimaki']

      const bot = await startBot({
        kimakiArgv,
        dataDir,
        token: credentials.token,
        appId: credentials.appId,
        discordRestUrl: restApiUrl(credentials),
        lock,
        opencodeServiceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'],
        ensureOpencode: backend === 'opencode',
        ...(backend === 'jcode' ? { backend: { kind: 'jcode' as const } } : {}),
        opencodeConfigDir: opencodeConfigDir(),
        opencodeDbFile: opencodeDbFile(),
        analytics: createAnalytics({ dataDir, botMode: credentials.mode, enabled: !options.noAnalytics }),
        autoWorktrees: Boolean(options.worktrees),
        allowAllUsers: Boolean(options.allowAllUsers),
        disabledSkills,
        disabledPrompt,
        coordinator: options.coordinator,
      })
      if (bot instanceof Error) failStartup(bot)
      // Opt-in hub mirror: with no persisted binding this is a no-op, so a plain
      // start behaves exactly as before. A bad binding is reported, never guessed
      // at, and leaves the bot running without a view.
      const { startViewSupervision } = await import('../ops/discord/view-supervision.ts')
      const view = await startViewSupervision({ dataDir, rest: bot.discord.rest })
      const viewError = view.error()
      if (viewError) logger.warn('Discord view not started', viewError)
      const viewBinding = view.binding()
      if (viewBinding) logger.info(`discord view mirrors ${viewBinding.baseUrl} into channel ${viewBinding.channelId}`)
      // The view stops first: it only needs the REST client, which bot.stop() destroys.
      // exit() keeps process.exitCode: the restart route sets RESTART_EXIT_CODE before its SIGTERM.
      const shutdown = () => {
        void view.stop().then(() => bot.stop()).then(() => process.exit())
      }
      process.once('SIGTERM', shutdown)
      process.once('SIGINT', shutdown)
      // The supervisor died (SIGKILL, crash): nobody owns this bot anymore.
      process.once('disconnect', shutdown)

      const gateway = credentials.mode === 'gateway'
      const onboarded = await runOnboarding({ bot, dataDir, guildId: options.guild ?? install?.guildId, installUrl, gateway, installerId: install?.installerId, machine })
      // The bot keeps running; the next start retries onboarding.
      if (onboarded instanceof Error) {
        logger.error(`onboarding failed`, onboarded)
        if (!process.stdin.isTTY) emitEvent({ type: 'error', message: `Onboarding failed: ${onboarded.message}. The bot is running; restart kimaki to retry.` })
        return
      }
      if (onboarded) process.stderr.write(`Onboarding: https://discord.com/channels/${onboarded.guildId}/${onboarded.threadId}\n`)
      const voiceChannels = await ensureVoiceChannels(bot, { machine })
      if (voiceChannels instanceof Error) logger.warn('cannot create the Kimaki voice channel', voiceChannels)
      // --no-autostart removes the script on every start, so the opt-out sticks while
      // launchd or systemd passes the flag. Only the default port: the plugin checks
      // that one. Runtime flags only; credentials, onboarding and --voice are saved in SQLite.
      if (options.noAutostart) {
        const removed = await removeAutostartScript({ dataDir })
        if (removed instanceof Error) logger.warn('cannot remove the autostart script', removed)
      } else if (lock.port === DEFAULT_LOCK_PORT) {
        const autostart = await writeAutostartScript({ dataDir, args: [
          ...(backend === 'jcode' ? ['--backend', 'jcode'] : []),
          ...(options.worktrees ? ['--worktrees'] : []),
          ...(options.allowAllUsers ? ['--allow-all-users'] : []),
          ...(options.disableSkills ? ['--disable-skills', options.disableSkills] : []),
          ...disabledPrompt.flatMap((section) => ['--disable-prompt', section]),
          ...(options.noAnalytics ? ['--no-analytics'] : []),
          ...(options.coordinator ? [] : ['--coordinator', 'false']),
          ...(options.machineName ? ['--machine-name', options.machineName] : []),
        ] })
        if (autostart instanceof Error) logger.warn('cannot write the autostart script', autostart)
      }
      if (!process.stdin.isTTY) emitEvent({ type: 'ready', app_id: credentials.appId, guild_ids: [...bot.discord.guilds.cache.keys()] })
    })
}

// login, login credential: OpenCode provider credentials through the bot.
export function registerLoginCommands(cli: Goke) {
  cli.command('login <provider>', 'Connect a provider using integration credentials')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--key <key>', 'API key to store for the provider')
    .option('--method <id>', 'OAuth method ID; without flags, list login methods')
    .option('--attempt <id>', 'Check or complete this native OAuth attempt')
    .option('--code <code>', 'Authorization code for the attempt')
    .option('--cancel', 'Cancel the native OAuth attempt')
    .action(async (provider, options) => {
      await action({ route: 'login', dataDir: options.dataDir, input: {
        provider, key: options.key, method: options.method, attempt: options.attempt, code: options.code, ...(options.cancel && { operation: 'cancel' }),
      } })
    })

  cli.command('login credential <id>', 'Activate, remove, or label a provider credential')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--operation <name>', 'activate | remove | label')
    .option('--label <text>', 'Credential label')
    .action(async (id, options) => {
      await action({ route: 'credential', dataDir: options.dataDir, input: { id, operation: options.operation ?? 'activate', label: options.label } })
    })
}

// tunnel, tts
export function registerToolCommands(cli: Goke) {
  cli.command('tunnel', 'Run a command and expose its local port with a public opentunnel.xyz URL. The child gets KIMAKI_TUNNEL_URL')
    .option('-p, --port <port>', 'Local port (default: read from the command output)')
    .option('-t, --tunnel-id <id>', 'Fixed subdomain (default: random). Only for public-safe services')
    .option('--host <host>', 'Local host (default: localhost)')
    .option('-k, --kill', 'Kill the process on --port first')
    .example('kimaki tunnel -- pnpm dev')
    .action(async (options) => {
      const command = options['--'] ?? []
      const port = options.port ? Number(options.port) : undefined
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) fail(new Error(`Invalid --port ${options.port}`))
      if (!port && command.length === 0) fail(new Error('Pass a command after --, or --port <port>. Example: kimaki tunnel -- pnpm dev'))
      const { runTunnel } = await import('../tunnel.ts')
      const result = await runTunnel({ port, command: command.length > 0 ? command : undefined, name: options.tunnelId, host: options.host, kill: options.kill })
      if (result instanceof Error) fail(result)
    })

  cli.command('tts [text]', 'Text to speech with OpenAI or Gemini. Reads stdin if no text is given')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-o, --output <path>', 'Output file (default: speech.mp3 or speech.wav)')
    .option('-p, --provider <name>', 'openai | gemini (default: from the stored key)')
    .option('-v, --voice <voice>', 'Voice ID (default: alloy for OpenAI, Kore for Gemini)')
    .option('-i, --instructions <text>', 'Style instructions (OpenAI only)')
    .option('--speed <n>', '0.25 to 4.0 (OpenAI only, default: 1.25)')
    .action(async (text, options) => {
      const chunks: Buffer[] = []
      if (!text && !process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      const input = text ?? Buffer.concat(chunks).toString('utf8').trim()
      if (!input) fail(new Error('Pass the text as an argument or pipe it via stdin'))
      if (options.provider && options.provider !== 'openai' && options.provider !== 'gemini') fail(new Error('--provider must be openai or gemini'))
      const speed = options.speed ? Number(options.speed) : 1.25
      if (!(speed >= 0.25 && speed <= 4)) fail(new Error('--speed must be between 0.25 and 4'))
      const [{ openDb }, { audioKeyCandidates, generateSpeech }] = await Promise.all([import('../db.ts'), import('../voice.ts')])
      // Any stored bot_api_keys row (imported from V1 /transcription-key); a missing database only skips it.
      const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
      const stored = opened instanceof Error ? null : await opened.db.query.bot_api_keys.findFirst().catch(() => null)
      if (!(opened instanceof Error)) opened.close()
      const key = audioKeyCandidates(stored).find((candidate) => !options.provider || candidate.provider === options.provider)
      if (!key) fail(new Error('No OpenAI or Gemini key. Set OPENAI_API_KEY or GEMINI_API_KEY'))
      const result = await generateSpeech({ text: input, apiKey: key.apiKey, provider: key.provider, voice: options.voice, instructions: options.instructions, speed })
      if (result instanceof Error) fail(result)
      const output = path.resolve(options.output ?? `speech.${result.mediaType === 'audio/mp3' ? 'mp3' : 'wav'}`)
      await fs.promises.writeFile(output, result.audio)
      process.stdout.write(`${output}\n`)
    })
}

// status, logs, bot token / keys set / install-url
export function registerBotCommands(cli: Goke) {
  cli.command('status', 'Bot health: running, pid, uptime, agent service URL and version, guilds')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'status', input: {} })
      if (result instanceof Error) {
        process.stdout.write(options.json ? `${JSON.stringify({ running: false, reason: result.message })}\n` : `not running: ${result.message}\n`)
        process.exitCode = 1
        return
      }
      const status = { running: true, ...result.data }
      if (options.json) return printJson(status)
      process.stdout.write(dedent`
        running: pid ${status.pid}, up ${status.uptimeSec}s, mode ${JSON.stringify(status.mode)}
        opencode: ${JSON.stringify(status.opencode)}
        guilds: ${JSON.stringify(status.guilds)}
        data dir: ${JSON.stringify(status.dataDir)}
      ` + '\n')
    })

  cli.command('logs', 'Print the log file path. The bot resets the file on every start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-f, --follow', 'Print the log and keep printing new lines')
    .action(async (options) => {
      const file = path.join(dataDirOrDefault(options.dataDir), 'kimaki.log')
      if (!options.follow) {
        process.stdout.write(`${file}\n`)
        return
      }
      await followFile(file)
    })

  cli.command('restart', 'Restart the running bot with the code on disk. Sessions keep running in the agent service')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'restart', input: {} })
      if (result instanceof Error) fail(result)
      process.stdout.write(`Restarting bot (pid ${result.data.pid})\n`)
    })

  cli.command('profile cpu', 'Record a CPU profile of the running bot and print the .cpuprofile path')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-d, --duration <duration>', 'How long to record, e.g. 20s or 2m (default: 20s)')
    .example('kimaki profile cpu --duration 30s')
    .action(async (options) => {
      const durationMs = parseDuration(options.duration ?? '20s', '--duration')
      if (durationMs instanceof Error) fail(durationMs)
      // Ctrl+C stops the recording early; the bot still writes the profile.
      const controller = new AbortController()
      process.once('SIGINT', () => controller.abort())
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(durationMs + 30_000)])
      process.stderr.write(`Recording for ${options.duration ?? '20s'}. Press Ctrl+C to stop early.\n`)
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'profile.cpu', input: { durationMs }, signal })
      if (result instanceof Error) fail(controller.signal.aborted ? new Error('Stopped early. The bot writes the profile to <data dir>/profiles/') : result)
      process.stdout.write(`${result.data.path}\n`)
    })

  cli.command('profile heap', 'Write a heap snapshot of the running bot and print the .heapsnapshot path')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: 'profile.heap', input: {}, signal: AbortSignal.timeout(300_000) })
      if (result instanceof Error) fail(result)
      process.stdout.write(`${result.data.path}\n`)
    })

  cli.command('bot token', 'Print saved bot credentials for automation')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => process.stdout.write(`${(await discordApi(options.dataDir)).credentials.token}\n`))

  cli.command('bot keys set', 'Store OpenAI or Gemini API keys for voice transcription and kimaki tts')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--openai <key>', 'OpenAI API key')
    .option('--gemini <key>', 'Gemini API key')
    .action(async (options) => {
      const [{ readSavedCredentials }, { saveAudioKeys }] = await Promise.all([import('../credentials.ts'), import('../voice.ts')])
      const opened = await openCliDb(options.dataDir)
      const result = await (async () => {
        const credentials = await readSavedCredentials({ db: opened.db })
        if (credentials instanceof Error) return credentials
        if (!credentials) return new Error('No saved bot credentials. Start kimaki once to onboard.')
        return saveAudioKeys({ db: opened.db, token: credentials.token, openai: options.openai, gemini: options.gemini })
      })()
      opened.close()
      if (result instanceof Error) fail(result)
      process.stdout.write(`Saved ${[options.openai && 'OpenAI', options.gemini && 'Gemini'].filter(Boolean).join(' and ')} API key\n`)
    })

  cli.command('bot install-url', 'Print the Discord bot install URL')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--gateway-callback-url <url>', 'Gateway only: redirect here after the install')
    .action(async (options) => {
      const { installUrlFor, gatewayUrlsFromEnv } = await import('../credentials.ts')
      const { credentials } = await discordApi(options.dataDir)
      process.stdout.write(`${installUrlFor({ credentials, website: gatewayUrlsFromEnv().website, callbackUrl: options.gatewayCallbackUrl })}\n`)
    })

  // The bot starts the hub mirror only for a persisted binding. These commands
  // are explicit: the operator supplies the guild, channel and hub URL, because
  // nothing about the bot can infer which session should be mirrored where.
  cli.command('discord-view bind', 'Mirror one hub session into a Discord channel on every bot start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--tenant <id>', 'Guild id the channel must belong to')
    .option('--surface <id>', 'Channel id to post turns into')
    .option('--url <url>', 'Hub URL, as printed by kimaki ops jcode serve')
    .option('--client <id>', 'Client identity in hub presence (default: discord-view-<surface>)')
    .option('--cursor <n>', 'Start from this cursor when the durable state file is missing')
    .option('--rebind', 'Follow a live session.started that names a different session (default: refuse)')
    .example('kimaki discord-view bind --tenant 123 --surface 456 --url http://127.0.0.1:8787')
    .action(async (options) => {
      const tenantId = options.tenant?.trim()
      if (!tenantId) fail(new ConfigError({ reason: 'Supply --tenant <guildId> explicitly. The view never infers a guild' }))
      const channelId = options.surface?.trim()
      if (!channelId) fail(new ConfigError({ reason: 'Supply --surface <channelId> explicitly. The view never infers a channel' }))
      const baseUrl = options.url?.trim()
      if (!baseUrl) fail(new ConfigError({ reason: 'Supply --url <hubUrl> explicitly. The view never infers a hub' }))
      const { viewBindingPath, writeViewBinding } = await import('../ops/discord/view-supervision.ts')
      const dataDir = dataDirOrDefault(options.dataDir)
      const written = await writeViewBinding({
        dataDir,
        binding: {
          tenantId,
          channelId,
          baseUrl,
          ...(options.client === undefined ? {} : { clientId: options.client }),
          ...(options.cursor === undefined ? {} : { cursor: Number(options.cursor) }),
          ...(options.rebind === true ? { rebind: true } : {}),
        },
      })
      if (written instanceof Error) fail(written)
      process.stdout.write(`Bound the Discord view to channel ${channelId} in guild ${tenantId} (${viewBindingPath(dataDir)}). Start or restart the bot to run it.\n`)
    })

  cli.command('discord-view unbind', 'Stop mirroring the hub into its channel on the next bot start')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (options) => {
      const { removeViewBinding, viewBindingPath } = await import('../ops/discord/view-supervision.ts')
      const dataDir = dataDirOrDefault(options.dataDir)
      const removed = await removeViewBinding({ dataDir })
      if (removed instanceof Error) fail(removed)
      process.stdout.write(removed ? `Removed ${viewBindingPath(dataDir)}\n` : `No Discord view binding at ${viewBindingPath(dataDir)}\n`)
    })

  cli.command('discord-view status', 'Print the persisted Discord view binding')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { readViewBinding, viewBindingPath, viewStatePath } = await import('../ops/discord/view-supervision.ts')
      const dataDir = dataDirOrDefault(options.dataDir)
      const binding = await readViewBinding({ dataDir })
      if (binding instanceof Error) fail(binding)
      const status = binding === null
        ? { bound: false, path: viewBindingPath(dataDir) }
        : {
            bound: true,
            path: viewBindingPath(dataDir),
            tenantId: binding.tenantId,
            channelId: binding.channelId,
            baseUrl: binding.baseUrl,
            clientId: binding.clientId ?? `discord-view-${binding.channelId}`,
            statePath: viewStatePath({ dataDir, channelId: binding.channelId }),
            ...(binding.cursor === undefined ? {} : { cursor: binding.cursor }),
            rebind: binding.rebind === true,
          }
      if (options.json) {
        printJson(status)
        return
      }
      if (binding === null) {
        process.stdout.write(`No Discord view binding at ${viewBindingPath(dataDir)}\n`)
        return
      }
      process.stdout.write(`Discord view bound: guild ${binding.tenantId}, channel ${binding.channelId}, hub ${binding.baseUrl}\n`)
    })
}
