// Local operations inventory only. Lazy imports preserve normal CLI startup.
import type { Goke } from 'goke'
import { DATA_DIR_HELP, fail, openCliDb, printJson } from './shared.ts'
import { ConfigError } from '../errors.ts'

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) fail(new ConfigError({ reason: `Supply --${flag} explicitly. These commands never infer session or tenant authority` }))
  return value
}

export function registerOpsCommands(cli: Goke) {
  cli.command('ops follow', 'Follow one explicitly authorized OpenCode session and publish fixed metadata')
    .option('--service-file <path>', 'Explicit running OpenCode service file')
    .option('--host <id>', 'Explicit runtime host identity')
    .option('--endpoint <id>', 'Explicit runtime endpoint identity')
    .option('--native-session <id>', 'Explicit OpenCode session ID')
    .option('--tenant <id>', 'Explicit Discord guild ID')
    .option('--surface <id>', 'Explicit Discord channel ID')
    .option('--token <token>', 'Discord bot token (or KIMAKI_BOT_TOKEN)')
    .option('--consent', 'Explicitly authorize metadata publication')
    .option('--timeout <ms>', 'Maximum follow duration in milliseconds (default: 60000)')
    .action(async (options) => {
      if (options.consent !== true) fail(new ConfigError({ reason: 'Supply --consent to authorize this publication' }))
      const serviceFile = required(options.serviceFile, 'service-file')
      const target = {
        tenantId: required(options.tenant, 'tenant'),
        surfaceId: required(options.surface, 'surface'),
        session: { hostId: required(options.host, 'host'), endpointId: required(options.endpoint, 'endpoint'), backendKind: 'opencode', nativeSessionId: required(options.nativeSession, 'native-session') },
      }
      const token = required(options.token ?? process.env['KIMAKI_BOT_TOKEN'], 'token')
      const timeout = options.timeout === undefined ? 60_000 : Number(options.timeout)
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) fail(new ConfigError({ reason: '--timeout must be a positive integer in milliseconds' }))
      const { resolveOpencode } = await import('../opencode-server.ts')
      const { createOpenCodeObserver } = await import('../ops/runtime/opencode.ts')
      const { publishObservedMetadata } = await import('../ops/discord/publication.ts')
      const { REST } = await import('discord.js')
      const controller = new AbortController()
      // The deadline stops observation and new publications. A Discord request
      // already in flight cannot be cancelled and may still complete.
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const endpoint = await resolveOpencode({ serviceFile, ensure: false })
        if (endpoint instanceof Error) fail(endpoint)
        if (controller.signal.aborted) fail(new ConfigError({ reason: 'Follow timed out before subscription' }))
        const observer = createOpenCodeObserver({ endpoint, hostId: target.session.hostId, endpointId: target.session.endpointId })
        if (observer instanceof Error) fail(observer)
        const rest = new REST({ ...(process.env['KIMAKI_DISCORD_REST_URL'] ? { api: process.env['KIMAKI_DISCORD_REST_URL'] } : {}), version: '10' }).setToken(token)
        const counts = { sent: 0, denied: 0, ignored: 0 }
        const grant = { ...target, publication: 'metadata' as const, consent: true }
        let pending: Promise<void> | undefined
        const observation = await observer.observe({ key: target.session, signal: controller.signal, onEvent: (observed) => {
          if (observed.raw.type !== 'session.renamed') { counts.ignored++; return }
          pending = (async () => {
            const result = await publishObservedMetadata({ rest, target, observed, grant })
            if (result instanceof Error) throw result
            counts[result.kind]++
          })()
          return pending
        } })
        if (observation instanceof Error) fail(observation)
        const { createLogger } = await import('../logger.ts')
        createLogger('OPS').info('Follow subscription ready')
        const result = await observation.done
        await pending
        if (result instanceof Error) fail(result)
        printJson(counts)
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    })

  cli.command('ops publish', 'Publish one explicitly authorized OpenCode metadata event to Discord')
    .option('--tenant <id>', 'Explicit Discord guild ID')
    .option('--surface <id>', 'Explicit Discord channel ID')
    .option('--host <id>', 'Explicit runtime host identity')
    .option('--endpoint <id>', 'Explicit runtime endpoint identity')
    .option('--native-session <id>', 'Explicit OpenCode session ID')
    .option('--event-file <path>', 'JSON file containing one OpenCodeObservedEvent')
    .option('--token <token>', 'Discord bot token (or KIMAKI_BOT_TOKEN)')
    .option('--consent', 'Explicitly authorize this one metadata publication')
    .action(async (options) => {
      if (options.consent !== true) fail(new ConfigError({ reason: 'Supply --consent to authorize this publication' }))
      const target = {
        tenantId: required(options.tenant, 'tenant'),
        surfaceId: required(options.surface, 'surface'),
        session: { hostId: required(options.host, 'host'), endpointId: required(options.endpoint, 'endpoint'), backendKind: 'opencode', nativeSessionId: required(options.nativeSession, 'native-session') },
      }
      const eventFile = required(options.eventFile, 'event-file')
      const token = required(options.token ?? process.env['KIMAKI_BOT_TOKEN'], 'token')
      const fs = await import('node:fs/promises')
      const errore = await import('errore')
      const text = await fs.readFile(eventFile, 'utf8').catch((cause) => new ConfigError({ reason: 'Cannot read --event-file', cause }))
      if (text instanceof Error) fail(text)
      const observed = errore.try(() => JSON.parse(text) as import('../ops/runtime/opencode.ts').OpenCodeObservedEvent, (cause) => new ConfigError({ reason: 'Invalid JSON in --event-file', cause }))
      if (observed instanceof Error) fail(observed)
      if (!observed || typeof observed !== 'object' || !observed.key || typeof observed.key !== 'object' || !observed.source || typeof observed.source !== 'object' || !observed.raw || typeof observed.raw !== 'object' || !observed.raw.data || typeof observed.raw.data !== 'object' || Array.isArray(observed.raw.data)) fail(new ConfigError({ reason: 'Invalid OpenCode observed event in --event-file' }))
      const { REST } = await import('discord.js')
      const { publishObservedMetadata } = await import('../ops/discord/publication.ts')
      const rest = new REST({ ...(process.env['KIMAKI_DISCORD_REST_URL'] ? { api: process.env['KIMAKI_DISCORD_REST_URL'] } : {}), version: '10' }).setToken(token)
      const result = await publishObservedMetadata({ rest, target, observed, grant: { ...target, publication: 'metadata', consent: true } })
      if (result instanceof Error) fail(result)
      if (result.kind === 'denied') fail(new ConfigError({ reason: 'Publication denied: event and Discord surface must match the explicit scope' }))
      printJson(result)
    })

  cli.command('ops discover', 'Read metadata-only herdr, opencode or codex inventory, never transcripts or terminal input')
    .option('--source <kind>', 'Inventory source: herdr (default), opencode or codex')
    .option('--service-file <path>', 'Explicit running OpenCode service file, never start a service')
    .option('--codex-home <path>', 'Explicit Codex state directory for the app-server, never the default home')
    .option('--host <id>', 'Explicit native runtime host identity')
    .option('--endpoint <id>', 'Explicit native runtime endpoint identity')
    .option('--binary <path>', 'Explicit herdr or Codex executable (default: herdr on PATH)')
    .option('--herdr-session <name>', 'Explicit herdr session scope')
    .option('--timeout <ms>', 'Bounded inventory timeout in milliseconds (default: 5000)')
    .action(async (options) => {
      const source = options.source ?? 'herdr'
      if (!['herdr', 'opencode', 'codex'].includes(source)) fail(new ConfigError({ reason: 'Supply --source herdr, opencode or codex' }))
      if (source === 'codex') {
        const binary = required(options.binary, 'binary')
        const codexHome = required(options.codexHome, 'codex-home')
        const hostId = required(options.host, 'host')
        const endpointId = required(options.endpoint, 'endpoint')
        if (options.serviceFile !== undefined || options.herdrSession !== undefined) fail(new ConfigError({ reason: '--service-file and --herdr-session do not apply to codex' }))
        const { startCodexAppServer } = await import('../ops/runtime/codex-app-server.ts')
        const { createCodexObserver } = await import('../ops/runtime/codex.ts')
        const server = await startCodexAppServer({ binary, codexHome, timeoutMs: options.timeout === undefined ? undefined : Number(options.timeout) })
        if (server instanceof Error) fail(server)
        try {
          const observer = createCodexObserver({ hostId, endpointId, request: server.request })
          if (observer instanceof Error) fail(observer)
          const page = await observer.discover()
          if (page instanceof Error) fail(page)
          printJson({ source: 'codex', observedAt: new Date().toISOString(), coverage: 'explicit-app-server-state-db-page', endpoint: page.source, sessions: page.sessions.map(({ key }) => key), cursor: page.cursor })
        } finally {
          await server.close()
        }
        return
      }
      if (source === 'opencode') {
        const serviceFile = required(options.serviceFile, 'service-file')
        const hostId = required(options.host, 'host')
        const endpointId = required(options.endpoint, 'endpoint')
        if (options.binary !== undefined || options.herdrSession !== undefined || options.timeout !== undefined) fail(new ConfigError({ reason: '--binary, --herdr-session and --timeout apply only to herdr. Native requests have a fixed bounded timeout' }))
        const { resolveOpencode } = await import('../opencode-server.ts')
        const { createOpenCodeObserver } = await import('../ops/runtime/opencode.ts')
        const endpoint = await resolveOpencode({ serviceFile, ensure: false })
        if (endpoint instanceof Error) fail(endpoint)
        const observer = createOpenCodeObserver({ endpoint, hostId, endpointId })
        if (observer instanceof Error) fail(observer)
        const page = await observer.discover()
        if (page instanceof Error) fail(page)
        printJson({ source: 'opencode', observedAt: new Date().toISOString(), coverage: 'explicit-native-endpoint-page', endpoint: page.source, sessions: page.sessions.map(({ key, native }) => ({ key, title: native.title })), cursor: page.cursor })
        return
      }
      if (options.serviceFile !== undefined || options.host !== undefined || options.endpoint !== undefined || options.codexHome !== undefined) fail(new ConfigError({ reason: '--service-file, --host, --endpoint and --codex-home apply only to opencode or codex' }))
      const { discoverHerdr } = await import('../ops/discovery/herdr.ts')
      const result = await discoverHerdr({ binary: options.binary, session: options.herdrSession, timeoutMs: options.timeout === undefined ? undefined : Number(options.timeout) })
      if (result instanceof Error) fail(result)
      printJson(result)
    })

  cli.command('ops bind', 'Register metadata-only observe association. No transcript publishing or runtime control')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--host <id>', 'Explicit runtime host identity')
    .option('--endpoint <id>', 'Explicit runtime endpoint identity, not a herdr pane')
    .option('--backend <kind>', 'Native runtime kind, for example codex or jcode')
    .option('--native-session <id>', 'Explicit native session ID, not a cwd or reported path')
    .option('--tenant <id>', 'Service tenant, for example Discord guild ID')
    .option('--service <kind>', 'Outward service kind (default: discord)')
    .option('--surface <id>', 'Outward conversation/surface ID')
    .option('--request <id>', 'Stable idempotency ID for this binding intent')
    .action(async (options) => {
      const session = {
        hostId: required(options.host, 'host'),
        endpointId: required(options.endpoint, 'endpoint'),
        backendKind: required(options.backend, 'backend'),
        nativeSessionId: required(options.nativeSession, 'native-session'),
      }
      const tenantId = required(options.tenant, 'tenant')
      const surfaceId = required(options.surface, 'surface')
      const idempotencyKey = required(options.request, 'request')
      const { bindSurface } = await import('../ops/bindings.ts')
      const opened = await openCliDb(options.dataDir)
      const result = await bindSurface({ db: opened.db, session, tenantId, surfaceId, idempotencyKey, serviceKind: options.service ?? 'discord' })
      opened.close()
      if (result instanceof Error) fail(result)
      printJson(result)
    })

  cli.command('ops bindings', 'List local metadata-only associations in an explicit tenant, including detached rows')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--tenant <id>', 'Explicit service tenant ID')
    .option('--service <kind>', 'Outward service kind (default: discord)')
    .action(async (options) => {
      const tenantId = required(options.tenant, 'tenant')
      const { listBindings } = await import('../ops/bindings.ts')
      const opened = await openCliDb(options.dataDir)
      const result = await listBindings({ db: opened.db, tenantId, serviceKind: options.service ?? 'discord' })
      opened.close()
      if (result instanceof Error) fail(result)
      printJson(result)
    })

  cli.command('ops detach <binding-id>', 'Detach metadata association only. Never stop, resume or interrupt the agent')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--tenant <id>', 'Explicit service tenant ID')
    .option('--service <kind>', 'Outward service kind (default: discord)')
    .action(async (bindingId, options) => {
      const tenantId = required(options.tenant, 'tenant')
      const { detachBinding } = await import('../ops/bindings.ts')
      const opened = await openCliDb(options.dataDir)
      const result = await detachBinding({ db: opened.db, bindingId, tenantId, serviceKind: options.service ?? 'discord' })
      opened.close()
      if (result instanceof Error) fail(result)
      printJson(result)
    })
}
