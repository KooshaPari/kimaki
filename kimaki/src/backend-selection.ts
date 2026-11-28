// Pure backend-selection policy. Kept in its own module so the OpenCode
// preflight gate can be tested without pulling in the bot's heavy module graph
// (Discord, lock server, OpenCode server).

import { ConfigError } from './errors.ts'

// The two bot backends the root command can start. `jcode` is the default (Phase 1
// of docs/opencode-removal.md) and drives the native Jcode observer; `opencode`
// keeps the original path byte-identical and stays reachable by flag or env.
export type BotBackend = 'opencode' | 'jcode'
export const BOT_BACKENDS = ['jcode', 'opencode'] as const

// A new bot with neither the flag nor KIMAKI_BACKEND resolves here. Kept in one
// place: the CLI default and the refusal list both describe it.
export const DEFAULT_BOT_BACKEND: BotBackend = 'jcode'

// The choice list printed by a refusal, with the default named.
export const BOT_BACKEND_CHOICES = BOT_BACKENDS.map((name) => (name === DEFAULT_BOT_BACKEND ? `${name} (default)` : name)).join(', ')

export type BotBackendSource = 'flag' | 'env' | 'default'

// How the operator selected the backend. Used in refusals/degrading messages so the
// named surface is the one they actually set (flag or environment), not a guess.
export function backendSelectionSurface({
  backend,
  source,
}: {
  backend: BotBackend
  source: BotBackendSource
}): string {
  if (source === 'env') return `KIMAKI_BACKEND=${backend}`
  if (source === 'flag') return `--backend ${backend}`
  return `backend ${backend} (default)`
}

// Phase 1.5: the install preflight is legacy-only for jcode. The opencode backend
// keeps its original call unchanged; a jcode start runs the check only when a
// persisted OpenCode thread needs it.
export function shouldCheckOpencode({
  backend,
  legacyThreadCount,
}: {
  backend: BotBackend
  legacyThreadCount: number
}): boolean {
  return backend === 'opencode' || legacyThreadCount > 0
}

// The startup error for a failed OpenCode preflight. opencode backend: the original
// error and messages are preserved unchanged. jcode backend: a legacy compatibility
// check failed, so the refusal/degrading message names the backend and surface.
export function legacyOpencodeCheckFailure({
  backend,
  source,
  legacyThreadCount,
  error,
}: {
  backend: BotBackend
  source: BotBackendSource
  legacyThreadCount: number
  error: Error
}): Error {
  if (backend === 'opencode') return error
  const surface = backendSelectionSurface({ backend, source })
  const threads = `${legacyThreadCount} legacy OpenCode thread${legacyThreadCount === 1 ? '' : 's'}`
  const verb = legacyThreadCount === 1 ? 'still requires' : 'still require'
  return new ConfigError({
    reason: `jcode backend (${surface}): ${threads} ${verb} OpenCode 2 for legacy compatibility; run the OpenCode check/install or remove those threads before starting jcode. ${error.message}`,
    cause: error,
  })
}

// Phase 2 gate: a jcode start must not strand OpenCode threads silently. This is a
// pure decision; the CLI reads the durable records and supplies `exported` and
// `abandoned`, so no I/O or defaults hide here. The opencode backend and a jcode
// start with no legacy threads are never gated.
export type OpencodeThreadDisposition =
  | { readonly kind: 'proceed'; readonly reason: 'no-legacy-threads' | 'exported' | 'abandoned'; readonly legacyThreadCount: number }
  | { readonly kind: 'export-required'; readonly legacyThreadCount: number }

export function opencodeThreadDisposition({
  backend,
  legacyThreadCount,
  exported,
  abandoned,
}: {
  backend: BotBackend
  legacyThreadCount: number
  exported: boolean
  abandoned: boolean
}): OpencodeThreadDisposition {
  // The opencode backend is not gated: it can still serve those threads natively.
  // This lane must not change that path, including its preflight.
  if (backend === 'opencode') return { kind: 'proceed', reason: 'no-legacy-threads', legacyThreadCount }
  if (legacyThreadCount <= 0) return { kind: 'proceed', reason: 'no-legacy-threads', legacyThreadCount }
  // If both records exist, the export is the stronger evidence: it means the
  // history can be restored rather than merely written off.
  if (exported) return { kind: 'proceed', reason: 'exported', legacyThreadCount }
  if (abandoned) return { kind: 'proceed', reason: 'abandoned', legacyThreadCount }
  return { kind: 'export-required', legacyThreadCount }
}

export const EXPORT_REMEDY = 'kimaki export opencode --out <dir>'
export const ABANDON_REMEDY = 'kimaki export abandon-opencode --data-dir <dir>'

/** The start refusal. Both remedies are named verbatim, with no third implied path. */
export function exportRequiredFailure({
  source,
  legacyThreadCount,
  error,
}: {
  source: BotBackendSource
  legacyThreadCount: number
  error?: Error
}): ConfigError {
  const surface = backendSelectionSurface({ backend: 'jcode', source })
  const threads = `${legacyThreadCount} legacy OpenCode thread${legacyThreadCount === 1 ? '' : 's'}`
  const verb = legacyThreadCount === 1 ? 'has' : 'have'
  return new ConfigError({
    reason: `jcode backend (${surface}): ${threads} ${verb} not been exported or explicitly abandoned; starting would strand ${legacyThreadCount === 1 ? 'it' : 'them'}. Export with ${EXPORT_REMEDY} or abandon with ${ABANDON_REMEDY} before starting jcode.`,
    ...(error && { cause: error }),
  })
}
