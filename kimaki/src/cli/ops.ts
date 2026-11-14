// Local operations inventory only. Lazy imports preserve normal CLI startup.
import type { Goke } from 'goke'
import { DATA_DIR_HELP, fail, openCliDb, printJson } from './shared.ts'
import { ConfigError } from '../errors.ts'

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) fail(new ConfigError({ reason: `Supply --${flag} explicitly. These commands never infer session or tenant authority` }))
  return value
}

export function registerOpsCommands(cli: Goke) {
  cli.command('ops follow', 'Follow one explicitly authorized OpenCode or Jcode session and publish fixed metadata')
    .option('--source <kind>', 'Runtime source: opencode (default) or jcode')
    .option('--service-file <path>', 'Explicit running OpenCode service file')
    .option('--jcode-home <path>', 'Explicit Jcode home for polling observation')
    .option('--host <id>', 'Explicit runtime host identity')
    .option('--endpoint <id>', 'Explicit runtime endpoint identity')
    .option('--native-session <id>', 'Explicit native session ID')
    .option('--tenant <id>', 'Explicit Discord guild ID')
    .option('--surface <id>', 'Explicit Discord channel ID')
    .option('--token <token>', 'Discord bot token (or KIMAKI_BOT_TOKEN)')
    .option('--consent', 'Explicitly authorize metadata publication')
    .option('--timeout <ms>', 'Maximum follow duration in milliseconds (default: 60000)')
    .action(async (options) => {
      if (options.consent !== true) fail(new ConfigError({ reason: 'Supply --consent to authorize this publication' }))
      const source = options.source ?? 'opencode'
      if (!['opencode', 'jcode'].includes(source)) fail(new ConfigError({ reason: 'Supply --source opencode or jcode' }))
      const backendKind = source === 'jcode' ? 'jcode' as const : 'opencode' as const
      const target = {
        tenantId: required(options.tenant, 'tenant'),
        surfaceId: required(options.surface, 'surface'),
        session: { hostId: required(options.host, 'host'), endpointId: required(options.endpoint, 'endpoint'), backendKind, nativeSessionId: required(options.nativeSession, 'native-session') },
      }
      const token = required(options.token ?? process.env['KIMAKI_BOT_TOKEN'], 'token')
      const timeout = options.timeout === undefined ? 60_000 : Number(options.timeout)
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) fail(new ConfigError({ reason: '--timeout must be a positive integer in milliseconds' }))
      const rest = new (await import('discord.js')).REST({ ...(process.env['KIMAKI_DISCORD_REST_URL'] ? { api: process.env['KIMAKI_DISCORD_REST_URL'] } : {}), version: '10' }).setToken(token)
      const counts = { sent: 0, denied: 0, ignored: 0 }
      const grant = { ...target, publication: 'metadata' as const, consent: true }
      const controller = new AbortController()
      // The deadline stops observation and new publications. A Discord request
      // already in flight cannot be cancelled and may still complete.
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        if (source === 'jcode') {
          const jcodeHome = required(options.jcodeHome, 'jcode-home')
          if (options.serviceFile !== undefined) fail(new ConfigError({ reason: '--service-file does not apply to jcode' }))
          const fs = await import('node:fs/promises')
          const { createJcodeObserver } = await import('../ops/runtime/jcode.ts')
          const { publishMetadataNotice } = await import('../ops/discord/publication.ts')
          const observer = createJcodeObserver({
            jcodeHome, hostId: target.session.hostId, endpointId: target.session.endpointId,
            readDir: (path) => fs.readdir(path),
            readFile: (path) => fs.readFile(path, 'utf8'),
          })
          if (observer instanceof Error) fail(observer)
          let pending: Promise<void> | undefined
          const observation = await observer.observe({ key: target.session, signal: controller.signal, onEvent: (event) => {
            // Only a rename justifies a notice. Appends stay counted, not published.
            if (event.type !== 'session.renamed') { counts.ignored++; return }
            pending = (async () => {
              const result = await publishMetadataNotice({ rest, target, grant, backend: 'jcode' })
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
          return
        }
        const serviceFile = required(options.serviceFile, 'service-file')
        if (options.jcodeHome !== undefined) fail(new ConfigError({ reason: '--jcode-home applies only to jcode' }))
        const { resolveOpencode } = await import('../opencode-server.ts')
        const { createOpenCodeObserver } = await import('../ops/runtime/opencode.ts')
        const { publishObservedMetadata } = await import('../ops/discord/publication.ts')
        const endpoint = await resolveOpencode({ serviceFile, ensure: false })
        if (endpoint instanceof Error) fail(endpoint)
        if (controller.signal.aborted) fail(new ConfigError({ reason: 'Follow timed out before subscription' }))
        const observer = createOpenCodeObserver({ endpoint, hostId: target.session.hostId, endpointId: target.session.endpointId })
        if (observer instanceof Error) fail(observer)
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

  cli.command('ops discover', 'Read metadata-only herdr, opencode, codex or jcode inventory, never transcripts or terminal input')
    .option('--source <kind>', 'Inventory source: herdr (default), opencode, codex or jcode')
    .option('--service-file <path>', 'Explicit running OpenCode service file, never start a service')
    .option('--codex-home <path>', 'Explicit Codex state directory for the app-server, never the default home')
    .option('--jcode-home <path>', 'Explicit Jcode home directory, never the default home')
    .option('--limit <n>', 'Page size for jcode discovery (default: 50)')
    .option('--cursor <offset>', 'Opaque cursor from a previous jcode page')
    .option('--host <id>', 'Explicit native runtime host identity')
    .option('--endpoint <id>', 'Explicit native runtime endpoint identity')
    .option('--binary <path>', 'Explicit herdr or Codex executable (default: herdr on PATH)')
    .option('--herdr-session <name>', 'Explicit herdr session scope')
    .option('--timeout <ms>', 'Bounded inventory timeout in milliseconds (default: 5000)')
    .action(async (options) => {
      const source = options.source ?? 'herdr'
      if (!['herdr', 'opencode', 'codex', 'jcode'].includes(source)) fail(new ConfigError({ reason: 'Supply --source herdr, opencode, codex or jcode' }))
      if (source === 'jcode') {
        const jcodeHome = required(options.jcodeHome, 'jcode-home')
        const hostId = required(options.host, 'host')
        const endpointId = required(options.endpoint, 'endpoint')
        if (options.serviceFile !== undefined || options.herdrSession !== undefined || options.codexHome !== undefined) fail(new ConfigError({ reason: '--service-file, --herdr-session and --codex-home do not apply to jcode' }))
        const fs = await import('node:fs/promises')
        const { createJcodeObserver } = await import('../ops/runtime/jcode.ts')
        const observer = createJcodeObserver({
          jcodeHome,
          hostId,
          endpointId,
          readDir: (path) => fs.readdir(path),
          readFile: (path) => fs.readFile(path, 'utf8'),
        })
        if (observer instanceof Error) fail(observer)
        const limit = options.limit === undefined ? undefined : Number(options.limit)
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) fail(new ConfigError({ reason: '--limit must be a positive integer' }))
        const page = await observer.discover({ limit, cursor: options.cursor })
        if (page instanceof Error) fail(page)
        printJson({ source: 'jcode', observedAt: new Date().toISOString(), coverage: 'explicit-jcode-home-metadata-page', endpoint: page.source, sessions: page.sessions.map(({ key, title }) => ({ key, title })), cursor: page.cursor })
        return
      }
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
      if (options.serviceFile !== undefined || options.host !== undefined || options.endpoint !== undefined || options.codexHome !== undefined || options.jcodeHome !== undefined) fail(new ConfigError({ reason: '--service-file, --host, --endpoint, --codex-home and --jcode-home apply only to opencode, codex or jcode' }))
      const { discoverHerdr } = await import('../ops/discovery/herdr.ts')
      const result = await discoverHerdr({ binary: options.binary, session: options.herdrSession, timeoutMs: options.timeout === undefined ? undefined : Number(options.timeout) })
      if (result instanceof Error) fail(result)
      printJson(result)
    })

  cli.command('ops paperclip run', 'Read one Paperclip run as metadata only, never transcript, logs or control')
    .option('--base-url <url>', 'Explicit Paperclip instance base URL, for example http://127.0.0.1:3199')
    .option('--run-id <id>', 'Explicit Paperclip heartbeat run ID')
    .option('--company <id>', 'Expected company scope; a different company is refused')
    .option('--agent <id>', 'Expected agent scope; a different agent is refused')
    .option('--timeout <ms>', 'Bounded read timeout in milliseconds (default: 10000)')
    .action(async (options) => {
      const baseUrl = required(options.baseUrl, 'base-url')
      const runId = required(options.runId, 'run-id')
      const timeout = options.timeout === undefined ? undefined : Number(options.timeout)
      if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) fail(new ConfigError({ reason: '--timeout must be a positive integer in milliseconds' }))
      const { readPaperclipRun } = await import('../ops/paperclip/observe.ts')
      const result = await readPaperclipRun({
        baseUrl,
        runId,
        expected: { companyId: options.company, agentId: options.agent },
        timeoutMs: timeout,
      })
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

  cli.command('ops jcode run', 'Run one prompt through the Jcode backend over ACP and stream its text')
    .option('--cwd <path>', 'Working directory for the Jcode ACP session')
    .option('--prompt <text>', 'Prompt text sent as one ACP session/prompt')
    .option('--binary <path>', 'Jcode executable (default: jcode)')
    .option('--model <id>', 'Model selected for the ACP session instead of the agent default')
    .option('--tool-profile <kind>', 'Jcode tool profile: none (default), minimal or full')
    .option('--timeout <ms>', 'Per-request ACP deadline in milliseconds')
    .option('--json', 'Print the final summary as JSON')
    .action(async (options) => {
      const cwd = required(options.cwd, 'cwd')
      const prompt = required(options.prompt, 'prompt')
      const model = options.model?.trim() ? options.model : undefined
      const toolProfile = options.toolProfile ?? 'none'
      if (!['none', 'minimal', 'full'].includes(toolProfile)) fail(new ConfigError({ reason: 'Supply --tool-profile none, minimal or full' }))
      const timeoutMs = options.timeout === undefined ? undefined : Number(options.timeout)
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) fail(new ConfigError({ reason: '--timeout must be a positive integer in milliseconds' }))
      const { createJcodeBackend } = await import('../backend/jcode.ts')
      const backend = createJcodeBackend({ binary: options.binary ?? 'jcode', cwd, model, toolProfile: toolProfile as 'none' | 'minimal' | 'full', timeoutMs })
      const started = await backend.start()
      if (started instanceof Error) {
        await backend.close()
        fail(started)
      }
      // With --json the summary owns stdout, so streamed chunks are suppressed
      // rather than glued in front of the document.
      const stream = options.json === true ? undefined : (text: string) => { process.stdout.write(text) }
      const result = await backend.prompt(prompt, stream)
      await backend.close()
      if (result instanceof Error) fail(result)
      if (options.json) printJson({
        sessionId: started.sessionId,
        model: started.model,
        stopReason: result.stopReason,
        updateCount: result.updateCount,
        characters: result.text.length,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      })
      else process.stdout.write(`\n${result.stopReason}\n`)
    })

  cli.command('ops jcode serve', 'Serve one Jcode session on loopback so several clients can watch the same turns')
    .option('--cwd <path>', 'Working directory for the Jcode ACP session')
    .option('--binary <path>', 'Jcode executable (default: jcode)')
    .option('--model <id>', 'Model selected for the ACP session instead of the agent default')
    .option('--tool-profile <kind>', 'Jcode tool profile: none (default), minimal or full')
    .option('--port <n>', 'Loopback port (default: 0, an ephemeral port)')
    .option('--token <token>', 'Optional shared token required in the x-kimaki-hub header')
    .option('--log <path>', 'Append-only JSONL event log; enables resume across restarts and takes a writer lease')
    .option('--timeout <ms>', 'Per-request ACP deadline in milliseconds')
    .action(async (options) => {
      const cwd = required(options.cwd, 'cwd')
      const toolProfile = options.toolProfile ?? 'none'
      if (!['none', 'minimal', 'full'].includes(toolProfile)) fail(new ConfigError({ reason: 'Supply --tool-profile none, minimal or full' }))
      const port = options.port === undefined ? 0 : Number(options.port)
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail(new ConfigError({ reason: '--port must be an integer between 0 and 65535' }))
      const timeoutMs = options.timeout === undefined ? undefined : Number(options.timeout)
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) fail(new ConfigError({ reason: '--timeout must be a positive integer in milliseconds' }))
      const model = options.model?.trim() ? options.model : undefined
      const { createJcodeBackend } = await import('../backend/jcode.ts')
      const { createSessionHub } = await import('../backend/hub.ts')
      const { startHubServer } = await import('../backend/hub-server.ts')
      const backend = createJcodeBackend({ binary: options.binary ?? 'jcode', cwd, model, toolProfile: toolProfile as 'none' | 'minimal' | 'full', timeoutMs })
      const hub = createSessionHub({ backend, model, logFile: options.log })
      if (hub instanceof Error) {
        await backend.close()
        fail(hub)
      }
      const server = await startHubServer({ hub, port, token: options.token })
      if (server instanceof Error) {
        await hub.close()
        fail(server)
      }
      // One line so a supervising client can attach without guessing the port.
      printJson({ url: server.url, port: server.port, capabilities: hub.capabilities })
      const shutdown = async (): Promise<void> => {
        await server.close()
        await hub.close()
        process.exit(0)
      }
      process.once('SIGINT', () => { void shutdown() })
      process.once('SIGTERM', () => { void shutdown() })
      // Stay attached until a signal arrives.
      await new Promise<void>(() => {})
    })

  cli.command('ops jcode attach', 'Attach to a running hub, stream its events, optionally prompt and acknowledge')
    .option('--url <url>', 'Explicit hub URL, as printed by ops jcode serve')
    .option('--client <id>', 'Client identity to register in hub presence')
    .option('--cursor <n>', 'Start from this cursor (default: 0)')
    .option('--prompt <text>', 'Submit one prompt after attaching')
    .option('--request-id <id>', 'Idempotency id for the prompt; a repeat refers to the existing receipt')
    .option('--ack', 'Acknowledge the last sequence once a turn finishes')
    .option('--watch <ms>', 'Stream without prompting for at most this long, then detach')
    .option('--timeout <ms>', 'Maximum attach duration in milliseconds (default: 120000)')
    .option('--json', 'Print a JSON summary instead of streamed text')
    .action(async (options) => {
      const url = required(options.url, 'url')
      const cursor = options.cursor === undefined ? 0 : Number(options.cursor)
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail(new ConfigError({ reason: '--cursor must be a non-negative integer' }))
      const timeout = options.timeout === undefined ? 120_000 : Number(options.timeout)
      if (!Number.isSafeInteger(timeout) || timeout < 1) fail(new ConfigError({ reason: '--timeout must be a positive integer in milliseconds' }))
      const { openHubStream, promptHub, ackHub, readHubState } = await import('../backend/hub-client.ts')

      const state = await readHubState({ baseUrl: url })
      if (state instanceof Error) fail(state)

      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), timeout)
      const chunks: string[] = []
      const events: Array<{ seq: number; type: string }> = []
      let lastSeq = cursor
      let outcome: { stopReason?: string; error?: string } = {}
      let settle: (() => void) | undefined
      const finished = new Promise<void>((resolve) => {
        settle = resolve
      })

      const attach = openHubStream({
        baseUrl: url,
        clientId: options.client,
        cursor,
        signal: controller.signal,
        onEvent: (event) => {
          lastSeq = event.seq
          events.push({ seq: event.seq, type: event.type })
          if (event.type === 'prompt.chunk') {
            chunks.push(event.text)
            if (!options.json) process.stdout.write(event.text)
          }
          if (event.type === 'prompt.finished') {
            outcome = { stopReason: event.stopReason }
            settle?.()
          }
          if (event.type === 'prompt.failed') {
            outcome = { error: event.reason }
            settle?.()
          }
        },
      })

      // Give the subscription a moment to register before prompting.
      await new Promise((resolve) => setTimeout(resolve, 200))
      const watch = options.watch === undefined ? undefined : Number(options.watch)
      if (watch !== undefined && (!Number.isSafeInteger(watch) || watch < 1)) {
        controller.abort()
        await attach
        clearTimeout(deadline)
        fail(new ConfigError({ reason: '--watch must be a positive integer in milliseconds' }))
      }
      if (options.prompt === undefined && watch === undefined) {
        // Nothing to wait for: report the hub state and detach.
        controller.abort()
        await attach
        clearTimeout(deadline)
        if (options.json) printJson({ state, events })
        else process.stdout.write(`attached to ${url} at seq ${state.seq}\n`)
        return
      }

      if (options.prompt !== undefined) {
        const submitted = await promptHub({ baseUrl: url, text: options.prompt, requestId: options.requestId })
        if (submitted instanceof Error) {
          controller.abort()
          await attach
          clearTimeout(deadline)
          fail(submitted)
        }
      }

      if (watch === undefined) {
        await finished
      } else {
        await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, watch))])
      }

      // Acknowledge before detaching: presence ends with the connection, so an
      // ack sent after the stream closes is correctly unroutable.
      let acked: number | undefined
      if (options.ack && options.client !== undefined) {
        const result = await ackHub({ baseUrl: url, clientId: options.client, seq: lastSeq })
        if (result instanceof Error) {
          controller.abort()
          await attach
          clearTimeout(deadline)
          fail(result)
        }
        acked = result.acked
      }

      controller.abort()
      await attach
      clearTimeout(deadline)

      if (options.json) {
        printJson({ events, characters: chunks.join('').length, stopReason: outcome.stopReason, error: outcome.error, acked, cursor: lastSeq })
      } else {
        process.stdout.write(`\n${outcome.error ?? outcome.stopReason ?? 'no result'}\n`)
      }
      if (outcome.error !== undefined) fail(new ConfigError({ reason: outcome.error }))
    })
}
