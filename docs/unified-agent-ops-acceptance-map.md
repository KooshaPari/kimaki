# Acceptance map against the delivered agent-ops zipset

Date: 2026-11-14 (Pacific). Source: `kimaki-agent-ops-zipset-2026-11-11` as delivered in `E:\koosh\Downloads`.

This file exists because the closure ledger tracked a self-authored M1 to M8 while the delivered plan used WP0 to WP9 and AC01 to AC40, so progress was not comparable. Status here means "evidence present in this repository", not host acceptance.

## Source integrity

Checksums from the bundle's own `SHA256SUMS.txt`: 7 of 7 documents match.

## Summary

| Status | Cases |
| --- | --- |
| Closed at the plan's standard | 0 |
| Partial | 20 |
| Not started | 20 |
| Total | 40 |

"No closed cases" is the honest reading: the plan requires independent native and host evidence per case, and no case has both a real native surface and a live service path yet.

## Acceptance cases

| Case | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| AC01 | External session discovered | partial | `ops discover` returns real sessions for OpenCode, Codex and Jcode through the public CLI; no process/task-count oracle recorded |
| AC02 | Passive observe | partial | observers are read-only by construction and detach leaves the native session unchanged (herdr p19/p15, OpenCode session read back intact) |
| AC03 | Original terminal continues | not started | no bound Discord view exists that would echo new native input |
| AC04 | Observe disconnect/restart | partial | a restarted follow republishes nothing; observer recovery and explicit gap reporting are not tested for Codex or Jcode |
| AC05 | Dynamic rebind | partial | metadata rebind with generation 2 fencing; no live client route change exercised |
| AC06 | Multiple read views | partial | the hub fans one Jcode session out to two real CLI clients with identical events; no Discord view in that path |
| AC07 | Stale control | partial | binding generation fencing exists; no stale control write is attempted or rejected |
| AC08 | Unknown process | partial | herdr unknown identities are surfaced without invention; no PID-reuse case |
| AC09 | PID reuse/runtime restart | not started | no PID-reuse or runtime-restart separation case |
| AC10 | Wrong backend fallback | not started | no wrong-binary, wrong-profile or wrong-provider negative case |
| AC11 | Unsupported capability | partial | capabilities declare unsupported operations and the CLI refuses them; no per-operation pre-dispatch test |
| AC12 | JCode text correction | not started | no Jcode retraction or correction handling |
| AC13 | Stream gap/overflow | partial | the hub reports clipped replay and replays from the log; no overflow or backpressure case |
| AC14 | Duplicate incoming event | not started | no duplicate-incoming-event case |
| AC15 | Crash after launch before ACK | not started | no crash-after-launch-before-ack case |
| AC16 | Competing managed launch paths | partial | the hub lease refuses a second writer; no Paperclip launcher fencing |
| AC17 | Cancel request | partial | hub cancel is accepted and inert when idle; no native terminal-state oracle |
| AC18 | Approval race/replay | not started | no approval race or replay case |
| AC19 | Artifact changed after approval | not started | no artifact digest/revision mismatch case |
| AC20 | Credential revocation | partial | consent revoked mid-flight blocks publication; credential revocation is not exercised |
| AC21 | Prompt injection through chat/output | not started | no prompt-injection-through-output case |
| AC22 | Worker success, sync-back failure | not started | no worker-success/sync-back-failure reconciliation case |
| AC23 | Failed HERDR wait/read | partial | bounded waits return explicit errors instead of fabricated results |
| AC24 | Synthetic engine backend | partial | identity comparison fails closed; no synthetic-engine oracle test |
| AC25 | Output send failure/429 | partial | publication is at-most-once and failures are reported; no delivery state or backoff on 429 |
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
| AC37 | Persisted session mistaken for live | partial | Jcode polling reads persisted state without reviving it; no explicit refusal case |
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
| WP4 | Codex adapter | weak | discovery and nonempty snapshot only; no prompt, approval, cancel or reconnect |
| WP5 | JCode/KCode adapters | partial | ACP backend, CLI, hub, durable stream, presence and ack verified; KCode identity and retraction absent |
| WP6 | Paperclip plugin and runtime adapter | partial | run metadata read and a local-command managed run; no entity projection or enrollment, model-backed run blocked |
| WP7 | Discord comparison and route ownership | partial | consent-gated metadata publication only; no in-bot wiring, route ownership or cutover |
| WP8 | Reliability and acceptance witnesses | partial | 61 backend unit tests, 3 opt-in acceptance cases, 4 real verification scripts; 20 acceptance cases untouched |
| WP9 | Migration and retirement | not started | decision matrix and rollback rehearsal only; nothing drained or retired |

## What would move the most cases

1. A live Discord view bound to an external session closes AC03, AC06 and part of AC07, AC26.
2. Codex control through the app-server closes AC03, AC04, AC17, AC18 for the second runtime.
3. A Paperclip external-session entity closes AC29 and unblocks AC30, AC22.
4. Failure-path cases (AC07, AC13, AC14, AC16, AC23, AC25, AC37) are cheap and need no new environment.
