# Acceptance map against the delivered agent-ops zipset

Date: 2026-11-14 (Pacific). Source: `kimaki-agent-ops-zipset-2026-11-11` as delivered in `E:\koosh\Downloads`.

This file exists because the closure ledger tracked a self-authored M1 to M8 while the delivered plan used WP0 to WP9 and AC01 to AC40, so progress was not comparable. Status here means "evidence present in this repository", not host acceptance.

## Source integrity

Checksums from the bundle's own `SHA256SUMS.txt`: 7 of 7 documents match.

## Summary

| Status | Cases |
| --- | --- |
| Closed at the plan's standard | 13 |
| Partial | 19 |
| Not started | 8 |
| Total | 40 |

AC03, AC04, AC06, AC07, AC09, AC10, AC11, AC13, AC14, AC17, AC18, AC23, AC25 are closed. Every other case still lacks both a real native surface and a live service path in the same piece of evidence, which is the standard the plan sets.

## Acceptance cases

| Case | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| AC01 | External session discovered | partial | `ops discover` returns real sessions for OpenCode, Codex and Jcode through the public CLI; no process/task-count oracle recorded |
| AC02 | Passive observe | partial | observers are read-only by construction and detach leaves the native session unchanged (herdr p19/p15, OpenCode session read back intact) |
| AC03 | Original terminal continues | closed | a session created by the native `jcode run` CLI was attached with `ops jcode history`, which replayed the user's own prompt and the reply from `session/load`. With `ops jcode watch` polling, a second native turn typed after attach (`jcode run --resume ...`) produced exactly two new messages, user then agent, with no duplicates across eight polls, while the native client kept working. jcode 0.99.1 does not push another client's turn into an attached ACP session (measured: zero updates), so following native input is poll-based with a fresh ACP connection per cycle, and a repeated load on one connection returns the first snapshot |
| AC04 | Observe disconnect/restart | closed | `ops discord view` holds a durable cursor: after a real ACP turn posted one channel message at sequence 5, the view was killed, restarted, and the next turn posted exactly one new message at sequence 9 with the first message still present and no duplicate. The same was then shown for a served Codex thread: a hub killed and restarted on the same log and thread ran a third turn that appeared once after the two earlier messages, with the same thread id in state. Recovery from a missing state file is reported, and a clipped replay fails closed instead of reposting |
| AC05 | Dynamic rebind | partial | metadata rebind with generation 2 fencing and a stale-control refusal (see AC07). `ops discord view` now records the session id in its durable state and refuses a state cursor that belongs to another session, so rebinding a channel to a new session fails closed instead of silently skipping that session's turns. No live route change between two running sessions was exercised |
| AC06 | Multiple read views | closed | one real jcode ACP session was served by `ops jcode serve` while two CLI clients (`cli-a`, `cli-b`) prompted through `ops jcode attach` and a Discord channel rendered the turns through `ops discord view`. The channel received `bridge-ok` for the first turn and `bridge-two` for the second, each exactly once. The same fabric was then demonstrated for the second runtime: `ops codex serve` held a real Codex thread, a shared client prompted it to `"stopReason":"completed"`, and the channel received the turn with the real thread id in the durable state. Uses discord-digital-twin as a real Discord-compatible server |
| AC07 | Stale control | closed | a real libSQL binding was created at generation 1, detached, and rebound at generation 2. A control write reusing the superseded binding's request id and generation is refused, and a control write against the live binding is refused too, because generation is not a control credential and the boundary admits only `mode: observe`. Both rows remain `mode: observe`, `publication_policy: none`. Proven sensitive: disabling the mode gate makes this test and the existing boundary test fail |
| AC08 | Unknown process | partial | herdr unknown identities are surfaced without invention; no PID-reuse case |
| AC09 | PID reuse/runtime restart | closed | a lease whose recorded pid is alive is refused even when that pid is not a hub (`Another hub holds this session lease`), and the holder file is left untouched, so a reused pid can never steal a lease; a lease whose pid is dead is taken over; and a real hub restart on the same log separates runs through the durable sequence (torn-line, mid-turn and full-turn restarts all covered, plus a Codex hub restart on the same thread) |
| AC10 | Wrong backend fallback | closed | the two cross-backend pairings fail closed with no fallback: `ops jcode run --binary <codex.exe>` exits 1 with `The ACP agent process exited before responding`, and `ops codex turn --binary <jcode.exe>` exits 1 with `Codex app-server initialize failed: app-server exited`. An invalid `--tool-profile` is refused by the CLI before spawning, and a missing `--codex-home` now reports `The --codex-home directory does not exist` instead of blaming the binary with a spawn ENOENT |
| AC11 | Unsupported capability | closed | each refusal is decided before dispatch and tested that way: a control binding is refused by the mode gate before any write, a Codex hub prompt before its thread exists is refused with **zero** control calls dispatched, a duplicate hub client id is refused rather than silently replaced, and a publication without `--consent` never reaches Discord. Capabilities also declare the unsupported operations with reasons |
| AC12 | JCode text correction | not started | the native surface does not exist. A real jcode 0.99.1 ACP turn emits only `available_commands_update`, `agent_message_chunk` and `usage_update`, and its `agentCapabilities` declares `loadSession`, `promptCapabilities` and `sessionCapabilities` (close, resume) with no retraction or correction surface. A probe whose model restated a misspelling delivered both strings as ordinary chunks. `client.test.ts` proves an unknown update kind is ignored rather than rendered as a fabricated correction. Separately measured: `session/load` answers success for an id that does not exist and replays nothing, so `ops jcode history` refuses an empty replay (exit 1 with a naming message) unless `--allow-empty` is passed, rather than letting "0 messages" read as a real session. Gated on an agent-side surface, not on client work |
| AC13 | Stream gap/overflow | closed | `hub.test.ts` covers the explicit gap path: a cursor behind the retained buffer returns `clipped: true` with the retained tail, a cursor at the head returns `clipped: false`, and a durable log replays in full from cursor 0. Observed cursor values and delivered event ids recorded in the test; 36 hub tests and `tsc` clean |
| AC14 | Duplicate incoming event | closed | real run through the public CLI and HTTP API: first submit admitted with `duplicate: false`, the same request id returned `duplicate: true` without a second turn, the sequence advanced exactly once (4), the same id with different text was refused with 409, and a fresh id was admitted |
| AC15 | Crash after launch before ACK | partial | A `backend.start()` that throws after the launch is normalized to an Error, so the hub never publishes `session.started` or reports a live session; a later submit fails closed and the sequence does not advance. 33 hub tests pass, `tsc` clean, commit `142dae78`. The crash is a fake backend throw, not a real managed process dying before ACK |
| AC16 | Competing managed launch paths | partial | the hub lease refuses a second writer; no Paperclip launcher fencing |
| AC17 | Cancel request | closed | a real codex 0.169 app-server turn was interrupted mid-flight through `ops codex turn --cancel-after 2500` against a deliberately slow local model: the CLI printed `cancel-requested` and the turn settled with `"status": "interrupted"` and empty text, which is the native turn state. The hub also accepts a cancel and stays inert when idle |
| AC18 | Approval race/replay | closed | `startCodexAppServer` holds a server-initiated request instead of failing it with `-32601`; `createCodexController` surfaces the full payload (command, cwd, kind, grantRoot, approvalId, startedAtMs), applies an opt-in policy, and answers exactly once. A replay, an unknown id, an id the transport dropped, and a second racing answer are each refused by name. Invalid policy decisions fail closed to `decline`; `humanCommand` refuses `acceptForSession`; `item/permissions/requestApproval` is refused rather than held; the supported capability names the two methods it answers; approvals require `holdsServerRequests: true`; the transport reports delivery only for a live writable child and clears held ids on exit. 37 controller, 5 transport and 4 hub tests pass; `tsc` clean; commit `8ee74cef`. The transport tests use a fake app-server child, and the real-native half is measured too: a real codex 0.169 app-server, driven by a local model that asks for `exec_command`, raised `item/commandExecution/requestApproval` (requestId 0, command `pwsh -Command 'echo approval-ok'`). `ops codex turn --approval accept` delivered `{decision:"accept"}`, the runtime executed the command (`Process exited with code 0 ... Output: approval-ok`), and the turn completed; `--approval decline` produced `exec_command failed: Rejected("rejected by user")` and no execution; with no approval channel at all the same run produced `Rejected("approval request failed")`, so nothing is granted by default. `ops codex serve --approval accept --approval-policy untrusted` surfaced the same request and the same real execution through the hub |
| AC19 | Artifact changed after approval | partial | The approval request carries a SHA-256 digest over method, threadId, turnId, itemId, command, cwd, kind, grantRoot, approvalId and reason. `answerApproval` requires the digest for accept/acceptForSession and refuses a missing or mismatched digest before any JSON-RPC answer; decline/cancel may omit it. A command mutated between `pendingApprovals()` and the answer is refused; both CLI approval surfaces print the digest. 43 controller tests pass; `tsc` clean; commit `d883083e`. The digest is controller-computed from the approval params, not a runtime artifact hash, and a fileChange's file contents are not in those params; no real-binary digest witness yet |
| AC20 | Credential revocation | partial | A stub Discord REST surface answers 401 after consent, an emptied bot token, and an already-revoked token. Each path returns a DiscordError, makes no successful send, and records zero delivered messages; 9 publication tests pass, commit `73c4cf08`. The revocation is simulated at the REST boundary; no live Discord credential was revoked |
| AC21 | Prompt injection through chat/output | partial | A model turn containing a prompt-injection instruction, `@everyone` and a raw user mention is posted verbatim as inert content. The request uses `allowed_mentions: { parse: [] }`, the stub records no mention delivery, no side effect or second message occurs, and the cursor advances once; ordinary text follows the same policy. 16 view tests pass, `tsc` clean, commit `59dbce14`. Only the view path is covered; no agent-side execution or bot-ingest path is tested |
| AC22 | Worker success, sync-back failure | not started | no worker-success/sync-back-failure reconciliation case |
| AC23 | Failed HERDR wait/read | closed | real CLI run with a binary that cannot exist: exit 1, no JSON inventory on stdout, and a message naming the failed Herdr inventory command. Unit tests also cover a missing binary and unsafe timeouts before spawning |
| AC24 | Synthetic engine backend | partial | identity comparison fails closed; no synthetic-engine oracle test |
| AC25 | Output send failure/429 | closed | a local REST stub answers the channel lookup 200 and the send 429: the CLI exits non-zero after exactly one POST, never prints `sent`, and emits a non-empty failure. The same stub with a 500 exposed a second defect: discord.js retried the send three times, so one call made four delivery attempts. Both clients now set `rejectOnRateLimit: () => true` and `retries: 0`, and the 500 case is pinned by its own test (one attempt, non-zero exit). `ops follow` has a dedicated 429 witness as well |
| AC26 | Echo between bots/services | partial | `ops discord view` now defaults its hub client id to `discord-view-<surface>`, not a per-process id. Two views on the same channel claim the same id and the hub refuses the second (400), so the channel receives each turn once; views on different channels keep distinct ids. 19 view tests pass, `tsc` clean, commit `6101c3d0`. This suppresses same-channel duplicate delivery; it is not a general bot-to-bot echo test |
| AC27 | Cold inbox backlog | partial | A hub that already holds a finished turn when the view starts with a fresh state file: the view posts the backlog exactly once in order, then follows a live turn once and persists the live cursor. 14 view tests pass, `tsc` clean, commit `79c7b42b`. The hub is the test fixture, not a live service |
| AC28 | Usage across reattach/retry | partial | ACP token usage is surfaced per turn; no accounting across reattach or retry |
| AC29 | Observed session in Paperclip | partial | `ops paperclip run` reads one real run as metadata; no Paperclip entity or projection exists |
| AC30 | Explicit enrollment | not started | no explicit enrollment record |
| AC31 | Task done without engineering proof | not started | AgilePlus acceptance is outside this repository |
| AC32 | Engineering done without product proof | not started | Tracera acceptance is outside this repository |
| AC33 | Backup restore | partial | `exportBindings` writes a versioned metadata-only JSON backup; `importBindings` restores ids, generations, states, created_at and route ownership in one transaction, skips byte-identical rows, and refuses same-id differences or active-surface/idempotency collisions without partial writes. 17 real-libSQL tests pass, `tsc` clean, commit `58cd9136`. The backup is a local JSON file, not an external object store; bindings carry no cursor, and no live route cutover is exercised |
| AC34 | Actual connector cutover | not started | no real connector cutover and no competing-consumer pause proof |
| AC35 | Clean restart | partial | hub restart from a stopped state is verified; the full bot stack restart is not |
| AC36 | Host/platform difference | partial | all evidence is Windows-only and no Linux success is claimed |
| AC37 | Persisted session mistaken for live | partial | real CLI run over a temp Jcode home: the persisted session was discovered with its title, message bodies never appeared, the home's file hashes and mtimes were unchanged after discovery, a missing home failed instead of inventing sessions, and unit tests show the observer exposes only read operations. The concurrent revival race is not exercised |
| AC38 | Rebind during activity | partial | A view live on session A posts A's turn, then a fake hub emits `session.started` for B and a full B turn. The view returns a ConfigError naming both sessions, aborts, posts no B message, and leaves the cursor on A/4; a repeated `session.started` for A still posts A's turn once. 13 view tests pass, `tsc` clean, commit `2e0ff50d`. The event source is a local fake hub because `createSessionHub` has no rebind path, so the live-service half is not exercised |
| AC39 | KCode reporter says jcode | not started | Design only: KCode is the KooshaPari/KCode fork of Jcode, with its own executable (`w6-install\bin\kcode.exe`), store (`~/.kcode`) and `KCODE_*` environment, but the same ACP surface. AC39 is a negative requirement: the KCode reporter claims `jcode`, and kimaki must resolve executable/store/socket and refuse rather than route by that label. Minimal surface: RuntimeProfile plus provenance, de-hardcoding in `ops/runtime/jcode.ts`, `--profile`/`--binary`, handshake verification, publication-label decision. Blockers: notice wording, profile-vs-family `backendKind` with binding relabel, unmeasured KCode ACP handshake, missing profile-to-executable registry, ACP-only versus SDK/socket scope |
| AC40 | Collector outage | not started | no collector-outage or source-health case |

## Work packages

| Package | Scope | Status | Evidence or gap |
| --- | --- | --- | --- |
| WP0 | Baseline, custody and early comparison | partial | provenance, inventory and consolidation matrix committed; no host/route manifest and no inherited-failure classification |
| WP1 | Minimal native-session/binding contract | mostly | `SessionKey`, capability matrix and fail-closed identity comparison; enroll and control operations are absent |
| WP2 | Kimaki boundary and external observations | partial | ops CLI kept separate from the bot and OpenCode path untouched; no binding path into the live bot |
| WP3 | HERDR/native discovery | partial | real herdr 0.9.3 discovery and metadata binding with fencing; no capture into a Discord view |
| WP4 | Codex adapter | mostly | real-binary evidence now exists for create, submit, stream, interrupt, resume and read. Against codex 0.169 with a local Responses-API model provider (no account credentials): `ops codex turn` streamed `stub-model-reply items=4` and reported `"status":"completed"`; `--cancel-after 2500` on a slow turn produced `"status":"interrupted"`; a second process resumed the same thread with `thread/resume` and ran a turn that carried six input items instead of four, proving history continuity; `ops codex history` read the thread in a fresh process and printed the user and agent messages in order. Default-provider credentials are still absent: pointing at an isolated home with no auth exits 1 at turn/start with `401 Unauthorized`. Approval answering is now supported when an approval channel is configured; without one the client still refuses by default. The race/replay paths are tested, but no real-binary approval request has been driven yet |
| WP5 | JCode/KCode adapters | partial | ACP backend, CLI, hub, durable stream, presence, ack and a Discord view of a live session verified; KCode identity absent and Jcode exposes no retraction or correction surface |
| WP6 | Paperclip plugin and runtime adapter | partial | run metadata read and a local-command managed run; no entity projection or enrollment, model-backed run blocked |
| WP7 | Discord comparison and route ownership | partial | consent-gated metadata publication, a live channel view of a hub session (`ops discord view`) with durable resume, and a native-session mirror (`ops jcode watch --tenant/--surface/--state`) that posted four real messages from a terminal session it did not start, with a durable index; no in-bot wiring, route ownership or cutover |
| WP8 | Reliability and acceptance witnesses | partial | 61 backend tests plus 33 hub, 16 ACP client, 43 Codex control, 6 Codex transport, 4 Codex hub, 9 publication, 19 Discord view, 7 native mirror and 17 binding tests; three real witnesses (three clients on one jcode hub, native terminal mirrored into a channel, real Codex thread served and mirrored); test-suite gate baseline recorded in `docs/release-gate-2026-11-14.md` |
| WP9 | Migration and retirement | not started | decision matrix and rollback rehearsal only; nothing drained or retired |

## What would move the most cases

1. A Paperclip external-session entity closes AC29 and unblocks AC30 and AC22. This is now the single largest lever.
2. A live route change between two running sessions closes AC05; today rebind is proven only as a fail-closed guard.
3. Native process oracles close AC08, AC09, AC10 and AC24: PID reuse, a wrong backend, and a synthetic engine are all identity questions with no evidence yet.
4. No cheap failure paths remain; AC26 now has a same-channel duplicate-suppression witness. The next levers are AC05, AC29 and AC39.
5. AC12 stays blocked on an agent-side correction surface; jcode 0.99.1 exposes none.

## Mutation validation (2026-11-14)

Each closed case below was re-checked by breaking the behaviour, confirming the test
fails, then restoring the file and re-running the suite green.

| Case | Mutation | Observed |
| --- | --- | --- |
| AC13 | `clipped = false` in the no-log branch | 3 tests fail, including two AC13 tests asserting the honest gap |
| AC13 | `clipped = true` in the log branch | 2 tests fail, including the full-log replay case |
| AC25 | removed `rejectOnRateLimit` from all four REST clients | the 429 test fails after 120103 ms: the retry loop never returns and `posts` is not 1 |
| AC12 | the client renders an unknown `agent_message_retraction` as the text `<retracted>` | the test fails with `the sky is grenn<retracted>...`, so it detects fabrication |
| AC13 | `if (ready.clipped)` disabled in `ops discord view` | the new clipped-replay test fails after 30013 ms: the view would mirror a partial turn instead of refusing |
| AC25 | `rejectOnRateLimit` removed from the `ops follow` client only | the follow 429 test fails at its 300079 ms bound: the follow process never exits and never reports the failure |
| AC07 | the `mode: observe` gate disabled in `bindSurface` | 2 tests fail: the stale-control test and the existing boundary test, so neither passes on a control write being silently accepted |
| AC05 | the cross-session state guard disabled in `ops discord view` | the new test fails at its 30017 ms poll bound: the view would resume another session's cursor instead of refusing |

After each mutation the file was restored from a byte copy and `git status` was checked
clean. The suites covering these cases are `hub.test.ts` (27), `acp/client.test.ts` (15),
`ops-publish.e2e.test.ts` (6), `ops/discord/view.test.ts` (7), `ops/discord/watch.test.ts`
(7), `ops/bindings.test.ts` (8) and `ops-follow.e2e.test.ts` (3, one of them the 429
witness); each was run green after the last edit to it.

Coverage of the 429 path after this pass:

- `ops publish`: proven by the stub test, and proven sensitive by the mutation above.
- `ops follow`: `ops-follow.e2e.test.ts` drives a real 429 through the Jcode follow
  path. Observed: exactly one POST, exit code non-zero, no `sent` line, 29 s. Proven
  sensitive by removing the guard from that client alone.
- Native mirror: `discord/watch.test.ts` covers a 429 leaving the cursor unadvanced.
- `ops discord view`: `view.test.ts` asserts that a 429 makes the view fail with no
  cursor written and a single POST. That test supplies its own guarded client, so it
  proves view behaviour, not the CLI's construction; the CLI guard itself is proven by
  the publish and follow tests.
- 5xx: measured before the fix at four POST attempts for one call, now exactly one, pinned
  by the 500 test.

The AC12 probe was reproduced on jcode 0.99.1: 14 `agent_message_chunk` updates plus
`available_commands_update` and `usage_update`, and no correction kind.

## Public-interface acceptance (2026-11-14)

Run through the shipped CLI against live processes, not fixtures: three real
`ops jcode serve` hubs, each holding its own real ACP session, one real `ops discord
view` process per attempt, and one real Discord-compatible server.

| Step | Observed |
| --- | --- |
| Hub A session mirrored | channel received `alpha-session`; state file `{"sessionId":"session_flamingo_1794674661592_0a7ac6f73449ccf5","seq":5}` |
| Same state file against hub B, which serves `session_dolphin_...` | `ops discord view` exit **1**, message `Discord view state belongs to session session_flamingo_..., but the hub is serving session_dolphin_...`; channel message count 1 before and 1 after, so nothing was mirrored and nothing was skipped silently |
| Same state file against a fresh hub with no session yet | `ops discord view` exit **1**, message `Hub has no session yet, so the saved cursor cannot be attributed to one; start the session or use a fresh state file` |

Constraint recorded honestly: the Discord side is `discord-digital-twin` because no
live guild token or channel is available on this host. Every other element of the path
is the real program: real `jcode` ACP child processes, real HTTP hub, real CLI exit
codes and state files.

## Codex real-binary acceptance (2026-11-14)

Driven through the shipped `ops codex` commands against `codex 0.169`, with a local
Responses-API model provider (`wire_api = "responses"`, verified required: the binary
rejects `wire_api = "chat"` with "no longer supported"). No account credentials were
used, and the user's real `CODEX_HOME` was never pointed at or modified.

| Step | Command | Observed |
| --- | --- | --- |
| Create, submit, stream | `ops codex turn --prompt "Say hello"` | `{"kind":"delta","text":"stub-model-reply"}` then `{"kind":"turn","status":"completed",...}` with real thread and turn UUIDs |
| Interrupt | `ops codex turn --prompt "slow reply please" --cancel-after 2500` | `cancel-requested` at 2500 ms, then `"status":"interrupted"` with empty text; the run ends in about one turn's timeout rather than hanging |
| Resume across processes | `ops codex turn --thread <id> --prompt "second turn"` | `thread/resume` accepted the thread that a previous process created; the model request carried 6 input items versus 4 on the first turn |
| Read history | `ops codex history --thread <id>` | in a fresh process: `user: first turn`, `agent: stub-model-reply items=4`, `user: second turn`, `agent: stub-model-reply items=6`, `2 turns, 4 messages` |
| Credential absence | `ops codex turn` with an isolated home and no auth | exit 1 at `turn/start` with `401 Unauthorized ... Missing bearer or basic authentication`; recorded as the constraint on the default provider |

Hypothesis disproved along the way: a thread is not visible to a new app-server process
without `thread/resume`; `turn/start` answered `thread not found` until the resume call
was added.

Writer-lock measurements (two app-server processes, one thread):

| Question | Observed |
| --- | --- |
| Does a resumed thread in process A block process B? | Yes. B's `thread/resume` fails with `thread <id> already has an active writer`, and its `turn/start` then fails with `thread not found`. Codex enforces one writer per thread natively, unlike Jcode |
| Does `thread/read` block a writer? | No. An app-server that had just read the thread stayed connected, a second process resumed that thread, and `turn/start` succeeded with a real turn id. Reading is therefore a safe observe path, and `readThread` must never resume, which a unit test now pins |
| Do cross-process notifications arrive? | No. While another process held the turn, the first process received nothing, so observation is poll-based rather than push |

Codex as a served session (same fabric as Jcode):

| Step | Command | Observed |
| --- | --- | --- |
| Serve | `ops codex serve --binary codex.exe --codex-home <isolated> --cwd <dir>` | printed a loopback URL and the hub capability block |
| Prompt through a shared client | `ops jcode attach --url <hub> --prompt "Serve this turn" --json` | `"stopReason":"completed"`, 24 characters streamed, cursor 4 |
| Mirror into Discord | `ops discord view --url <hub> --tenant <guild> --surface <channel> --state <file>` | channel received `stub-model-reply items=4`; state file recorded the real Codex thread id `01a1db13-3efc-7303-92a7-aea8b5f7e553` at sequence 4 |

That is the operator's goal applied to the second runtime: one live Codex thread,
several clients, and Discord as one of them.

Codex durability across a restart, and two defects it exposed:

| Step | Observed |
| --- | --- |
| Serve with `--log events3.jsonl --thread <id>`, one turn | turn completed, log holds four events with the thread id in `session.started` |
| Kill the hub, serve again with the same `--log` and `--thread` | the hub restored the session from the log and ran a second turn; the resumed thread carried 8 input items against 6 and 4 on earlier turns, so history survived both the restart and the resume |
| Serve a second hub on the same log while the first runs | refused with `Another hub holds this session lease (pid …)` |

Defect 1, found by that run: a hub restored from a log replays history but never
reattaches the backend, so the first prompt failed with `The Codex backend has not
started a thread`. `ops codex serve` now reattaches to the logged thread (resuming it)
before listening, refuses a `--thread` that does not match the log, and refuses to
serve when the resumed thread differs from the logged one.

Defect 2, found while checking that: `ops jcode attach --prompt` defaulted to cursor 0,
so replaying an earlier finished turn satisfied the wait and the client reported the
previous turn's result, exiting before its own turn ran. A prompting attach now starts
at the hub's current sequence; verified by a turn that returned `"cursor": 10` for its
own completion instead of a stale `4`.

Approval requests are a first-class opt-in. Without an approval channel the transport still answers a server-initiated request such as `item/commandExecution/requestApproval` with JSON-RPC error `-32601` on a microtask and the turn settles: an approval-gated action fails rather than being granted. With `--approval`, the transport holds the request instead, the controller surfaces it, and the first answer wins. A replay, an unknown id, an id the transport dropped, and a second racing answer are each refused by name. The transport half is tested against a fake app-server child, and the real-binary half is measured too: a real codex 0.169 app-server asked for a command under `approvalPolicy: untrusted`, and the answer decided whether the command ran.

Real-binary approval witness, all through the shipped CLI:

| Run | Observed |
| --- | --- |
| `--approval accept --approval-policy untrusted` | `{"kind":"approval-request","requestId":0,"method":"item/commandExecution/requestApproval","command":"...pwsh.exe -Command 'echo approval-ok'","decision":"accept"}`, then the turn completed and the model saw `Process exited with code 0 ... Output: approval-ok` |
| `--approval decline` | the same request with `"decision":"decline"`; the model saw `exec_command failed: Rejected("rejected by user")` and nothing ran |
| no `--approval` | no approval line at all; the model saw `exec_command failed: Rejected("approval request failed")`, so the default is fail-closed |
| `--approval cancel` | the request was answered, then the whole turn settled as `"status": "interrupted"` with the text produced so far; no further model turn happened, so cancel aborts the turn rather than just the one command |
| `--approval accept`, two commands in one turn | two separate approval requests, one per command, each answered `accept`; both commands ran |
| `--approval acceptForSession`, two different commands | two requests again, so the session grant is not a blanket pass for the turn |
| `--approval accept`, the identical command twice | two requests again, so the collapse below is the session grant and not a dedupe of repeated commands |
| `--approval acceptForSession`, the identical command twice | exactly one request on two separate runs; both invocations ran (`exit code 0`, `approval-ok` twice), so codex keys the session grant on the exact command |
| `--approval acceptForSession`, then the same command with one extra argument | two requests, so the grant is exact-command, not prefix-matched |
| `--approval accept`, `require_escalated` request | the request carried the model's own justification in `reason` and a `digest`; accepting it ran the command outside the sandbox (`Process exited with code 0 ... Output: escalated-ok`) |
| `--approval decline`, same escalation | `exec_command failed: Rejected("rejected by user")`; nothing ran |
| `ops codex serve --approval accept --approval-policy untrusted` | the hub surfaced the same request on stdout and the command ran (`exit code 0`, `approval-ok`) |

The witness model is a local stub that speaks the Responses API, so no account credential is involved; every other element is the shipped program and the real codex 0.169 binary.

| Check | Observed |
| --- | --- |
| Policy auto-answer | `accept` delivered once as `{decision:"accept"}`; request surfaced with its command |
| No policy | request stays open in `pendingApprovals()` until answered by id |
| Replay | second answer refused as already answered; transport saw one answer |
| Race | first of two answers wins; loser refused; one answer delivered |
| Unknown / dropped id | refused with a named reason; no answer forwarded |
| Policy throws | decision becomes `decline`, never an accidental grant |
| Close with held request | `close` releases it with `-32601`; later answers return false |
| Unsupported server request | failed with `-32601` so the turn cannot hang |
| Payload scope | command, cwd, kind, grantRoot, approvalId and startedAtMs are surfaced; a fileChange grantRoot is visible before any session-wide answer |
| Method honesty | the supported capability names commandExecution and fileChange; item/permissions/requestApproval is refused with -32601 and never enters pending |
| Transport tie | approvals require `holdsServerRequests: true`; the capability is supported only then |
| Dead child | respond/respondError return false after exit or close; pendingServerRequests is empty |
| Decision validation | an invalid policy value fails closed to decline; humanCommand refuses acceptForSession |

Approval digest and credential revocation, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC19 digest | `pendingApprovals()` carries `sha256:` over the artifact fields. An accept with the digest the caller read is forwarded; a wrong digest, a missing digest on accept, and a command mutated after it was read are refused before any answer. decline/cancel may omit the digest. 43 controller tests, `tsc` clean, commit `d883083e` |
| AC20 revocation | A stub REST surface answers 401 after consent, an emptied bot token, and an already-revoked token; every path returns a DiscordError with zero delivered messages. 9 publication tests, commit `73c4cf08`. No live Discord credential was revoked |

Codex parity with the jcode fabric, measured end to end:

| Step | Observed |
| --- | --- |
| Two CLI clients on one served thread | `cli-a` and `cli-b` both exited 0; the channel received two messages, `items=4` then `items=6`, each once |
| Kill the hub, restart it on the same log and thread | new hub started against the same thread id; `cli-c` exited 0 |
| Channel after the restart | three messages with no duplicate of the two earlier ones, and the third carried `items=8`, so history accumulated across the restart |
| Durable state | `{"sessionId":"01a1db37-99ca-7b40-a831-1e1e9fb13386","seq":10}` with the same thread id before and after |

An earlier attempt at this run failed and was traced to the test model, not the product:
the local stub delayed every request because its slow-mode check matched a substring
present in all request bodies, and the stub had expired mid-run. Both were fixed in the
harness before the passing run above.

## Second validation pass (2026-11-14, later)

| Area | What was checked | Observed |
| --- | --- | --- |
| AC13 through the CLI | `ops jcode serve --buffer 2`, one real ACP turn, then `ops jcode attach --cursor 0` | JSON summary carried `"ready":{"cursor":0,"clipped":true,"source":"buffer"}` and only the tail events 4 and 5; plain mode printed `replay clipped: the hub no longer retains every event after the requested cursor`; cursor 4 returned `clipped:false` and `source:"buffer"` as the control |
| AC13 gap in the CLI itself | `ops jcode attach` ignored the hub's ready frame, so a clipped replay looked complete | fixed: the ready frame is now surfaced, and `--buffer` makes the bounded case reachable from the shipped command |
| AC25 lookup failure | `429` on the channel lookup rather than the send | exit non-zero, **zero** POSTs, no `sent` line |
| AC25 transient send failure | `503` on the send | exit non-zero after exactly **one** POST, no retry |
| AC12 prompt-time echo | a `user_message_chunk` arriving during a prompt | excluded from the assistant text (test asserts `ab`, not `atyped-midturnb`); the mutation that folds it in fails the test |
| Rebind with a damaged cursor | corrupt view state file | refused with an error naming the state, and nothing posted |

Third pass additions:

| Area | What was checked | Observed |
| --- | --- | --- |
| AC13 durable replay through the CLI | `ops jcode serve --buffer 1 --log events.jsonl`, one real ACP turn (7 log events), hub stopped and restarted on the same log | `ops jcode attach --cursor 0` replayed all **7** events with `"ready":{"cursor":0,"clipped":false,"source":"log"}`. A one-event buffer is not a gap when the log covers the history |
| AC25 unknown surface | `ops publish` against a stub that answers the channel lookup with `404 Unknown Channel` | exit non-zero, **zero** POSTs, no `sent` line; publish suite now 9 of 9 |

Fourth pass:

| Area | What was checked | Observed |
| --- | --- | --- |
| Torn log after a crash | a log whose last line is a partial write, then `createSessionHub` | restores the valid prefix (sequence 3), replays 1-3 with `clipped:false`, and the next turn continues at sequence 7 rather than reusing numbers |
| Two surfaces on one session | two `ops discord view` processes on different channels of one hub | **defect found and fixed**: both views defaulted to client id `discord-view`, and the hub refuses a duplicate id (`Hub refused the stream with status 400`), so only one channel ever received the turn. The default is now `discord-view-<pid>`. After the fix both channels received exactly one message and both state files recorded the same session id at sequence 4 |
| Wrong tenant | `ops discord view --tenant 000000000000000000` on a channel owned by another guild | refuses without posting; covered by a unit test that asserts an Error, no message and no state file. **Open issue**: the CLI process exits with Windows code `0xC0000409` and a libuv `UV_HANDLE_CLOSING` assertion instead of a clean 1 when it fails this early, so the refusal is correct but the exit path is not clean |
| Rebind with a cursor ahead of the hub | state `{sessionId: <real>, seq: <seq + 500>}` | **defect found and fixed**: the view exited 0 with `{"kind":"closed"}` and `attach --cursor 500` also exited 0 with no events. The hub wrote SSE headers before subscribing, so its refusal arrived as a 200 whose JSON body the client read as an empty stream, and `attach` ignored the `Error` that `openHubStream` resolves. The server now subscribes before writing headers (400 with `Hub cursor is ahead of the stream`) and the CLI fails on a refused attach. Re-verified: raw fetch returns 400, and `attach --cursor 500` exits 1 |

Exit-abort investigation for that open issue:

| Check | Observed |
| --- | --- |
| Reproduction | three runs of the wrong-tenant view: exits `3221226505`, `1`, `3221226505`; the first probe run was `0xC0000409` twice out of three, so it is a race, not a deterministic failure |
| Unreachable hub (`--url http://127.0.0.1:1`) | exit 1, clean. The abort needs a completed Discord REST exchange |
| `ops publish` with a missing event file | exit 1, clean. No REST exchange |
| Synchronous stderr write in `fail` | kept, because it guarantees the message is flushed before exit, but it does not change the abort (`0xC0000409` on three of three after the change) |
| `REST` client | exposes no `destroy()` in discord.js 14.26.4, so the CLI cannot close the keep-alive agent before exiting |

Conclusion: the abort comes from calling `process.exit()` while discord.js' keep-alive socket is still closing, which libuv reports as a closing async handle. A clean fix means replacing `process.exit()` in the CLI's `fail` path with a drained exit (set `process.exitCode`, let the loop close sockets, and only then terminate), which touches every command's exit strategy. The message is still printed before the abort, and the exit code is non-zero either way, so the refusal is safe; the cleanliness of the code is the remaining gap and is left documented rather than half-fixed.

Fifth pass:

| Area | What was checked | Observed |
| --- | --- | --- |
| AC03/AC12 interop | a session kimaki itself created over ACP (`ops jcode run` reported `session_vole_...`), read back with `ops jcode history` | the load replayed `user: Reply with exactly: acp-created-session` and `agent: acp-created-session`, so observation covers kimaki's own sessions and not only sessions started by a native client |
| AC25 watch mirror failure | `ops jcode watch --discord --emit-existing` against a stub that 429s every post | printed `Discord publish native watch message failed` and exited non-zero, and **no state file was written**, so the cursor did not advance. The same `0xC0000409` teardown abort appeared here too, which confirms the exit-abort is repo-wide on Discord REST failures rather than specific to the view's tenant check |
| Operator trap found | the same watch command without `KIMAKI_DISCORD_REST_URL` | it reached the real Discord API with the stub token and failed `401: Unauthorized`. Expected behaviour, worth knowing: the REST URL override is an environment variable, not a flag |

Sixth pass:

| Area | What was checked | Observed |
| --- | --- | --- |
| AC12/AC03 load independence | `ops jcode history --session session_vole_... --cwd <different directory>` | the history still replayed the prompt and reply, so binding a view does not require the session's original working directory |
| Rebind upgrade safety | a state file in the older `{seq}` shape, with a live view then a new turn | resumed rather than refused, posted exactly the new turn, and the file was upgraded in place to include `sessionId`, so an upgrade does not silently stall existing views |
| AC13 concurrent cursors | one subscriber at cursor 0 (clipped) and one at the head, then a second live turn | the clipped subscriber held the tail `3,4` plus the live `5,6,7`, the live subscriber held only `5,6,7`, and the hub reported two subscribers, so replay choice does not leak between clients |

Seventh pass:

| Area | What was checked | Observed |
| --- | --- | --- |
| AC12 unknown session in the watcher | `ops jcode watch --session session_does_not_exist --iterations 1` | **defect fixed**: before this it polled silently and exited 0 with nothing reported, because jcode answers `session/load` successfully for a missing id. The first poll now refuses an empty history (exit 1, message naming the ambiguity) and `--allow-empty` opts back in (exit 0). The same command against a real session still exits 0 |

Eighth pass:

| Area | What was checked | Observed |
| --- | --- | --- |
| AC13 crash mid-turn | a log that ends after `prompt.started` and one chunk, then `createSessionHub` | restores `seq 2` with `busy:false`, replays both events unclipped, and a new turn continues the sequence to 6 instead of reusing the orphaned numbers (a restored hub also emits `session.started` on the next submit) |
| AC25 malformed channel body | a channel lookup that answers 200 with `<html>not json</html>` | exit non-zero, **zero** POSTs, no `sent` line; publish suite now 11 of 11 |

Ninth pass:

| Area | What was checked | Observed |
| --- | --- | --- |
| AC13 broken subscriber | one subscriber whose `onEvent` throws, plus a healthy one | the healthy client still received the whole turn `1,2,3,4`, the thrower was detached after its first failure (`subscribers: 1`), and the turn itself succeeded, so a consumer bug cannot corrupt the stream for others |
| AC25 non-text surface | `ops publish` against a channel lookup answering `type: 2` (guild voice) | refused as denied with **zero** POSTs and no `sent` line; publication validates the channel type the same way the view does |
| AC12 history schema | `ops jcode history --json` | keys are exactly `sessionId`, `model`, `history`, with the model reported and both messages present |

Backup restore and live rebind, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC33 | `exportBindings`/`importBindings` round-trip into a fresh real libSQL DB preserves ids, generations, states, routes and timestamps; a second import is a no-op; same-id differences and active-surface/idempotency collisions refuse the whole import; malformed or authority-widening rows write nothing. 17 tests, commit `58cd9136`. Local JSON only; no external store or live cutover |
| AC38 | A live view bound to session A fails closed when a fake hub emits `session.started` for B and a full B turn: ConfigError naming both sessions, no B post, cursor stays A/4. A repeated `session.started` for A is a resume and still posts once. 13 tests, commit `2e0ff50d`. The fake hub is used because `createSessionHub` has no rebind path |

## KCode identity design (2026-11-14)

KCode is the `KooshaPari/KCode` fork of the Jcode runtime: its own executable (`w6-install\bin\kcode.exe`, v0.93.398-k0.1.0-dev), store (`~/.kcode`) and `KCODE_*` environment, but the same ACP surface and `sessions/session_*.json` layout as stock `jcode.exe` v0.99.1 (`~/.jcode`). AC39 is a negative requirement, not a rename: the KCode reporter claims `jcode`, and kimaki must resolve the executable/store/socket and refuse rather than route by that label or select the stock binary. The current code fails structurally: hardcoded `'jcode'`, no provenance, `?? 'jcode'` defaults, and a discarded handshake `agentName`.

The minimal surface is a `RuntimeProfile` plus observation provenance in `src/ops/contracts.ts`, de-hardcoding in `src/ops/runtime/jcode.ts`, `--profile`/`--binary` on ops commands, profile and env on the backend input, handshake verification, and a publication-label decision. Tests should cover positive profile preservation and four negative wrong-identity refusals across the observer, backend, ACP client and publication files. Blockers: Discord notice wording, profile-vs-family `backendKind` with binding relabel, the unmeasured KCode ACP handshake, a missing profile-to-executable registry, and whether the scope is ACP-only or also SDK/socket.

Crash-before-ACK and cold backlog, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC15 | A backend whose `start()` throws after launch is normalized to an Error; the hub publishes no `session.started`, reports no session, and a later submit fails closed without advancing the sequence. 33 hub tests, commit `142dae78`. Fake backend throw, not a real process crash |
| AC27 | A cold view starts with a fresh state file against a hub that already holds a finished turn: it posts the backlog once in order, then a live turn once, and persists the live cursor. 14 view tests, commit `79c7b42b`. Fixture hub, not a live service |

Injection output safety, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC21 | A model turn with a prompt-injection instruction, `@everyone` and a raw user mention is posted verbatim as inert content; `allowed_mentions` is parse-empty, the stub records no mention delivery, no side effect or second message occurs, and the cursor advances once. Ordinary text follows the same policy. 16 view tests, commit `59dbce14`. View path only; no agent-side execution or bot-ingest test |

Echo/duplicate suppression, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC26 | The default view client id is `discord-view-<surface>`. Two views on the same channel claim the same id; the hub refuses the second with 400, so the channel receives each turn once. Views on different channels keep distinct ids and both post once. 19 view tests, commit `6101c3d0`. Same-channel duplicate suppression only; no general bot-to-bot echo test |
