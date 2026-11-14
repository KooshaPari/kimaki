import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { BUILTIN_SKILL_IDS, disabledSkillRules, parseDisabledPromptSections, parseDisabledSkills, PROMPT_SECTIONS, readBuiltinSkills } from './builtin-skills.ts'
import { baseInstructions } from './system-prompt.ts'

test('every built-in skill file parses', async () => {
  const skills = await readBuiltinSkills()
  if (skills instanceof Error) throw skills
  expect(skills.map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS])
  for (const skill of skills) {
    expect(skill.description, skill.id).toContain('Only for Kimaki Discord sessions')
    expect(skill.content.startsWith('# '), skill.id).toBe(true)
  }
})

// Encoding tests use temp files so they do not depend on how this checkout
// happens to be encoded (core.autocrlf may hand us CRLF or LF on disk).
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

const skillFile = (description: string, eol: '\n' | '\r\n') =>
  ['---', 'name: demo-skill', `description: ${description}`, '---', '', '# Demo skill', '', 'Body line.'].join(eol) + eol

async function tempSkillsDir(files: Partial<Record<(typeof BUILTIN_SKILL_IDS)[number], string>>): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kimaki-skills-'))
  tempDirs.push(dir)
  for (const id of BUILTIN_SKILL_IDS) {
    await fs.promises.mkdir(path.join(dir, id), { recursive: true })
    await fs.promises.writeFile(path.join(dir, id, 'SKILL.md'), files[id] ?? skillFile(`fixture ${id}`, '\n'), 'utf8')
  }
  return dir
}

const errorMessage = (value: unknown) => (value instanceof Error ? value.message : '')

test('a CRLF skill file yields its frontmatter description', async () => {
  const dir = await tempSkillsDir({ 'kimaki-debug': skillFile('CRLF debug skill', '\r\n'), 'kimaki-tunnel': skillFile('CRLF tunnel skill', '\r\n') })
  const skills = await readBuiltinSkills(dir)
  if (skills instanceof Error) throw skills
  expect(skills.map((skill) => skill.description)).toEqual(['CRLF debug skill', 'CRLF tunnel skill'])
  expect(skills[0]!.content).toBe('# Demo skill\n\nBody line.')
})

test('an LF skill file still parses', async () => {
  const dir = await tempSkillsDir({ 'kimaki-debug': skillFile('LF debug skill', '\n'), 'kimaki-tunnel': skillFile('LF tunnel skill', '\n') })
  const skills = await readBuiltinSkills(dir)
  if (skills instanceof Error) throw skills
  expect(skills.map((skill) => skill.description)).toEqual(['LF debug skill', 'LF tunnel skill'])
  expect(skills[1]!.content).toBe('# Demo skill\n\nBody line.')
})

test('a skill file with mixed line endings parses', async () => {
  const mixed = '---\r\nname: mixed-skill\r\ndescription: Mixed endings skill\n---\r\n\r\n# Demo skill\nBody line.\r\n'
  const dir = await tempSkillsDir({ 'kimaki-debug': mixed })
  const skills = await readBuiltinSkills(dir)
  if (skills instanceof Error) throw skills
  expect(skills[0]!.description).toBe('Mixed endings skill')
  expect(skills[0]!.content).toBe('# Demo skill\nBody line.')
})

test('a skill file without frontmatter is refused by name', async () => {
  const dir = await tempSkillsDir({ 'kimaki-debug': '# No frontmatter\r\n\r\ndescription: not frontmatter\r\n' })
  const failed = await readBuiltinSkills(dir)
  expect(failed).toBeInstanceOf(Error)
  expect(errorMessage(failed)).toContain('missing frontmatter description')
  expect(errorMessage(failed)).toContain('kimaki-debug')
})

test('a skill file with frontmatter but no description is refused by name', async () => {
  const dir = await tempSkillsDir({ 'kimaki-debug': '---\r\nname: nameless\r\n---\r\n\r\n# Demo skill\r\n' })
  const failed = await readBuiltinSkills(dir)
  expect(failed).toBeInstanceOf(Error)
  expect(errorMessage(failed)).toContain('missing frontmatter description')
  expect(errorMessage(failed)).toContain('kimaki-debug')
})

test('a skill file with an empty description value is refused, not defaulted', async () => {
  const empty = await tempSkillsDir({ 'kimaki-debug': '---\r\ndescription:\r\n---\r\n\r\n# Demo skill\r\n' })
  const failed = await readBuiltinSkills(empty)
  expect(failed).toBeInstanceOf(Error)
  expect(errorMessage(failed)).toContain('missing frontmatter description')

  const quoted = await tempSkillsDir({ 'kimaki-debug': '---\r\ndescription: ""\r\n---\r\n\r\n# Demo skill\r\n' })
  const quotedFailed = await readBuiltinSkills(quoted)
  expect(quotedFailed).toBeInstanceOf(Error)
  expect(errorMessage(quotedFailed)).toContain('missing frontmatter description')
})

test('--disable-skills accepts all, a list, and rejects unknown ids', () => {
  expect(parseDisabledSkills(undefined)).toEqual([])
  expect(parseDisabledSkills('kimaki-tunnel, kimaki-debug')).toEqual(['kimaki-tunnel', 'kimaki-debug'])
  expect(parseDisabledSkills('all')).toEqual([...BUILTIN_SKILL_IDS])
  expect(parseDisabledSkills('tunnel')).toBeInstanceOf(Error)
  expect(disabledSkillRules(['kimaki-tunnel'])).toMatchInlineSnapshot(`
    [
      {
        "action": "skill",
        "effect": "deny",
        "resource": "kimaki-tunnel",
      },
    ]
  `)
})

test('--disable-prompt removes exactly the headings of each section', () => {
  expect(parseDisabledPromptSections(['critique-diffs,discord-callouts', 'search-result-urls'])).toEqual(['critique-diffs', 'discord-callouts', 'search-result-urls'])
  expect(parseDisabledPromptSections(['critique'])).toBeInstanceOf(Error)
  const input = { sessionId: 'ses_1', threadId: '2', channelId: '3', guildId: '4', userId: '5', dataDir: '/data', channelTopic: null, agents: [], parentSessionId: null }
  const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('## '))
  const full = headings(baseInstructions(input))
  const removed = Object.fromEntries(PROMPT_SECTIONS.map((section) => {
    const kept = new Set(headings(baseInstructions({ ...input, disabled: [section] })))
    return [section, full.filter((heading) => !kept.has(heading))]
  }))
  expect(removed).toMatchInlineSnapshot(`
    {
      "action-buttons": [
        "## action buttons",
        "## ending conversations with options",
      ],
      "critique-diffs": [
        "## showing diffs",
      ],
      "cross-project-commands": [
        "## cross-project commands",
      ],
      "diagrams": [
        "## diagrams",
      ],
      "discord-callouts": [
        "## Callouts in Kimaki Discord",
      ],
      "discord-permissions": [
        "## permissions",
      ],
      "file-upload-requests": [
        "## requesting files from the user",
      ],
      "kimaki-debugging": [
        "## debugging kimaki issues",
      ],
      "markdown-formatting": [
        "## markdown formatting",
      ],
      "search-result-urls": [
        "## URLs in search results",
      ],
      "session-abort": [
        "## aborting a session",
      ],
      "session-sleep": [
        "## sleeping the session",
      ],
      "waiting-sessions": [
        "## waiting for a session to finish",
      ],
    }
  `)
  expect(headings(baseInstructions({ ...input, disabled: [...PROMPT_SECTIONS] }))).toMatchInlineSnapshot(`
    [
      "## Discord output",
      "## shell tool",
      "## commit messages",
      "## uploading files to discord",
      "## generating audio from text",
      "## archiving the current thread",
      "## updating the session title",
      "## discord user mentions",
      "## starting new sessions from CLI",
      "## scheduled sends and routines",
      "## reading other sessions",
    ]
  `)
})
