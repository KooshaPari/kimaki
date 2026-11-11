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
