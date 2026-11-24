// libSQL's native statements can retain Windows file handles briefly after
// close, and the bot/opencode children may still be exiting when `afterAll`
// runs. Removing a per-test data dir therefore has to tolerate a short window
// where the directory is still held open (typically `kimaki.db-shm`, which stays
// locked until every connection to the database is gone).
import fs from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Portable scratch root for tests that need a real directory outside the repo.
// A committed test must not bake a drive letter in: on a POSIX host `E:/x`
// becomes a literal directory named `E:` inside the package. KIMAKI_TEST_SCRATCH
// wins when set; otherwise the per-OS temp directory. The subdirectory is created
// here so callers get an existing parent, which is what the old call sites assumed.
export function scratchDir(name: string): string {
  const root = process.env['KIMAKI_TEST_SCRATCH'] ?? path.join(os.tmpdir(), 'kimaki-tests')
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Each round spends up to 10 retries with a 100ms linear backoff (Node's fs.rm
// waits 100, 200, ... 1000ms between tries, so a round is ~5.5s). Two rounds with
// a pause between them cover roughly 12s, enough to outlast a closing SQLite
// handle or a child process that is a few seconds behind, and still a hard bound
// that fits inside the 60s default hook timeout: once the rounds are spent the
// error is thrown, so a genuinely stuck directory fails the suite instead of
// being hidden.
const REMOVAL_ROUNDS = 2
const REMOVAL_RETRY_DELAY_MS = 100
const REMOVAL_MAX_RETRIES = 10
const REMOVAL_ROUND_PAUSE_MS = 500
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

// Removes a temp path, retrying while the OS still holds it. Unlike
// removeTempDirs this never swallows a failure: after the bound is spent the
// error propagates, so teardown problems stay visible.
export async function removeTempDir(target: string): Promise<void> {
  for (let round = 1; round <= REMOVAL_ROUNDS; round++) {
    try {
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: REMOVAL_MAX_RETRIES,
        retryDelay: REMOVAL_RETRY_DELAY_MS,
      })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== undefined && !RETRYABLE_CODES.has(code)) throw error
      if (round === REMOVAL_ROUNDS) throw error
      await new Promise((resolve) => setTimeout(resolve, REMOVAL_ROUND_PAUSE_MS * round))
    }
  }
}

// Removes a per-test data directory under the same bound.
export async function removeDataDir(dir: string): Promise<void> {
  await removeTempDir(dir)
}

// Cleanup must not fail an otherwise passing test, so retry and, if the OS
// still holds the directory, leave it to temp cleanup.
export async function removeTempDirs(dirs: string[], attempts = 10): Promise<void> {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error
        if (attempt === attempts - 1) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}
