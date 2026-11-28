// Env-name hygiene for the fork's own identifiers.
//
// The fork owns no OpenCode configuration surface: every OPENCODE_* name that
// stays in src is either read by a live OpenCode process (runtime-owned, so it
// cannot be renamed from here) or set only by tests. Two former names were
// private identifiers of this codebase and never crossed a process boundary,
// so they were renamed to JCODE_* with no dual-read. This test pins that rename
// over a fixed file list: it reads exactly these two files and never walks the
// tree, so it costs two reads and cannot be broken by new directories.
import fs from 'node:fs'
import { expect, test } from 'vitest'

const renamed = [
  { file: './prompt.ts', legacy: 'OPENCODE_MAX_ATTACHMENT_BYTES', current: 'JCODE_MAX_ATTACHMENT_BYTES' },
  { file: './plugin/anthropic/index.ts', legacy: 'OPENCODE_ENV_BLOCK', current: 'JCODE_ENV_BLOCK' },
]

test.each(renamed)('$file carries $current and no $legacy', ({ file, legacy, current }) => {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  expect(source).toContain(current)
  expect(source).not.toContain(legacy)
})
