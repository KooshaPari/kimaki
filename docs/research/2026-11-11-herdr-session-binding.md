# herdr discovery and dynamic session binding

Date: 2026-11-11 (Pacific). Status: bounded source research and proposed contract, not an implemented integration.

## Scope and decision

Catch externally started agents through **both herdr observations and native runtime registries**. Bind an explicitly selected native session to one or more service surfaces without launching, adopting, resuming, terminating, or rewriting it merely to observe it. herdr remains authoritative for its terminal observations, the runtime for session and transcript truth, and the future SDK for binding policy, identity reconciliation and command receipts.

This follows `docs/superpowers/specs/2026-11-11-unified-agent-ops-design.md`. The coordinator and task-mode decisions in `plans/decisions/` describe Kimaki-owned conversations, not permission to inject their roles, warmup or completion notifications into arbitrary external sessions.

Research used GitHub primary files fetched with `gh api ... -H "Accept: application/vnd.github.raw+json"`, pinned to `KooshaPari/herdr` master commit `08f0d168c92b6eea8a3688edc0714cd40b34dea8`. No running herdr, private registry contents, transcript, screen, credentials or secrets were read. No runtime attachment was tested. Installed protocol compatibility remains unverified.

## Primary evidence

All herdr paths below are relative to that exact commit, not floating master:

| ID | Primary file | Evidence used |
| --- | --- | --- |
| H1 | `src/api/schema/agents.rs` | `AgentInfo`, `AgentSessionInfo`, list/get target and prompt parameter shapes |
| H2 | `src/app/api/agents.rs` | `handle_agent_list`, `handle_agent_get`, `validate_agent_prompt`, `submit_agent_prompt`, deferred submission completion |
| H3 | `src/api/server/subscription_socket_tests.rs` | Acknowledgement, history overflow, isolated slow-client closure and Windows partial-line reader |
| H4 | `src/cli/agent.rs` | Actual list/get wrappers, terminal attach, prompt/wait and Windows foreground limitation |
| H5 | `docs/next/website/src/content/docs/socket-api.mdx` | NDJSON transport, endpoint selection, bootstrap/recovery and reported session references |
| H6 | `src/ipc.rs` | Unix filesystem socket versus Windows namespaced pipe conversion, marker and polling |
| H7 | `src/agent_resume.rs` | `AgentSessionRefKind` has `id` and `path`, not only an ID |

Reproducible retrieval example, substituting any path from the table:

```text
gh api repos/KooshaPari/herdr/contents/src/api/schema/agents.rs?ref=08f0d168c92b6eea8a3688edc0714cd40b34dea8 -H "Accept: application/vnd.github.raw+json"
```

Local evidence: `kimaki/src/schema.ts` (`thread_sessions`), `kimaki/src/sessions.ts` (`adoptSession`, `resume`), and `kimaki/src/event-loop.ts` (unbound session routing). Source inspection is not evidence that a local service is running.

## Actual discovery APIs and transports

### Inventory is available, but not a machine-wide process registry

H2 implements `agent.list` by returning `collect_agent_infos()` as `result.type = agent_list`, with `result.agents`. `agent.get` accepts `{ "target": "w1:p1" }`, reconciles the managed target and returns `result.type = agent_info`, with `result.agent`. H4 exposes these as `herdr agent list` and `herdr agent get <target>` with no `--json` flag in those two parsers. Do not invent an HTTP `/agents` endpoint or an `agent.subscribe` method.

Illustrative wire requests, not executed here:

```json
{"id":"inventory-1","method":"agent.list","params":{}}
{"id":"inspect-1","method":"agent.get","params":{"target":"w1:p1"}}
```

H1's `AgentInfo` includes `terminal_id`, optional `agent`, `agent_status`, `workspace_id`, `tab_id`, `pane_id`, `revision`, `state_change_seq`, optional `cwd`, optional `foreground_cwd`, and optional `agent_session: { source, agent, kind, value }`. It also includes presentation fields, readiness flags and optional `completion_seq`. Missing optional fields are normal. In particular, the status field is `agent_status`, not `status`.

H5 distinguishes `cwd` (pane/workspace location) from `foreground_cwd` (when resolvable, the current PTY-controlling process location). Neither is a native session key. Cross-workspace pane moves retain the terminal but change the public pane ID. Names, titles, display labels and cwd are hints only. Do not equate `revision`, `state_change_seq`, or `completion_seq` with a native transcript cursor or globally durable event ID.

herdr inventory covers its known panes. Agents launched in another terminal, service, host or WSL environment need the corresponding explicitly configured native registry. Merge observations, do not require herdr to have started the agent and do not claim every OS process is discoverable.

### Endpoint selection and Windows

H5 specifies newline-delimited JSON over a Unix domain socket on Unix and a named pipe on Windows, not TCP, HTTP, WebSocket or an ordinary readable `.sock` file. Documented logical defaults are `~/.config/herdr/herdr.sock` and `~/.config/herdr/sessions/<name>/herdr.sock`. Resolve in this order: explicit CLI `--session <name>`, `HERDR_SOCKET_PATH`, `HERDR_SESSION`, default session. Resolve config roots on the target host instead of hardcoding a Windows expansion of `~`.

H6 converts the logical path through `to_ns_name::<GenericNamespaced>()` on Windows and writes a marker file at the path when binding. A marker's presence is not proof of liveness. A raw TypeScript client must validate the interprocess-compatible named-pipe mapping against the installed build, rather than passing the marker path to a Unix socket API or guessing a pipe literal. Prefer bounded CLI list/get calls for the first portable inventory slice. H5 recommends `HERDR_BIN_PATH` for plugin invocations. Do not assume that variable exists outside a herdr-managed environment.

H3 notes that LocalStream receive timeouts are unsupported on Windows and retains partial JSON lines with bounded nonblocking/`PeekNamedPipe` reads. Future clients need explicit deadlines, cancellation, bounded buffers, fragmented-line support and a distinction between idle and EOF. H4 also says Windows has no foreground process group, so its Unix shell-initialization retry cannot be inferred there. Windows process-tree/cwd evidence may be incomplete. Treat Windows and WSL as separate endpoint/host scopes unless a verified mapping exists.

A subscription is a long-lived **separate connection**. A one-shot CLI process is not a durable subscription. Native registry transport and live-attach capabilities must be verified per runtime/version. This research does not certify a Jcode daemon transport, Codex app-server takeover, or a Windows native adapter.

### Bootstrap and recovery

H5's actual streaming API is `events.subscribe`; `events.wait` is a bounded wait alternative. `session.snapshot` is a one-time bootstrap response, also exposed by `herdr api snapshot`. Subscribe to metadata/lifecycle changes such as `pane.created`, `pane.updated`, `pane.moved`, `pane.closed`, `pane.exited` and `pane.agent_detected`. A targeted status subscription has this documented shape:

```json
{"id":"watch-1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.agent_status_changed","pane_id":"w1:p1","agent_status":"blocked"}]}}
```

Wait for `result.type = subscription_started`. Invalid referenced panes reject the whole subscription and close it. Lifecycle subscriptions do not replay pre-acceptance history. Do not use `pane.output_matched` for discovery: it involves terminal-output matching rather than metadata-only presence.

Subscribe first, continuously drain events, then request an authoritative snapshot on another connection. Replace the cache with current reads and use incoming events as invalidations. Serialize refreshes and refresh again if an event arrives during a read. Do not apply buffered old event payloads unconditionally over the newer snapshot.

H3 tests bursts and shared-history overflow: a lagging subscriber receives the original request ID with `error.code = events_lost`, then its connection closes without disconnecting healthy clients. H5 requires a new subscription, acknowledgement and snapshot reconciliation. Recovery restores current state, not missing history. Repeat for another gap. A restart invalidates presence freshness and control, even if logical session identity is later recovered.

## Native identity reconciliation without transcript reads

Proposed keys and procedure, not existing herdr or Kimaki records:

1. Scope observation identity by host, herdr endpoint and server incarnation, then `terminal_id`. Keep pane/workspace/tab as mutable aliases. A terminal is not a native session, and PID reuse is never identity proof.
2. Read `agent_session` when provided. H5 exposes this read-only object from agent and pane get/list. H7 supports `kind = id` and `kind = path`. Preserve reporter `source`, agent kind, reference kind and provenance. A reported path is data, not permission to open a file or execute resume arguments.
3. Consult only an allowlisted native registry's metadata API under separate authorization. Resolve a candidate to `(hostId, runtimeEndpointId, backendKind, nativeSessionId)`. Confirm backend agreement, endpoint ownership, allowed project scope and current live association. Do not merge same-ID strings from different endpoints or hosts.
4. For `kind = path`, ask the runtime's approved metadata resolver to map the reference without scraping transcript contents. Reject path escape, unauthorized share/host, or unresolved aliases. If the runtime has no metadata-only resolver, retain provisional presence rather than opening the transcript.
5. If `agent_session` is absent, use metadata-only registry candidates and corroborating evidence. Same cwd/title, most recent activity, or a matching agent label is insufficient for automatic binding. Multiple candidates become `ambiguous`; absent candidates remain `presence-only`. Ask for explicit selection or an already authorized integration report, not terminal scraping.
6. Poll configured native registries independently to catch agents outside herdr. Deduplicate herdr and native observations only after verified native identity resolution. A saved/resumable session is not proof of a currently controllable process. Never launch a replacement to make it attachable.

`pane.report_agent_session` can report identity independently of lifecycle state. Discovery must not call `pane.report_agent`, clear authority, install hooks or write `resume_argv` just to manufacture evidence. Native control and observation capability probes must remain read-only until explicitly authorized.

## Safe binding state machine

Maintain presence, observation and control as related but separate records. Proposed transitions:

| State/transition | Required guard and effect |
| --- | --- |
| `unseen -> discovered` | Allowed host/project inventory, metadata only, private inventory by default |
| `discovered -> resolved` | Unique verified native key with fresh evidence; ambiguity stays explicit |
| `resolved -> observed` | Actor and tenant authorization plus native read/subscription capability; create binding generation and start cursor |
| `observed -> control-requested` | Explicit request, current identity and native mutation capability; discovery is not consent |
| `control-requested -> controlled` | Fresh lease/epoch, backend policy and disclosed native exclusivity level; deny if required exclusivity is unavailable |
| `controlled -> observed` | Release, expiry, contention or reconnect revokes mutation authority without stopping the process |
| `* -> stale/unreachable/ambiguous` | Gap, endpoint failure, replaced occupant or conflicting identity suspends writes; reconcile metadata |
| `observed/controlled -> detached` | Retire delivery and authority locally, never kill, interrupt, resume or rewrite the external session |

Allow multiple observe bindings. Default history policy is new native events after bind, not historical replay. Consent to inventory is not consent to publish title/path details or transcript text to Discord. Historical replay requires a separate previewed scope and tenant policy. Native events remain transcript truth; projections and per-binding delivery cursors are not a second transcript authority.

An SDK-only lease fences SDK commands, not simultaneous typing in the native TUI. Require backend-enforced control where exclusive mutation is necessary. Re-check actor, binding generation, native session identity and lease epoch for every mutation, including buttons. On timeout after dispatch, mark the receipt `uncertain` and reconcile, never blindly resend. A move installs the new binding generation/cursor before retiring the previous target. Late deliveries for retired generations must not publish. Presence disappearance does not by itself prove a native session ended.

## Terminal control is not native session control

H4's `herdr agent attach <target> [--takeover]` resolves `terminal_id` and calls `run_terminal_attach`. It attaches a terminal client, not a runtime transcript API. Do not invoke it during discovery or silently take over the user's terminal.

H2's `agent.prompt` validates a nonempty prompt, target, unblocked state, recognized agent, no pending managed launch and a runtime still hosting the expected foreground agent. It encodes text and Enter as terminal input and queues submission with a 300 ms delay. On Windows, Codex gets an added right-arrow key as a paste boundary because its input reader can otherwise treat Enter as a newline. Copilot also has focus-input handling. These are concrete reasons not to emulate prompts with generic paste plus Enter.

Deferred success acknowledges PTY submission completion, not a native inbox item, model acceptance, exactly-once execution, or a completed assistant turn. Optional `wait: { until, timeout_ms }` couples prompt and semantic wait to avoid a separate-call race. H5 says agent waits pin the resolved occupant and observe semantic state, not arbitrary command completion. Status detection is not native turn truth.

Terminal prompting is disabled by default for external bindings. If separately approved, expose it as degraded terminal input with explicit target/occupant checks, contention warning and uncertain-outcome receipts. It cannot approve runtime permissions by sending keys automatically. No fallback from a failed native API to terminal injection, no automatic retry on ambiguous submission, and no terminal-output publication as a substitute for native event access.

## Kimaki seam and bounded implementation direction

`schema.ts` retains `source: kimaki | external_poll` on `thread_sessions`, whose primary key is the surface `thread_id`. That enum is not proof of a working passive herdr collector or multi-observer router. `sessions.ts:adoptSession` currently creates a thread, writes `metadata.kimaki`, modifies permission rules, installs instruction entries, fetches up to 100 messages, deletes previous bindings for the same session and replays history. `resume` calls it after project validation. This is mutating adoption, not safe observation. `event-loop.ts` routes unknown sessions through bound parents and drops unrelated TUI sessions.

The first approved slice should add metadata-only discovery and identity contracts separately from adoption. A later observe path needs runtime-scoped identity, multi-surface routing, explicit publication policy and no marker, permissions or instruction writes. Preserve current Kimaki-owned behavior, but do not route external observe through `adoptSession`, automatic coordinator roles/warmup, or an implicit prompt. Any schema work must be additive and independently reviewed. No implementation or migration is authorized by this document.

## Bounded acceptance tests for a future slice

Use synthetic metadata and fake endpoints, no private sessions, credentials or transcript fixtures. These are proposed tests, not tests run for this research.

| Test | Observable acceptance |
| --- | --- |
| External start, inside/outside herdr | herdr plus independent native registry yields private inventory; zero launch/stop/write calls |
| Missing reference and cwd collision | Two sessions in one cwd remain ambiguous; no attach or transcript read |
| Endpoint collision and path reference | Equal ID across hosts stays distinct; path is resolved only by approved metadata resolver; unsafe path denied |
| Pane move/replacement | Move preserves verified session association; reused pane with changed terminal/native identity revokes control |
| Subscribe/snapshot race | Event during refresh schedules another read; stale payload cannot overwrite current inventory |
| Windows framing and liveness | Fragmented NDJSON, idle pipe, marker without server, EOF and deadline produce bounded, distinct outcomes |
| Overflow/reconnect | `events_lost` revokes freshness, resubscribes and reconciles; no invented recovered history or auto-restored lease |
| Observe and multi-observe | Two authorized surfaces receive only post-bind native events; zero metadata/permission/instruction mutation or old-binding deletion |
| Unauthorized actor and native contention | Control denied despite visible presence; SDK-only lease never claims native TUI fencing |
| Uncertain submission | Timeout after send creates uncertain receipt, no duplicate prompt or terminal fallback |
| Move/detach | Old generation stops delivery; detach never terminates, interrupts, resumes or changes external process |
| Terminal degradation | Blocked/replaced occupant denied; PTY acknowledgement is never labeled native turn completion |

Before claiming a usable Windows integration, run one consented installed-version transport/metadata canary and one native adapter observation canary. Live controls require separate opt-in. Remaining unknowns are installed herdr compatibility, exact client pipe-name interoperability, metadata-only Jcode/Codex registry contracts and native concurrent-control enforcement. None blocks this documentation deliverable, and none is represented as verified runtime support.

## Validation and storage boundary

Only this research file is authored by this task. No code, install, build, commit, legacy change or live service call is required. Validate with `git status --short`, a path-limited diff/no-index diff for this initially untracked file, and `git diff --check -- <path>` plus a whitespace check for the new file.

Storage preflight found C: at 465,606,914,048 free bytes, below the 500,000,000,000-byte threshold. E: is the verified `Data` volume with 3,549,573,840,896 free bytes. All output remains in the existing E: checkout. The supplied design already records an initiated migration inventory and active-writer coordination blocker. This bounded document-only task does not relocate or delete concurrent work and does not claim that full migration is complete.
