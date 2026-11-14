# Acceptance map against the delivered agent-ops zipset

Date: 2026-11-14 (Pacific). Source: `kimaki-agent-ops-zipset-2026-11-11` as delivered in `E:\koosh\Downloads`.

This file exists because the closure ledger tracked a self-authored M1 to M8 while the delivered plan used WP0 to WP9 and AC01 to AC40, so progress was not comparable. Status here means "evidence present in this repository", not host acceptance.

## Source integrity

Checksums from the bundle's own `SHA256SUMS.txt`: 7 of 7 documents match.

## Summary

| Status | Cases |
| --- | --- |
| Closed at the plan's standard | 7 |
| Partial | 15 |
| Not started | 18 |
| Total | 40 |

AC03, AC04, AC06, AC13, AC14, AC23 and AC25 are closed. Every other case still lacks both a real native surface and a live service path in the same piece of evidence, which is the standard the plan sets.

## Acceptance cases

| Case | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| AC01 | External session discovered | partial | `ops discover` returns real sessions for OpenCode, Codex and Jcode through the public CLI; no process/task-count oracle recorded |
| AC02 | Passive observe | partial | observers are read-only by construction and detach leaves the native session unchanged (herdr p19/p15, OpenCode session read back intact) |
| AC03 | Original terminal continues | closed | a session created by the native `jcode run` CLI was attached with `ops jcode history`, which replayed the user's own prompt and the reply from `session/load`. With `ops jcode watch` polling, a second native turn typed after attach (`jcode run --resume ...`) produced exactly two new messages, user then agent, with no duplicates across eight polls, while the native client kept working. jcode 0.99.1 does not push another client's turn into an attached ACP session (measured: zero updates), so following native input is poll-based with a fresh ACP connection per cycle, and a repeated load on one connection returns the first snapshot |
| AC04 | Observe disconnect/restart | closed | `ops discord view` holds a durable cursor: after a real ACP turn posted one channel message at sequence 5, the view was killed, restarted, and the next turn posted exactly one new message at sequence 9 with the first message still present and no duplicate. Recovery from a missing state file is reported ("starting at sequence 0"), and a clipped replay fails closed instead of reposting. Codex and the Jcode observer path are not covered by this evidence |
| AC05 | Dynamic rebind | partial | metadata rebind with generation 2 fencing; no live client route change exercised |
| AC06 | Multiple read views | closed | one real jcode ACP session was served by `ops jcode serve` while two CLI clients (`cli-a`, `cli-b`) prompted through `ops jcode attach` and a Discord channel rendered the turns through `ops discord view`. The channel received `bridge-ok` for the first turn and `bridge-two` for the second, each exactly once, with the CLI clients seeing the same turns. Uses discord-digital-twin as a real Discord-compatible server |
| AC07 | Stale control | partial | binding generation fencing exists; no stale control write is attempted or rejected |
| AC08 | Unknown process | partial | herdr unknown identities are surfaced without invention; no PID-reuse case |
| AC09 | PID reuse/runtime restart | not started | no PID-reuse or runtime-restart separation case |
| AC10 | Wrong backend fallback | not started | no wrong-binary, wrong-profile or wrong-provider negative case |
| AC11 | Unsupported capability | partial | capabilities declare unsupported operations and the CLI refuses them; no per-operation pre-dispatch test |
| AC12 | JCode text correction | not started | the native surface does not exist. A real jcode 0.99.1 ACP turn emits only `available_commands_update`, `agent_message_chunk` and `usage_update`, and its `agentCapabilities` declares `loadSession`, `promptCapabilities` and `sessionCapabilities` (close, resume) with no retraction or correction surface. A probe whose model restated a misspelling delivered both strings as ordinary chunks. `client.test.ts` now proves an unknown update kind is ignored rather than rendered as a fabricated correction, so this case is gated on an agent-side surface, not on client work |
| AC13 | Stream gap/overflow | closed | `hub.test.ts` covers the explicit gap path: a cursor behind the retained buffer returns `clipped: true` with the retained tail, a cursor at the head returns `clipped: false`, and a durable log replays in full from cursor 0. Observed cursor values and delivered event ids recorded in the test; 27 hub tests and `tsc` clean at `d9b1bf31` |
| AC14 | Duplicate incoming event | closed | real run through the public CLI and HTTP API: first submit admitted with `duplicate: false`, the same request id returned `duplicate: true` without a second turn, the sequence advanced exactly once (4), the same id with different text was refused with 409, and a fresh id was admitted |
| AC15 | Crash after launch before ACK | not started | no crash-after-launch-before-ack case |
| AC16 | Competing managed launch paths | partial | the hub lease refuses a second writer; no Paperclip launcher fencing |
| AC17 | Cancel request | partial | hub cancel is accepted and inert when idle; no native terminal-state oracle |
| AC18 | Approval race/replay | not started | no approval race or replay case |
| AC19 | Artifact changed after approval | not started | no artifact digest/revision mismatch case |
| AC20 | Credential revocation | partial | consent revoked mid-flight blocks publication; credential revocation is not exercised |
| AC21 | Prompt injection through chat/output | not started | no prompt-injection-through-output case |
| AC22 | Worker success, sync-back failure | not started | no worker-success/sync-back-failure reconciliation case |
| AC23 | Failed HERDR wait/read | closed | real CLI run with a binary that cannot exist: exit 1, no JSON inventory on stdout, and a message naming the failed Herdr inventory command. Unit tests also cover a missing binary and unsafe timeouts before spawning |
| AC24 | Synthetic engine backend | partial | identity comparison fails closed; no synthetic-engine oracle test |
| AC25 | Output send failure/429 | closed | a local REST stub answers the channel lookup 200 and the send 429: the CLI exits non-zero after exactly one POST, never prints `sent`, and emits a non-empty failure. `rejectOnRateLimit` was set on both REST clients because discord.js otherwise re-issues a 429 forever, which contradicted the at-most-once claim |
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
| WP4 | Codex adapter | partial | `createCodexController` implements thread/start, turn/start with streamed deltas, turn/interrupt and bounded timeouts against the protocol generated by `codex app-server generate-ts`. `codex-app-server.ts` now passes notifications and server-initiated requests to a subscriber, answers unanswered requests with a JSON-RPC error, and closes the child on a failed initialize. `ops codex turn` drives a real binary end to end and fails honestly: with a throwaway CODEX_HOME it exits 1 at turn/start with `401 Unauthorized ... Missing bearer or basic authentication`, so no real model turn is proven yet. Approval answering stays declared unsupported |
| WP5 | JCode/KCode adapters | partial | ACP backend, CLI, hub, durable stream, presence, ack and a Discord view of a live session verified; KCode identity absent and Jcode exposes no retraction or correction surface |
| WP6 | Paperclip plugin and runtime adapter | partial | run metadata read and a local-command managed run; no entity projection or enrollment, model-backed run blocked |
| WP7 | Discord comparison and route ownership | partial | consent-gated metadata publication, a live channel view of a hub session (`ops discord view`) with durable resume, and a native-session mirror (`ops jcode watch --tenant/--surface/--state`) that posted four real messages from a terminal session it did not start, with a durable index; no in-bot wiring, route ownership or cutover |
| WP8 | Reliability and acceptance witnesses | partial | 61 backend tests plus 27 hub, 15 ACP client, 17 Codex runtime, 5 publication, 4 Discord view and 7 native mirror tests; two real witnesses (three clients on one hub, native terminal mirrored into a channel); acceptance-case totals below; test-suite gate baseline recorded in `docs/release-gate-2026-11-14.md` |
| WP9 | Migration and retirement | not started | decision matrix and rollback rehearsal only; nothing drained or retired |

## What would move the most cases

1. A live Discord view bound to an external session closes AC03, AC06 and part of AC07, AC26.
2. Codex control through the app-server closes AC03, AC04, AC17, AC18 for the second runtime.
3. A Paperclip external-session entity closes AC29 and unblocks AC30, AC22.
4. Failure-path cases (AC07, AC13, AC14, AC16, AC23, AC25, AC37) are cheap and need no new environment.
