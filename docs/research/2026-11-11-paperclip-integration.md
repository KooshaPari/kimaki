# Paperclip control-plane integration research

Date: 2026-11-11 (Pacific). Status: proposed, documentation only. No deployment or lifecycle authority is granted by this document.

## Scope and source pin

This is a bounded primary-source investigation, not an exhaustive upstream audit. Read alongside `../superpowers/specs/2026-11-11-unified-agent-ops-design.md`, especially its non-negotiable boundaries, authority map and Paperclip strategy. Searching `plans/decisions/` for `Paperclip` found no existing decision. No source, dependencies, credentials or running agents were changed.

`gh api repos/paperclipai/paperclip/commits/master --jq .sha` resolved master to **`f125b823f4c7c37680ffa788ceee1ab0bc8f44b1`** during this investigation. All upstream paths below refer to that immutable revision, not an installed release. To resolve a reference, append its path to this base:

```text
https://github.com/paperclipai/paperclip/blob/f125b823f4c7c37680ffa788ceee1ab0bc8f44b1/
```

| Ref | Inspected primary source | Relevant symbols or sections |
| --- | --- | --- |
| P1 | `docs/adapters/overview.md` | How Adapters Work, Adapter Architecture, External Adapters |
| P2 | `.agents/skills/create-agent-adapter/SKILL.md` | Shared Types, three registries, environment diagnostics, execution guidance |
| P3 | `packages/paperclip-runner/README.md` | Native Runner introduction, execution environment lifecycle, completion/recovery discussion |
| P4 | `packages/adapter-utils/src/types.ts` | `AdapterExecutionContext`, `AdapterRuntime`, `AdapterExecutionResult`, `ServerAdapterModule`, `UsageSummary` |
| P5 | `packages/paperclip-runner/src/contracts/types.ts` | `NativeRunIdentity`, `NativeSessionCapabilities`, `NativeUserMessage` |
| P6 | `packages/paperclip-runner/src/contracts/native-session-backend.ts` | `NativeSessionBackend`, `NativeSession`, `PersistedNativeSession`, cancellation and recovery errors |
| P7 | `packages/paperclip-runner/src/contracts/control-plane-port.ts` | `ControlPlanePort`, append receipts, replay, finalization options |
| P8 | `packages/paperclip-runner/src/protocol/replay-contract.ts` | PRP version constants, `PrpCommand`, `PrpEvent`, validation and negotiation |

P1-P3 were read through the web and their introductions reconfirmed through the GitHub contents API at the pin. P4-P8 were read through that API at the pin. Generated JSON schemas, server HTTP handlers, Rust implementation and live deployments were not audited. Symbol names below are actual inspected contracts. Proposed local records and paths are explicitly marked.

## Decision: a distinct control plane

Paperclip is neither a model/backend selector nor a Discord/service bridge. Proposed topology:

```text
Paperclip task/organization/policy authority
                  |
       Paperclip control-plane connector
                  |
      agent-ops identity, receipts, bindings
        /                         \
Runtime adapters IN           Service bridges OUT
OpenCode/Jcode/Codex           Discord and other surfaces
        ^
herdr observations -> scoped identity reconciliation
```

Paperclip decides whether its work is admitted, budgeted, approved and complete. The native runtime remains transcript/turn/tool truth. Herdr supplies presence evidence, not permission. The SDK persists correlation, command receipts and delivery cursors, not another scheduler or competing authoritative transcript. These are proposed design choices implementing the local spec, not upstream guarantees.

Avoid invoking a Paperclip-managed runtime once through Runner and again through Kimaki's existing session creation. One admitted work request has exactly one execution owner. Discord is a projection and authorized command origin, not an alternative run owner.

## Actual upstream contracts and path selection

### Native Runner: preferred future integration target

P3 explicitly directs new harness/provider integration to the Runner path and preserves legacy adapters as a compatibility boundary. It identifies Rust `runner/` as production Runner and TypeScript as reference/control-plane SDK/conformance tooling. Its execution driver is an in-process interface, not a plugin wire API. Local loopback WS and configured remote WSS are described, but that is not an authorization to invent a public server route. P3 also requires governed completion, not final assistant text alone.

The relevant actual contracts are:

- P5 `NativeRunIdentity`: required string fields `runId`, `sessionId`, `companyId`, `issueId`, `agentId`. Do not rename `issueId` to `taskId` in upstream payloads.
- P6 `NativeSessionBackend`: `descriptor()`, `openSession(input)`, optional `openReplacementSession(input, previous)` and `recoverSession(snapshot, options)`. Recovery takes an abort signal. A historical native session ID alone is not this recovery contract.
- P6 `NativeSession`: `identity()`, `capabilities()`, `events({afterCursor}?)`, `startTurn({message,...})` returning `turnId`, `result()`, `snapshot(options?)`, `close({reason})`. Optional methods include `attachRun`, `steer`, `interrupt`, `cancel`, `resolveRuntimeRequest`, and `handoffRuntimeRequest`. Optional methods and capability flags must be checked, not assumed.
- P5 capabilities include `resume`, `typedEvents`, `steering`, `interruption`, `structuredResult`, optional `usage`, `reconciliation`, runtime-request capabilities and `unsupported`. `completionBoundary` can be `provider_termination` or `paperclip_work_session`; `providerTermination` can be `confirmed` or `unavailable`. Work-session completion therefore need not prove a remote process exited.
- P6 checkpoints distinguish normalized `sessionId`, optional `providerSessionId` and tagged `providerIdentity`, run `identity`, optional `activeTurnId`, `terminalTurns`, cursor and pending runtime requests. Do not substitute a pane ID or PID for any of these.
- P7 `ControlPlanePort` provides `openRun`, `appendEvent`, `replayEvents`, `completeRun`, and optional checkpoint load/save. Append returns `{cursor, highestContiguousSourceSeq, disposition: 'committed' | 'duplicate'}`. Replay takes `runId`, `sourceInstanceId`, `afterSourceSeq`, `limit`. Structured finalization accepts `result`, `terminal`, optional `turnId`, `callerResultId`, `callerDedupeKey`.
- P8 declares protocol name `paperclip.runner`, minimum version 1 and current version **3**. The README's PRP v1 description is not proof the current protocol maximum is 1. Negotiate versions and validate actual envelopes.
- P8 `PrpCommand` contains `schema`, `commandId`, `controllerSeq`, `type`, `issuedAt`, `payload`. `PrpEvent` contains `schema`, `sourceEventId`, `sourceSeq`, `sourceInstanceId`, `sourceKind`, `runId`, `normalizedSessionId`, optional `turnId`/`itemId`, `eventType`, `schemaVersion`, `priority`, `emittedAt`, optional observation/source/debug and payload. Generic payload typing is not permission to fabricate event kinds.

P7's comment describes production implementation as a later phase while P3 describes server integration. Treat that as documentation/version-context uncertainty, not a conclusion that native production support is absent. Server wiring needs a separate implementation-time check.

**Recommendation:** qualify a connector against the pinned Runner contracts before production. Do not directly implement `NativeSession` around arbitrary herdr-discovered sessions: its close/cancellation/recovery obligations exceed passive observation authority.

### Legacy adapter path: compatibility option, not universal attach

P1 describes heartbeat selection by `adapterType`/`adapterConfig`, followed by `execute()`. P2 describes server, UI and CLI consumers, not just a process launcher. P4 is more complete than P2's abbreviated type examples:

- `ServerAdapterModule` requires `type`, `execute(ctx)` and `testEnvironment(ctx)`; `sessionCodec` and many capability/metadata hooks are optional.
- `AdapterExecutionContext` includes `runId`, `agent`, `runtime`, `config`, `context`, `onLog`, optional `onMeta`, `onEvent`, `onUsage`, `onDispatch`, `onSpawn`, `authToken`, `signal`, `onCancellationReady`, execution target and runtime tool access. `context` is a generic record, not a strongly typed task/approval grant.
- `AdapterRuntime` contains nullable legacy `sessionId`, `sessionParams`, `sessionDisplayId`, `taskKey`. Persist opaque session state through the codec; display IDs are not authority tokens.
- `AdapterExecutionResult` requires `exitCode`, `signal`, `timedOut`; it can report session parameters, usage, cost, summary, error metadata and recovery evidence. A zero exit code alone is not a validated native completion contract.
- P4 cancellation is run-scoped. Opt in through `onCancellationReady` before provider work. `stopRemoteStartup` and `onProviderStopped` require host ownership and verified termination, not an agent-selected process to kill.

Use a legacy adapter only for an explicitly bounded, owned execution compatibility slice if required by the deployed Paperclip version. Keep UI parsing, environment checks and CLI formatting in scope. Do not claim that the generic HTTP adapter provides arbitrary live-session attach or exactly-once dispatch. External adapter installation examples in P1 are not execution/cancel endpoints and are not used here.

## Proposed correlation and durable state

The following records are **new application design**, not existing upstream interfaces or approved package names.

| Proposed field/key | Meaning and constraints |
| --- | --- |
| `paperclipInstanceId + companyId` | Tenant authority scope; required on every lookup, event export and command |
| `issueId + agentId` | Paperclip task assignment correlation; legacy `context.taskId` must be validated and mapped explicitly, never inferred from cwd |
| `runId + attemptId` | Execution and local attempt identity; attempt is SDK-owned unless upstream supplies a verified equivalent |
| `normalizedSessionId` | Runner session correlation; map explicitly to P5's `identity.sessionId` at the boundary |
| `sessionRef` | SDK key for `(hostId, endpointId, backendKind, nativeSessionId)`; separate from Paperclip session and process incarnation |
| `turnId + itemId/requestId` | Turn and action/approval correlation where supplied; preserve upstream provenance |
| `bindingId + generation` | Service delivery target and authority generation, never a task/run identity |
| `commandId + inputDigest` | Durable mutation receipt; same ID with different input is a conflict |
| `sourceInstanceId + sourceSeq/sourceEventId` | Source-scoped replay/deduplication evidence; preserve run/session binding |
| `ownership` | `paperclip-owned` or `external-observe`; explicit authority escalation required before dispatch |

One issue can have many runs and one runtime session can span multiple runs. Never join solely on `agentId`, `taskKey`, cwd, PID or a display ID. A restarted source can have a new incarnation without changing the native conversation. A new attempt is not implicit permission to repeat a side effect.

Initial implementation target, deferred until implementation approval: **`kimaki/src/ops/control-plane/paperclip.ts`**, as specified in the main implementation plan. Keep the control-plane boundary independent of Discord and runtime-specific imports without creating a new shared package first.

The following paths are **future extraction options only after a second real consumer justifies a shared package**, not immediate implementation targets. They describe possible responsibility splits, not approved package names:

| Path | Proposed responsibility |
| --- | --- |
| `packages/agent-ops/src/control-planes/paperclip/contracts.ts` | Versioned correlation, ownership, policy and receipt records, no Discord/runtime imports |
| `packages/agent-ops/src/control-planes/paperclip/connector.ts` | `admitWork`, `associateExternal`, `publishProgress`, `reconcileCommand`, `requestRunCancellation` application ports |
| `packages/agent-ops/src/control-planes/paperclip/runner-mapping.ts` | Validate and map pinned native identities/events/results, capability negotiation |
| `packages/agent-ops/src/control-planes/paperclip/ledger.ts` | Durable inbox/outbox, unique keys, attempts, replay watermarks and uncertain outcomes |
| `packages/agent-ops/src/control-planes/paperclip/policy.ts` | Admission/approval/budget decision references and expiry checks |
| `packages/paperclip-agent-ops-adapter/` | Optional legacy compatibility package only if deployment qualification requires it |

These methods are conceptual local ports, **not upstream HTTP routes**. No task start, attach, approval, budget or cancellation HTTP endpoint is asserted by this research. Before implementing a transport, inspect deployed server handlers/auth and choose either supported Runner integration or a qualified adapter boundary. Do not turn `ControlPlanePort` into a guessed REST API.

## Idempotency, approval, budget and cancellation

### Dispatch and recovery

1. Authenticate tenant/actor, resolve identity, check explicit execution ownership and current policy before accepting work.
2. Persist immutable input digest and command receipt before dispatch. An exact duplicate returns the prior receipt. A conflicting duplicate fails closed.
3. Record dispatch evidence and runtime turn identity. Lost acknowledgement after dispatch becomes `uncertain`, not permission to start another session.
4. Reconcile against runtime/native checkpoint and Paperclip records. If no reliable readback exists, require operator resolution. An SDK idempotency key cannot make an uncooperative runtime exactly-once.
5. Deduplicate progress separately from commands. P8 validation rejects conflicting duplicate event content, checks run/session and semantic-call correlation, and checks matching semantic operation/idempotency identities. P7 offers committed/duplicate receipts and contiguous source progress. Preserve those checks rather than flattening everything into chat text.
6. Publish terminal outcome through an outbox with a stable result key. A retry of publication must not rerun the work. Do not claim `callerDedupeKey` alone proves all server-side exactly-once behavior without testing the actual port implementation.

### Approval

Paperclip organizational approval and native runtime tool approval are independent gates. Neither substitutes for the other. Proposed grant binding: tenant, issue, run, session, turn/request, action digest, actor, expiry and policy revision. Recheck at dispatch and resolution, reject stale/duplicate/conflicting approvals, and durably record the decision. A `context.approvalId`, approved hire callback or Discord button is not a blanket permission grant. P6 exposes request resolution/handoff hooks, but this investigation did not audit their imported resolution union or server authorization. Disable mutation approval forwarding until qualified.

### Budget and accounting

Paperclip owns admission and budget policy for its runs. Proposed connector obtains an authoritative admission decision and bounded allocation before dispatch; unknown or unreachable policy blocks new work. This is a requirement, not a claim that an upstream reservation endpoint was found. Do not implement a competing wallet in Kimaki or pretend token observations enforce a hard provider spend cap.

P4 distinguishes per-run from session-cumulative usage, reported/estimated/unpriced cost, billing type, completeness, provider request identity and pricing provenance. `inputTokens` excludes cache reads and includes cache writes; `cacheWriteTokens` is a subset, not another total. Preserve those semantics and per-model receipts. Delta cumulative counters only within a verified same-session baseline. Missing measurements stay unknown, not zero. Proposed usage ledger deduplicates by scoped provider receipt or run/attempt/model interval and does not sum both checkpoints and final totals. Out-of-band activity on an external session is not silently billed to a Paperclip task. Hard budget enforcement under delayed usage remains unvalidated.

### Cancellation scope

| Operation | Required effect in proposed integration |
| --- | --- |
| Detach Discord or another surface | Stop projection only, preserve runtime and task |
| Cancel service delivery retry | Stop that outbox operation only |
| Interrupt owned turn | Capability-checked native interruption of exact turn, not whole host/process tree |
| Cancel Paperclip-owned run | Revoke its mutation/publication authority, settle in-flight receipts, perform only owned cleanup, report confirmed/uncertain termination separately |
| Cancel task association on external observation | Remove association/forwarding only, never kill or interrupt external runtime |
| Shut down SDK/connector | Release observer resources; do not cascade-stop user sessions |

P6 defines `cancel` as synchronous authority revocation followed by passive cleanup through `NativeSessionCancellation.cleanup`; cleanup must not mutate durable control-plane state. Its `close` contract stops provider work and settles pending promises, so it is unsuitable as the detach primitive for an externally owned session. P7 abort options require mutating operations to settle without a new durable commit after cancellation, with an explicitly documented postcommit observer exception for governed-cancellation terminal append. An `AbortSignal` or lost socket by itself is not proof a provider stopped. Cancellation racing completion must settle once in the durable authority, retaining actual side-effect outcomes and late-event provenance.

## Herdr-discovered external agents

Implement `discover -> resolve -> bind observe` without calling existing Kimaki adoption that changes metadata, permissions or instructions. Scope inventory by allowed host/project/tenant. Resolve native identity through the runtime adapter, keeping pane/PID/cwd evidence separate. If transcript access cannot be verified, expose presence only.

An explicit Paperclip issue association can tag an observed session, but must not launch a heartbeat into it, install tools, change credentials, publish old history, approve actions, interrupt it or acquire lifecycle ownership. Start publication at the binding cursor with opt-in historical replay. Multiple observers are permitted and tenant filters apply before publication. Native TUI activity remains possible and is not fenced by an SDK-only lease.

Future control escalation needs explicit user/runtime consent, current Paperclip policy and demonstrable native exclusivity or a disclosed safe contention policy. Prefer a new Paperclip-owned bounded session when those guarantees cannot be established. Never fall back to herdr terminal keystroke injection. Herdr's actual API was not inspected in this bounded Paperclip investigation; no discovery or control endpoint is asserted here.

## Staged gates before implementation or rollout

These are **proposed tests, not tests run for this document**.

| Gate | Acceptance evidence |
| --- | --- |
| 0: deployment qualification | Pin deployed Paperclip/runtime versions, inspect new Runner skill/playbook, actual schemas, handlers/auth and Rust path; choose one transport and prove negotiated protocol/capabilities |
| 1: pure contract slice | Fixtures for native/legacy mappings, protocol 1-3 negotiation and unsupported versions, tenant mismatch, issue/task mapping, absent native IDs and differing session namespaces |
| 2: durable ledger/faults | Duplicate/conflicting dispatch and events, source gaps/restart, crash before/after dispatch, lost ack, outbox retry, uncertain side effects, exactly one terminal publication without redispatch |
| 3: passive external vertical slice | Fake herdr observations plus real runtime read interface; bind/move/detach preserve external process, permissions/instructions untouched, old transcript hidden, multiple observers and cross-tenant denial |
| 4: governed owned-run slice | Deterministic owned harness, real chosen Paperclip boundary, expiry/revocation and stale approval rejection, interrupt vs cancel, completion/cancel race, delayed cleanup and checkpoint failure |
| 5: budget/accounting | Admission denial/unavailability blocks dispatch, duplicate and partial receipts, cache semantics, cumulative counter reset, unknown price, overspend latency and externally generated usage exclusion |
| 6: reversible canary | One opt-in project/tenant, private projection, no parallel scheduler, restore/reconnect with native session and receipt continuity, detach without external termination |

No live gate is passed by reading upstream types. Implemented Kimaki code will require its build and relevant full message/reducer tests, but no code or build is authorized in this documentation-only task.

## Limits and follow-up boundary

- Master source is not proof the deployed Paperclip release exposes the same contracts. New Runner skill/playbook, full generated schemas, server routes/auth, Rust parity and adapter plugin packaging need a focused qualification pass before coding.
- No Windows process, WS, cancellation, native attach or multi-observer behavior was exercised. Runner recovery/verified adoption must not be generalized to arbitrary user-launched sessions.
- Budget reservation/approval transport, administrative task mutations and exact finalization enforcement were not inspected. They remain blocked implementation questions rather than invented endpoints.
- No guarantee of hard spend caps, global exactly-once side effects, exclusive control over a native TUI or automatic safe external-session adoption is established.
- Local storage preflight: C: free bytes `465606410240`, below the `500000000000` threshold; E: verified `Data`, free bytes `3553600065536`. This sole output stays under the existing E: checkout. No migration or large allocation was attempted.

Validation for this task is reference-path/symbol inspection against the pinned GitHub contents plus local Markdown/diff checks. This document deliberately separates inspected contracts from design, test proposals and unvalidated deployment claims.
