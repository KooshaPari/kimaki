# Acceptance map against the delivered agent-ops zipset

Date: 2026-11-14 (Pacific). Source: `kimaki-agent-ops-zipset-2026-11-11` as delivered in `E:\koosh\Downloads`.

This file exists because the closure ledger tracked a self-authored M1 to M8 while the delivered plan used WP0 to WP9 and AC01 to AC40, so progress was not comparable. Status here means "evidence present in this repository", not host acceptance.

## Source integrity

Checksums from the bundle's own `SHA256SUMS.txt`: 7 of 7 documents match.

## Summary

| Status | Cases |
| --- | --- |
| Closed at the plan's standard | 15 |
| Partial | 23 |
| Not started | 2 |
| Total | 40 |

AC03, AC04, AC05, AC06, AC07, AC09, AC10, AC11, AC13, AC14, AC17, AC18, AC23, AC25, AC38 are closed. Every other case still lacks both a real native surface and a live service path in the same piece of evidence, which is the standard the plan sets.

## Acceptance cases

| Case | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| AC01 | External session discovered | partial | `ops discover` returns real sessions for OpenCode, Codex and Jcode through the public CLI, and a metadata process oracle now reports the inventory count and an independent observed-process count side by side with `countsAgree` visible, for inventories with and without pid metadata. The comparison is not wired into `ops discover`, and the three-backend and count-only cases compare fixture inventories against an in-memory table. 22 process-oracle tests, `tsc` clean, commits `5d78160a` and `121a8491` |
| AC02 | Passive observe | partial | observers are read-only by construction and detach leaves the native session unchanged (herdr p19/p15, OpenCode session read back intact) |
| AC03 | Original terminal continues | closed | a session created by the native `jcode run` CLI was attached with `ops jcode history`, which replayed the user's own prompt and the reply from `session/load`. With `ops jcode watch` polling, a second native turn typed after attach (`jcode run --resume ...`) produced exactly two new messages, user then agent, with no duplicates across eight polls, while the native client kept working. jcode 0.99.1 does not push another client's turn into an attached ACP session (measured: zero updates), so following native input is poll-based with a fresh ACP connection per cycle, and a repeated load on one connection returns the first snapshot |
| AC04 | Observe disconnect/restart | closed | `ops discord view` holds a durable cursor: after a real ACP turn posted one channel message at sequence 5, the view was killed, restarted, and the next turn posted exactly one new message at sequence 9 with the first message still present and no duplicate. The same was then shown for a served Codex thread: a hub killed and restarted on the same log and thread ran a third turn that appeared once after the two earlier messages, with the same thread id in state. Recovery from a missing state file is reported, and a clipped replay fails closed instead of reposting |
| AC05 | Dynamic rebind | closed | metadata rebind with generation 2 fencing and a stale-control refusal (see AC07), and `ops discord view --rebind` follows an explicitly approved session change: it adopts the new session, resets the cursor to the new start, drops a half-buffered turn from the old session, and persists `{sessionId, seq}` for the new one; without `--rebind` a renumbered session change fails closed naming both sessions (4 view tests against a hand-written SSE hub, 23 in the file). An aborted subscriber stream leaves no hub presence and the same client id reattaches immediately (9 hub-server tests). 32 tests across the two files, `tsc` clean, commit `5b7626f2`. The live route change itself is now witnessed against real infrastructure: `kimaki/src/ops-rebind-live.test.ts` runs the real `openDiscordView` against real `createSessionHub` instances and their real `startHubServer` SSE surface at one stable URL, so the `session.started` that triggers each decision is published by the hub from its own durable log. Without approval the view returns a `ConfigError` naming `session-a` and `session-b`, posts nothing for B and keeps the cursor on A/4; with `--rebind` it adopts B (`seen = [4, 4]`, state `{session-b, 4}`), and a real republished `session.started` at seq 5 neither duplicates B's post nor suppresses the new turn (`seen = [4, 4, 8]`, channel `answer:alpha, answer:beta, answer:gamma`, state `{session-b, 8}`). 2 tests pass, exit 0, 19.48 s; `tsc` clean; commit `d3074bc9`. Remainders: every identity change falls between turns, so a rebind with a half-buffered turn in flight is still proven only against the stub hub; the session ids come from the test's backend double, not a live jcode/kcode runtime; continuity across the change is provided by a test relay because `view.ts` has no reconnect loop and `createSessionHub` has no in-place rebind, so a live rebind is always a hub restart; the outbound Discord REST is `discord-digital-twin`, the substitution AC04, AC06 and AC38 close on |
| AC06 | Multiple read views | closed | one real jcode ACP session was served by `ops jcode serve` while two CLI clients (`cli-a`, `cli-b`) prompted through `ops jcode attach` and a Discord channel rendered the turns through `ops discord view`. The channel received `bridge-ok` for the first turn and `bridge-two` for the second, each exactly once. The same fabric was then demonstrated for the second runtime: `ops codex serve` held a real Codex thread, a shared client prompted it to `"stopReason":"completed"`, and the channel received the turn with the real thread id in the durable state. Uses discord-digital-twin as a real Discord-compatible server |
| AC07 | Stale control | closed | a real libSQL binding was created at generation 1, detached, and rebound at generation 2. A control write reusing the superseded binding's request id and generation is refused, and a control write against the live binding is refused too, because generation is not a control credential and the boundary admits only `mode: observe`. Both rows remain `mode: observe`, `publication_policy: none`. Proven sensitive: disabling the mode gate makes this test and the existing boundary test fail |
| AC08 | Unknown process | partial | herdr unknown identities are surfaced without invention, and a recorded process identity is no longer trusted on pid alone: `ProcessIdentity` pairs a pid with an OS birth marker (Win32 `CreationDate`, POSIX `lstart`), so a pid whose live marker differs reports `reused`, and a marker missing on either side reports `unknown` with a named reason; `classifyProcessIdentity` has a truth table for all five combinations. Real enumeration read this host's own pid and birth marker on Windows. The mismatch cases are pure in-memory tables, the POSIX parser is fixture-tested only, and herdr inventory carries no process identity, so no live session is attributed through the oracle and no live PID-reuse event was observed. Commit `5d78160a` |
| AC09 | PID reuse/runtime restart | closed | a lease whose recorded pid is alive is refused even when that pid is not a hub (`Another hub holds this session lease`), and the holder file is left untouched, so a reused pid can never steal a lease; a lease whose pid is dead is taken over; and a real hub restart on the same log separates runs through the durable sequence (torn-line, mid-turn and full-turn restarts all covered, plus a Codex hub restart on the same thread) |
| AC10 | Wrong backend fallback | closed | the two cross-backend pairings fail closed with no fallback: `ops jcode run --binary <codex.exe>` exits 1 with `The ACP agent process exited before responding`, and `ops codex turn --binary <jcode.exe>` exits 1 with `Codex app-server initialize failed: app-server exited`. An invalid `--tool-profile` is refused by the CLI before spawning, and a missing `--codex-home` now reports `The --codex-home directory does not exist` instead of blaming the binary with a spawn ENOENT |
| AC11 | Unsupported capability | closed | each refusal is decided before dispatch and tested that way: a control binding is refused by the mode gate before any write, a Codex hub prompt before its thread exists is refused with **zero** control calls dispatched, a duplicate hub client id is refused rather than silently replaced, and a publication without `--consent` never reaches Discord. Capabilities also declare the unsupported operations with reasons |
| AC12 | JCode text correction | partial | the client is now gated and inert: a correction counts only when the peer's own `agentCapabilities` literally declares `retractMessages`, `textCorrection` or `messageRetraction` (top level or under `sessionCapabilities`), and jcode 0.99.1 declares none, so no update kind is invented. When declared, a retraction names a segment and replaces its text (absent text withdraws it) and the assembled turn is recomputed instead of appended; a retraction that is undeclared, names an unknown segment, or arrives after the turn result is ignored, and a user echo during a prompt never enters the turn text. 24 client tests (6 new), commit `eb116314`. The retraction shape and the three capability keys are a documented local extension, not an observed jcode emission: a real jcode 0.99.1 turn emits only `available_commands_update`, `agent_message_chunk` and `usage_update`, and its `agentCapabilities` declares `loadSession`, `promptCapabilities` and `sessionCapabilities` (close, resume). A probe whose model restated a misspelling delivered both strings as ordinary chunks. Separately measured: `session/load` answers success for an id that does not exist and replays nothing, so `ops jcode history` refuses an empty replay (exit 1 with a naming message) unless `--allow-empty` is passed. Gated on an agent-side surface, so the client stays inert until a peer declares one |
| AC13 | Stream gap/overflow | closed | `hub.test.ts` covers the explicit gap path: a cursor behind the retained buffer returns `clipped: true` with the retained tail, a cursor at the head returns `clipped: false`, and a durable log replays in full from cursor 0. Observed cursor values and delivered event ids recorded in the test; 36 hub tests and `tsc` clean |
| AC14 | Duplicate incoming event | closed | real run through the public CLI and HTTP API: first submit admitted with `duplicate: false`, the same request id returned `duplicate: true` without a second turn, the sequence advanced exactly once (4), the same id with different text was refused with 409, and a fresh id was admitted |
| AC15 | Crash after launch before ACK | partial | A throwing or rejecting `backend.start()` is still normalized to an Error, and the hub now bounds a pre-ACK launch (`launchTimeoutMs`, default 30 s) and refuses to fabricate a session when a launch returns no id. Two tests spawn a real `node` child that writes its pid and `process.exit(7)` without answering, driven through the real `createAcpClient` transport: `start()` returns the death error well under the timeout with no `session.started`, `seq` stays 0, a later submit fails closed, the child pid is dead, a real dead pid in the holder file is taken over, and a second test pins the deadline for a child whose exit the transport never observes. 38 hub tests, `tsc` clean, commit `1ffb6d9c`. The dying child is a synthetic node ACP agent, not a real jcode/kcode runtime killed mid-handshake; the 250 ms deadline test is timing-sensitive under parallel load (it failed once in a 4-file parallel run and passed 38/38 alone) |
| AC16 | Competing managed launch paths | partial | the hub lease still refuses a second writer, and a managed launch now has a Paperclip claim fence: one claim per `(instanceId, runId)` with monotonic `generation` and `claimSeq`, a sha256 digest over the record, holder-only release, heartbeat expiry, and a stale takeover that advances the generation so the previous holder's write is refused. A second live claim, a release by a non-holder, a superseded or forged generation, and a run already held by the hub are each refused by name, and both directions are covered (a hub claim blocks a Paperclip claim, a Paperclip claim blocks a hub write). 11 launch-fence tests (30 paperclip tests with `index` and `observe`), `tsc` clean in `src/ops/paperclip/**`, commit `9629b7e3`; accepting a competing live claim fails 3 tests and freezing the generation fails 2. Not closed: the fence is a caller-owned JSON record with no cross-process lock and no Paperclip API call, `launchFenceCapabilities` declares `dispatch`, `remoteWrite` and `inference` false, and no shipped command imports `createLaunchFence`, so no two real launchers were raced |
| AC17 | Cancel request | closed | a real codex 0.169 app-server turn was interrupted mid-flight through `ops codex turn --cancel-after 2500` against a deliberately slow local model: the CLI printed `cancel-requested` and the turn settled with `"status": "interrupted"` and empty text, which is the native turn state. The hub also accepts a cancel and stays inert when idle |
| AC18 | Approval race/replay | closed | `startCodexAppServer` holds a server-initiated request instead of failing it with `-32601`; `createCodexController` surfaces the full payload (command, cwd, kind, grantRoot, approvalId, startedAtMs), applies an opt-in policy, and answers exactly once. A replay, an unknown id, an id the transport dropped, and a second racing answer are each refused by name. Invalid policy decisions fail closed to `decline`; `humanCommand` refuses `acceptForSession`; `item/permissions/requestApproval` is refused rather than held; the supported capability names the two methods it answers; approvals require `holdsServerRequests: true`; the transport reports delivery only for a live writable child and clears held ids on exit. 43 controller, 6 transport and 7 hub tests pass; `tsc` clean; commit `8ee74cef`. The transport tests use a fake app-server child, and the real-native half is measured too: a real codex 0.169 app-server, driven by a local model that asks for `exec_command`, raised `item/commandExecution/requestApproval` (requestId 0, command `pwsh -Command 'echo approval-ok'`). `ops codex turn --approval accept` delivered `{decision:"accept"}`, the runtime executed the command (`Process exited with code 0 ... Output: approval-ok`), and the turn completed; `--approval decline` produced `exec_command failed: Rejected("rejected by user")` and no execution; with no approval channel at all the same run produced `Rejected("approval request failed")`, so nothing is granted by default. `ops codex serve --approval accept --approval-policy untrusted` surfaced the same request and the same real execution through the hub |
| AC19 | Artifact changed after approval | partial | The approval request carries a SHA-256 digest over method, threadId, turnId, itemId, command, cwd, kind, grantRoot, approvalId and reason. `answerApproval` requires the digest for accept/acceptForSession and refuses a missing or mismatched digest before any JSON-RPC answer; decline/cancel may omit it. A command mutated between `pendingApprovals()` and the answer is refused; both CLI approval surfaces print the digest. 43 controller tests pass; `tsc` clean; commit `d883083e`. The digest is controller-computed from the approval params, not a runtime artifact hash, and a fileChange's file contents are not in those params; no real-binary digest witness yet |
| AC20 | Credential revocation | partial | A stub Discord REST surface answers 401 after consent, an emptied bot token, and an already-revoked token. Each path returns a DiscordError, makes no successful send, and records zero delivered messages; 9 publication tests pass, commit `73c4cf08`. The revocation is simulated at the REST boundary; no live Discord credential was revoked |
| AC21 | Prompt injection through chat/output | partial | A model turn containing a prompt-injection instruction, `@everyone` and a raw user mention is posted verbatim as inert content. The request uses `allowed_mentions: { parse: [] }`, the stub records no mention delivery, no side effect or second message occurs, and the cursor advances once; ordinary text follows the same policy. 2 new injection tests (23 in the view file) pass, `tsc` clean, commit `59dbce14`. Only the view path is covered; no agent-side execution or bot-ingest path is tested |
| AC22 | Worker success, sync-back failure | partial | `WorkerResultSyncBack` holds one record per worker result: `pending-sync` after a failed write-back (never `failed`), `synced` only when an `ack_id` arrives, with monotone `attempts` and a canonical `payload_digest`. Reconcile is idempotent (a duplicate retry delivers nothing) and six refusals fail by name: conflicting payload, same digest different target, concurrent in-flight reconcile, unknown id, blank id/target, non-JSON payload. 7 new tests (24 in `bindings.test.ts`), `tsc` clean, commit `fc333ebd`. The ledger is an in-process `Map` and delivery is a caller-supplied callback, so no live sync-back target is exercised and a restart drops pending records because there is no table or migration |
| AC23 | Failed HERDR wait/read | closed | real CLI run with a binary that cannot exist: exit 1, no JSON inventory on stdout, and a message naming the failed Herdr inventory command. Unit tests also cover a missing binary and unsafe timeouts before spawning |
| AC24 | Synthetic engine backend | partial | `classifyEngine` fails closed on a blank identity, on a synthetic marker (`synthetic`, `stub`, `fixture`, `replay`, `mock`, `fake` in the claim, engine, identity or version) and on a missing version instead of defaulting one; `assertControlEngine` also refuses a foreign identity. `createCodexHubBackend` runs the gate before `startThread`/`sendTurn`/`cancel`, so a synthetic engine gets the marker-named `ConfigError` from each and the controller stub records zero calls; `createObservationOnlyEngine` accepts a synthetic claim but exposes no `start`, `prompt` or `cancel` property. 7 engine-identity and 7 codex-hub tests, `tsc` clean, commit `56073c2f`. The refusal is exercised with a recording controller stub, not a live synthetic engine refused real control |
| AC25 | Output send failure/429 | closed | a local REST stub answers the channel lookup 200 and the send 429: the CLI exits non-zero after exactly one POST, never prints `sent`, and emits a non-empty failure. The same stub with a 500 exposed a second defect: discord.js retried the send three times, so one call made four delivery attempts. Both clients now set `rejectOnRateLimit: () => true` and `retries: 0`, and the 500 case is pinned by its own test (one attempt, non-zero exit). `ops follow` has a dedicated 429 witness as well |
| AC26 | Echo between bots/services | partial | `ops discord view` defaults its hub client id to `discord-view-<surface>`, so two views on one channel cannot both post (the hub refuses the second with 400), and a message-level guard now drops an own message by author identity first, then a bot-authored `-# echo:<service> origin:<id> hop:<n>` marker naming this service, and republishes a foreign marker only while `hop < maxHops` (default 1), so two guarded services reach a fixed point in exactly two publishes; a human-authored marker is not trusted. 6 echo and 3 watch tests pass, `tsc` clean, commit `34f01ae8`. The loop witness runs against the `discord-digital-twin` stub REST surface with a seeded second bot, not a live guild or a second real bot process, so the row stays partial |
| AC27 | Cold inbox backlog | partial | A hub that already holds a finished turn when the view starts with a fresh state file: the view posts the backlog exactly once in order, then follows a live turn once and persists the live cursor. 1 new cold-inbox test (23 in the view file) passes, `tsc` clean, commit `79c7b42b`. The hub is the test fixture, not a live service |
| AC28 | Usage across reattach/retry | partial | `foldAnalytics` keys usage by durable execution position (`aggregateID:seq`): a reattach that replays a completed turn emits nothing, a retried step upserts by position so only the billed attempt lands, and per-session rows stay separate. Four tests pin literal numbers for reattach replay, a retry that consumed tokens, attach-detach-reattach-continue, and interleaved root/child rows; 6 in `analytics.test.ts`, `tsc` clean, commit `b87ba5f5`. The event sequences are constructed fixtures, not captured from a live hub reattach, so no live replay path is exercised |
| AC29 | Observed session in Paperclip | partial | `projectObservedSession` is a pure, idempotent projection of an enrolled session to a local `paperclip-observed-session` entity (`ownership: external-observe`, `policy: {mode observe, publication none, writes false, dispatch false}`) with a digest; identical inputs give a byte-identical entity and changing only observed metadata leaves `entityId`, `externalRef`, `title` and `policy` fixed. 9 projection tests (32 paperclip tests with `registry.test.ts`), `tsc` clean, commit `658b6d16`. The entity is a local fixture modelled on the existing `paperclip/index.ts` metadata boundary; no Paperclip API is called, no Paperclip-side entity is claimed, and no shipped command reaches this module; `ops paperclip run` still only reads one run as metadata |
| AC30 | Explicit enrollment | partial | `enrollSession` writes a versioned `paperclip-enrollment` record only for an explicit `action: enroll`, with a `sha256:` digest over a fixed-order record, a tamper check, and refusals for a non-action, blank fields, runtime/session mismatch, widened `surface`/`mode`/`publication`, a non-ISO timestamp, a second different enrollment, and a tampered or digest-less record; identical re-enrollment is a byte-identical no-op. 5 new enrollment cases in `registry.test.ts` (23 tests in the file), `tsc` clean, commit `658b6d16`. The record is a local library surface with no shipped command and no Paperclip API call, so nothing is enrolled against a live service |
| AC31 | Task done without engineering proof | not started | AgilePlus acceptance is outside this repository |
| AC32 | Engineering done without product proof | not started | Tracera acceptance is outside this repository |
| AC33 | Backup restore | partial | restore now crosses an object-store boundary on top of the `58cd9136` export/import: `uploadBindingBackup` seals `{version, exportedAt, rows}` with a sha256 digest, puts UTF-8 JSON create-only (`replace` opts out) and returns key, size, etag and digest; `restoreBindingBackup` reads the object, verifies shape, schema version and digest, then lets `importBindings` write every row in one transaction, so a corrupt or re-versioned payload writes nothing. Two implementations: a local filesystem store (one file per key, `wx` conditional put) and an in-memory stub with a tamper hook. 7 backup-store tests against the real libSQL database plus 30 unchanged bindings tests, commit `f734d976`; the digest check and the conditional put are each proven sensitive by mutation (1 test fails for each). Not closed: both stores are local or stub, so no remote object store, no server-side checksum enforcement, no retry, timeout or pagination, and no live route cutover |
| AC34 | Actual connector cutover | partial | `beginCutover`/`completeCutover`/`abortCutover` in `ops/cutover.ts` move ownership of one surface between bindings, each in a single transaction: source `active` -> `paused` with a `staged` target at generation+1, then target `active` and source `retired`, or abort restoring the source at its original generation and releasing the target to `detached`. `ownerGeneration` fences only rows that can still own, a single-flight guard refuses a second cutover by name, completion is idempotent, and `writeSurface` refuses a competing consumer at a superseded or ahead generation while naming the surface. 6 new tests in `bindings.test.ts` (30 in the file), `tsc` clean, commit `1b5abe81`. This is a metadata cutover in the local bindings store: no live Discord or Paperclip connector was stopped, started or rerouted, no process was signalled, and the competing consumer is a caller presenting a superseded generation, not a second running bot |
| AC35 | Clean restart | partial | hub restart from a stopped state is verified; the full bot stack restart is not |
| AC36 | Host/platform difference | partial | all evidence is Windows-only and no Linux success is claimed |
| AC37 | Persisted session mistaken for live | partial | on a real filesystem home (`mkdtemp`, real `readFile`/`readdir`) a read is accepted only when two bounded reads are byte-identical, parse completely and carry the requested id, so a half-written record is reported transient instead of surfacing a truncated title or a phantom session; `discover()` reports `observation.health` and `skippedTransient`, `readSnapshot` names the transient reason, `observe()` takes `onHealth` and its handle exposes `health()`, and a transient poll never moves the reported baseline. 17 observer tests (4 new), `tsc` clean in `src/ops/runtime/jcode.ts`, commit `23c29ac3`; replacing the consistency rule with one loose read plus a title regex fails 2 new tests. Still partial: the concurrent writer is the test's own filesystem, not a live jcode process mid-turn, and the shipped `ops discover --source jcode` prints only source, coverage, endpoint, sessions and cursor, dropping `page.observation`, so the transient/consistent distinction does not reach the CLI. Earlier real-CLI evidence stands: a persisted session was discovered with its title, no message bodies appeared, and the home's hashes and mtimes were unchanged after discovery |
| AC38 | Rebind during activity | closed | `kimaki/src/ops-rebind-live.test.ts` drives the real `openDiscordView` against real `createSessionHub` instances and their real loopback `startHubServer` surface, so the `session.started` that triggers every decision is published by the hub's own `publish()` from its own durable log. A view live on A posts A's turn once and persists `{session-a, 4}`; the hub is then restarted at the same URL on a fresh log and its own `start()` publishes `session.started` for B at seq 1. Without `--rebind` the view returns a `ConfigError` naming both sessions, posts nothing for B, and leaves the cursor on A/4; with `--rebind` it adopts B, posts B's turn exactly once and persists `{session-b, 4}`. A third hub on a rotated log restores seq 4 and republishes a real repeated `session.started` for the same B at seq 5, which does not duplicate B's earlier post and still posts the new turn once (`seen` = 4, 4, 8). 2 tests pass, 1 file, exit 0, 19.48 s on this host; `tsc` clean; commit `d3074bc9`. Disclosed remainders: both identity changes fall between turns rather than inside an in-flight turn, the session ids come from the test's backend double (not a live jcode/kcode runtime), continuity across the hub restart is provided by the test's loopback relay because `view.ts` has no reconnect loop, and the outbound Discord REST is `discord-digital-twin`, the same substitution AC04 and AC06 close on |
| AC39 | KCode reporter says jcode | partial | `RuntimeProfile` (`jcode`/`kcode`: executable, `<prefix>HOME` env, store, `expectedIdentity`) plus `profileId` provenance drive the observer and backend; `--profile` is wired on `ops jcode run`, `history` and `watch`; a profile/executable mismatch, a store-leaf mismatch, an unknown profile and a handshake identity mismatch are refused before any ACP call or store read. Real-binary witness (2026-11-14): `kcode.exe` v0.93.398 on PATH self-reports `jcode`, so `ops jcode run --profile kcode --cwd .` prints `Runtime profile kcode expects identity 'kcode', but the ACP handshake reported 'jcode'; refusing to route a kcode session` and exits non-zero; `ops jcode history --profile kcode` and `ops jcode watch --profile kcode` print the same text and also exit non-zero; and `--profile nope` is refused with `Unknown runtime profile 'nope'. Expected one of: jcode, kcode` instead of falling back to the stock binary. 34 profile tests across the observer and backend (5 + 8 new) plus 2 new ACP client identity tests, `tsc` clean, commits `4a4b3391` and `fff491aa`. The publication label is now profile-aware at its own boundary: `publishMetadataNotice` resolves the notice text from an optional `profile` provenance (`External KCode session activity observed.` for `kcode`, `External Jcode ...` for `jcode`), refuses an unknown profile id and a profile/backend family mismatch before any REST call including the channel GET, and keeps the stored binding's `backendKind: 'jcode'` unchanged; 13 publication and 13 runtime-profile tests, `tsc` clean, commit `f11618ac`. Still partial: `src/cli/ops.ts:161` calls it with `backend: 'jcode'` and no `profile`, so an `ops follow` kcode session still prints the stock Jcode notice, and `expectedIdentity: 'kcode'` plus the `<prefix>HOME` variable name are unverified against a real kcode handshake because kcode reports `jcode` |
| AC40 | Collector outage | partial | the analytics send path now retains events across a collector outage: `createEventSink` keeps unaccepted events in order, caps retention at 256 with a counted drop, serializes passes so a burst cannot overlap or skip an emit, and on recovery flushes retained events once in order; `SourceHealth` separates a network failure from a non-2xx status and clears on recovery; `attempted = delivered + retained + dropped` is asserted inside the cap and outage loops. 6 AC40 tests plus 6 fold tests, `tsc` clean in the analytics files, commits `1b788fff` and `8e7646d7`; faking acceptance fails all 5 tests that exercised it before the burst case existed. Not closed: the collector is a scripted fake transport, so no real collector was taken down; `health()` and `counters()` are library surfaces with one warn log on an unreachable flush and no CLI command that prints them; the retention buffer is in-memory and is lost on process exit |

## Work packages

| Package | Scope | Status | Evidence or gap |
| --- | --- | --- | --- |
| WP0 | Baseline, custody and early comparison | partial | provenance, inventory and consolidation matrix committed; no host/route manifest and no inherited-failure classification |
| WP1 | Minimal native-session/binding contract | mostly | `SessionKey`, capability matrix and fail-closed identity comparison; enroll and control operations are absent |
| WP2 | Kimaki boundary and external observations | partial | ops CLI kept separate from the bot and OpenCode path untouched; no binding path into the live bot |
| WP3 | HERDR/native discovery | partial | real herdr 0.9.3 discovery and metadata binding with fencing; no capture into a Discord view |
| WP4 | Codex adapter | mostly | real-binary evidence now exists for create, submit, stream, interrupt, resume and read. Against codex 0.169 with a local Responses-API model provider (no account credentials): `ops codex turn` streamed `stub-model-reply items=4` and reported `"status":"completed"`; `--cancel-after 2500` on a slow turn produced `"status":"interrupted"`; a second process resumed the same thread with `thread/resume` and ran a turn that carried six input items instead of four, proving history continuity; `ops codex history` read the thread in a fresh process and printed the user and agent messages in order. Default-provider credentials are still absent: pointing at an isolated home with no auth exits 1 at turn/start with `401 Unauthorized`. Approval answering is now supported when an approval channel is configured; without one the client still refuses by default. The race/replay paths are tested. A real-binary approval request was independently reproduced on 2026-11-15: accept executed `echo approval-ok` (exit 0), decline produced `Rejected("rejected by user")`, and no channel produced `Rejected("approval request failed")` |
| WP5 | JCode/KCode adapters | partial | ACP backend, CLI, hub, durable stream, presence, ack and a Discord view of a live session verified; KCode identity absent and Jcode exposes no retraction or correction surface |
| WP6 | Paperclip plugin and runtime adapter | partial | run metadata read and a local-command managed run; no entity projection or enrollment, model-backed run blocked |
| WP7 | Discord comparison and route ownership | partial | consent-gated metadata publication, a live channel view of a hub session (`ops discord view`) with durable resume, and a native-session mirror (`ops jcode watch --tenant/--surface/--state`) that posted four real messages from a terminal session it did not start, with a durable index; no in-bot wiring, route ownership or cutover |
| WP8 | Reliability and acceptance witnesses | partial | Validated on 2026-11-15: 98 backend (hub 38, hub-server 9, hub-client 5, jcode 22, ACP 24), 43 Codex control, 6 Codex transport, 7 Codex hub, 13 publication, 23 Discord view, 3 native mirror, 30 binding, 6 echo, 9 projection, 30 paperclip, 50 discovery, 7 backup-store and 7 engine-identity tests; three real witnesses (three clients on one jcode hub, native terminal mirrored into a channel, real Codex thread served and mirrored); test-suite gate baseline recorded in `docs/release-gate-2026-11-14.md` |
| WP9 | Migration and retirement | not started | decision matrix and rollback rehearsal only; nothing drained or retired |

## What would move the most cases

1. AC29, AC30 and AC22 now have a local projection, an explicit enrollment record and a reconciliation ledger; the remaining lever is a live Paperclip API call and a persisted sync-back table, which turns all three from local to live.
2. AC05's live route change is now evidenced (`d3074bc9`); what it does not yet carry is a rebind with a turn in flight, a real jcode/kcode runtime behind the session, and a client that reconnects by itself instead of through the test relay.
3. The process oracle and the engine-identity oracle now exist (AC01, AC08, AC24); the remaining lever is wiring them into `ops discover` and a live control path instead of comparing fixtures.
4. No cheap failure paths remain; AC26 has a fixed-point echo witness against a stub REST surface and AC34 a metadata cutover in the local store. The next levers are AC39's `ops follow` provenance wiring and a real kcode `expectedIdentity`, a live connector reroute for AC34, a real jcode/kcode crash mid-handshake for AC15, and a mid-turn rebind for AC05.
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
| AC38 | A live view bound to session A fails closed when a fake hub emits `session.started` for B and a full B turn: ConfigError naming both sessions, no B post, cursor stays A/4. A repeated `session.started` for A is a resume and still posts once. 13 tests, commit `2e0ff50d`. `createSessionHub` has no in-place rebind, which is why this pass stood in a hand-written SSE hub; the restart path that does publish a second `session.started` is witnessed against the real hub in the 2026-11-15 entry below |

## KCode identity design (2026-11-14)

KCode is the `KooshaPari/KCode` fork of the Jcode runtime: its own executable (`w6-install\bin\kcode.exe`, v0.93.398-k0.1.0-dev), store (`~/.kcode`) and `KCODE_*` environment, but the same ACP surface and `sessions/session_*.json` layout as stock `jcode.exe` v0.99.1 (`~/.jcode`). AC39 is a negative requirement, not a rename: the KCode reporter claims `jcode`, and kimaki must resolve the executable/store/socket and refuse rather than route by that label or select the stock binary. The current code fails structurally: hardcoded `'jcode'`, no provenance, `?? 'jcode'` defaults, and a discarded handshake `agentName`.

The minimal surface is a `RuntimeProfile` plus observation provenance in `src/ops/contracts.ts`, de-hardcoding in `src/ops/runtime/jcode.ts`, `--profile`/`--binary` on ops commands, profile and env on the backend input, handshake verification, and a publication-label decision. Tests should cover positive profile preservation and four negative wrong-identity refusals across the observer, backend, ACP client and publication files. Blockers: Discord notice wording, profile-vs-family `backendKind` with binding relabel, the unmeasured KCode ACP handshake, a missing profile-to-executable registry, and whether the scope is ACP-only or also SDK/socket.

Crash-before-ACK and cold backlog, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC15 | A backend whose `start()` throws after launch is normalized to an Error; the hub publishes no `session.started`, reports no session, and a later submit fails closed without advancing the sequence. 33 hub tests, commit `142dae78`. Fake backend throw, not a real process crash |
| AC27 | A cold view starts with a fresh state file against a hub that already holds a finished turn: it posts the backlog once in order, then a live turn once, and persists the live cursor. 14 view tests, commit `79c7b42b`. Fixture hub, not a live service |

AC15's row above is superseded later the same day by commit `1ffb6d9c`; see the six-lane section at the end.

Injection output safety, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC21 | A model turn with a prompt-injection instruction, `@everyone` and a raw user mention is posted verbatim as inert content; `allowed_mentions` is parse-empty, the stub records no mention delivery, no side effect or second message occurs, and the cursor advances once. Ordinary text follows the same policy. 16 view tests, commit `59dbce14`. View path only; no agent-side execution or bot-ingest test |

Echo/duplicate suppression, 2026-11-14:

| Case | Evidence |
| --- | --- |
| AC26 | The default view client id is `discord-view-<surface>`. Two views on the same channel claim the same id; the hub refuses the second with 400, so the channel receives each turn once. Views on different channels keep distinct ids and both post once. 19 view tests, commit `6101c3d0`. Same-channel duplicate suppression only; no general bot-to-bot echo test |

## Six concurrent lanes and the real KCode handshake (2026-11-14)

Each commit below was checked with `git show --stat`, and each cited test file and test
name was confirmed present before the case rows were updated. Test counts are from a run
of the cited files on this host.

| Lane / case | Commit | Files | Tests run |
| --- | --- | --- | --- |
| AC05 approved rebind and hub presence on abort | `5b7626f2` | `ops/discord/view.ts`, `ops/discord/view.test.ts`, `backend/hub-server.test.ts`, `cli/ops.ts` | 32 (view 23, hub-server 9) |
| AC15 real managed child crash before ACK | `1ffb6d9c` | `backend/hub.ts`, `backend/hub.test.ts` | 38 hub |
| AC28 usage across reattach and retry | `b87ba5f5` | `analytics.ts`, `analytics.test.ts` | 6 analytics |
| AC39 runtime identity | `4a4b3391`, `fff491aa` | `ops/contracts.ts`, `ops/runtime/jcode.ts`, `backend/jcode.ts`, `backend/acp/client.ts`, `cli/ops.ts` and their tests | 34 profile + 2 ACP identity |
| AC29 projection, AC30 enrollment | `658b6d16` | `ops/paperclip/{seal,enrollment,project}.ts`, `ops/registry.test.ts`, `ops/projection.test.ts` | 32 (registry 23, projection 9) |
| AC22 worker success, sync-back failure | `fc333ebd` | `ops/bindings.ts`, `ops/bindings.test.ts` | 24 bindings |

Real-binary KCode handshake, measured today with `kcode.exe` v0.93.398-k0.1.0-dev at
`C:\Users\koosh\w6-install\bin\kcode.exe` on PATH and the shipped CLI:

| Command | Observed |
| --- | --- |
| `ops jcode run --profile kcode --cwd .` | `Runtime profile kcode expects identity 'kcode', but the ACP handshake reported 'jcode'; refusing to route a kcode session`; exit non-zero |
| `ops jcode history --profile kcode --session session_x` | the same refusal text; exit non-zero |
| `ops jcode watch --profile kcode --session session_x` | the same refusal text; exit non-zero |
| `ops jcode run --profile nope` | `Unknown runtime profile 'nope'. Expected one of: jcode, kcode`; exit non-zero, so an unknown profile never falls back to the stock binary |

This is the real-binary witness for AC39's negative requirement: KCode self-reports
`jcode` over ACP, and kimaki refuses to route a `kcode` profile through it.

Residual gaps recorded rather than hidden:

- `ops follow` derives `backendKind: 'jcode'` from `--source` (`src/cli/ops.ts:161`) and
  still passes no `profile` to `publishMetadataNotice`, so a kcode session watched through
  `ops follow` falls back to the stock Jcode notice. The label boundary itself is
  profile-aware since `f11618ac`; only the CLI wiring is missing.
- `KCODE_PROFILE.expectedIdentity = 'kcode'` and the `<prefix>HOME` variable name
  (`KCODE_HOME`) are unverified against a real kcode handshake, because kcode reports
  `jcode`; the identity checks are exercised against a fake `AcpClient` only.
- AC29's `paperclip-observed-session` entity is a local fixture modelled on the existing
  `paperclip/index.ts` metadata boundary; no Paperclip API is called and no Paperclip-side
  entity is claimed.
- AC15's crash is a real spawned `node` child that exits before ACK through the real ACP
  transport, not a managed jcode/kcode runtime killed mid-handshake.
- The `1ffb6d9c` 250 ms deadline test is timing-sensitive under parallel load: it failed
  once when `hub.test.ts` ran alongside three other files and passed 38/38 in isolation.

## Second wave (2026-11-14)

Second batch of lanes after `e7706146`. Each commit was checked with `git show --stat`, and
each cited test file and test name was confirmed present in the tree before a row changed.
The seven cited files were run together on this host: 88 tests, 7 files, all green.

| Case | Commit | What changed | Why the status did or did not move |
| --- | --- | --- | --- |
| AC01 | `5d78160a`, `121a8491` | An inventory is now compared against an independent process oracle, with `countsAgree` reported for inventories with and without pid metadata | still partial: the oracle is not wired into `ops discover`, and the compared inventories are fixtures |
| AC08 | `5d78160a` | A process identity is a pid plus a birth marker; a differing marker reports `reused`, a missing one reports `unknown` | still partial: the mismatch cases are in-memory tables and no live PID reuse was observed |
| AC24 | `56073c2f` | `classifyEngine` refuses a synthetic or version-less engine for control; the codex hub gates before `startThread`/`sendTurn`/`cancel`; the observation-only surface has no control property | still partial: the refusal is proven with a recording controller stub, not a live synthetic engine |
| AC26 | `34f01ae8` | Own-message identity, a durable bot-authored echo marker and a `hop < maxHops` cycle bound stop a two-service exchange at a fixed point | still partial: the loop witness runs against the `discord-digital-twin` stub REST surface, not a live guild |
| AC34 | `1b5abe81` | Pause, staged handover, retire and abort move surface ownership in one transaction each, with generation fencing and a named competing-consumer refusal | not started -> partial: it is a metadata cutover in the local bindings store, not a live connector reroute and not a second running bot |
| AC39 | `f11618ac` | `publishMetadataNotice` resolves the notice label from `profile` and refuses an unknown or family-mismatched profile before any REST call | still partial: `src/cli/ops.ts:161` still passes no `profile`, so an `ops follow` kcode session prints the stock Jcode notice |

Downgraded against the lane reports: AC26 was reported as closed, but its only loop witness
is the Discord twin stub, so it stays partial. AC39's publication gap was reported closed;
the label boundary is fixed and tested, but the shipped `ops follow` path does not pass
provenance, so the residual gap is narrowed rather than removed.

## Third wave (2026-11-14/15)

Third batch of lanes on `feat/passive-session-bindings`. Each commit was checked with
`git show --stat`, and every cited test file and test name was confirmed present in the
committed tree, not only in the worktree. The five cited files plus `analytics.test.ts` were
run together on this host: 71 tests (7 backup-store, 24 ACP client, 17 observer, 11
launch-fence, 6 collector-outage, 6 fold), all green. A follow-up commit from the same
analytics lane, `8e7646d7`, landed during this pass and added the AC40 burst case plus the
serialization it pins, so AC40 cites both commits. Package-wide
`tsc` reports only the three pre-existing `AcpInitializeResult` fixture errors in
`src/backend/jcode.test.ts`; no lane file has a diagnostic.

| Case | Commit | What changed | Why the status did or did not move |
| --- | --- | --- | --- |
| AC12 | `eb116314` | Text correction is armed only by a declared peer capability; a declared retraction replaces a named segment's text and recomputes the turn | not started -> partial: the client half now exists and is gated, but jcode 0.99.1 declares no retraction surface, so the path is inert and no live correction was observed |
| AC16 | `9629b7e3` | A Paperclip claim record fences one launcher per managed run, with generation, claimSeq, digest, heartbeat expiry and stale takeover | still partial: a caller-owned record with no cross-process lock, no Paperclip API call and no shipped command, so no two real launchers were raced |
| AC33 | `f734d976` | Restore crosses an object-store boundary with a sealed digest, create-only put and verification before a single-transaction import | still partial: both stores are local or stub, so remote behaviour, server-side checksums and a live cutover are unproven |
| AC37 | `23c29ac3` | A torn read is reported transient instead of surfacing a truncated title or a phantom session, with health on discover, snapshot and observe | still partial: the concurrent writer is the test's own filesystem, and `ops discover --source jcode` drops `page.observation` |
| AC40 | `1b788fff`, `8e7646d7` | Unaccepted events are retained in order across an outage, with a capped buffer, serialized passes and a typed source health | not started -> partial: the collector is a scripted fake transport and the buffer is in-memory, so no real collector was taken down |

Downgraded or narrowed against the lane reports: AC12's report describes a working correction
path, but the only peer that declares the surface is the lane's own fake, so the row says the
client is inert until a peer declares one. AC33's report calls the boundary an object store;
the two implementations are a local filesystem and an in-memory stub, so digest and
conditional-put are harness-enforced. AC16's report fences a managed launch; the fence is a
local record with `dispatch` and `remoteWrite` false. AC40's report describes a collector
outage; no collector process was stopped. AC37's report describes health reporting, which the
library now has, but the shipped `ops discover` discards it.

Live rebind against the real hub, 2026-11-15:

| Case | Evidence |
| --- | --- |
| AC38 | `kimaki/src/ops-rebind-live.test.ts` (new, 2 tests) replaces the hand-written SSE hub of the `2e0ff50d` pass with real `createSessionHub` instances and their real `startHubServer` loopback surface, behind one stable URL served by a test relay that forwards upstream bytes and never invents an event, sequence number or session id. The `session.started` that drives each decision is published by the hub itself: a restart onto a fresh log publishes `{seq:1, session.started, session-b}`, and a restart onto a rotated log restores `seq:4` and republishes `session.started` for the same session at `seq:5` (its own subscriber recorded exactly `[{seq:5, type:'session.started', sessionId:'session-b', model:null}]`). Without `--rebind` the view returns a `ConfigError` naming `session-a` and `session-b`, posts no B message and leaves the cursor on A/4; with `--rebind` it adopts B (`seen = [4, 4]`, state `{session-b, 4}`), and the repeated start at seq 5 neither duplicates `answer:beta` nor suppresses the new turn (`seen = [4, 4, 8]`, channel `answer:alpha, answer:beta, answer:gamma`, state `{session-b, 8}`). Run on this host: `Test Files 1 passed (1)`, `Tests 2 passed (2)`, exit 0, 19.48 s; `tsc --noEmit` exit 0; flipping `rebind: true` to `false` in the second test fails it at `Timed out waiting for B's post`. Commit `d3074bc9`. Outbound Discord REST is `discord-digital-twin`, the same substitution AC04 and AC06 close on. This becomes closed: the two identity changes fall between turns rather than inside an in-flight turn, and the session ids come from the test's backend double rather than a live jcode/kcode runtime, which the row records as remainders |
| AC05 | The same file supplies the live route change AC05 previously lacked: `openDiscordView` attached over real SSE to hub A, then the same URL serving hub B and hub C, so the fail-closed and `--rebind` decisions run against a real hub identity change instead of the hand-written SSE stub of `5b7626f2`. Re-run on this host for this review: `Test Files 1 passed (1)`, `Tests 2 passed (2)`, exit 0, commit `d3074bc9`. The stub-based half-buffered-turn drop and the `5b7626f2` view tests are unchanged and still cited in the row. Remainders: no identity change occurs with a turn in flight, the session ids come from a backend double, continuity is relay-assisted, and outbound Discord REST is the twin |
