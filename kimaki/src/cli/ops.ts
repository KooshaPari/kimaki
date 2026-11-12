// Local operations inventory only. Lazy imports preserve normal CLI startup.
import type { Goke } from 'goke'
import { DATA_DIR_HELP, fail, openCliDb, printJson } from './shared.ts'
import { ConfigError } from '../errors.ts'

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) fail(new ConfigError({ reason: `Supply --${flag} explicitly. These commands never infer session or tenant authority` }))
  return value
}

export function registerOpsCommands(cli: Goke) {
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
