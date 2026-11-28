// The one writer of a thread's session row.
//
// `thread_sessions` binds a Discord thread to exactly one session, and the row's
// `backend` column is what src/thread-backend.ts reads to decide which connection
// serves it. Two callers need this exact write (src/sessions.ts for the OpenCode
// path, src/jcode-thread.ts for the jcode creation path), so it lives here rather
// than being copied: a second insertion site that forgot the backend column would
// make a jcode thread an OpenCode thread by default (src/migrations.ts), and the
// jcode bot would then refuse to serve the thread it just created.

import type { Bot } from './bot.ts'
import { DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import * as schema from './schema.ts'

const logger = createLogger('THREADS')

/**
 * Insert the thread's session row, then teach the event loop about it.
 *
 * The insert comes first: the row is the authority src/thread-backend.ts resolves
 * against, and the in-memory routing map must never name a backend the row does
 * not.
 */
export async function bindThread(
  bot: Bot,
  { threadId, sessionId, channelId, directory, isNew }: { threadId: string; sessionId: string; channelId: string; directory: string; isNew: boolean },
): Promise<DbError | void> {
  // The backend is recorded with the binding (docs/opencode-removal.md step 1.1):
  // without it the column's default would make every new thread an OpenCode
  // thread, and a jcode bot would refuse to serve the thread it just created.
  const inserted = await bot.db
    .insert(schema.thread_sessions)
    .values({ thread_id: threadId, session_id: sessionId, source: 'kimaki', backend: bot.backendKind })
    .catch((cause) => new DbError({ operation: 'insert thread_sessions', cause }))
  if (inserted instanceof Error) return inserted
  await bot.eventLoop.bind({ threadId, sessionId, channelId, directory, isNew, backend: bot.backendKind })
  logger.log(`session ${sessionId} bound to thread ${threadId}`)
}
