# Unified Agent Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support native OpenCode, Jcode and Codex sessions through a backend-neutral operations boundary, discover external agents through herdr, bind them dynamically to Discord, and integrate Paperclip without competing session owners.

**Architecture:** First build a small operations module within the fork and keep Kimaki's existing Discord rendering. Separate native runtime identity/lifecycle from surface binding, discovery evidence and mutation authority. Integrate other projects over shared contracts before any physical merge.

**Tech Stack:** Existing TypeScript ESM, pnpm 9.15.9, Vitest, libSQL/Drizzle, current OpenCode V2 client. Codex app-server and Jcode client protocol behind adapters. Herdr remains a separate Rust service.

**Spec:** `docs/superpowers/specs/2026-11-11-unified-agent-ops-design.md`

**Status:** Implementation in progress after the user's November 11 `go` and continuation. Commit `e318374b` provides the identity/metadata foundation and local bind/list/detach CLI, not complete Tasks 1-3 or supported live backends. Its 52 focused tests, 2 migration checks, production build and compiled CLI workflow passed. Full regression and native/Discord E2E remain unqualified. Continue Task 2's read-only OpenCode boundary and actual acceptance diagnosis before dependent streaming/control changes. Companion `docs/research/2026-11-11-*.md` documents contain source mappings and observed qualification limits. No production rollout, shared daemon changes or legacy retirement is authorized by local implementation approval.

## Global Constraints

- Discovery is not consent to publish transcripts, inject prompts, change permissions, or take control.
- Binding is not process ownership. Detaching Discord never kills an external session.
- Runtime transcript/turn truth stays with the runtime. The SDK owns identity reconciliation, bindings, permissions, command receipts and projections, not a second competing transcript authority.
- Multiple observers are supported. Mutations require explicit control authority, and the SDK must not claim its lease fences a separate native TUI unless the backend actually enforces it.
- Existing OpenCode behavior remains supported. Unsupported backend features are disabled visibly rather than emulated by altering another backend's session.
- No blind monorepo merge. Preserve unique bot capabilities and state before retiring any implementation.
- Keep all new work on verified E: while C: remains below 500,000,000,000 free bytes. No live bot restarts, native session takeover, production credential changes or data migration without explicit coordination.
- Read `AGENTS.md`, applicable decisions and required feature/error/changeset skills before code changes. Never import V1 OpenCode SDK. Preserve additive database compatibility and light CLI startup.

## Review Focus

1. Same native session IDs on different hosts/endpoints and reused pane/PIDs must not collide (Task 1 and 3).
2. Discovery or observe binding must not alter runtime metadata/instructions/permissions or leak historical transcripts (Task 2 and 3).
3. Native UI and Discord/Paperclip writers must not silently race, and expired lease commands must be rejected (Task 4).
4. Disconnect after a write, duplicate events, delayed old-binding output and restart replay must not duplicate prompts or cross tenants (Task 4 and 5).
5. Backend without safe live attachment, or presence without native identity, must remain visibly presence-only (Task 3, 6 and 7).

## Planned module ownership

New files below are proposed, not existing upstream modules. Keep them inside `kimaki/src/ops/` initially. Extract a workspace package only after a second consumer passes contract tests.

| Path | Responsibility |
| --- | --- |
| `ops/contracts.ts` | Runtime-neutral records and discriminated capabilities |
| `ops/registry.ts` | Endpoint/session identity and discovery reconciliation |
| `ops/bindings.ts` | Surface association, generations and visibility |
| `ops/control.ts` | Authorization, leases and command receipts |
| `ops/projection.ts` | Normalized events and read views |
| `ops/delivery.ts` | Per-binding outbox, cursors and replay |
| `ops/runtime/opencode.ts` | Existing OpenCode calls and event translation |
| `ops/runtime/jcode.ts` | Qualified Jcode transport |
| `ops/runtime/codex.ts` | Qualified Codex app-server transport |
| `ops/discovery/herdr.ts` | Herdr evidence ingestion, no implicit control |
| `ops/control-plane/paperclip.ts` | Task and run correlation with Paperclip |
| `ops/telemetry.ts` | Metadata-only metrics and audit export |

Tests live beside each new module as `*.test.ts`. Real workflow tests live in `kimaki/src/ops-*.e2e.test.ts` using isolated data and transports. Existing `schema.ts`, `migrations.ts`, `store.ts`, `bot.ts`, `sessions.ts`, `prompt.ts`, `event-loop.ts`, `effects.ts`, `ingress.ts`, `main.ts` and relevant command modules are integration points, not a mandate to rewrite them all in one task.

## Task 1: Identity and contracts

**Files:** Create `ops/contracts.ts`, `ops/registry.ts` and `ops/registry.test.ts`.

**Interfaces:** `SessionKey = { hostId: string, endpointId: string, backendKind: string, nativeSessionId: string }`. `reconcileObservation(observation: DiscoveryObservation): Promise<SessionRecord | UnresolvedObservation>` preserves process incarnation separately. `RuntimeAdapter` exposes `capabilities`, `discover`, `observe`, `readSnapshot`, and optional `create`/`submit`/`interrupt`/`answerApproval` operations with explicit unsupported results. All control operations accept a stable command ID and runtime-scoped session reference.

- [ ] Write failing tests `sameNativeIdDifferentEndpoints`, `pidReuseDoesNotAlias`, `daemonRestartPreservesNativeIdentity`, `missingNativeIdRemainsUnresolved` and `unsupportedOperationIsExplicit`. Assert distinct identity for two endpoint-scoped `s1` values and no attached transcript for unresolved presence.
- [ ] Run `pnpm run test --run src/ops/registry.test.ts` inside `kimaki`, observe the named tests fail for missing implementations rather than environment failure.
- [ ] Implement the contracts and pure reconciliation with source provenance and a versioned capability result. Do not normalize all native protocols into a fictitious OpenCode server.
- [ ] Run the targeted tests and `pnpm build`, then commit only these files and the required changeset if applicable.

## Task 2: Preserve OpenCode through an adapter

**Files:** Create `ops/runtime/opencode.ts`, `ops/runtime/opencode.test.ts`. Modify `bot.ts`, `opencode-server.ts`, `sessions.ts`, `prompt.ts`, `event-loop.ts` only where needed to route native calls through the boundary.

**Consumes:** Task 1 contracts. **Produces:** `createOpenCodeAdapter(connection): RuntimeAdapter`, preserving native IDs, runtime error values and feature capabilities. Keep OpenCode plugin code OpenCode-specific.

- [ ] Write failing tests for create/prompt/interrupt, snapshot hydration, model capability exposure, and `observeHasNoSessionUpdateOrInstructionWrites`. Replay existing reducer fixtures through the adapter and compare existing visible effects.
- [ ] Run targeted tests to verify failures.
- [ ] Wrap native V2 calls without changing normal Kimaki-created session behavior. Implement passive observe separately from current mutating `adoptSession`.
- [ ] Run targeted tests, existing `thread-reducer.fixtures.test.ts`, `legacy.e2e.test.ts` and `session-commands.e2e.test.ts` with isolated lock/data settings. Run `pnpm build` and commit.

## Task 3: Herdr discovery and passive bindings

**Files:** Create `ops/discovery/herdr.ts`, `ops/bindings.ts` and their tests. Modify `schema.ts`, `migrations.ts`, `store.ts`, `sessions.ts`, `event-loop.ts`, and add `ops-bindings.e2e.test.ts`.

**Consumes:** Registry and observe adapter. **Produces:** `bindSurface(input: BindSurfaceInput): Promise<SurfaceBinding>`, `detachBinding(bindingId: string): Promise<void>`, `reconcileHerdr(snapshot: HerdrSnapshot): Promise<DiscoveryResult>`. Bind input includes session, surface/tenant IDs, mode, publication policy and idempotency key. Detach affects only binding/cursor state.

- [ ] Write failing tests for externally launched session discovered after bot startup, two panes in the same cwd, unresolved agent presence, PID/pane reuse, herdr disconnect/stale state, two observe surfaces, new-events-only default, and detach with zero runtime stop calls. Add old-shaped database migration coverage in `db.test.ts`.
- [ ] Run targeted tests, confirm failures.
- [ ] Implement the version-qualified herdr API mapping from its research document. Resnapshot after reconnect/gap. Add new tables/columns additively, regenerate schema with `pnpm generate`. Keep original thread mapping as compatibility input and do not mutate external runtime metadata.
- [ ] Run targeted tests, `db.test.ts`, and an isolated workflow: start an agent outside the bot, discover it, bind observe, see new public-safe output, detach, verify the agent remains usable. If this cannot run, mark acceptance blocked rather than claiming coverage from mocks. Build and commit.

## Task 4: Explicit control and uncertain writes

**Files:** Create `ops/control.ts`, `ops/control.test.ts`. Modify command/ingress authorization paths and add `ops-control.e2e.test.ts`.

**Consumes:** Session/binding records. **Produces:** `requestControl(input: ControlRequest): Promise<ControlResult>`, `releaseControl(leaseId: string): Promise<void>`, `dispatchCommand(input: AuthorizedCommand): Promise<CommandReceipt>`. Each command carries binding generation and lease epoch. Runtime-native exclusivity evidence is separate from SDK-only lease state.

- [ ] Write failing tests for observe-mode submit/approve/interrupt denial, two SDK controller claims, expired epoch rejection, stale binding generation, native UI contention, duplicate interaction ID, authorization revoked mid-flight, and disconnect after a potentially accepted prompt producing `uncertain` without resubmission.
- [ ] Run targeted tests to verify failures.
- [ ] Implement durable compare-and-swap lease changes and receipts before network side effects. Reconcile uncertain writes using native identifiers where supported. Return a blocked result where native safety cannot be established. Never use blind terminal input as fallback.
- [ ] Run targeted tests and isolated handoff/release tests. Verify native sandbox approval still applies, build and commit.

## Task 5: Service-neutral projections and delivery

**Files:** Create `ops/projection.ts`, `ops/delivery.ts`, `ops/telemetry.ts` and tests. Modify `thread-reducer.ts`, `format-parts.ts`, `effects.ts`, `event-loop.ts`; add `ops-delivery.e2e.test.ts`.

**Consumes:** Runtime envelopes and bindings. **Produces:** `projectEvent(state: SessionProjection, event: EventEnvelope): ProjectionResult`, `enqueueDelivery(binding: SurfaceBinding, effect: ServiceEffect): Promise<void>`, `flushBinding(bindingId: string): Promise<DeliveryResult>`. Discord remains the first service adapter. Runtime raw evidence and normalized view versions remain distinguishable.

- [ ] Write failing tests for duplicate/out-of-order events, replay gap, uncertain service send, restart cursor restoration, binding move while streaming, cross-tenant rejection, echo suppression, provider reasoning exclusion, unsafe mentions, slow service backpressure and preserved approval/terminal events.
- [ ] Run targeted tests to verify failures.
- [ ] Implement source-scoped deduplication, per-binding outbox/cursors and generation fencing. Coalesce only replaceable deltas. Keep existing formatting through a compatibility translation until fixtures prove parity.
- [ ] Run targeted and existing reducer/renderer tests plus isolated crash/reconnect workflow. Build and commit. Full message/reducer suite is required at the final gate, inspecting any snapshots rather than accepting bulk changes.

## Task 6: Qualify and implement Jcode

**Files:** Create `ops/runtime/jcode.ts`, its tests and `ops-jcode.e2e.test.ts`. Add backend selection in `main.ts`, onboarding and model/command capability checks.

**Consumes:** Tasks 1-5 contracts. **Produces:** `createJcodeAdapter(config: JcodeEndpointConfig): Promise<RuntimeAdapter>` with transport/version-negotiated capabilities.

- [ ] First qualify the installed daemon/harness boundary and Windows transport using documented versioned schemas. The research found bundled `api --stdio` documentation but the installed binary rejects `jcode api --help`, so resolve this mismatch explicitly rather than assuming that entrypoint exists. Pin a fixture source and supported minimum version in tests. Do not start/stop the shared active server. If safe external-session subscription/control is unavailable, ship presence-only or observe-only support and record the missing upstream requirement.
- [ ] Write failing tests for session discovery, text/tool/approval/terminal events, usage with unknown cost, reconnect, explicit stop scope and unsupported fork/undo/queue behavior. Include externally started session observation and competing native client behavior.
- [ ] Run targeted tests, implement only qualified methods, rerun tests and build.
- [ ] Run a real isolated Jcode session started outside Kimaki through discover/bind/detach. If claiming control support, also prove authorized prompt, approval, interrupt and safe handoff. Commit with an honest capability matrix.

## Task 7: Qualify and implement Codex

**Files:** Create `ops/runtime/codex.ts`, its tests and `ops-codex.e2e.test.ts`. Extend backend configuration and capability UI from Task 6.

**Consumes:** Tasks 1-5 contracts. **Produces:** `createCodexAdapter(config: CodexEndpointConfig): Promise<RuntimeAdapter>` using app-server protocol schemas pinned to the tested binary version.

- [ ] Qualify initialize, listing/read/resume, subscriptions, turns and approval behavior using official protocol/schema and the installed binary. Earlier PowerShell probes timed out, but repeated actual Node stdio probes now pass initialize and empty thread/list against codex-cli 0.167.1, with isolated homes, zero model calls and confirmed child exit. Read/resume, subscriptions, turns and approvals remain unqualified. See `docs/research/2026-11-11-real-interface-observations.md`. Explicitly distinguish historical resume from live attach to an existing CLI. Do not attach a second app-server and claim it owns an unrelated running CLI.
- [ ] Write failing tests for protocol initialization, thread/turn IDs, streamed deltas/tools, approvals, interrupted/failed vs completed status, child agents, reconnect, unsupported attachment and native UI conflict.
- [ ] Run targeted tests, implement the qualified app-server mapping and version checks, rerun tests and build.
- [ ] Run isolated external Codex discovery and observe workflow. Only mark live control supported if the same running session has been proven safe, otherwise document the presence-only/observe-only limitation. Commit.

## Task 8: Paperclip and project federation

**Files:** Create `ops/control-plane/paperclip.ts`, its tests and `ops-paperclip.e2e.test.ts`. Qualify the pinned native Runner connector first. Create a separate legacy Paperclip-side adapter package only if the deployed version requires that compatibility path. Add `docs/ops-migration-inventory.md`.

**Consumes:** Runtime-independent command/receipt/event contracts. **Produces:** `correlateTask(input: TaskAssociation): Promise<TaskLink>` and `executePaperclipRun(input: PaperclipRunRequest): Promise<PaperclipRunResult>` on our side. These names are proposed internal functions, not upstream endpoints.

- [ ] Write failing tests for task/run/session correlation, heartbeat deduplication, replay after crash, budget denial, cancellation scope, approval delegation, external-session observation without task takeover, and Paperclip loss during an active runtime turn.
- [ ] Run targeted tests. Implement one supported pinned Paperclip adapter path without inventing HTTP routes, preserving its context/session/usage conventions. Do not enable a second scheduler for the same work.
- [ ] Run a real isolated task assignment, progress, approval and completion/cancel workflow, plus attach-only external session observation. Confirm detach/cancel semantics cannot kill unrelated external work. Build and commit.
- [ ] Implement a PhenoBot compatibility consumer against the same contracts in a separately approved, owned change. Inventory forum/GitHub bridge, persona, voice and scheduler behavior before retiring anything. Test commands and persisted mappings on one reversible canary. Other projects remain federated until equivalent preservation evidence exists.

## Final gate and execution sequencing

Run Tasks 1 and 2 sequentially. Task 3 can prepare independent herdr fixtures while Task 2 completes but integrates only afterward. Task 4 depends on passive identity/bindings. Task 5 establishes delivery guarantees before rich backend rollout. Tasks 6 and 7 may run as independent implementation lanes once contracts are stable. Task 8 starts with a qualified backend and explicit Paperclip policy ownership.

- [ ] Initialize required submodules non-recursively after checking storage and upstream object availability. Use the pinned workspace install policy. Do not run the root `prepare` script blindly or globally install fork code.
- [ ] Run `pnpm build` inside `kimaki`. For changed message handling/reducer behavior, run `pnpm run test --run -u` once with `KIMAKI_TEST_WORKERS` constrained for available memory, inspect all snapshot differences, then rerun without snapshot update. No live bot port collision.
- [ ] Execute the external-agent acceptance matrix for each claimed supported capability on Windows and the actual target host topology. Tests must prove no metadata/instruction/permission mutation on passive bind and no runtime shutdown on detach.
- [ ] Verify git diff, additive migration against a copied old-schema fixture, no secrets/private transcripts, and no unqualified feature claims. Product changes need local commits, not automatic upstream PRs or public pushes.
- [ ] Present capability support, real acceptance results and blocked transport cases for approval before production rollout or consolidation.
