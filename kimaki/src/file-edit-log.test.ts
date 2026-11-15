import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { appendFileEditEvents, editorsForFile, extractEditedFiles, loadFileEditEvents } from './file-edit-log.ts'

test('extractEditedFiles reads edit/write paths and every file header of a patch', () => {
  const patchText = '*** Begin Patch\n*** Add File: a.txt\n*** Update File: b.txt\n+x\n*** Move to: c.txt\n*** Delete File: d.txt\n*** End Patch'
  // The product resolves every tool path with `path.resolve`, so the results are OS-native
  // absolute paths. Resolve the fixture root the same way instead of hard-coding a POSIX `/p`.
  const directory = path.resolve('/p')
  expect({
    edit: extractEditedFiles({ tool: 'edit', input: { path: 'src/e.ts' }, directory }),
    write: extractEditedFiles({ tool: 'write', input: { path: '/abs/w.txt' }, directory }),
    patch: extractEditedFiles({ tool: 'patch', input: { patchText }, directory }),
    home: extractEditedFiles({ tool: 'write', input: { path: '~/h.txt' }, directory }).map((file) => file.replace(os.homedir(), '~')),
    shell: extractEditedFiles({ tool: 'shell', input: { command: 'touch f' }, directory }),
    missing: extractEditedFiles({ tool: 'edit', input: undefined, directory }),
  }).toEqual({
    edit: [path.join(directory, 'src', 'e.ts')],
    write: [path.resolve('/abs/w.txt')],
    patch: [path.join(directory, 'a.txt'), path.join(directory, 'b.txt'), path.join(directory, 'd.txt'), path.join(directory, 'c.txt')],
    home: [path.join('~', 'h.txt')],
    shell: [],
    missing: [],
  })
})

test('a v1 file-edit-events.jsonl is read, extended and compacted by the same code', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-edit-'))
  const v1 = [
    { v: 1, at: 1000, sessionId: 'ses_old', file: '/p/a.ts', tool: 'apply_patch' },
    { v: 1, at: 2000, sessionId: 'ses_mid', file: '/p/a.ts', tool: 'edit' },
    { v: 1, at: 1500, sessionId: 'ses_old', file: '/p/b.ts', tool: 'write' },
    { v: 1, at: 1200, sessionId: 'ses_old', file: '/p/b.ts', tool: 'write' },
  ]
  fs.writeFileSync(path.join(dataDir, 'file-edit-events.jsonl'), `${v1.map((event) => JSON.stringify(event)).join('\n')}\nnot json\n{"v":2}\n`)
  const appended = await appendFileEditEvents({ dataDir, events: [{ v: 1, at: 3000, sessionId: 'ses_new', file: '/p/a.ts', tool: 'write' }], maxEvents: 4, compactAfterBytes: 1 })
  if (appended instanceof Error) throw appended
  const events = await loadFileEditEvents({ dataDir })
  if (events instanceof Error) throw events
  expect({ editors: await editorsForFile({ events, filePath: 'a.ts', cwd: '/p' }), kept: events.length }).toMatchInlineSnapshot(`
    {
      "editors": [
        {
          "at": 3000,
          "sessionId": "ses_new",
        },
        {
          "at": 2000,
          "sessionId": "ses_mid",
        },
        {
          "at": 1000,
          "sessionId": "ses_old",
        },
      ],
      "kept": 4,
    }
  `)
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('editorsForFile matches through symlinks, also for deleted files', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-edit-link-')))
  fs.mkdirSync(path.join(root, 'real'))
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
  const events = [{ v: 1 as const, at: 1, sessionId: 'ses_a', file: path.join(root, 'real', 'gone.ts'), tool: 'write' as const }]
  const viaLink = await editorsForFile({ events, filePath: path.join(root, 'link', 'gone.ts'), cwd: root })
  expect(viaLink.map((editor) => editor.sessionId)).toEqual(['ses_a'])
  fs.rmSync(root, { recursive: true, force: true })
})
