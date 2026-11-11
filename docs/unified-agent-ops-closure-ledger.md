# Unified agent-ops initiative: closure ledger

Updated: 2026-11-11. Status: active, not complete. This is the durable scope and acceptance ledger for the Kimaki-based initiative, not a claim that the items below are implemented. Detailed design and sequencing: `docs/superpowers/plans/2026-11-11-unified-agent-ops.md`. Preserve existing uncommitted work and review this ledger when starting or closing work.

## Outcome and architecture

Adapt the Kimaki fork into a unified agent operations and observability layer. Agent runtimes enter through backend adapters. Discord, Paperclip and other services connect through outward bridges. Discover and dynamically bind independently started sessions, including herdr-assisted discovery, without requiring the layer to own the session. Evaluate consolidation of existing bots and projects rather than presuming a merge is safe or desirable.

## Milestones and acceptance gates

- [ ] **M1: Baseline and architecture.** Record fork/upstream provenance, runtime and service contracts, existing bot inventory, ownership, security boundaries, and migration alternatives. Close only when outstanding unknowns are tracked and relevant source pins verified. Existing research and plan are available, but the connector comparison and some source-pin reconciliation remain open.
- [ ] **M2: Runtime adapters.** For OpenCode, Jcode and Codex, publish an honest versioned capability matrix and implement supported discovery, identity, observation and lifecycle operations. Demonstrate each through its real public interface, including independently started sessions, unsupported attach behavior and errors. OpenCode isolated observation has passed previously. Jcode and Codex live adapter acceptance is outstanding.
- [ ] **M3: Dynamic session binding.** Use herdr discovery where supported and native lookup with explicit identity and authority. Exercise real external sessions, tenant isolation, duplicate binding, restart/reconnect and non-owning detach. Verify the original client remains usable and session state is not modified without authorization. Existing metadata-only inventory and durable associations are a foundation, not full live acceptance.
- [ ] **M4: Discord outward bridge.** Deliver an authorized external session to a Discord view, preserve identity and permissions, enforce privacy, and test disconnect, retry, restart and duplicate behavior against the actual bridge interface. Document precisely what is delivered and what is not.
- [ ] **M5: Paperclip external-observation pilot.** Bind an independently started native session to a Discord view and project it into Paperclip as a plugin-owned external-session entity. Verify no task or run is invented, the native client continues working, and observer detach/restart does not take ownership. Repeat or document explicit support limits for each targeted runtime.
- [ ] **M6: Paperclip managed-execution pilot.** From an explicitly authorized Paperclip task, create exactly one attributable managed native attempt with idempotent retry, identity correlation, lifecycle evidence and supported cancellation/approval. Exercise failure and restart paths. Prove behavior on the actual integration boundary, not only fixtures.
- [ ] **M7: Existing project consolidation.** Map each candidate's capabilities, owners, state, integrations and operational dependencies. Compare migration, coexistence and reverse-merge options. Prove capability parity, data preservation, rollback and owner approval before any cutover or retirement. No existing service is retired by this ledger.
- [ ] **M8: Release and operations.** Run real end-to-end pilots, authorization and isolation checks, fault/recovery and restart tests, full relevant build/test gates, documentation, deployment and rollback rehearsal. Record versions, commands, results, known limitations and explicitly accepted exceptions. Obtain appropriate signoff before production changes.

## Closure discipline

Each milestone needs a named owner, concrete evidence links or reproducible commands, observed results, and a dated status. Unit tests, mocks and source inspection supplement but do not substitute for real public-interface acceptance. A blocked or unsupported capability stays open with its specific constraint. Do not silently mark a capability complete because a type, plan or placeholder exists. Closure of the whole initiative requires all applicable milestones and both Paperclip pilots, or a clearly documented and explicitly approved scope change.

## Current evidence and immediate work

- Previously committed passive binding and isolated OpenCode observer slices passed bounded CLI/database and native observer acceptance. They do not establish Discord, Paperclip, Jcode or Codex end-to-end support.
- Paperclip correlation and metadata projection foundations pass 10 focused tests and the production TypeScript build. On 2026-11-11 the native projection assertion passed against an isolated real OpenCode session using Vitest's thread pool (task `3451270sk4`), including non-owning detach and no model calls. Earlier runs failed before test execution. This does not validate Paperclip or Discord delivery.
- Next: review and integrate the draft boundaries, complete the first external-session-to-Discord/Paperclip pilot, qualify Jcode and Codex interfaces, then implement the separately authorized managed execution pilot. Keep the existing bot capability and rollback inventory current.
