// Unit tests for the per-session instruction prefix. These pin the four
// behaviours the jcode path depends on: a real instruction reaches the prompt,
// an empty one sends nothing, an oversized one is refused instead of truncated,
// and the same instruction is never injected twice.

import { describe, expect, it } from 'vitest'

import {
  applyInstruction,
  INSTRUCTION_MARKER,
  instructionDigest,
  MAX_INSTRUCTION_CHARS,
  planInstruction,
} from './instructions.js'

const INSTRUCTION = '## kimaki\n\nBe concise. Reply in at most two lines.'

describe('planInstruction', () => {
  it('turns a present instruction into a labelled prefix block', () => {
    const plan = planInstruction({ instruction: INSTRUCTION })

    expect(plan.kind).toBe('prefix')
    if (plan.kind !== 'prefix') throw new Error('expected a prefix plan')
    expect(plan.chars).toBe(INSTRUCTION.length)
    expect(plan.digest).toBe(instructionDigest(INSTRUCTION))
    // The block names itself as a user prefix, never as a system prompt.
    expect(plan.text).toContain(`<!-- ${INSTRUCTION_MARKER} sha256=${plan.digest} role=user-prefix -->`)
    expect(plan.text).toContain(`<!-- /${INSTRUCTION_MARKER} -->`)
    expect(plan.text).toContain(INSTRUCTION)
    expect(plan.text.endsWith('\n\n')).toBe(true)
  })

  it('sends nothing for an empty or whitespace-only instruction', () => {
    for (const instruction of ['', '   ', '\r\n\n\t ']) {
      const plan = planInstruction({ instruction })
      expect(plan).toEqual({ kind: 'none', digest: null, reason: 'empty' })
      expect(applyInstruction(plan, 'hello')).toBe('hello')
    }
  })

  it('refuses an instruction over the bound instead of truncating it', () => {
    const oversized = 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)
    const plan = planInstruction({ instruction: oversized })

    expect(plan.kind).toBe('rejected')
    if (plan.kind !== 'rejected') throw new Error('expected a rejected plan')
    expect(plan.chars).toBe(MAX_INSTRUCTION_CHARS + 1)
    expect(plan.reason).toContain(String(MAX_INSTRUCTION_CHARS))
    expect(plan.reason).toContain(String(MAX_INSTRUCTION_CHARS + 1))
    // A refusal must never swallow the user's message.
    expect(applyInstruction(plan, 'hello')).toBe('hello')

    // Exactly at the bound is still accepted.
    const atBound = planInstruction({ instruction: 'y'.repeat(MAX_INSTRUCTION_CHARS) })
    expect(atBound.kind).toBe('prefix')
  })

  it('keeps a stable digest and does not re-inject an already delivered instruction', () => {
    const digest = instructionDigest(INSTRUCTION)
    expect(digest).not.toBe(null)
    // CRLF and trailing whitespace are normalization details, not new content.
    const crlf = INSTRUCTION.replace(/\n/g, '\r\n') + '\n  '
    expect(instructionDigest(crlf)).toBe(digest)
    expect(instructionDigest(INSTRUCTION + '!')).not.toBe(digest)
    expect(instructionDigest('   ')).toBe(null)

    const again = planInstruction({ instruction: INSTRUCTION, deliveredDigest: digest })
    expect(again).toEqual({ kind: 'none', digest, reason: 'already-delivered' })
    expect(applyInstruction(again, 'hello')).toBe('hello')

    // A changed instruction is delivered even though the session has a digest.
    const changed = planInstruction({ instruction: INSTRUCTION + '\nAlso: no emoji.', deliveredDigest: digest })
    expect(changed.kind).toBe('prefix')
    if (changed.kind !== 'prefix') throw new Error('expected a prefix plan')
    expect(changed.digest).not.toBe(digest)
  })
})

describe('applyInstruction', () => {
  it('puts the instruction block before the user text', () => {
    const plan = planInstruction({ instruction: INSTRUCTION })
    const prompt = applyInstruction(plan, 'what changed?')

    expect(prompt.startsWith(`<!-- ${INSTRUCTION_MARKER}`)).toBe(true)
    expect(prompt).toContain(INSTRUCTION)
    expect(prompt.endsWith('\n\nwhat changed?')).toBe(true)
  })
})
