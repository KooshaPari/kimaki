// Bot-owned supervision of the hub-to-channel view.
//
// `ops discord view` runs the mirror as its own process. This module lets the
// running bot own it instead, driven by a small persisted binding, so the view
// shares the bot's Discord REST client and stops with it.
//
// Registering a binding is explicit and opt-in: with no binding file the bot
// starts no view and this module reports `idle`, which keeps every existing
// start unchanged. A binding that cannot be read is reported and never guessed
// at, because a wrong tenant or channel would post a session's turns into the
// wrong place.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { REST } from 'discord.js'
import { ConfigError } from '../../errors.js'
import { createLogger } from '../../logger.ts'
import { defaultViewClientId, openDiscordView } from './view.ts'

const logger = createLogger('VIEW')

// One file, next to the bot's own state. A view is a single operator choice, so
// a second binding would have to answer which one wins.
export const VIEW_BINDING_FILE = 'discord-view.json'

export type DiscordViewBinding = {
  // Discord guild id the channel must belong to (openDiscordView refuses any other).
  tenantId: string
  // Channel that receives one message per finished turn.
  channelId: string
  // Hub URL, as printed by `ops jcode serve`.
  baseUrl: string
  // Default: defaultViewClientId(channelId), which also makes a duplicate view
  // on the same channel get refused by the hub.
  clientId?: string
  // Only used when the durable state file is missing.
  cursor?: number
  // Explicit follow of a live session change; default refuses it.
  rebind?: boolean
}

export function viewBindingPath(dataDir: string): string {
  return path.join(dataDir, VIEW_BINDING_FILE)
}

// The durable cursor lives under the data dir, never in a caller's cwd. The
// channel id is encoded so a hand-edited binding cannot escape that directory.
export function viewStatePath({ dataDir, channelId }: { dataDir: string; channelId: string }): string {
  return path.join(dataDir, 'discord-view', `${encodeURIComponent(channelId)}.state.json`)
}

function nonEmpty(value: unknown): value is string {
  // A leading or trailing space is an operator typo, not a valid Discord id.
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

// Everything openDiscordView needs must be present and well formed before a
// view starts; the checks mirror the hub client's own URL rules.
export function parseViewBinding(value: unknown): DiscordViewBinding | Error {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return new ConfigError({ reason: 'Discord view binding must be a JSON object' })
  }
  const raw = value as Record<string, unknown>
  if (!nonEmpty(raw['tenantId'])) return new ConfigError({ reason: 'Discord view binding needs a non-empty tenantId (guild id)' })
  if (!nonEmpty(raw['channelId'])) return new ConfigError({ reason: 'Discord view binding needs a non-empty channelId' })
  if (!nonEmpty(raw['baseUrl'])) return new ConfigError({ reason: 'Discord view binding needs a non-empty baseUrl' })
  let url: URL
  try {
    url = new URL(raw['baseUrl'])
  } catch (cause) {
    return new ConfigError({ reason: 'Discord view baseUrl must be an absolute URL', cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return new ConfigError({ reason: 'Discord view baseUrl must use http or https' })
  }
  if (url.username || url.password) return new ConfigError({ reason: 'Credentials in a Discord view baseUrl are not accepted' })
  if (raw['clientId'] !== undefined && !nonEmpty(raw['clientId'])) {
    return new ConfigError({ reason: 'Discord view clientId must be a non-empty string when present' })
  }
  const cursor = raw['cursor']
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || (cursor as number) < 0)) {
    return new ConfigError({ reason: 'Discord view cursor must be a non-negative integer when present' })
  }
  if (raw['rebind'] !== undefined && typeof raw['rebind'] !== 'boolean') {
    return new ConfigError({ reason: 'Discord view rebind must be a boolean when present' })
  }
  return {
    tenantId: raw['tenantId'],
    channelId: raw['channelId'],
    baseUrl: raw['baseUrl'],
    ...(raw['clientId'] === undefined ? {} : { clientId: raw['clientId'] }),
    ...(cursor === undefined ? {} : { cursor: cursor as number }),
    ...(raw['rebind'] === undefined ? {} : { rebind: raw['rebind'] as boolean }),
  }
}

// null means no binding was registered, which is the default (and unchanged) start.
export async function readViewBinding({ dataDir }: { dataDir: string }): Promise<DiscordViewBinding | null | Error> {
  const file = viewBindingPath(dataDir)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    return new ConfigError({ reason: `Cannot read the Discord view binding at ${file}`, cause })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    // A half-written file is not "no binding": refuse it rather than silently
    // leaving a previously registered mirror off.
    return new ConfigError({ reason: `Discord view binding at ${file} is not valid JSON`, cause })
  }
  return parseViewBinding(raw)
}

export async function writeViewBinding({ dataDir, binding }: { dataDir: string; binding: unknown }): Promise<Error | void> {
  const parsed = parseViewBinding(binding)
  if (parsed instanceof Error) return parsed
  const file = viewBindingPath(dataDir)
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.mkdir(dataDir, { recursive: true })
    try {
      // 0600: the file names a guild and channel, not credentials, but the bot
      // data dir is private and the binding should not be world readable.
      await fs.writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temp, file)
    } finally {
      await fs.rm(temp, { force: true })
    }
  } catch (cause) {
    return new ConfigError({ reason: `Cannot write the Discord view binding at ${file}`, cause })
  }
}

// true: a binding was removed; false: none existed.
export async function removeViewBinding({ dataDir }: { dataDir: string }): Promise<boolean | ConfigError> {
  try {
    await fs.rm(viewBindingPath(dataDir), { force: true })
    return true
  } catch (cause) {
    return new ConfigError({ reason: `Cannot remove the Discord view binding at ${viewBindingPath(dataDir)}`, cause })
  }
}

export type OpenDiscordView = (options: Parameters<typeof openDiscordView>[0]) => Promise<Error | undefined>

export type ViewSupervisorState = 'idle' | 'running' | 'failed' | 'stopped'

export type ViewSupervisor = {
  // idle: no binding. running: the view is attached or attaching. failed: the
  // binding was refused, or the view failed. stopped: stop() finished.
  state: () => ViewSupervisorState
  binding: () => DiscordViewBinding | undefined
  // The binding or view failure, for the caller to log once.
  error: () => Error | undefined
  // Resolves with the view's own outcome. Never rejects, so a failed view does
  // not become an unhandled rejection when nobody awaits it.
  result: Promise<Error | undefined>
  // Aborts the view's signal and awaits it. Idempotent.
  stop: () => Promise<void>
}

function idleSupervisor(): ViewSupervisor {
  return {
    state: () => 'idle',
    binding: () => undefined,
    error: () => undefined,
    result: Promise.resolve(undefined),
    stop: async () => {},
  }
}

function failedSupervisor(error: Error): ViewSupervisor {
  return {
    state: () => 'failed',
    binding: () => undefined,
    error: () => error,
    result: Promise.resolve(error),
    stop: async () => {},
  }
}

// Reads the binding and, when one exists, starts the view against the bot's own
// Discord REST client. Nothing here infers a tenant, channel or hub: all three
// come from the binding an operator registered explicitly.
export async function startViewSupervision({ dataDir, rest, openView = openDiscordView, report }: {
  dataDir: string
  rest: REST
  openView?: OpenDiscordView
  // Tests capture the report instead of letting it reach the log file.
  report?: (error: Error) => void
}): Promise<ViewSupervisor> {
  const note = report ?? ((error: Error) => logger.warn('Discord view', error))
  const binding = await readViewBinding({ dataDir })
  if (binding instanceof Error) {
    note(binding)
    return failedSupervisor(binding)
  }
  if (binding === null) return idleSupervisor()

  const controller = new AbortController()
  let state: ViewSupervisorState = 'running'
  let failure: Error | undefined
  const statePath = viewStatePath({ dataDir, channelId: binding.channelId })
  const clientId = binding.clientId ?? defaultViewClientId(binding.channelId)
  logger.info(`mirroring the hub ${binding.baseUrl} into channel ${binding.channelId}`)
  const result: Promise<Error | undefined> = (async () => {
    let outcome: Error | undefined
    try {
      outcome = await openView({
        rest,
        tenantId: binding.tenantId,
        channelId: binding.channelId,
        clientId,
        ...(binding.cursor === undefined ? {} : { cursor: binding.cursor }),
        statePath,
        baseUrl: binding.baseUrl,
        signal: controller.signal,
        ...(binding.rebind === undefined ? {} : { rebind: binding.rebind }),
      })
    } catch (cause) {
      outcome = cause instanceof Error ? cause : new Error(String(cause))
    }
    if (outcome instanceof Error) {
      failure = outcome
      // A view that stops on its own does not restart: the reason (bad channel,
      // clipped replay, hub gone) needs an operator, not a retry loop.
      if (state === 'running') state = 'failed'
      note(outcome)
    }
    return outcome
  })()
  let stopping: Promise<void> | undefined
  return {
    state: () => state,
    binding: () => binding,
    error: () => failure,
    result,
    stop: () => (stopping ??= (async () => {
      controller.abort()
      await result
      if (state === 'running') state = 'stopped'
    })()),
  }
}
