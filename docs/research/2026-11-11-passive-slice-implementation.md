# Passive session binding implementation ledger

Plan: `docs/superpowers/plans/2026-11-11-unified-agent-ops.md`
Approval: user said `go` on November 11, 2026 after the proposed first passive discovery/bind/detach slice.
Base: `9c6bf0a6`. Branch: `feat/passive-session-bindings`.

## Scope rulings

- Implement identity contracts, bounded portable herdr metadata inventory, durable metadata-only observe associations and local CLI interfaces first. Native transport qualification remains unresolved, so no runtime transcript observation, Discord publication, control, session resume or terminal injection is enabled. A metadata association must never be advertised as live attachment.
- Task 1 provides identity used by Task 3. Task 2's live OpenCode adapter and Task 3's service event delivery cannot be represented as qualified merely by storing bindings. Preserve existing OpenCode code unchanged in this slice. Costs: real transcript streaming remains a subsequent slice, explicitly blocked pending transport qualification and service delivery policy.
- Persist bindings additively in existing Kimaki SQLite. Existing CLI rule remains: only bot startup migrates, CLI never creates a database or migrates it. Tests initialize isolated databases through the existing public migration interface.
- Native session keys are explicitly supplied to metadata bindings, not inferred from herdr pane/cwd/path. Herdr references remain candidate evidence. All publication policies are `none` until safe observation and delivery exist.
- No frozen legacy repository modifications or executions, no personal browser, no live bot restart, no credentials or production-state reads, and no public push.

## Preflight

C: free 479,103,152,128 bytes, below threshold. E: verified Data, new work and package-manager caches on E. Existing migration activity remains separately coordinated, no relocation attempted here.
Root pnpm shim is broken (missing corepack module). Recover using pinned pnpm 9.15.9 via npm exec with cache/store on E. Dependency scripts disabled for initial installation. Required errore submodule initialized at existing gitlink, no pointer change.
Required changesets skill unavailable from skill registry, so read `.changeset/readme.md` and follow its package/release-note rules.

## Work

- Registry implementation delegated with sole ownership of contracts/registry/tests.
- Herdr inventory implementation delegated with sole ownership of discovery/herdr/tests.
- Coordinator owns additive schema, durable bindings/tests, CLI and acceptance workflow.
- Binding tests written first against real libSQL persistence and existing openDb interface. Verification results follow below.

## Observed validation

All runs used isolated state on E:, not production Discord, user runtime sessions or the default Kimaki database.

| Boundary | Actual check | Observed result |
| --- | --- | --- |
| Red before implementation | Production CLI and binding tests before operations modules existed | Failed on missing command/module and missing additive table, alongside Windows cleanup failures |
| Identity and discovery contracts | Project Vitest, registry and herdr suites | 15 identity and 27 discovery tests passed. Discovery child uses a fixture, not a live daemon |
| Durable bindings and public source CLI | Project Vitest, `bindings.test.ts` and `ops-cli.test.ts`, real libSQL and separate CLI processes | 7 binding and 3 CLI tests passed, including retries, tenant isolation, concurrent duplicates, rebind generations, repeated detach and refusing missing DB creation |
| Combined focused run | Actual project test script, four operations files, one worker | 52/52 passed, 4/4 files, 86.38 seconds |
| Additive migration | Actual `openDb` startup/subcommand interfaces, fresh DB and old-shaped DB preserving thread mapping | 2/2 selected tests passed, 5 unrelated tests not selected, 16.75 seconds |
| Generated schema | Actual project `generate` command | Passed after replacing Windows-incompatible `pnpm` executable spawning with Node launching installed Drizzle CLI. Generated schema adds only the operations table and indexes |
| Production build | Actual package `pnpm run build` via pinned pnpm JS entrypoint | Passed twice after generating required Discord-twin Prisma client. No lockfile or submodule pointer changes |
| Compiled product CLI | `node dist/cli.js`, real existing isolated DB initialized with compiled `openDb` | Bind, retry, list, detach and repeat detach all passed, exit 0. Publication stayed `none`. Native identity was explicitly unverified. Initial driver import needed a Windows file URL correction |
| Native Codex protocol | Installed 0.167.1 app-server, fresh empty home, real stdio | Initialize and empty thread/list passed. Repeat confirmed child exit 0, no stderr and zero model calls |
| Broader regression suite | Actual entire project test script | Not green. Many E2E setups initially failed because ignore-scripts installation left the 229-byte OpenCode launcher unresolved. Other observed failures include Windows CRLF worktree assertions and legacy DB file handling. Stopped only this owned test run after about 7.5 minutes to repair prerequisite rather than repeat invalid setups |
| Existing native E2E after repair | Ran reviewed pinned OpenCode postinstall, verified version, then actual `cli-read.e2e.test.ts` using isolated OpenCode and Discord twin | Setup advanced into both tests, but both timed out at 30 seconds. 0/2 passed, 96.81 seconds overall. Native/Discord regression compatibility remains unverified, not silently waived |

Windows libSQL native statements retained file handles after close until finalization. A minimal real-client reproduction confirmed exposed GC releases the handle. Test forks now expose GC on Windows and affected cleanup waits for finalizers before removing isolated files. Initial failures and retries are retained in scratch logs. An inline snapshot update targeted the wrong snapshot during the migration run. Review caught it, restored the legacy expected values as an explicit equality assertion, and updated only the fresh-install table list. No legacy assertion was removed to obtain a pass.

Logs and acceptance drivers are under `E:\koosh\Agents\kimaki-research-20261111`: `passive-red.log`, `passive-green.log`, `passive-final-targeted.log`, `passive-final-migration.log`, `passive-final-build.log`, `passive-full-suite.log`, `passive-native-e2e.log`, `built-ops-canary.mjs` and `codex-node-canary.mjs`. The compiled CLI acceptance used `built-ops-nn1AZr`. Logs are local evidence, not release artifacts.

## Review and remaining gates

Coordinator reviewed identity serialization, metadata allowlist, child timeout/output budgets, sanitized failures, SQL uniqueness/generation allocation, lazy CLI registration, additive schema and migration assertions. CodeRabbit is unavailable on this host, so no external automated review is claimed. No bot/session event-loop code was changed. Documentation and minor changeset describe metadata associations only.

The bounded outcome is better than the research checkpoint: operators now have an actual compiled local bind/list/detach workflow with persistent, isolated records and no runtime lifecycle dependency. This is not the overall requested product. Remaining gates are live herdr daemon qualification, Jcode native entrypoint mismatch, independent native-session attachment, post-bind streaming and replay policy, authorized Discord publication, Paperclip execution, and legacy consolidation parity. End-to-end runtime/service acceptance and the full regression suite are not green. No live rollout, legacy data migration, bot restart or public push occurred.

## Continuation and timeout diagnosis

The user requested continued work after this foundation. Plan status and goal assessments were corrected: the overall product remains incomplete, not a closed feedback loop. A read-only OpenCode observer is the next implementation lane, before modifying bot routing or service publication.

An actual single-test retry with a 120-second test deadline failed in the existing explicit 60-second setup hook, before the selected test ran. Vitest measured 80.59 seconds collecting modules and 20.56 seconds transforming them. No timeout change was committed. An instrumented driver using the same real project harness then measured approximately 84 seconds importing modules, followed by the isolated Discord twin becoming ready. The native service failed registration within its existing 60-second deadline. Its isolated log recorded `cli starting` about 53 seconds after launch, leaving only about 7 seconds for service startup. The pinned executable's actual `serve --help` also took approximately 36 seconds but succeeded and exposed the expected flags. A subsequent process snapshot found no remaining OpenCode process. These observations establish severe cold-start latency as a contributor, not a proven API defect or a passing native acceptance result. Logs: `native-timeout-diagnostics.log` and task `044038h3jp`; driver `native-boundary-driver.mjs`.

Installed `jcode --help` and `jcode acp --help` also confirm an ACP adapter command exists despite the absent `api` subcommand. Only help was invoked. No ACP daemon startup, session load or subscription was attempted, so the missing harness entrypoint must not be generalized into a claim that Jcode has no integration surface.

## Read-only native observer continuation

The next additive slice implements an explicit OpenCode V2 observer without changing bot routing. Native discovery, separately authorized history snapshots and exact-session callback delivery preserve native provenance. Detach cancels only its subscription. Runtime mutation, replay and native-exclusive control remain unsupported. The native subscription is endpoint-wide before local filtering, so callers must be authorized for the entire endpoint stream.

`ops discover --source opencode` now requires explicit service-file, host and endpoint flags. Resolution uses `ensure: false`, never starting or adopting a service. CLI output allowlists qualified identity and title only. Two new public CLI tests failed before implementation and then passed. The full CLI run was not green: 2/5 passed, while three existing workflows exceeded their 20-second child startup deadline with null exit codes. Log: `native-discovery-cli-green.log`.

Actual isolated native acceptance passed 1/1 in `native-public-cli-acceptance.log`, task `21102066p8` exit 0. The test creates a session directly through the native SDK outside Kimaki, discovers it through the public CLI, verifies the exact output allowlist, reads empty history, observes native lifecycle events from two subscribers, detaches independently and confirms the session remains readable with unchanged metadata, permissions and instructions. The actual model endpoint received zero requests. Collection took 59.21 seconds and tests 33.88 seconds. This qualifies this bounded OpenCode path, not Discord publication or other backends.

Coordinator review found asynchronous callback rejection and malformed-event cleanup gaps. Nine regression cases reproduced the failures, then the corrected suite passed 23/23 with no unhandled errors. Async callbacks are serialized with cancellation-aware waiting and late rejection handling. Unexpected event-loop failures flow through shared cleanup. Logs: `observer-callback-red.log`, `observer-callback-green.log`, `observer-callback-build.log`. The worker's sequential unit/build task `263387edp1` exited 0. Final consolidated production build and both observer suites passed after the fixes: task `395998t332` exit 0, 24/24 tests across two files, including the real native/public CLI workflow. Logs: `observer-integrated-build.log` and `observer-integrated-acceptance.log`. No public push, real bot changes or WSL/VHD operations occurred.
