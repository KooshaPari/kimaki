// Local operations inventory only. Lazy imports preserve normal CLI startup.
import type { Goke } from 'goke'
import { DATA_DIR_HELP, fail, openCliDb, printJson } from './shared.ts'
import { ConfigError } from '../errors.ts'

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) fail(new ConfigError({ reason: `Supply --${flag} explicitly. These commands never infer session or tenant authority` }))
  return value
}

export function registerOpsCommands(cli: Goke) {
  cli.command('ops discover', 'Read metadata-only herdr inventory, never transcripts or terminal input')
    .option('--binary <path>', 'Explicit herdr executable (default: herdr on PATH)')
    .option('--herdr-session <name>', 'Explicit herdr session scope')
    .option('--timeout <ms>', 'Bounded inventory timeout in milliseconds (default: 5000)')
    .action(async (options) => {
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
