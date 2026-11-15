// OpenCode binary lookup: the first supported binary wins. Only OpenCode 1
// is an error with install instructions, never replaced.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { findOpencodeBinary } from './opencode-server.ts'
import { opencodeBinary } from './test/harness.ts'

test('supported binary wins over OpenCode 1, only OpenCode 1 is an error, nothing found is null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode-bin-'))
  // A stub the host can actually execute, so the detector spawns it and parses
  // real output: a shebang script on POSIX, a .cmd shim on Windows, where an
  // extension-less script is not executable and npm installs CLIs as .cmd.
  const win = process.platform === 'win32'
  const v1 = path.join(dir, win ? 'opencode.cmd' : 'opencode')
  fs.writeFileSync(v1, win ? '@echo off\r\necho 1.15.5\r\n' : '#!/bin/sh\necho 1.15.5\n', { mode: 0o755 })
  const v2 = opencodeBinary()
  const message = (value: Error | string | null) => (value instanceof Error ? value.message.replace(v1, '<dir>/opencode') : value)

  expect(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2', v2, v1] })).toBe(v2)
  expect(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2', v1, v2] })).toBe(v2)
  expect(message(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2', v1] }))).toMatchInlineSnapshot(`"Kimaki now requires OpenCode 2, but <dir>/opencode is OpenCode 1.15.5. Install OpenCode 2 with: curl -fsSL https://opencode.ai/v2/install | bash (or: npm i -g @opencode/cli). Then run kimaki again. To keep using OpenCode 1, run the older Kimaki instead: npx kimaki@0"`)
  expect(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2'] })).toBe(null)
  fs.rmSync(dir, { recursive: true, force: true })
})
