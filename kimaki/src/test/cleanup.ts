// libSQL's native statements can retain Windows file handles briefly after
// close. Cleanup must not fail an otherwise passing test, so retry and, if the
// OS still holds the directory, leave it to temp cleanup.
import fs from 'node:fs'

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
