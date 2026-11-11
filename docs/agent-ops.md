# Experimental local agent operations

This first slice separates runtime identity **IN** from service association **OUT**. It provides metadata inventory and durable local associations, not live agent attachment or Discord transcript streaming. Existing OpenCode conversations are unchanged.

## What is available

- `kimaki ops discover` runs a bounded, read-only `herdr agent list` and prints validated metadata as JSON. Coverage is herdr-managed panes only. A native ID or path reported by herdr remains an unverified candidate, not an endpoint-qualified runtime session.
- `kimaki ops discover --source opencode --service-file <path> --host <id> --endpoint <id>` reads one native session page from an explicitly selected running service. It prints qualified identities and titles only, never history, permissions or instructions. It never starts a service. Native requests have fixed bounded timeouts and do not accept herdr-only flags.
- `kimaki ops bind` records a metadata-only observe association with an explicit runtime host, endpoint, backend and native session ID. It neither verifies nor resumes that session. Publication policy is always `none`.
- `kimaki ops bindings` lists associations within the explicitly named local tenant and service.
- `kimaki ops detach` changes only the association state. There is no runtime stop, interrupt, resume or metadata-update call.

These commands are for trusted local operators. Tenant filtering is isolation of local records, not authentication or authorization for remote users. No Discord command, HTTP control endpoint or automatic publication is exposed by this slice. Do not share the local database or discovery output as if it were public telemetry.

## Usage

```text
kimaki ops discover --herdr-session work --timeout 5000
kimaki ops bind --host host-a --endpoint codex-a --backend codex --native-session native-thread-id --tenant guild-id --surface discord-thread-id --request unique-intent-id
kimaki ops bindings --tenant guild-id
kimaki ops detach binding-id --tenant guild-id
```

Discovery supports an explicit `--binary` executable path. It never invokes a shell, opens reported session paths, scrapes terminal output or sends terminal input. Output is size-bounded and errors never echo captured child output. Inventory is a point-in-time snapshot, not a subscription. Re-run discovery to refresh it. No global process discovery or background watcher is implied.

Bindings default to service `discord`, or select `--service <kind>`. Use `--data-dir <path>` to target a specific existing Kimaki database. As with existing Kimaki CLI commands, subcommands never migrate or create the database. Normal bot startup applies the additive table. Do not launch a second bot against a running instance merely to initialize this feature. There is no standalone migration command in this slice.

The request ID is scoped by service and tenant. Retrying the same intent returns its original row, including detached state. Reusing it for a different intent fails. Each surface has at most one active association per tenant/service. Explicitly detach before rebinding, with a new request ID. The new association receives the next surface generation. Two different surfaces may observe the same runtime identity independently. Generations currently fence local associations only, not native runtime commands or service delivery.

## Explicitly not available yet

An experimental developer-only OpenCode V2 read-only boundary lives in `kimaki/src/ops/runtime/opencode.ts`. It takes an explicit resolved endpoint and registered host/endpoint identity, exposes paginated discovery, an explicitly requested snapshot and exact-session native events. Only metadata discovery is exposed through the CLI. Snapshot and observation remain developer APIs, not Discord routing. Snapshot reads may contain history and require separate operator authorization. Observation does not automatically read a snapshot, adopt a session or replay history. The implementation ledger distinguishes unit contract checks from actual native acceptance. Independent detach and unchanged native permissions/instructions passed an isolated real-service test. Public CLI native discovery also passed against that external session, with output restricted to qualified identity and title. Do not interpret the internal API's presence as supported end-to-end service attachment.

The installed native SDK subscription is endpoint-wide, without a session-scoped subscription option. Exact-session filtering happens before callback delivery inside this observer, not at the server. Only use an endpoint whose entire native stream the caller is authorized to receive. This is not a multi-tenant transport security boundary, even though local binding records are tenant-filtered.

- Qualified Jcode/Codex live observation adapters and end-to-end OpenCode service attachment.
- Automatic external-session reconciliation from herdr candidates into native registries.
- Historical replay, new transcript delivery, Discord rendering or service outboxes.
- Runtime control, leases, approvals, stop, native exclusive-writer enforcement.
- Paperclip task/run execution, policy enforcement or session enrollment.
- Herdr subscriptions, overflow recovery or Windows raw named-pipe transport.

Those features retain the design and qualification gates in the [implementation plan](superpowers/plans/2026-11-11-unified-agent-ops.md). A successful metadata association must never be presented as a running, reachable or controlled agent.

## Verification

Tests live beside the operations modules and in `kimaki/src/ops-cli.test.ts`. They exercise real SQLite constraints and the public CLI across separate processes. `db.test.ts` checks additive migration and preservation of existing thread mappings. Herdr transport tests use an isolated executable fixture, so they are contract evidence, not proof of compatibility with a live installed daemon.

The implementation ledger records actual runs, failed attempts and remaining blockers: [passive slice implementation](research/2026-11-11-passive-slice-implementation.md).
