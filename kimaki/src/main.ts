// Bot wiring. Order: lock port (bound by the caller) -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. Returns a handle so tests can drive the bot
// in-process and stop it cleanly.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import * as errore from 'errore'

import { createJcodeBotBackend, resolveJcodeHome, type JcodeBotBackendInput, type JcodeBotBackendSpec, type JcodeBotConnection } from './backend/jcode-bot-backend.ts'
import { createAgentUi } from './agent-ui.ts'
import type { Analytics } from './analytics.ts'
import { oc, type Bot, type WarmupTimers } from './bot.ts'
import type { PromptSection } from './builtin-skills.ts'
import { openDb } from './db.ts'
import { createEffectsRunner } from './effects.ts'
import { DbError, DiscordError } from './errors.ts'
import { createEventLoop, type RunEnded } from './event-loop.ts'
import { registerIngress } from './ingress.ts'
import { runLockRoute } from './lock-routes.ts'
import { installShim, type LockServer } from './lock-server.ts'
import { createLogger } from './logger.ts'
import { createCoordinatorNotes } from './coordinator.ts'
import { installPluginShim, watchOpencode, type Backend, type OpencodeConnection, type OpencodeEndpoint } from './opencode-server.ts'
import { countUserProjects } from './project.ts'
import { createScheduler, systemClock, type Clock } from './scheduler.ts'
import { createEventRecorder, syncSessionTranscript } from './session-events.ts'
import { channelDefaults, createPluginWait, refreshCliContext } from './sessions.ts'
import { createInteractionRegistry, registerSlashCommands } from './slash-commands.ts'
import { createSleepLock } from './sleeps.ts'
import { createBotStore } from './store.ts'
import { backendPlan } from './thread-backend.ts'
import type { TranscriptionBaseUrls } from './voice.ts'
import { createVoiceCalls, type RealtimeBaseUrls } from './voice-call.ts'

const logger = createLogger('MAIN')
// The close handshake takes ~120ms to Discord and to gateway-proxy.
const DISCORD_CLOSE_WAIT_MS = 500

export type StartBotOptions = {
  dataDir: string
  token: string
  // Credentials.appId; must have a bot_tokens row.
  appId: string
  // Bound by the caller before migration and onboarding; startBot owns it from here.
  lock: LockServer
  // discord.js REST `api` URL: gateway-proxy in gateway mode, the digital twin
  // in tests. The WebSocket URL comes from GET /gateway/bot on that host.
  discordRestUrl?: string | null
  // Registration file of the OpenCode service. Defaults to the XDG state dir.
  opencodeServiceFile?: string
  // Start the service with Service.ensure() when none is running.
  ensureOpencode: boolean
  // Global OpenCode config dir that gets plugins/kimaki/ (opencodeConfigDir()).
  // Required, so no caller writes into the user's real config by accident.
  opencodeConfigDir: string
  // OpenCode's SQLite file (opencodeDbFile()): voice transcription reads the ChatGPT credential from it.
  // Required, so tests never read the developer's real credentials.
  opencodeDbFile: string
  // Command that runs this Kimaki install, for the <dataDir>/bin/kimaki shim agents call.
  // No --data-dir: the shim sets KIMAKI_DATA_DIR, and not every command takes the flag.
  kimakiArgv: readonly string[]
  // Product analytics sink (createAnalytics or disabledAnalytics).
  analytics: Analytics
  // Voice transcription API base URLs; tests point Gemini at a local fake.
  transcriptionBaseUrls?: TranscriptionBaseUrls
  // Voice call WebSocket URLs; tests point OpenAI at a local fake.
  realtimeBaseUrls?: RealtimeBaseUrls
  // The scheduler's only source of time. Tests pass a manual clock.
  clock?: Clock
  // How often due tasks and wakes run; null: never (tests call scheduler.runDueTasks).
  schedulerIntervalMs?: number | null
  autoWorktrees?: boolean
  allowAllUsers?: boolean
  // Built-in skill ids denied in new sessions (builtin-skills.ts).
  disabledSkills?: readonly string[]
  // Static instruction parts left out of new sessions (system-prompt.ts).
  disabledPrompt?: readonly PromptSection[]
  // `--coordinator`: coordinator mode for channels without a /toggle-coordinator choice (ingress.ts). Default: on.
  coordinator?: boolean
  // Default: the plugin's prompt cache warmup windows (plugin/coordinator.ts). Tests pass short ones.
  warmupTimers?: WarmupTimers
  // Drive the event loop from a native Jcode session instead of OpenCode. Absent: the OpenCode
  // path below, unchanged. Present: the observe-only seam in backend/jcode-bot-backend.ts; a
  // failure to construct it is returned as an Error, never a fallback to OpenCode.
  backend?: JcodeBotBackendSpec
}

// The arguments the OpenCode watcher takes. Exported so the seam's default path can be asserted
// without starting Discord or an OpenCode service.
export type BotConnectionCallbacks = Parameters<typeof watchOpencode>[0]

export type BotConnectionSelection = OpencodeConnection | Promise<Error | OpencodeConnection | JcodeBotConnection>

/**
 * The one place startBot chooses its backend.
 *
 * With no `backend` this calls watchOpencode with exactly the callbacks it always received and
 * returns its connection synchronously, so the default path gains no await and no new object.
 * With a Jcode backend it returns a promise; construction resolves an Error rather than throwing.
 */
export function startBotConnection(
  {
    backend,
    callbacks,
    cursorDir,
    intervalMs,
  }: {
    backend?: JcodeBotBackendSpec
    callbacks: BotConnectionCallbacks
    // Durable dedupe for the Jcode observer; must live outside the Jcode store.
    cursorDir?: string
    intervalMs?: number
  },
  opencodeFactory: (options: BotConnectionCallbacks) => OpencodeConnection = watchOpencode,
  jcodeFactory: (input: JcodeBotBackendInput) => Promise<Error | JcodeBotConnection> = createJcodeBotBackend,
): BotConnectionSelection {
  if (backend?.kind !== 'jcode') return opencodeFactory(callbacks)
  return jcodeFactory({
    ...(backend.binary === undefined ? {} : { binary: backend.binary }),
    ...(backend.home === undefined ? {} : { home: backend.home }),
    ...(backend.sessionId === undefined ? {} : { sessionId: backend.sessionId }),
    ...(backend.follow === undefined ? {} : { follow: backend.follow }),
    ...(backend.createPrompt === undefined ? {} : { createPrompt: backend.createPrompt }),
    ...(cursorDir === undefined ? {} : { cursorDir }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    onEvent: callbacks.onEvent,
  })
}

/** Session ids already persisted under the home the bot will observe. */
const persistedJcodeSessions = (home: string | undefined): string[] => {
  const dir = path.join(resolveJcodeHome(home), 'sessions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort()
}

export type JcodeStartupFollow =
  | { follow: 'defer'; reason: string }
  | { follow?: 'existing' | 'create' | 'defer'; reason: null }

/**
 * The one place the bot decides how its own jcode session starts.
 *
 * A cold install has no explicit session id, no creation prompt and no persisted
 * record, so it defers: a thread creates its own session when it binds. Every
 * other case keeps the previous choice, including the loud refusal for a
 * non-explicit follow over an empty store, because callers that need one bot
 * session must hear about that fault.
 */
export function jcodeStartupFollow({
  backend,
  persistedSessions,
}: {
  backend?: JcodeBotBackendSpec
  persistedSessions: readonly string[]
}): JcodeStartupFollow {
  const deferred: JcodeStartupFollow = { follow: 'defer', reason: 'no persisted session; the first thread creates its own session when it binds' }
  const explicit = backend?.follow
  // An explicit defer is honoured, and reported the same way as an inferred one.
  if (backend?.kind === 'jcode' && explicit === 'defer') return deferred
  // Only an unconfigured cold install defers. Any explicit follow, including a
  // `create` prompt or an `existing` id, keeps today's behaviour: creation mints
  // a session, an id is followed, and a non-explicit empty store still refuses.
  if (
    backend?.kind === 'jcode' &&
    explicit === undefined &&
    (backend.sessionId === undefined || backend.sessionId.trim() === '') &&
    (backend.createPrompt === undefined || backend.createPrompt.trim() === '') &&
    persistedSessions.length === 0
  ) {
    return deferred
  }
  return { follow: explicit, reason: null }
}

export type BotConnections = {
  // `--backend` / KIMAKI_BACKEND: the backend new threads bind to.
  backendKind: 'opencode' | 'jcode'
  // The connection `bot.opencode` exposes: the configured backend.
  primary: OpencodeConnection | JcodeBotConnection
  // Every connection this bot started (thread-backend.ts resolves per thread).
  backends: { readonly opencode: OpencodeConnection | null; readonly jcode: JcodeBotConnection | null }
  // Cold-install notice: the bot is up but has no session until a thread binds.
  startupNotice?: string
}

/**
 * Every connection one bot start needs.
 *
 * A jcode start still starts OpenCode when a persisted row says `opencode`, which is the
 * plan step 1.1 mitigation: legacy threads keep resolving through the OpenCode connection.
 * A start with no such row starts no OpenCode connection at all. The primary connection is
 * always the configured backend, so a jcode bot reports OpenCode-only operations by name
 * rather than silently falling back.
 */
export async function startBotConnections(
  {
    backend,
    callbacks,
    cursorDir,
    intervalMs,
    legacyOpencodeThreads,
    persistedSessions,
  }: {
    backend?: JcodeBotBackendSpec
    callbacks: BotConnectionCallbacks
    cursorDir?: string
    intervalMs?: number
    // Rows whose backend is opencode (backendPlan().needsOpencode).
    legacyOpencodeThreads: boolean
    // Session ids already persisted under the configured jcode home.
    persistedSessions?: readonly string[]
  },
  opencodeFactory: (options: BotConnectionCallbacks) => OpencodeConnection = watchOpencode,
  jcodeFactory: (input: JcodeBotBackendInput) => Promise<Error | JcodeBotConnection> = createJcodeBotBackend,
): Promise<Error | BotConnections> {
  const backendKind: 'opencode' | 'jcode' = backend?.kind === 'jcode' ? 'jcode' : 'opencode'
  const follow = jcodeStartupFollow({ backend, persistedSessions: persistedSessions ?? [] })
  const selected = startBotConnection(
    {
      ...(backend === undefined ? {} : { backend: { ...backend, ...(follow.reason === null ? {} : { follow: follow.follow }) } }),
      callbacks,
      ...(cursorDir === undefined ? {} : { cursorDir }),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    },
    opencodeFactory,
    jcodeFactory,
  )
  const primary = selected instanceof Promise ? await selected : selected
  if (primary instanceof Error) return primary
  if (backendKind === 'opencode') return { backendKind, primary: primary as OpencodeConnection, backends: { opencode: primary as OpencodeConnection, jcode: null } }
  const jcode = (): BotConnections => ({
    backendKind,
    primary: primary as JcodeBotConnection,
    backends: {
      opencode: legacyOpencodeThreads ? opencodeFactory(callbacks) : null,
      jcode: primary as JcodeBotConnection,
    },
    ...(follow.reason === null ? {} : { startupNotice: follow.reason }),
  })
  return jcode()
}

export type BotHandle = Bot & {
  lock: LockServer
  // Tests drive scheduling with a manual clock and call this themselves.
  scheduler: { runDueTasks: () => Promise<void> }
  stop: () => Promise<void>
}

async function loginDiscord({ discord, token }: { discord: Client; token: string }): Promise<DiscordError | void> {
  const ready = new Promise<void>((resolve) => discord.once(Events.ClientReady, () => resolve()))
  const login = await discord.login(token).catch((e) => new DiscordError({ operation: 'login', cause: e }))
  if (login instanceof Error) return login
  await ready
}

export async function startBot(options: StartBotOptions): Promise<Error | BotHandle> {
  // Each resource registers its cleanup when acquired; disposal runs in reverse
  // (commands and scheduler first, the db and the lock port last). A startup
  // failure disposes it on return; a started bot moves it into stop().
  await using cleanup = new errore.AsyncDisposableStack()
  const lock = options.lock
  cleanup.defer(() => lock.close())

  const opened = await openDb({ dataDir: options.dataDir, migrate: true })
  if (opened instanceof Error) return opened
  cleanup.defer(() => opened.close())
  const db = opened.db

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    ...(options.discordRestUrl && { rest: { api: options.discordRestUrl, version: '10' } }),
  })
  // TODO: drop this once @discordjs/rest can keep its token on 401. handleErrors()
  // calls setToken(null) on any 401, and every later request fails with "Expected
  // token to be set" until a restart. One transient 401 (gateway-proxy restarting
  // with an empty client registry) must not kill the bot. Only Client.destroy()
  // may clear it: it sets client.token to null first.
  // https://github.com/discordjs/discord.js/blob/main/packages/rest/src/lib/handlers/Shared.ts
  const setToken = discord.rest.setToken.bind(discord.rest)
  discord.rest.setToken = (token) => {
    // Typed string, but handleErrors() and destroy() pass null.
    if (!token && discord.token !== null) {
      logger.warn('Discord REST answered 401; keeping the bot token for the next request')
      return discord.rest
    }
    return setToken(token)
  }
  // Gateway lifecycle, to debug reconnects that break voice joins or event delivery.
  discord.on(Events.ShardDisconnect, (event, id) => logger.warn(`gateway shard ${id} disconnected with code ${event.code}`))
  discord.on(Events.ShardReconnecting, (id) => logger.warn(`gateway shard ${id} reconnecting`))
  discord.on(Events.ShardResume, (id, replayed) => logger.info(`gateway shard ${id} resumed, ${replayed} events replayed`))
  discord.on(Events.ShardReady, (id) => logger.info(`gateway shard ${id} ready`))
  discord.on(Events.ShardError, (error, id) => logger.warn(`gateway shard ${id} error`, error))
  // TODO: await destroy() fully once gateway-proxy uses Fly's `tls` handler. Fly's `http`
  // handler closes a WebSocket's client TCP ~5s after the proxy closed it, and destroy()
  // waits for that TCP close, so Ctrl+C took 5s. The close frames are exchanged by then.
  cleanup.defer(() => Promise.race([discord.destroy(), sleep(DISCORD_CLOSE_WAIT_MS, undefined, { ref: false })]))
  cleanup.defer(() => options.analytics.flush())
  const store = createBotStore()
  const recorder = createEventRecorder({ dataDir: options.dataDir })
  cleanup.defer(() => recorder.close())
  const effects = createEffectsRunner({
    discord,
    // Viewed effects come from OpenCode events, so `opencode` below is always set by then.
    markViewed: async ({ sessionId, idle }) => {
      const result = await oc({ opencode }, 'mark session viewed', (client) => client.session.view({ sessionID: sessionId, idle }))
      if (result instanceof Error) return result
    },
    footerDefaults: (channelId) => channelDefaults({ db, opencode }, channelId),
  })
  cleanup.defer(() => effects.stop())
  const voiceCalls = createVoiceCalls({ opencodeConfigDir: options.opencodeConfigDir })
  const onTranscriptDue = (sessionId: string) => {
    void oc({ opencode }, 'sync transcript', (client) => syncSessionTranscript({ client, dataDir: options.dataDir, sessionId })).then((result) => {
      if (result instanceof Error) logger.warn(`transcript of ${sessionId} not synced`, result)
    })
  }
  const coordinatorNotes = createCoordinatorNotes()
  const onRunEnded = (run: RunEnded) => {
    voiceCalls.runEnded(run)
    coordinatorNotes.runEnded(run)
  }
  const eventLoop = createEventLoop({ store, db, discord, effects, recorder, analytics: options.analytics, onRunEnded, onTranscriptDue })
  const loaded = await eventLoop.load()
  if (loaded instanceof Error) return loaded
  // Before the service is used, so a service started by ensure() loads it at once.
  const plugin = await installPluginShim({ configDir: options.opencodeConfigDir })
  if (plugin instanceof Error) return plugin
  // Which persisted rows need which connection (step 1.1's mitigation). Read after
  // eventLoop.load(), which reads the same table, so a failure is already reported.
  const persistedRows = await db.query.thread_sessions.findMany({ columns: { thread_id: true, backend: true } }).catch((cause) => new DbError({ operation: 'read thread_sessions', cause }))
  if (persistedRows instanceof Error) return persistedRows
  const plan = backendPlan(persistedRows)
  const connections = await startBotConnections({
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    cursorDir: path.join(options.dataDir, 'jcode-observe'),
    legacyOpencodeThreads: plan.needsOpencode,
    persistedSessions: options.backend?.kind === 'jcode' ? persistedJcodeSessions(options.backend.home) : [],
    callbacks: {
      serviceFile: options.opencodeServiceFile,
      ensure: options.ensureOpencode,
      onConnect: eventLoop.onConnect,
      onEvent: eventLoop.onEvent,
      onDisconnect: eventLoop.onDisconnect,
    },
  })
  if (connections instanceof Error) return connections
  const { startupNotice } = connections
  // `bot.opencode` is the configured backend; `bot.backends` is what thread rows resolve to.
  const opencode: Bot['opencode'] = connections.primary
  const { backends } = connections
  cleanup.defer(() => opencode.stop())
  if (backends.opencode && backends.opencode !== opencode) cleanup.defer(() => backends.opencode?.stop())
  const shim = await installShim({ dataDir: options.dataDir, argv: options.kimakiArgv })
  if (shim instanceof Error) return shim
  // The features that non-interaction code reaches through bot.features.
  const agentUi = createAgentUi({ store, eventLoop, opencode })
  cleanup.defer(() => agentUi.stop())
  const bot: Bot = {
    discord,
    db,
    store,
    opencode,
    backends,
    backendKind: connections.backendKind,
    // A created thread's session must land in the store this bot observes, so the same
    // explicit binary/home that started the connection is what creation uses.
    jcodeStore: {
      binary: options.backend?.binary ?? null,
      home: options.backend?.home ?? null,
    },
    eventLoop,
    effects,
    analytics: options.analytics,
    clock: options.clock ?? systemClock,
    dataDir: options.dataDir,
    lockPort: lock.port,
    supervised: lock.supervised,
    token: options.token,
    appId: options.appId,
    opencodeDbFile: options.opencodeDbFile,
    transcriptionBaseUrls: options.transcriptionBaseUrls ?? {},
    realtimeBaseUrls: options.realtimeBaseUrls ?? {},
    autoWorktrees: options.autoWorktrees ?? false,
    allowAllUsers: options.allowAllUsers ?? false,
    disabledSkills: options.disabledSkills ?? [],
    disabledPrompt: options.disabledPrompt ?? [],
    coordinatorDefault: options.coordinator ?? true,
    warmupTimers: options.warmupTimers ?? null,
    features: { withSleepLock: createSleepLock(), waitForPlugin: createPluginWait({ opencode }), agentUi, voiceCalls },
  }
  const scheduler = createScheduler({
    bot,
    intervalMs: options.schedulerIntervalMs === undefined ? 5_000 : options.schedulerIntervalMs,
  })
  cleanup.defer(() => scheduler.stop())
  // The lock server only passes /kimaki/* paths.
  lock.handle((route, input, signal) => runLockRoute(bot, { route: route.slice('/kimaki/'.length), input, signal }))
  // Before login: gateway-proxy replays missed messages right after READY.
  registerIngress(bot)
  voiceCalls.register(bot)
  coordinatorNotes.register(bot)
  // Before discord.destroy() (registered earlier, so disposed later): leaving voice needs the gateway.
  cleanup.defer(() => voiceCalls.stop(bot))

  // Resolves with the first fatal error, or null when both sides are ready.
  // Not Promise.all: a failed side must not wait for the other (Discord login
  // or OpenCode retries can take long), and the other side's "stopped" error
  // would hide the real cause.
  const failure = await new Promise<Error | null>((resolve) => {
    const pending = { count: 2 }
    const settle = (result: Error | OpencodeEndpoint | void) => {
      if (result instanceof Error) {
        resolve(result)
        return
      }
      pending.count--
      if (pending.count === 0) resolve(null)
    }
    void opencode.ready.then(settle)
    void loginDiscord({ discord, token: options.token }).then(settle)
  })
  if (failure) return failure
  const refreshed = await refreshCliContext(bot)
  if (refreshed instanceof Error) return refreshed
  const commands = registerSlashCommands(bot, createInteractionRegistry(), { globalDirectory: options.opencodeConfigDir })
  cleanup.defer(() => commands.stop())
  // Awaited so the handle is only returned once every guild has its commands.
  await commands.registerAll()
  // After Discord and OpenCode are ready: a due task needs both.
  const scheduling = await scheduler.start()
  if (scheduling instanceof Error) return scheduling
  if (startupNotice === undefined) logger.info(`bot ready as ${discord.user?.tag} in ${discord.guilds.cache.size} server(s)`)
  else logger.info(`bot ready as ${discord.user?.tag} in ${discord.guilds.cache.size} server(s); ${startupNotice}`)
  const projects = await countUserProjects({ db, dataDir: options.dataDir })
  if (projects instanceof Error) logger.warn(projects)
  options.analytics.track('bot_started', {
    guild_count: discord.guilds.cache.size,
    ...(!(projects instanceof Error) && { user_project_count: projects }),
  })
  const resources = cleanup.move()
  let stopping: Promise<void> | undefined
  return { ...bot, lock, scheduler: { runDueTasks: scheduler.runDueTasks }, stop: () => (stopping ??= resources.disposeAsync()) }
}
