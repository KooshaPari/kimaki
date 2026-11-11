# Native backend adapter qualification

Date: 2026-11-11 (Pacific). Research only, not an implementation or live compatibility certification.

## Outcome and evidence boundary

Use native OpenCode V2, a qualified Jcode native transport, and Codex app-server as separate runtime adapters IN. Discord remains a bridge OUT. ACP is not the current Kimaki abstraction. Herdr discovers agents started outside Kimaki, but discovery alone confers neither transcript publication nor control. Preserve the ownership boundaries in [the design](../superpowers/specs/2026-11-11-unified-agent-ops-design.md) and use the proposed filenames in [the implementation plan](../superpowers/plans/2026-11-11-unified-agent-ops.md), rather than duplicating that plan here.

Evidence grades below distinguish **observed source/help**, **documented protocol**, and **unqualified runtime behavior**. None of the adapters was exercised against a live agent. Checkout inspected: `fdbe1541d03d27c5174b3d1067f5e6f9cb9634f1`. Jcode context identifies v0.99.1 (`7206efd0c`), but installed help and bundled documentation demonstrably differ on harness availability. Do not assume that executable version proves daemon protocol support.

## Sources and reproducibility

Local sources are repository-relative and were read on the date above:

- **K1:** `AGENTS.md`, `kimaki/src/bot.ts:49-96`, `109-128`: native connection, errors, session lookup and routing identity.
- **K2:** `kimaki/src/sessions.ts:112-123`, `632-725`, `750-776`: binding, mutating adoption and resume.
- **K3:** `kimaki/src/event-loop.ts:1-15`, `240-347`: parent routing, ignored external roots, active-session snapshot hydration. Also `kimaki/src/thread-reducer.ts:404-526`, `551-576`: execution, step, text and child event cases.
- **K4:** `plans/decisions/coordinator.md`, `plans/decisions/task-mode.md`: coordinator synthetic prompts, marker-scoped warmup and lifecycle context. These features are not automatically safe for observed external sessions.
- **J1:** bundled `jcode_docs` read `docs/SERVER_ARCHITECTURE.md`, especially Lifecycle, Headless run Sessions, Session Ownership Markers and Remote Client Working Directory.
- **J2:** bundled `docs/IOS_APP.md`, Protocol: native requests and events, with client UI limitations explicitly separated from server capability.
- **J3:** bundled `docs/NATIVE_SSH.md`, Protocol and compatibility, Disconnect behavior: native bridge versus harness wire format, capability negotiation, history refresh and continuation semantics.
- **J4:** bundled `docs/MULTI_SESSION_CLIENT_ARCHITECTURE.md`: explicitly **Proposed**, not evidence that concurrent passive surfaces already ship.
- **J5:** bundled `docs/SESSION_CREATION_LATENCY.md`: harness `hello`/`create_session`, legacy-socket bridge and State-to-Attached behavior, measured on a Linux host, not this Windows installation.
- **J6:** installed help only: `jcode --help`, `jcode serve --help`. `jcode api --help` returned exit 2, unrecognized subcommand. An earlier bounded help chain also attempted `jcode harness --help`; it is not used as positive protocol evidence. No service was started.
- **C1:** official OpenAI app-server reference, fetched 2026-11-11: `https://developers.openai.com/codex/app-server/`, which redirected to `https://learn.chatgpt.com/docs/app-server`. Relevant headings: initialization, resume, read stored thread, steer, notifications and approvals.
- **C2:** official source supplement fetched the same date: `https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md`. This moving main document contains experimental additions. Pin the target release schema before implementation and do not treat main as the installed version.

Bundled Jcode references are documentation provenance, not files asserted to exist in this repository. No credentials, user session histories, runtime registries or live daemon endpoints were read.

## Exact Kimaki seams

| Existing seam | What it actually does | Adapter consequence |
| --- | --- | --- |
| `Bot.opencode`, `oc()` in K1 | Carries one `OpencodeConnection` and executes native client calls with OpenCode-specific errors | Introduce runtime-scoped routing at the planned operations boundary. A backend selector cannot turn this context into a neutral API. Keep OpenCode-specific helpers within its adapter. |
| `sessionDirectory`, `rootSession`, `threadOfSession` in K1 | Uses native session get and bare session-ID keyed store mappings | Resolve an internal session key scoped by host, endpoint and backend before routing to surfaces. Never key cross-backend identity by native ID alone. |
| `bindThread()` in K2 | Inserts `thread_sessions` with source `kimaki`, then calls event-loop bind | A passive binding needs separate authority/history policy and many observers. Existing source labels are not permission grants. |
| `adoptSession()` in K2 | Creates a thread, updates metadata and permission rules, installs instructions, reads 100 messages, deletes prior session bindings, replays history | **Never use for observe attach.** It mutates the runtime, activates marker-driven behavior and displaces prior observers. Preserve it only for explicitly authorized adoption behavior. |
| `resume()` in K2 | Gets an existing native session and checks project directory before adoption | Existing-session support exists, but is not passive attachment. Directory eligibility is not consent. |
| Unknown-session path in K3 | Walks at most eight parent links to a bound ancestor, otherwise ignores the root | Feed discovery into a registry before surface filtering. Do not automatically publish every external event or reuse ignored-root behavior as discovery. |
| `snapshots()` in K3 | Reads active sessions and bound roots, adopts known descendant chains, builds `kimaki.snapshot` | Reuse the snapshot-plus-events principle, not OpenCode-shaped data for every runtime. Snapshot refresh is not a guaranteed durable replay cursor. |
| Reducer in K3 | Consumes native execution/step/text/tool and synthetic Kimaki events | Translate through the planned projection boundary. Keep native IDs and event provenance, do not fabricate OpenCode steps or inbox events for other backends. |

Normal Kimaki-created OpenCode sessions retain current marker/instruction behavior. Observe-only sessions must not acquire that marker or coordinator/sleep warmup, prompt injection, permission replacement, model selection or lifecycle ownership merely because Discord is bound. Detach removes only the surface association and delivery subscription. [K1-K4]

## Capability qualification

Capabilities must be endpoint/version-specific and independently declare discovery, historical read, live observation, creation, submit, steer, queue, interrupt, approvals and replay. Unknown is not supported.

| Capability | OpenCode V2 in this checkout | Jcode native evidence | Codex app-server evidence |
| --- | --- | --- | --- |
| Inventory/history | Native session get/list and message list, with paginated lists documented in AGENTS | Server owns many sessions. History is a native request. Ownership markers are not a list of generating agents [J1-J2] | `thread/list`, `thread/read`, paginated turns [C1] |
| Live events | Shared `/api/event` consumed by event loop. Unbound external roots currently filtered [K3] | Native subscription and event stream documented [J2-J3]. Safe passive attachment still unqualified | Notifications on the connected app-server transport [C1] |
| Existing session | Current resume calls mutating adoption [K2] | Native resume/attach documented, but owner conflict and subscription side effects need qualification [J1-J4] | `thread/resume` loads/subscribes, unlike historical `thread/read` [C1] |
| Create/control | Native session create/prompt/interrupt, not ACP [AGENTS, K1-K2] | Native message/cancel/soft_interrupt documented. Harness create documented but local CLI entrypoint absent [J2,J5-J6] | `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt` [C1] |
| Queue equivalence | Native inbox/queue is OpenCode-specific [AGENTS,K3] | Do not equate soft interrupt with OpenCode durable queue [J2-J3] | Do not infer OpenCode queue semantics from steer [C1] |
| Reconnect | Current active-state hydration, no proof here of complete missed-event replay [K3] | Native SSH explicitly has no event-cursor replay, refreshes history [J3] | Require target-version gap recovery qualification, not assumed replay |
| Exclusive writer | No native-UI fencing established | Single-controller proposal and takeover checks are not a proven observer lease [J4] | No native-UI fencing established |

The Codex entries summarize C1's documented API, not proof of attaching to an arbitrary independent CLI process. In particular, reading stored history and resuming it through another server do not establish access to the original live execution.

## Native event mapping

These are proposed normalized projection categories, not new protocol names. Preserve backend-native session, turn, tool and request IDs where supplied. Retain unknown event types as non-rendered diagnostic metadata subject to redaction, rather than guessing state transitions.

| Projection | OpenCode source | Jcode native source | Codex source |
| --- | --- | --- | --- |
| Session/snapshot | `session.get`, `session.active`, synthetic `kimaki.snapshot` [K3] | `session`, `state`, `history` [J2] | `thread/started`, `thread/status/changed`, read responses [C1] |
| Assistant output | `session.text.ended` confirmed in reducer [K3] | `text_delta`, `text_replace`, `message_end` [J2] | `item/agentMessage/delta`, item completion [C1] |
| Tool progress/result | `session.tool.*` [K3] | `tool_start`, `tool_input`, `tool_exec`, `tool_done` [J2] | `item/started`, `item/completed`, typed progress [C1] |
| Turn terminal state | `session.execution.succeeded/failed/interrupted` [K3] | `done`, `error`, `interrupted`, interpreted with state [J2] | `turn/completed` status [C1] |
| Usage | `session.step.ended` [K3] | `tokens` [J2] | Qualify target schema before enabling usage export |
| Human decision | Native forms/permissions snapshot [K3] | Approval transport not established by mobile consumer list. Require wire qualification | Server approval requests, correlated by request ID [C2] |

Do not expose reasoning deltas just because Jcode streams them. A transport error or disconnect is not a completed/failed agent turn. Do not invent turn boundaries from Jcode `message_end` alone. These are projection safety requirements, pending fixture-backed interpretation of the full wire schema.

## Live external attach versus historical resume

### OpenCode

The service is shared with the user's TUI, not owned by the Discord bot [AGENTS]. This makes native service observation the strongest existing seam. However, passive attachment is a **new application path**, not a rename of `resume()`. Hydrate and route only after binding consent, with no session update or instruction entry writes. Distinguish reading a snapshot for reconciliation from publishing old messages to Discord. Default publication starts at the binding boundary. [K1-K3]

### Jcode

Persistent native daemon attachment and historical session recovery are related but not interchangeable. `jcode run` normally hosts an in-process agent without a listening server. Herdr may discover that process, but a daemon socket elsewhere is not proof it can observe that run. Several sessions can share the daemon PID, and stale ownership markers do not prove liveness. [J1]

The native client protocol documents Subscribe and ResumeSession, while the harness API is a different wire protocol. Bundled docs describe `jcode api --stdio`, but the installed executable rejects `api`. Do not install, update or start another daemon to hide that mismatch. Treat harness availability on this host as **blocked pending version/platform qualification**. [J2-J3,J5-J6]

Subscription can transmit cwd and capabilities, and user-response capability changes can affect tool registration (bundled `docs/user-response.md`, search result). Therefore even a connection that sends no prompt is not yet proven semantically read-only. Qualify a passive attach that preserves cwd, model, tool catalog, owner and disconnect behavior. Native SSH documents opt-in continuation on disconnect and no cursor replay. It is Unix-client documentation, not proof of Windows bridge support. [J1,J3]

### Codex

C1 distinguishes stored reads from resume/subscription. A new app-server loading a saved thread is not evidence that it joins an independent TUI's currently running turn. Qualification must identify the actual hosting endpoint and demonstrate that native-UI output is observable there without a duplicate execution, config override or takeover. Until then, externally discovered Codex sessions stay presence-only or explicitly historical-readable, not live-attached. This is an inference from the documented distinction, not an upstream promise of universal attach. [C1]

## Authority and acceptance gates

Herdr contributes `(host, pane, process incarnation, cwd, optional native ID, evidence time)`. It does not assign transcript identity from cwd alone, publish transcripts, claim Paperclip ownership, or grant a control lease. Unresolved observations remain presence-only. Binding mode, publication policy and generation belong to the registry, not native prompt metadata. These are requirements from the design, not assertions about an implemented herdr protocol.

An SDK control lease gates SDK-originated commands only. It cannot fence a native UI unless the runtime validates the same authority at its mutation boundary. If native contention cannot be safely excluded, refuse exclusive-control claims and disable mutations. Approval responses are mutations too. Acknowledged command acceptance is separate from turn completion, and ambiguous transport failures require reconciliation instead of blind prompt retries.

Before enabling each adapter, isolated contract tests must establish:

1. External native-UI output reaches an authorized observe binding while the native UI remains connected. Assert no prompt, metadata, permission, instruction, cwd or tool-catalog changes.
2. Detach/disconnect neither interrupts the run nor owns daemon shutdown. Verify native-UI continuation and multiple observers separately.
3. Historical read, live attach and resume are distinct capabilities. Reject unknown endpoint/native-ID mappings and in-process runs without a safe API.
4. Reconnect resynchronizes from native truth without replaying historical output as new. Explicitly report gaps when no durable cursor exists.
5. Duplicate/late events and old binding generations never cross surfaces or tenants. Preserve native approval IDs and reject stale responses.
6. Native UI contention cannot bypass a claimed exclusive-control guarantee. Otherwise label enforcement `sdk-only` and fail closed for unsafe control.

## Validation performed

Only this markdown deliverable was written. Read spec, plan, decisions and bounded native sources, queried bundled Jcode documentation, and ran help-only CLI commands. Official OpenAI web sources were consulted. No code, build, installation, daemon operation, session takeover, credential read or commit was performed. C: free space was below 500,000,000,000 bytes and E: was verified as Data, so the sole output stays in the existing E: checkout. Reference existence and final diff checks are recorded in the completion report, not a claim of runtime acceptance.
