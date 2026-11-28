// Engine identity oracle for runtime backends. A backend can answer the same
// protocol without being a real runtime: a synthetic engine is a stub, fixture
// or replay shim that answers frames but has no real runtime version, or says so
// with a marker. An identity claim alone must never route real control, so every
// control decision goes through this oracle rather than trusting the claim.
import { ConfigError } from '../../errors.js'

export type EngineIdentityClaim = {
  // Engine name the peer reports, for example 'codex' or 'jcode'.
  identity: string
  // Real runtime version. A synthetic engine has none, and a missing version is
  // refused rather than defaulted.
  version?: string | null
  // Explicit synthetic marker (a stub, fixture or replay shim).
  synthetic?: boolean
  // Optional free-form engine label, for example 'synthetic'.
  engine?: string | null
}

// Markers that name a non-real engine. Detection is exact on the label, and
// substring on the identity/version strings, so '0.0.0-synthetic' is caught too.
export const SYNTHETIC_MARKERS: readonly string[] = Object.freeze([
  'synthetic',
  'stub',
  'fixture',
  'replay',
  'mock',
  'fake',
])

export type RealEngine = {
  kind: 'real'
  identity: string
  version: string
}

export type EngineRefusal = {
  kind: 'refused'
  identity: string
  // The synthetic marker that caused the refusal, or null when the claim is
  // refused for a different reason (missing version, blank identity).
  marker: string | null
  reason: string
}

export type EngineClassification = RealEngine | EngineRefusal

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const containsMarker = (value: string): string | null => {
  const lower = value.toLowerCase()
  for (const marker of SYNTHETIC_MARKERS) {
    if (lower.includes(marker)) return marker
  }
  return null
}

const refusal = (identity: string, marker: string | null, reason: string): EngineRefusal => ({
  kind: 'refused',
  identity,
  marker,
  reason,
})

// Classify one claim without applying routing policy. The classifier fails
// closed: an unlabelled synthetic engine that answers the protocol but reports
// no runtime version still lands on `refused`.
export function classifyEngine(claim: EngineIdentityClaim): EngineClassification {
  const identity = text(claim?.identity)
  if (!identity) return refusal(identity, null, 'Engine identity is blank; refusing control operations')

  // An explicit flag wins, then the engine label, then the identity and version
  // strings. Naming the marker in the refusal is the point: an operator can see
  // which part of the claim identified the backend as synthetic.
  const label = text(claim.engine).toLowerCase()
  const marker =
    claim.synthetic === true
      ? 'synthetic'
      : SYNTHETIC_MARKERS.includes(label)
        ? label
        : containsMarker(identity) ?? containsMarker(text(claim.version))
  if (marker !== null) {
    return refusal(
      identity,
      marker,
      `Engine '${identity}' reports the synthetic marker '${marker}'; refusing control operations`,
    )
  }

  const version = text(claim.version)
  if (!version) {
    return refusal(
      identity,
      null,
      `Engine '${identity}' reports no runtime version; refusing control operations rather than defaulting a version`,
    )
  }

  return { kind: 'real', identity, version }
}

const expectedMismatch = (identity: string, expectedIdentity: string): ConfigError | null =>
  identity === expectedIdentity
    ? null
    : new ConfigError({
        reason: `Engine '${identity}' is not the expected runtime '${expectedIdentity}'; refusing control operations`,
      })

// Control gate. Returns the verified real engine or a refusal. A synthetic
// engine never reaches this return path, so no control frame can be dispatched
// on its behalf.
export function assertControlEngine(
  claim: EngineIdentityClaim,
  expectedIdentity?: string,
): RealEngine | ConfigError {
  const classified = classifyEngine(claim)
  if (classified.kind === 'refused') return new ConfigError({ reason: classified.reason })
  if (expectedIdentity !== undefined) {
    const mismatch = expectedMismatch(classified.identity, expectedIdentity)
    if (mismatch !== null) return mismatch
  }
  return classified
}

export type ObservationOnlyEngine<T> = {
  mode: 'observe'
  identity: string
  // Present so a caller can inspect which marker allowed observation.
  marker: string | null
  // Runs one observation read. There is deliberately no start/prompt/cancel:
  // the surface cannot express a control operation at all.
  observe: () => Promise<T>
  // Always zero. The counter exists so observation-only use is checkable rather
  // than merely asserted.
  controlFramesSent: () => number
}

// Observation-only adapter. A synthetic engine is legitimate to watch (fixtures
// and replay shims are exactly how you observe), but the returned surface has no
// control method and never calls one. A claim from a foreign engine is still
// refused, because observing it would misattribute its records.
export function createObservationOnlyEngine<T>({
  claim,
  expectedIdentity,
  observe,
}: {
  claim: EngineIdentityClaim
  expectedIdentity?: string
  observe: () => Promise<T> | T
}): ObservationOnlyEngine<T> | ConfigError {
  const identity = text(claim?.identity)
  if (!identity) return new ConfigError({ reason: 'Engine identity is blank; refusing observation' })
  if (expectedIdentity !== undefined) {
    const mismatch = expectedMismatch(identity, expectedIdentity)
    if (mismatch !== null) return mismatch
  }
  const classified = classifyEngine(claim)
  const marker = classified.kind === 'refused' ? classified.marker : null
  return {
    mode: 'observe',
    identity,
    marker,
    observe: async () => observe(),
    controlFramesSent: () => 0,
  }
}
