# Existing projects: bounded consolidation inventory

Date: 2026-11-11 (Pacific). Research only, not migration approval.

## Scope and evidence standard

Read alongside `docs/superpowers/specs/2026-11-11-unified-agent-ops-design.md`. Desired topology: agent runtimes **IN**, Discord and other service bridges **OUT**, Paperclip as a separate control plane, and herdr as discovery/pane observation with non-owning dynamic bindings. Federation is the default. Do not infer that an HTTP wrapper, persona name, or terminal pane proves native session attachment.

This was a bounded, read-only source audit. No builds, installs, legacy writes, bot actions, data reads, credential files, commits, or relocation were performed. Directory names were listed, but `.env`, `.env.example`, credential stores, and production state were not opened. Tests named below are future gates, not passing results from this audit.

Storage preflight: C: free bytes were 465,564,807,168, below 500,000,000,000. E: was verified as Data with 3,555,115,446,272 free bytes. All new output is this document on E:. Other Robocopy activity was reported by the coordinating task, not inspected or interrupted here. Sparse legacy directories may reflect ongoing relocation, but that is not established by this audit. Do not repair, recopy, or remove them without coordinating owners.

### Local evidence ledger

Paths below are relative to these exact roots. Source observations refer to the files read, not assertions that every feature works in production.

| ID | Root and revision/status | Evidence actually inspected |
| --- | --- | --- |
| P | `C:\Users\koosh\PhenoBot`, HEAD `4a9cdb4` (2026-10-16), untracked `.data/` and `.worktrees/` | `README.md`, `package.json`, `LICENSE`, `src/bridges/bindings.ts`, `runtime.ts`, `inbox.ts`, `src/pm/interfaces.ts`, `src/utils/idempotency.ts`; tracked source path inventory |
| A | `C:\Users\koosh\AgCord\agcord-project`, not a Git checkout at inspected root or backend/web subdirectories | `agcord-backend/app.py` opening section, `requirements.txt`, `agcord-web/go.mod`, `main.go`; handler/service/model path inventory |
| S | `C:\Users\koosh\Dev\substrate`, not a Git checkout | Root listing contained `.pytest_cache/` and `driver-mcp/`; latter contained only `.pytest_cache/`. No README, manifest or implementation available at these inspected levels |
| G | `C:\Users\koosh\Dev\agentapi-plusplus`, HEAD `5170818` (2026-06-30), `git status --short` empty | `README.md`, `LICENSE`, `go.mod`, opening `cmd/server/server.go`; endpoint/auth matches in `lib/httpapi/server.go`, `handlers.go`; tracked path inventory |
| D | `C:\Users\koosh\Dev\dispatch-mcp`, not a Git checkout | Root contained only `.pytest_cache/`; no README, manifest or implementation available |

An empty short status means no reported working-tree changes, not a health check. Failed Git status for A/S/D means status is unknown, not clean. No alternate moved checkout was located or assumed. P's untracked data/worktrees were not traversed.

## Capability and preservation matrix

| Project | Evidence-backed capabilities | Boundary and reuse direction | Unique behavior to preserve or verify |
| --- | --- | --- | --- |
| PhenoBot (P) | README describes Discord forum-to-GitHub issue/comment creation, labels, locking, closure/deletion and slash workflows. Manifest includes Discord, Octokit, Prisma, SQLite, Redis, calendar/Jira/NATS dependencies. Source implements scoped persona binding, opt-in bridge runtime and disk receipts | OUT service bridge, not the runtime registry. Federate issue/PM/calendar workflows first. Extract small contracts only after license/governance approval | Thread/channel/role precedence, last-good binding reload, persona enrollment, trusted-webhook handling, durable receipt replay and independent expiry. Preserve forum/issue IDs and pending receipts without copying secrets |
| AgCord (A) | Flask/Socket.IO demo data for servers, channels, agents and voice presence. Go mux exposes server/channel/messages/agents APIs, websocket endpoint and explicitly starts simulation | Optional UI/OUT client prototype. Do not make it runtime or task truth. Reuse interaction concepts before code | Dashboard/server/channel navigation, agent status presentation and voice-room concept. Real runtime execution, voice media transport, persistence and auth are not demonstrated by inspected sections |
| Substrate (S) | No local implementation available at requested path. G README says `crates/engine-agentapi` is the fold destination | Candidate routing/runtime engine federation, not a second SDK scheduler. Adapter contract review blocked on actual checkout | Preserve provider routing, budgets and engine behavior only after source audit. A directory name and another project's migration notice do not prove current API compatibility |
| AgentAPI++ (G) | Go/Cobra PTY-oriented server with eleven named CLI families plus custom type; README describes message/status HTTP and SSE. Source registers status, messages, message submission and upload | Optional runtime IN adapter for an explicitly managed gateway. Prefer native runtime APIs where available. Do not equate PTY control with passive external attach | Terminal-backed CLI compatibility, message parsing and SSE. Native tool/approval semantics, resumability and externally started CLI discovery remain unproven |
| dispatch-mcp (D) | No implementation available at requested path | Defer reuse. Do not add an MCP dispatch layer on the strength of its name | Tool names, schemas, cancellation, session affinity, retries, routing and auth all require source evidence |
| Kimaki host | Design checkpoint identifies native OpenCode coupling in `bot.ts`, `sessions.ts`, `prompt.ts`, `event-loop.ts`, `thread-reducer.ts` | Preserve Discord OUT behavior while introducing runtime IN contracts, not wholesale replacement | Event-derived display, queue/interrupt behavior, questions/permissions, voice, attachments and replay. Checkpoint's `adoptSession` mutates metadata/permissions/instructions, so it is not passive binding |

### Important source-level distinctions

- **P bindings:** `bindings.ts` requires a guild and exactly one channel/thread/role selector, validates persona IDs, rejects duplicate scopes, retains the previous configuration on reload failure, and resolves thread before parent channel before role. This is useful service routing, but its `agentId` is a persona, not a runtime-scoped native session identity.
- **P receipt durability:** `inbox.ts` hashes agent plus Discord message ID, publishes a complete temporary receipt using a hard link, retains the original receipt on duplicate publication, and marks delivery separately. Replay batches are bounded at 25 with a retained directory cursor. Preserve this anti-starvation/idempotent intake behavior, but test Windows/filesystem semantics before reuse.
- **P missing runtime protocols:** `pendingAdapters()` explicitly returns `pending-protocol` and names native inbox/wake work for Jcode, Codex and Paperclip as TODO. Accepted receipts are not proof of a woken agent. `runtime.ts` replays only configured HTTP wake adapters and listens on loopback. Neither observation proves native attach.
- **P weaker legacy idempotency:** `src/utils/idempotency.ts` permits acquisition when Redis is unavailable. Do not reuse that helper as a durable exactly-once command guarantee. Intake deduplication also cannot prove a remote side effect happened only once.
- **G security:** `lib/httpapi/server.go` warns that mutating endpoints can be open to callers passing the host allowlist when API-key auth is disabled. The SDK must require explicit authorization rather than assume localhost/allowed-hosts establishes user authority. No API key value was read.
- **A prototype status:** `main.go` calls `StartSimulation()` and labels demo mode. Broad CORS is configured in both inspected entrypoints. This is evidence for a prototype surface, not secure production control or genuine model execution. No embedded secret values are reproduced here.

## Status and licensing caveats

P's README prominently says archived/frozen, permanent pause and owner sign-off required, while older body text says stable and HEAD is newer than the work-state table. Treat the pause as the operational restriction. Read-only inventory does not authorize resurrection, upstream issues, dependency adoption or extraction. P `LICENSE` and manifest say MIT, with copyright notice preservation required. License permission does not override the owner's freeze policy.

G README explicitly says **FOLDED 2026-06-24** into substrate's `crates/engine-agentapi`, preserving the Go gateway as an external subprocess. Older active/85% text conflicts with that notice. Treat it as preservation-only pending owner confirmation. Root LICENSE is MIT, while `LICENSE-APACHE` and `LICENSE-MIT` filenames also exist and were not read. Inspect component provenance before copying. `go.mod` names `github.com/coder/agentapi`, which differs from README attribution to an Anthropic fork. Do not assume naming proves provenance.

A, S and D have no inspected license at their residual roots. This is **unknown permission**, not public domain or proof there is no license in a complete checkout. No dependencies should be copied from them until actual repository/license discovery is complete.

## Remote candidate metadata, not source certification

Public repository pages were requested on 2026-11-11 without credentials. Several responses were cached and two successful pages subsequently returned 404 on a follow-up fetch. Remote metadata is therefore provisional. Source trees, CI, issues, installed binaries and running services were not audited. Evidence locators are explicit repository identifiers, not invented local paths.

| Repository under `KooshaPari` | Observation | Proposed role and remaining uncertainty |
| --- | --- | --- |
| `PhenoBot` | Public fetch returned 404 | P is local evidence only. Remote identity, visibility/rename and archive status unverified. A 404 does not distinguish private, renamed or missing |
| `Substrate` | Public fetch returned 404 | Runtime/routing federation candidate, supported only indirectly by G's fold notice. Current schemas/license unknown |
| `phenotype-router-spec` | Initial page describes JSON schemas for RouterDispatch, RouterMailbox, RouterTrace and RouterArtifact, pointing at substrate adapters; subsequent fetch returned 404 | Potential contract vocabulary, not verified interoperable code. Schema contents/version/license uninspected. Source: `https://github.com/KooshaPari/phenotype-router-spec` |
| `PhenoAI` | Public fetch returned 404 | Uninspected candidate. Do not infer runtime or product capabilities |
| `zz-pause-ref-AtomsTech` | Public fetch returned 404 | Uninspected reference candidate. Do not equate with P merely because P's package is named atomsbot |
| `vibeproxy-monitoring-unified` | Initial description calls it a monitoring scaffold with pre-implementation governance/spec stubs; subsequent fetch returned 404 | Possible observability requirements input, not a deployable collector. License/source uninspected. Source: `https://github.com/KooshaPari/vibeproxy-monitoring-unified` |
| `HarnessDesk` | Public fetch returned 404 | Uninspected. No supported session-management claim |
| `herdr` | README describes terminal/pane server, SSH machines, agent state, CLI/socket API; says Apache-2.0 | Discovery/pane observation federation. README says processes survive client detach, but after server/machine restart saved layout and supported sessions can resume, not original processes. Arbitrary external-process discovery and stable native-session mapping remain unverified. Source: `https://github.com/KooshaPari/herdr` |
| `ShareCLI` | Description is Rust process/resource runtime for high-concurrency workloads; README advertises process health and Prometheus endpoints, MIT or Apache-2.0 | Optional host resource governor. Do not make it Paperclip's task scheduler or runtime transcript owner. License files, endpoint contracts and enforcement uninspected. Source: `https://github.com/KooshaPari/ShareCLI` |
| `Tracera` | Page describes audit/provenance infrastructure; README calls out MIT LICENSE versus workspace `MIT OR Apache-2.0` metadata | Optional OUT audit exporter. Resolve license metadata discrepancy before extraction. No verified ingestion protocol or implementation health claim. Source: `https://github.com/KooshaPari/Tracera` |

No current archive flag, release, test pass, or ownership claim is inferred from a project description. Paperclip was not source-audited here and is a required architectural boundary, not a capability certified by this inventory.

## Federation versus merge decision

**Recommend Kimaki as the first integration host and Discord bridge, with a service-independent SDK boundary.** This follows the checkpoint and the observed mismatch between runtime truth, P's persona/service bindings, and A's simulated UI. It is a proposal, not approval of umbrella ownership.

1. Wrap existing OpenCode behavior first. Add Jcode/Codex IN adapters only against verified native contracts. Keep PTY-based G support capability-limited, especially approvals and externally owned sessions.
2. Federate P's forum/GitHub/PM/calendar functions as OUT bridges. A named `PMProviderAdapter` is a useful service seam, not a replacement for Paperclip organization/task/budget authority. Avoid a second task scheduler.
3. Keep Substrate routing, ShareCLI resource control and herdr terminal lifecycle separate. Registry observations may link their IDs, but must not transfer ownership implicitly.
4. Paperclip-originated work carries task/policy correlation and bounded execution authority. Externally discovered sessions remain unassociated until an explicit association/consent operation. Do not auto-enroll every discovered terminal into Paperclip.
5. Prefer isolated module extraction after two consumers and acceptance tests exist. Whole-repo merges import competing stores, overlapping command frameworks, prototype code, paused governance and unknown licenses without proving preservation.

### Reusable seams and paths

| Source | Reuse target | Required adaptation |
| --- | --- | --- |
| P `src/bridges/bindings.ts`, `bindings.test.ts` | OUT routing precedence and last-good reload tests | Separate persona routing from `(host, endpoint, backend, nativeSessionId)` registry keys and binding generations |
| P `src/bridges/inbox.ts` | Durable intake/receipt design | Add lease epoch, binding generation, accepted/confirmed/uncertain outcomes and reconciliation. Never blindly resend ambiguous remote mutations |
| P `src/bridges/runtime.ts`, `expiry.test.ts` | Opt-in bridge and independent expiry behavior | Detaching/archiving a surface must not kill an external runtime. Test pending-protocol explicitly |
| P `src/pm/interfaces.ts` | Service-provider interface vocabulary | Preserve provider IDs and links. Paperclip task ownership remains separate |
| P tracked paths `src/pm/adapters/`, `src/calendar/`, `src/users/`, `src/sync/webhooks/` | Follow-up preservation inventory | Paths exist, contents not audited here. Validate each workflow and identity mapping before retirement |
| A `agcord-web/main.go`, `handlers/handlers.go`, `services/agcord.go`, `models/models.go` | UI/API concepts | Only main.go read. Replace simulation with authorized projections and remove open control assumptions before reuse |
| G `cmd/server/server.go`, `lib/httpapi/server.go`, `lib/httpapi/handlers.go` | Optional gateway IN adapter contract | Negotiate message/status/SSE semantics, auth and cancellation. Do not claim native tool events from screen parsing |
| S proposed `crates/engine-agentapi` | Follow-up integration location | Reported by G README only, not present at inspected S root. Resolve actual source before design dependency |
| D | None yet | Find complete checkout and inspect tool schema before selecting any reusable code |

## Testable migration gates

These are acceptance criteria for later implementation, not tests run today. Any failed gate blocks retirement.

| Gate | Required observable test/result |
| --- | --- |
| Evidence and permission | Locate complete A/S/D checkouts without disturbing copy jobs. Record HEAD, status, license and owner approval for frozen/folded projects. Capture existing commands/jobs/mappings through approved redacted export, not credential inspection |
| Native identity | Two hosts with the same native session ID remain distinct. Reused PID never reattaches an old session. Pane/cwd-only observations remain provisional until native identity resolves |
| Passive discovery | Start an external session outside Kimaki. Discover it without prompt injection, metadata/permission changes or transcript publication. Presence-only runtimes remain presence-only |
| Non-owning bind/detach | Bind observe with new-events-only default, attach two observers, move one binding, then detach both. External process/session remains alive and usable in its native UI |
| Consent and tenancy | Unauthorized user/button/API call cannot request control or historical replay. Wrong-guild binding cannot receive events. Explicit replay previews scope. Service output redacts sensitive content and suppresses unsafe mentions |
| Mutation authority | Expired lease and old binding generation reject commands. Native UI contention is either backend-enforced or visibly SDK-only, never falsely fenced. Lost acknowledgment yields uncertain receipt and reconciliation, not duplicate prompt |
| Delivery durability | Crash/reconnect during service send resumes cursor/outbox without duplicate terminal outcome. Duplicate Discord receipt retains original content. Simulated remote acceptance followed by connection loss does not execute twice |
| Runtime fidelity | Replay OpenCode queue/steer/interrupt, forms, permissions, subagents, voice and attachments against preserved Discord expectations. Unsupported Jcode/Codex/PTY features are visibly disabled, not silently emulated |
| P preservation | Fixture-test thread > channel > role routing, invalid reload retention, trusted webhook rejection, pending-protocol receipts, replay fairness and expiry continuing after one archival failure. Compare forum/issue/comment/label/status mappings and scheduled notifications before/after canary |
| A honesty | UI distinguishes simulated, observed, unreachable and controlled sessions. No demo status is counted as runtime health. Cross-origin and authorization tests fail closed for mutation |
| Paperclip boundary | One Paperclip task creates one bounded owned run with budget/approval correlation. Discovery of an unrelated external session creates no task, budget charge or lifecycle ownership. Cancellation affects only authorized owned work |
| Canary and rollback | Back up approved state, preserve schema compatibility and old mappings, switch one project/tenant, verify cursor continuity and unique workflows, then roll back without replaying historical private output or losing pending receipts |
| Retirement | Owner approves parity report, license notices and retention plan. No missing unique feature, unverified data export or active writer remains. Retire only after rollback drill, never by blindly deleting legacy roots |

## Independent validation follow-up

At 2026-11-11 00:36 Pacific, the coordinator independently repeated bounded, read-only checks against the original local roots. C: had 478,935,719,936 free bytes, still below the placement threshold. E: remained volume Data with 3,548,407,537,664 free bytes. No legacy source, state or running process was modified.

| Requirement | Actual observation | Acceptance boundary |
| --- | --- | --- |
| Inspect legacy evidence | Native Git commands again returned P HEAD `4a9cdb4` with only untracked `.data/` and `.worktrees/`, and G HEAD `5170818` with empty short status. Directory listings again showed A's backend/web directories, S's cache/driver directories and D's cache-only root | Reproduces the recorded local evidence. Does not certify alternate destinations, deployed services or complete ecosystem coverage |
| Capability inventory | Re-read source matches confirm P thread > parent-channel > role precedence, duplicate rejection, hard-link receipt publication, bounded 25-item cursor, native-wake TODO and Redis-unavailable allow-through. G's actual README confirms fold destination and five named HTTP endpoints. Actual server source warns of disabled authentication. A's actual entrypoint registers UI/API routes and starts simulation | Supports federation, preservation gates and capability limits. No runtime compatibility or production health is inferred from source |
| Migration restrictions | P's actual README repeats strict permanent pause, archived/frozen and owner sign-off. G explicitly says source preservation only. Tracked-file enumeration confirms the bridge tests and calendar/PM/user/webhook seams named above | No legacy test runner, install, bot or gateway was launched. P's strict no-agent-work restriction prevents further execution or extraction without owner authorization |
| Sole document change | Git history shows this inventory was introduced in `168dbc82`. That commit contains seven documentation files and no product source. The repository was clean before this follow-up | The aggregate commit does not prove per-worker authorship or sole-file scope. The worker's sole-file report remains reported evidence, not independently reconstructed attribution. Coordinator follow-up intentionally edits this inventory only |

This closes the source-inventory feedback loop at the documentation level: the preservation and federation recommendations agree with independently observed source and native Git interfaces. It does not close the product acceptance loop. Frozen-project authorization, missing complete checkouts, contract qualification and eventual canary/rollback gates remain blocking. Structural markdown validation supplements these observations and cannot substitute for runtime acceptance.

## Result and blockers

Federation is actionable as a design direction, but code extraction or retirement is not yet justified. Strongest inspected reuse candidates are P's scoped routing/durable intake and G's explicit gateway surface. A is a prototype surface, while S and D are residual paths with no auditable implementation. Locate their coordinated destinations and audit exact contracts before committing the SDK to them. Remote 404s and cached metadata leave several named candidates uninspected. Nothing in this report authorizes a live migration, process takeover, relocation or publication of private topology.
