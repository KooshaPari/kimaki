import { createHash } from 'node:crypto'

/**
 * Content digest over an explicitly ordered record. Callers pass a freshly
 * constructed object with a fixed key order, never a key-sorted walk of an
 * arbitrary input, so the digest is reproducible from the stored JSON alone.
 */
export function seal(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`
}

/** Stable identifier derived from fixed-order parts. */
export function derive(prefix: string, parts: readonly string[]): string {
  return `${prefix}${createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 32)}`
}
