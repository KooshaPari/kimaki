// One runtime identity, resolved before any executable, store or handshake is
// trusted. KCode is the KooshaPari/KCode fork of Jcode: same ACP surface and the
// same sessions/session_*.json layout, but its own executable, store and
// KCODE_* environment. A profile is plain data; resolution lives with its
// consumer so this file stays behaviour-free.
export type RuntimeProfileId = 'jcode' | 'kcode'

export type RuntimeEnvPrefix = 'JCODE_' | 'KCODE_'

export type RuntimeProfile = {
  readonly id: RuntimeProfileId
  // Executable that speaks this profile's ACP surface.
  readonly executable: string
  // Environment prefix the runtime owns (for example <prefix>HOME).
  readonly envPrefix: RuntimeEnvPrefix
  // Directory holding sessions/session_*.json, in home-relative display form.
  readonly storeDir: string
  // Identity the peer must report in the ACP initialize handshake.
  readonly expectedIdentity: string
}

export const STOCK_JCODE_PROFILE: RuntimeProfile = Object.freeze({
  id: 'jcode',
  executable: 'jcode',
  envPrefix: 'JCODE_',
  storeDir: '~/.jcode',
  expectedIdentity: 'jcode',
})

export const KCODE_PROFILE: RuntimeProfile = Object.freeze({
  id: 'kcode',
  executable: 'kcode',
  envPrefix: 'KCODE_',
  storeDir: '~/.kcode',
  expectedIdentity: 'kcode',
})

export const RUNTIME_PROFILES: Readonly<Record<RuntimeProfileId, RuntimeProfile>> = Object.freeze({
  jcode: STOCK_JCODE_PROFILE,
  kcode: KCODE_PROFILE,
})

export const RUNTIME_PROFILE_IDS: readonly RuntimeProfileId[] = Object.freeze(['jcode', 'kcode'] as const)

// Native session identity is scoped to a runtime endpoint, never a PID or cwd.
export type SessionKey = {
  hostId: string
  endpointId: string
  backendKind: string
  nativeSessionId: string
}

export type DiscoveryObservation = {
  provider: string
  hostId: string
  // The discovery endpoint is provenance, not the native runtime endpoint.
  endpointId: string
  observationId: string
  observedAt: number
  processIncarnation: string | null
  nativeSession: SessionKey | null
}

export type ReconciledObservation =
  | {
      kind: 'resolved'
      key: SessionKey
      id: string
      observation: DiscoveryObservation
    }
  | {
      kind: 'unresolved'
      observation: DiscoveryObservation
      reason: string
    }

export type UnsupportedCapability = {
  kind: 'unsupported'
  reason: string
}

// This version only describes metadata discovery. It promises neither transcript
// access nor a qualified native transport, runtime ownership or mutation authority.
export type PassiveCapabilities = {
  version: 1
  discovery: { kind: 'supported' }
  control: {
    create: UnsupportedCapability
    submit: UnsupportedCapability
    interrupt: UnsupportedCapability
    answerApproval: UnsupportedCapability
  }
}
