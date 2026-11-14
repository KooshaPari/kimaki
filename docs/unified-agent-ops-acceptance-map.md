# Acceptance map against the delivered agent-ops zipset

Date: 2026-11-14 (Pacific). Source: `kimaki-agent-ops-zipset-2026-11-11` as delivered in `E:\koosh\Downloads`.

This file exists because the closure ledger tracked a self-authored M1 to M8 while the delivered plan used WP0 to WP9 and AC01 to AC40, so progress was not comparable. Status here means "evidence present in this repository", not host acceptance.

## Source integrity

Checksums from the bundle's own `SHA256SUMS.txt`: 7 of 7 documents match.

## Summary

| Status | Cases |
| --- | --- |
| Closed at the plan's standard | 9 |
| Partial | 14 |
| Not started | 17 |
| Total | 40 |

AC03, AC04, AC06, AC07, AC13, AC14, AC17, AC23 and AC25 are closed. Every other case still lacks both a real native surface and a live service path in the same piece of evidence, which is the standard the plan sets. AC18 moved from not started to partial: the approval race and replay paths now exist and are tested at the controller and transport layers, but no real Codex 0.169 approval request has been driven end to end.

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
| AC09 | PID reuse/runtime restart | not started | no PID-reuse or runtime-restart separation case |
| AC10 | Wrong backend fallback | not started | no wrong-binary, wrong-profile or wrong-provider negative case |
| AC11 | Unsupported capability | partial | capabilities declare unsupported operations and the CLI refuses them; no per-operation pre-dispatch test |
| AC12 | JCode text correction | not started | the native surface does not exist. A real jcode 0.99.1 ACP turn emits only `available_commands_update`, `agent_message_chunk` and `usage_update`, and its `agentCapabilities` declares `loadSession`, `promptCapabilities` and `sessionCapabilities` (close, resume) with no retraction or correction surface. A probe whose model restated a misspelling delivered both strings as ordinary chunks. `client.test.ts` proves an unknown update kind is ignored rather than rendered as a fabricated correction. Separately measured: `session/load` answers success for an id that does not exist and replays nothing, so `ops jcode history` refuses an empty replay (exit 1 with a naming message) unless `--allow-empty` is passed, rather than letting "0 messages" read as a real session. Gated on an agent-side surface, not on client work |
| AC13 | Stream gap/overflow | closed | `hub.test.ts` covers the explicit gap path: a cursor behind the retained buffer returns `clipped: true` with the retained tail, a cursor at the head returns `clipped: false`, and a durable log replays in full from cursor 0. Observed cursor values and delivered event ids recorded in the test; 27 hub tests and `tsc` clean at `d9b1bf31` |
| AC14 | Duplicate incoming event | closed | real run through the public CLI and HTTP API: first submit admitted with `duplicate: false`, the same request id returned `duplicate: true` without a second turn, the sequence advanced exactly once (4), the same id with different text was refused with 409, and a fresh id was admitted |
| AC15 | Crash after launch before ACK | not started | no crash-after-launch-before-ack case |
| AC16 | Competing managed launch paths | partial | the hub lease refuses a second writer; no Paperclip launcher fencing |
| AC17 | Cancel request | closed | a real codex 0.169 app-server turn was interrupted mid-flight through `ops codex turn --cancel-after 2500` against a deliberately slow local model: the CLI printed `cancel-requested` and the turn settled with `"status": "interrupted"` and empty text, which is the native turn state. The hub also accepts a cancel and stays inert when idle |
| AC18 | Approval race/replay | partial | `startCodexAppServer` can hold a server-initiated request instead of failing it with `-32601`; `createCodexController` surfaces the request, applies an opt-in policy, and answers it exactly once. A replay, an id that was never issued, an id the transport dropped, and a second racing answer are each refused by name; `close` releases anything still held. 30 controller tests and 4 transport tests pass, `tsc` is clean, commit `8450f029`. The transport tests use a fake app-server child, so the real-native half is still missing: no Codex 0.169 approval request has been driven through a real binary |
| AC19 | Artifact changed after approval | not started | no artifact digest/revision mismatch case |
| AC20 | Credential revocation | partial | consent revoked mid-flight blocks publication; credential revocation is not exercised |
| AC21 | Prompt injection through chat/output | not started | no prompt-injection-through-output case |
| AC22 | Worker success, sync-back failure | not started | no worker-success/sync-back-failure reconciliation case |
| AC23 | Failed HERDR wait/read | closed | real CLI run with a binary that cannot exist: exit 1, no JSON inventory on stdout, and a message naming the failed Herdr inventory command. Unit tests also cover a missing binary and unsafe timeouts before spawning |
| AC24 | Synthetic engine backend | partial | identity comparison fails closed; no synthetic-engine oracle test |
| AC25 | Output send failure/429 | closed | a local REST stub answers the channel lookup 200 and the send 429: the CLI exits non-zero after exactly one POST, never prints `sent`, and emits a non-empty failure. The same stub with a 500 exposed a second defect: discord.js retried the send three times, so one call made four delivery attempts. Both clients now set `rejectOnRateLimit: () => true` and `retries: 0`, and the 500 case is pinned by its own test (one attempt, non-zero exit). `ops follow` has a dedicated 429 witness as well |
| AC26 | Echo between bots/services | not started | no echo suppression case |
| AC27 | Cold inbox backlog | not started | no cold inbox backlog case |
| AC28 | Usage across reattach/retry | partial | ACP token usage is surfaced per turn; no accounting across reattach or retry |
| AC29 | Observed session in Paperclip | partial | `ops paperclip run` reads one real run as metadata; no Paperclip entity or projection exists |
| AC30 | Explicit enrollment | not started | no explicit enrollment record |
| AC31 | Task done without engineering proof | not started | AgilePlus acceptance is outside this repository |
| AC32 | Engineering done without product proof | not started | Tracera acceptance is outside this repository |
| AC33 | Backup restore | not started | no backup/restore case for ids, cursors or route ownership |
| AC34 | Actual connector cutover | not started | no real connector cutover and no competing-consumer pause proof |
| AC35 | Clean restart | partial | hub restart from a stopped state is verified; the full bot stack restart is not |
| AC36 | Host/platform difference | partial | all evidence is Windows-only and no Linux success is claimed |
| AC37 | Persisted session mistaken for live | partial | real CLI run over a temp Jcode home: the persisted session was discovered with its title, message bodies never appeared, the home's file hashes and mtimes were unchanged after discovery, a missing home failed instead of inventing sessions, and unit tests show the observer exposes only read operations. The concurrent revival race is not exercised |
| AC38 | Rebind during activity | not started | no rebind-during-activity case |
| AC39 | KCode reporter says jcode | not started | KCode identity is not implemented or tested |
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
| WP8 | Reliability and acceptance witnesses | partial | 61 backend tests plus 27 hub, 15 ACP client, 30 Codex control, 4 Codex transport, 4 Codex hub, 6 publication, 8 Discord view, 7 native mirror and 8 binding tests; three real witnesses (three clients on one jcode hub, native terminal mirrored into a channel, real Codex thread served and mirrored); test-suite gate baseline recorded in `docs/release-gate-2026-11-14.md` |
| WP9 | Migration and retirement | not started | decision matrix and rollback rehearsal only; nothing drained or retired |

## What would move the most cases

1. A live Discord view bound to an external session closes AC03, AC06 and part of AC07, AC26.
2. Codex control is now exercised for AC03, AC04 and AC17. AC18 is partial: the approval race and replay paths exist and are tested, but a real Codex approval request is still needed to close it.
3. A Paperclip external-session entity closes AC29 and unblocks AC30, AC22.
4. Failure-path cases (AC07, AC13, AC14, AC16, AC23, AC25, AC37) are cheap and need no new environment.

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

Approval requests are a first-class opt-in. Without an approval channel the transport still answers a server-initiated request such as `item/commandExecution/requestApproval` with JSON-RPC error `-32601` on a microtask and the turn settles: an approval-gated action fails rather than being granted. With `--approval`, the transport holds the request instead, the controller surfaces it, and the first answer wins. A replay, an unknown id, an id the transport dropped, and a second racing answer are each refused by name. The tests use a fake app-server child for the transport half, so the real-binary approval request remains the open half of AC18.

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
| Rebind with a cursor ahead of the hub | state `{sessionId: <real>, seq: <seq + 500>}` | **defect found and fixed**: the view exited 0 with `{"kind":"closed"}` and `attach --cursor 500` also exited 0 with no events. The hub wrote SSE headers before subscribing, so its refusal arrived as a 200 whose JSON body the client read as an empty stream, and `attach` ignored the `Error` that `openHubStream` resolves. The server now subscribes before writing headers (400 with `Hub cursor is ahead of the stream`) and the CLI fails on a refused attach. Re-verified: raw fetch returns 400, and `attach --cursor 500` exits 1 |
