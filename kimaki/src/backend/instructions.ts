// Delivery of kimaki's per-session instruction to a jcode session.
//
// jcode offers no per-session system or append-system surface over ACP or the
// CLI (measured; see docs/jcode-system-instructions.md). The only per-session
// channel is the prompt text itself, so this module turns the instruction into
// an explicit block prepended to the session's first prompt.
//
// This is a prefix, not a system prompt. The block header says `role=user-prefix`
// on the wire so a reader of the transcript is never told otherwise. A session's
// instructions are pure functions of their input: same text in, same bytes out.

import crypto from 'node:crypto'

// The instruction is one per session and is not re-sent on later turns, so the
// bound only has to keep a single prompt within the provider's context. Measured
// base instruction for a plain thread is ~41k chars; 64k leaves room for a long
// agent list without making the first prompt pathological.
export const MAX_INSTRUCTION_CHARS = 64_000

export const INSTRUCTION_MARKER = 'kimaki:session-instruction'

/** Digest prefix length; long enough to make an accidental collision irrelevant. */
const DIGEST_CHARS = 16

export type InstructionPlan =
  /** Nothing to send: the instruction is empty, or was already delivered. */
  | { kind: 'none'; digest: string | null; reason: 'empty' | 'already-delivered' }
  /** Prefix this text in front of the session's first prompt, once. */
  | { kind: 'prefix'; digest: string; text: string; chars: number }
  /** The instruction is over the bound: refuse instead of truncating it. */
  | { kind: 'rejected'; digest: string; reason: string; chars: number }

// Line endings differ between the platforms kimaki runs on, and the same
// instruction must digest the same way on all of them.
export function normalizeInstruction(instruction: string): string {
  return instruction.replace(/\r\n?/g, '\n').trim()
}

/** Stable digest of the normalized instruction. Empty input has no digest. */
export function instructionDigest(instruction: string): string | null {
  const text = normalizeInstruction(instruction)
  if (text === '') return null
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, DIGEST_CHARS)
}

function block(digest: string, text: string): string {
  return `<!-- ${INSTRUCTION_MARKER} sha256=${digest} role=user-prefix -->\n${text}\n<!-- /${INSTRUCTION_MARKER} -->\n\n`
}

/**
 * What the jcode path must send for one session.
 *
 * `deliveredDigest` is the digest already injected into this session, so a
 * resume, a rebind or a re-adoption does not send the same instruction twice.
 */
export function planInstruction({
  instruction,
  deliveredDigest = null,
}: {
  instruction: string
  deliveredDigest?: string | null
}): InstructionPlan {
  const text = normalizeInstruction(instruction)
  if (text === '') return { kind: 'none', digest: null, reason: 'empty' }
  const digest = instructionDigest(text)!
  if (deliveredDigest === digest) return { kind: 'none', digest, reason: 'already-delivered' }
  const chars = text.length
  if (chars > MAX_INSTRUCTION_CHARS) {
    return {
      kind: 'rejected',
      digest,
      chars,
      reason: `session instruction is ${chars} chars, over the ${MAX_INSTRUCTION_CHARS}-char limit for a prompt prefix`,
    }
  }
  return { kind: 'prefix', digest, text: block(digest, text), chars }
}

/**
 * The prompt the jcode backend sends: the instruction block once, then the
 * user's own text. A rejected or empty plan leaves the prompt untouched, so a
 * failure to deliver instructions never swallows the user's message.
 */
export function applyInstruction(plan: InstructionPlan, prompt: string): string {
  return plan.kind === 'prefix' ? plan.text + prompt : prompt
}
