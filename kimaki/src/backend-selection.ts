// Pure backend-selection policy. Kept in its own module so the OpenCode
// preflight gate can be tested without pulling in the bot's heavy module graph
// (Discord, lock server, OpenCode server).

import { ConfigError } from './errors.ts'

// The two bot backends the root command can start. `opencode` is the default and
// keeps the existing path byte-identical; `jcode` drives the native Jcode observer.
export type BotBackend = 'opencode' | 'jcode'
export const BOT_BACKENDS = ['opencode', 'jcode'] as const

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
  return new ConfigError({
    reason: `jcode backend (${surface}): ${threads} still require OpenCode 2 for legacy compatibility; run the OpenCode check/install or remove those threads before starting jcode. ${error.message}`,
    cause: error,
  })
}
