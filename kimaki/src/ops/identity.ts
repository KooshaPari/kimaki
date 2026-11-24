// Identity resolution for a runtime profile against an ACP handshake.
//
// ACP reports exactly two identity fields, a name and a version, and declares no
// fork marker of its own. A KooshaPari fork reuses the upstream ACP surface and
// the upstream name, so the only discriminator between stock jcode and kcode is
// the fork segment in the version: this repo's convention is BASEVERSION-k<semver>
// (for example 0.93.0-k0.1.0), which upstream never emits.
//
// A profile therefore states a name plus whether a fork segment is required, and
// this module is the one place that decides whether an observation satisfies it.
import type { RuntimeIdentityExpectation } from './contracts.ts'

export type ObservedIdentity = {
  readonly name: string | null
  readonly version: string | null
}

// A version must be a real dotted version before its fork segment means
// anything, so an unparsable version is a refusal rather than an assumption of
// stock. Accepts an optional pre-release/build tail.
const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

// The fork segment out of BASEVERSION-k<semver>, matched only inside a parsable
// version so a stray '-k' in unrelated text can never satisfy a fork profile.
const FORK_SEGMENT = /-k\d/

export const isParsableVersion = (version: string): boolean => VERSION_SHAPE.test(version)

export const hasForkSegment = (version: string): boolean =>
  isParsableVersion(version) && FORK_SEGMENT.test(version)

const expectedText = (expected: RuntimeIdentityExpectation): string =>
  `identity '${expected.name}' ${expected.fork ? 'with' : 'without'} a -k<digits> fork segment in the version`

const observedText = (observed: ObservedIdentity): string =>
  `identity '${observed.name}' version '${observed.version}'`

/**
 * null when the handshake satisfies the profile, otherwise the full refusal
 * reason. Every rejection names the profile, the expectation and what actually
 * arrived, so an operator can see why a routing attempt stopped. A caller must
 * refuse on a non-null result; this never softens a mismatch into a warning.
 */
export function identityRefusal(
  expected: RuntimeIdentityExpectation,
  observed: ObservedIdentity,
  label: string,
): string | null {
  const refuse = (detail: string): string =>
    `Runtime profile ${label} expects ${expectedText(expected)}, but the ACP handshake reported ${detail}; refusing to route a ${label} session`

  if (observed.name === null) return refuse('no identity')
  if (observed.version === null) return refuse(`identity '${observed.name}' with no version`)
  if (!isParsableVersion(observed.version)) {
    return refuse(`identity '${observed.name}' version '${observed.version}', which is not a parsable version`)
  }
  if (observed.name !== expected.name) return refuse(observedText(observed))
  if (hasForkSegment(observed.version) !== expected.fork) {
    return refuse(
      `${observedText(observed)}, which ${expected.fork ? 'does not carry' : 'carries'} a -k<digits> fork segment`,
    )
  }
  return null
}
