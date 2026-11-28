// Session ID env var: KIMAKI_SESSION_ID is authoritative; OPENCODE_SESSION_ID
// is read for one release so existing installs keep working.
import { createLogger } from './logger.ts'

const logger = createLogger('SESSION_ENV')

let deprecationLogged = false

export const KIMAKI_SESSION_ID_ENV = 'KIMAKI_SESSION_ID'
export const OPENCODE_SESSION_ID_ENV = 'OPENCODE_SESSION_ID'

export function readSessionIdEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const next = env[KIMAKI_SESSION_ID_ENV]
  if (next) return next
  const old = env[OPENCODE_SESSION_ID_ENV]
  if (old) {
    if (!deprecationLogged) {
      deprecationLogged = true
      logger.warn(`${OPENCODE_SESSION_ID_ENV} is deprecated; set ${KIMAKI_SESSION_ID_ENV} instead`)
    }
    return old
  }
  return undefined
}

// For tests: reset the one-time deprecation log guard.
export function resetSessionIdEnvDeprecationForTests() {
  deprecationLogged = false
}

// Both names exported during this release so an old child still works.
export function sessionIdChildEnv(sessionId: string): Record<string, string> {
  return {
    [KIMAKI_SESSION_ID_ENV]: sessionId,
    [OPENCODE_SESSION_ID_ENV]: sessionId,
  }
}
