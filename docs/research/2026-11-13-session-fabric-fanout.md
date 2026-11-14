# Session fabric: fan-out design note

Date: 2026-11-13 (Pacific). Status: design note, no code. Grounded in the working tree at commit `8e65d60d`, the
uncommitted `kimaki/src/backend/` contract file, and direct ACP probes against a real `jcode 0.99.1`. Claims not
verified against a running service are marked unverified.

Goal: one live backend agent session, several clients attached at once (a Discord channel, a Paperclip agent chat
and a CLI chat all talking to the same session) with realtime sync. herdr-style discovery stops being a one-shot
inventory and becomes a fabric or multiplexer.

## 0. Measured today against jcode 0.99.1

Probed with tools disabled, JSON-RPC 2.0 over stdio. Observations, not API proposals.

1. The ACP control surface works. `initialize` returns `protocolVersion: 1`, `agentInfo { name: jcode, version:
   0.99.1 }`, `agentCapabilities.loadSession: true`, and session capabilities `close` and `resume`. `session/new`
   returns a `sessionId` plus `configOptions`. `session/set_config_option { sessionId, configId: 'model', value:
   'beam-free' }` switches the model, echoes it, and emits a `config_option_update` `session/update`.
   `session/prompt` streams `agent_message_chunk` updates and resolves `{ stopReason: 'end_turn', usage: {
   inputTokens, outputTokens, totalTokens } }`.
2. Model selection is load-bearing. Without an explicit model the session uses the agent default (`deepseek-v4-pro`
   here) and the operator credential returns HTTP 403 "Model access is disabled", surfaced as JSON-RPC error
   `-32000` rather than a protocol-level failure. A fabric must treat model selection as part of session setup.
3. Attach works across processes, fan-out does not. Client A created the session and set the model. Client B ran
   `session/resume { sessionId, cwd, mcpServers }` on a separate `jcode acp` process and succeeded, receiving
   `configOptions` with the model already set. A then prompted. A observed 4 `session/update` frames and the
   assistant text `ok`. B observed 1 update and zero assistant text.
4. Consequence: updates go only to the client that issued the prompt. ACP is a per-connection stream, not a
   broadcast. Realtime multi-client viewing requires a hub by construction, not by preference.

## 1. What exists today

### Identity

`kimaki/src/ops/contracts.ts` defines `SessionKey` as `{ hostId, endpointId, backendKind, nativeSessionId }`, scoped
to a runtime endpoint and explicitly "never a PID or cwd". `ops/registry.ts` serialises that tuple with
`JSON.stringify([...])` in fixed positions and excludes discovery evidence and process incarnation from the id. Two
processes name the same session only if they agree on those four fields.

### Discovery and observation per runtime

| Runtime | File | Behaviour | Kind |
| --- | --- | --- | --- |
| herdr | `ops/discovery/herdr.ts` | `execFile(herdr, ['agent','list'])`, zod-decoded, `coverage: 'herdr-managed-panes-only'` | observation |
| OpenCode | `ops/runtime/opencode.ts` | `session.list` page, `session.get` + `message.list` snapshot, `event.subscribe` | observation |
| Codex | `ops/runtime/codex.ts` | `thread/list`, `thread/read` over a caller-owned app-server | observation |
| Jcode | `ops/runtime/jcode.ts` | reads `<jcodeHome>/sessions/*.json` on a 500 ms poll | observation |

Points that matter for fan-out:

- herdr's `sessionCandidate` is documented in-file as "an unverified reporter claim, not native endpoint identity"
  (`herdr.ts:54`). Pane ids such as `wJ:p19` are herdr-local.
- OpenCode `observe` waits for `server.connected`, then filters by `raw.data.sessionID` locally
  (`opencode.ts:134`). The comment at `opencode.ts:91-93` notes the native transport still receives endpoint-wide
  events before that filter. Awaiting `onEvent` inline (`opencode.ts:135-149`) means one slow consumer stalls the
  whole loop.
- Codex declares `observe: unsupported` because a historical read is not a live attach (`codex.ts:29`).
- Jcode synthesises its own `seq` starting at `0` inside each `observe()` call (`jcode.ts:121`). That is a per-call
  counter, not a durable cursor. Replay is unsupported because Jcode persists state, not an event log
  (`jcode.ts:59`).

### Bindings and fencing

`ops/bindings.ts` writes `ops_surface_bindings`:

- `mode` is forced to `'observe'` and `publication_policy` to `'none'`, anything else is refused
  (`bindings.ts:30-32`).
- `generation` is allocated inside the insert with `MAX(generation)+1`, so allocation and uniqueness are one SQLite
  statement across processes (`bindings.ts:46`).
- `onConflictDoNothing()` plus a re-read on `(service_kind, tenant_id, idempotency_key)` returns the identical row
  for a repeat and refuses a new intent under the same request id (`bindings.ts:49-59`).
- `schema.ts:47-48` has unique `ops_binding_request` and a partial `ops_binding_active_surface` on the active
  state, so a surface has one active binding.
- `detachBinding` only flips `state` to `'detached'` and never touches the runtime.

The binding is a metadata association with no runtime adapter, transcript reader or lifecycle callback
(`bindings.ts:1-2`). It confers no authority.

### Publication out

`ops/discord/publication.ts` posts one fixed allowlisted line with `allowed_mentions: { parse: [] }`, re-validates
consent and scope after the channel lookup (`publication.ts:77-80`), and is deliberately at-most-once: a failed POST
is reported, not retried, because a POST that may have succeeded would duplicate (`publication.ts:3-5`). `cli/ops.ts`
wires this through `ops publish` and `ops follow`, keeping at most one in-flight publication via a single `pending`
promise (`cli/ops.ts:57-67`, `87-96`).

### The ACP-driven Jcode backend

`kimaki/src/backend/acp/contracts.ts` is present as an untracked file. It declares ACP as the control surface and
states that several clients may attach but "Jcode offers no exclusive writer lease" (`contracts.ts:84-87`). Declared
capabilities: `prompt/streaming/cancel: true`, `replay: false`, `exclusiveControl: false`.

There is no `client.ts`, no `backend/jcode.ts` and no ACP CLI wiring in the tree, so the contract file is a seam and
a design statement. The protocol behaviour above was measured directly against the binary, not through this code.

### Control versus observation, stated plainly

- Control in the repo today: none. `registry.ts:9-18` declares create, submit, interrupt and answer-approval
  unsupported across every adapter.
- Control available at the transport: ACP `session/new`, `session/resume`, `session/set_config_option`,
  `session/prompt`, `session/cancel`, per section 0.
- Discovery: herdr plus three native registries, all read-only.
- Publication: outbound observation delivery, one-way, no inbound reply path.

## 2. What fan-out needs that does not exist

1. **Subscriber model with per-client cursors.** `ops_surface_bindings` has no cursor column (`schema.ts:31-49`).
   Jcode's `seq` restarts per call, so a persisted integer would not mean the same thing to two clients. No row
   records "client X consumed position Y".
2. **Ordering and at-least-once delivery.** OpenCode passes `raw: V2Event` through unchanged (`opencode.ts:14-21`),
   and whether that sequence is gapless per session is unverified. ACP `session/update` frames carry no monotonic id
   the probe exposed. There is no fabric-level sequence, no delivery ledger and no acknowledgement.
3. **Backpressure.** `opencode.ts:135-149` awaits each consumer inline. Correct for one observer, wrong for N: the
   slowest client sets the pace. No per-client queue, drop policy or slow-client eviction exists. The CLI sidesteps
   this by allowing one in-flight POST.
4. **Per-client presence and identity.** A binding row has tenant and surface but no client identity, heartbeat,
   last-seen, capability set or per-client rights. The Discord `MetadataGrant` is a caller-owned ephemeral object
   (`publication.ts:1-2`), not a durable identity that distinguishes two clients.
5. **A single serialized writer or explicit multi-writer rules.** No exclusive writer lease is claimed anywhere:
   `bindings.ts:31`, `opencode.ts:63`, `jcode.ts:30` and the ACP contract comment. Section 0 fact 3 shows two clients
   can hold the same session simultaneously, so the question is live.

## 3. ACP as control plane, herdr as discovery plane

herdr's unit is a terminal pane: `pane_id`, `revision`, `state_change_seq`, `agent_status` (`herdr.ts:18-34`). It
reports that something runs and roughly in what state. It carries no content, has no request/response semantics, and
its session claim is unverified. A pane can die, reattach or be replaced while the agent session survives, so pane
identity is strictly weaker than session identity. herdr is a discovery and presence plane.

An ACP session is a protocol object with a daemon-scoped, resumable id, a request stream and a `session/update`
stream, plus defined `session/resume`, `session/prompt` and `session/cancel`. Section 0 fact 3 shows that id survives
across separate `jcode acp` processes, which is exactly what a fan-out key needs and exactly what a herdr pane id
lacks.

Why an ACP session is the better fan-out unit:

- Its id is daemon-scoped and resumable, so it rejoins `SessionKey` across client processes.
- `session/update` is already a subscription feed, so per-client fan-out is filtering, not screen scraping.
- Cancellation is defined, so a client can withdraw intent without killing the session.
- It carries no terminal geometry, so a second client cannot disturb what the first sees.

Why ACP alone is insufficient, now measured. ACP delivers updates only to the prompting connection (fact 3), and
`replay: false` (`contracts.ts:84`) means no resume cursor for a client that misses frames. The durable stream
therefore has to live in the fabric, not in a proxy of one ACP connection.

Upstream herdr has a subscription socket (`docs/research/2026-11-11-herdr-session-binding.md`, H3 and H5) but
Kimaki's adapter only shells `agent list`. That socket is a candidate presence source, never a content transport.

## 4. Three designs, judged against fact 3

### A. Hub owns N client connections

One process attaches once, owns the cursor ledger, and fans out to each client over the channel it already speaks
(Discord REST, Paperclip plugin, CLI socket).

Pros: one writer by construction, one place for cursors, one place for backpressure and drop policy, local duplicate
suppression, consistent with the `pending`-promise serialisation in `cli/ops.ts`. Cons: stateful daemon and single
point of failure, cursors must be persisted to survive restart, it becomes an auth boundary mapping Discord and
Paperclip identities to client records, and it adds a hop.

### B. Broadcast bus, each client holds its own ACP connection

Every client runs its own `jcode acp` process and resumes the same session.

Refuted by the measurement. `session/resume` does succeed for a second client, which is why B looks plausible on
paper, but that client received 1 update and zero assistant text while the first streamed the answer (fact 3). B
would give every client a write path and no reliable read path, so clients would attach and then see silence.

Pros, for completeness: no hub to operate, private backpressure per client, crashes isolated. Cons, decisive: no
streaming fan-out, N writers with no lease, two clients can submit conflicting prompts with no cross-connection
ordering, and cursors die with the connection.

### C. Hybrid, hub owns the writer and clients subscribe read-only

The hub alone issues `session/prompt`, `session/cancel` and `session/set_config_option`. Clients hold a read
subscription and may propose input that the hub accepts under policy.

Pros: removes multi-writer ambiguity without pretending a lease exists, keeps per-client read isolation, fits the
consent-first culture where nothing is written or published without an explicit grant, and lets the binding
generation seal a writer identity. Cons: the read side still needs hub-side fan-out so it collapses into A for reads,
the hub is still a SPOF, and writer election is still unimplemented, so the only real mutex today is hub-local.

**Recommendation.** Implement C and reuse A's machinery for reads: a hub process, a persisted fabric sequence with a
delivery ledger, a per-client queue, and a hub-local single-writer mutex. Treat model selection as part of session
creation through `set_config_option`, and fail session setup on a JSON-RPC error such as `-32000` rather than
presenting a connected session that cannot answer (fact 2).

## 5. Ordering, idempotency and duplicate suppression

Patterns already in the repo:

- **Binding idempotency.** Unique index on `(service_kind, tenant_id, idempotency_key)` plus an equality re-check on
  the returned row (`bindings.ts:49-59`, `schema.ts:47`). A repeat returns the same row, a different intent under the
  same key is refused.
- **Fencing by generation.** `MAX(generation)+1` inside the insert, so a replacement is a new generation and old
  observers are identifiable as stale.
- **At-most-once outbound.** Publication explicitly does not retry (`publication.ts:3-5`, `publication.ts:87`).
- **Late re-validation.** Consent and scope are re-read after the destination lookup (`publication.ts:77-80`), so a
  revoked grant cannot publish mid-flight.

What must be added:

- **Fabric sequence.** A monotonic `fabric_seq` per session allocated by the hub in one SQLite transaction becomes
  the cursor. Native `seq` from Jcode or `V2Event` is evidence only, and ACP `session/update` frames offer no usable
  id (fact 3 exposed counts, not ids).
- **Delivery ledger.** One row per `(binding_id, fabric_seq)` with a unique constraint, written before the side
  effect and marked complete after. Duplicate suppression becomes a constraint violation rather than a heuristic.
- **Exactly-once must be ours.** Measured in the closure ledger (M6, 2026-11-12): two Paperclip wakeups carrying an
  identical `idempotencyKey` produced two distinct runs. A third-party key is not a dedupe guarantee, so for
  `session/prompt` and `session/cancel` the fabric allocates and persists its own request id and reconciles on
  restart instead of retrying blindly.
- **Semantics per class.** For metadata notices, at-least-once plus a unique ledger is effectively-once and a
  duplicate notice is harmless. For control writes the ledger must gate the write itself, and an in-doubt write
  after a hub crash needs reconciliation against the native session, not a replay.
- **Ordering scope.** Ordering is guaranteed per session and per client. Cross-client write ordering exists only
  through the single-writer mutex. Without it no ordering claim is honest.

## 6. Open questions

1. Does ACP `session/update` carry any field usable as a resume cursor? The probe recorded counts and text, not ids,
   so assume no until shown otherwise.
2. Is OpenCode's `V2Event` sequence durable, gapless and per-session? Unverified.
3. What is a client identity for Discord, Paperclip and CLI, and where does presence live?
4. Who may write when two clients both want to prompt: one operator identity, or per-client arbitration with a queue?
5. How long do cursors survive, and what is the contract on hub restart with N clients?
6. Does a resumed session receive updates for triggers other than a prompt from another client, for example a tool
   completion or daemon-side event? Only the prompting connection saw text, so unverified.
7. Can herdr's subscription socket be the presence plane, so pane death and session death are distinguishable?

## 7. Phased plan, small testable increments

1. **Fabric sequence and delivery ledger.** Add `ops_fabric_seq` and `ops_delivery_ledger` in
   `kimaki/src/schema.ts`, mirroring the transaction and unique-index pattern in `ops/bindings.ts`. Test: concurrent
   inserts yield contiguous sequences and a repeated `(binding, seq)` is refused.
2. **Subscriber registry.** New `kimaki/src/ops/fabric/stream.ts` wrapping `createOpenCodeObserver` and
   `createJcodeObserver` unchanged, exposing `subscribe({ key, clientId, cursor })` with a per-client bounded queue
   and drop policy. Test: a stalled client does not delay a fast one and the fast client's cursor advances.
3. **Cursor column and resume.** Add a cursor to `ops_surface_bindings` or a join table and let `ops follow` in
   `kimaki/src/cli/ops.ts` take `--client-id` and resume. Test: a killed and restarted follow republishes nothing,
   which is the case the current e2e gets wrong (`docs/unified-agent-ops-closure-ledger.md:33`).
4. **Writer mutex.** New `kimaki/src/ops/fabric/writer.ts` holding a lease row keyed on the `SessionKey` id, refusing
   a second writer with a typed error. Test: refused while held, accepted after release, stale lease times out.
5. **ACP backend behind the existing contracts.** Add `kimaki/src/backend/acp/client.ts` and
   `kimaki/src/backend/jcode.ts` implementing `AcpClient` and `JcodeBackend`, including `set_config_option` for model
   setup and a typed failure on JSON-RPC `-32000`. Add `ops attach` in `kimaki/src/cli/ops.ts` reporting capabilities
   and refusing when a needed capability is absent. Test: prompt round trip, cancel, refused concurrent prompt, and a
   forced model-access failure reported as a setup error not a live session.
6. **Presence.** Record client heartbeat and last-seen, surface it in `ops bindings`, later add herdr subscription
   reading for pane-death detection. Test: a detached client leaves presence without touching the runtime.
7. **End-to-end fan-out.** One real ACP Jcode session through the hub, two subscribers (CLI plus the Discord follower
   in `cli/ops.ts`), a forced reader stall, then a hub restart. Assert one notice per event, no duplicate after
   restart, and that the non-prompting subscriber sees the answer through the hub even though ACP alone would have
   hidden it.

Increments 1 through 4 are the fabric and must land before 5, because wiring ACP without a ledger and a mutex
reproduces exactly the multi-writer ambiguity that fact 3 makes real.

## Unverified claims in this note

- Whether ACP `session/update` has any monotonic resume identifier.
- Whether OpenCode `V2Event` sequence is durable and gapless.
- Whether the untracked `backend/acp/contracts.ts` reflects any running implementation. No ACP client, backend or CLI
  path exists in the tree, and the measured behaviour came from direct protocol probes.
- Behaviour of a resumed session under triggers other than a prompt from another client.
- herdr subscription socket behaviour as a presence source. Only the upstream research doc was read, not a live
  subscription.

## 8. Update: the hub now exists

The first phased increment in this note is implemented. `kimaki/src/backend/hub.ts` owns one backend session and one writer, publishes an ordered event stream into a bounded replay buffer, and hands clients a cursor. `kimaki/src/backend/hub-server.ts` exposes it on loopback with `GET /state`, `POST /prompt`, `POST /cancel` and `GET /events?cursor=N` over server-sent events. `ops jcode serve` wires those to a real `jcode acp` child.

Measured: two independent clients attached to one hub received an identical sequence (1 to 4) and identical assistant text for a real turn against jcode 0.99.1. Coverage: 11 hub unit tests, 6 server tests, and one opt-in real acceptance (`KIMAKI_JCODE_HUB_E2E=1`).

A later increment added durability. With `--log <path>` the hub appends every event to a JSONL file, restores its sequence and session identity on restart, replays from that file when a cursor predates the in-memory window, and takes an advisory lease so a second hub refuses to write the same session. Measured: after a hard restart the hub resumed at sequence 4 with the same session id, and a fresh client replayed all four events without prompting the agent again. Clients now have identity and acknowledgement too: `GET /events?client=<id>` registers presence, `POST /ack {client, seq}` records how far a client has processed with monotonic updates, and presence ends when the connection closes. Still missing, from section 2: a shared broker across machines, acknowledgement durability across a restart, and routing an ack for a client that is not currently attached.

