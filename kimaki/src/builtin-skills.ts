// Opt-out skills Kimaki ships in skills/<id>/SKILL.md (debug, tunnel). They are
// not in the system prompt, which keeps the rest of the CLI reference.
//
//   plugin (OpenCode process) ──▶ readBuiltinSkills ──▶ ctx.skill.transform(add)
//   bot ──▶ --disable-skills ──▶ session permissions `skill:<id>` deny
//
// Plugin files must not pull in discord.js or SQLite: keep this module plain fs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConfigError, FilesystemError } from './errors.ts'

export const BUILTIN_SKILL_IDS = ['kimaki-debug', 'kimaki-tunnel'] as const

export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number]

export function isBuiltinSkill(id: string): boolean {
  return (BUILTIN_SKILL_IDS as readonly string[]).includes(id)
}

// src/ and dist/ both sit next to skills/.
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills')

export type BuiltinSkill = { id: string; name: string; description: string; path: string; content: string }

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const value = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim()
  // `description:` and `description: ""` are empty values, not descriptions.
  return value && !/^(['"])\1$/.test(value) ? value : undefined
}

// Checkouts differ: core.autocrlf=true stores CRLF, some editors mix both, and a
// BOM can survive a copy. Normalise in memory instead of rewriting skill files on
// disk, so Windows and UNIX checkouts parse the same.
export function normaliseNewlines(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

// Pure parse of one skill file. Kept exported so tests can cover every encoding
// without depending on how this checkout happens to be checked out.
export function parseBuiltinSkill(id: string, file: string, raw: string): FilesystemError | BuiltinSkill {
  const text = normaliseNewlines(raw)
  const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(text)
  const description = match?.[1] ? frontmatterValue(match[1], 'description') : undefined
  if (!match || !description) return new FilesystemError({ operation: `parse ${file}: missing frontmatter description` })
  // Virtual path: OpenCode has no file to scan for these (same as its /builtin skills).
  return { id, name: id, description, path: `/kimaki/${id}.md`, content: (match[2] ?? '').trim() }
}

export async function readBuiltinSkills(skillsDir: string = SKILLS_DIR): Promise<FilesystemError | BuiltinSkill[]> {
  const skills: BuiltinSkill[] = []
  for (const id of BUILTIN_SKILL_IDS) {
    const file = path.join(skillsDir, id, 'SKILL.md')
    const raw = await fs.promises.readFile(file, 'utf8').catch((cause) => new FilesystemError({ operation: `read ${file}`, cause }))
    if (raw instanceof Error) return raw
    const skill = parseBuiltinSkill(id, file, raw)
    if (skill instanceof Error) return skill
    skills.push(skill)
  }
  return skills
}

// `all` or a comma separated list of built-in skill ids.
export function parseDisabledSkills(value: string | undefined): ConfigError | BuiltinSkillId[] {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (items.includes('all')) return [...BUILTIN_SKILL_IDS]
  const unknown = items.filter((item) => !isBuiltinSkill(item))
  if (unknown.length > 0) return new ConfigError({ reason: `Unknown built-in skill ${unknown.join(', ')}. Choose from: all, ${BUILTIN_SKILL_IDS.join(', ')}` })
  return items as BuiltinSkillId[]
}

// Static parts of the session instructions (system-prompt.ts) that
// `kimaki --disable-prompt <section>` removes. Here, not in system-prompt.ts,
// so the CLI help can list them without loading zod.
export const PROMPT_SECTIONS = [
  'discord-permissions',
  'kimaki-debugging',
  'file-upload-requests',
  'action-buttons',
  'session-sleep',
  'session-abort',
  'cross-project-commands',
  'waiting-sessions',
  'critique-diffs',
  'markdown-formatting',
  'discord-callouts',
  'search-result-urls',
  'diagrams',
] as const

export type PromptSection = (typeof PROMPT_SECTIONS)[number]

function isPromptSection(item: string): item is PromptSection {
  return PROMPT_SECTIONS.some((section) => section === item)
}

// Repeatable flag; each value can also be a comma separated list.
export function parseDisabledPromptSections(values: readonly string[] | undefined): ConfigError | PromptSection[] {
  const items = (values ?? []).flatMap((value) => value.split(',')).map((item) => item.trim()).filter(Boolean)
  const unknown = items.filter((item) => !isPromptSection(item))
  if (unknown.length > 0) return new ConfigError({ reason: `Unknown prompt section ${unknown.join(', ')}. Choose from: ${PROMPT_SECTIONS.join(', ')}` })
  return items.filter(isPromptSection)
}

// OpenCode hides a skill from the model and the skill tool when its permission is denied.
export function disabledSkillRules(disabled: readonly string[]) {
  return disabled.map((id) => ({ action: 'skill', resource: id, effect: 'deny' }) as const)
}
