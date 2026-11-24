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
