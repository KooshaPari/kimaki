# Replacing the bot's OpenCode runtime with jcode/ACP

Status: design document, no code changed. Line numbers are from the working tree at
`E:\koosh\CodeProjects\kimaki` (package `kimaki/`), branch `feat/passive-session-bindings`,
recorded 2026-11-16.

This document is the implementation spec for the *bot side* of the removal. It does not
repeat the file-by-file inventory in `docs/opencode-removal.md`; it answers one question:
what does `src/main.ts` + `src/bot.ts` + `src/sessions.ts` + `src/prompt.ts` actually call
on OpenCode, which of those calls already exist over ACP and the hub, and what an adapter
has to do about the rest.

Read section 5 before believing any estimate. Three of the bot's load-bearing operations
have no jcode counterpart at all, and one of them runs before the first prompt of every
new Discord thread.

---

## 1. The contract the bot consumes today

### 1.1 The single seam (and why it is deceptively narrow)

Every runtime call in the bot goes through one helper:

```
src/bot.ts:89-96   oc(bot, operation, run) reads bot.opencode.endpoint?.client
                   and converts a missing endpoint into OpenCodeUnavailableError
src/bot.ts:53      opencode: OpencodeConnection
src/opencode-server.ts:327-354  OpencodeConnection { connected, endpoint, ready, subscribe, stop }
src/opencode-server.ts:281-285  OpencodeEndpoint { client: OpenCodeClient, url, version }
```

So the bot is coupled to the *shape of `OpenCodeClient`*, not to a transport. That is good
news for the adapter (section 3) and bad news for the gap analysis: `OpenCodeClient` is a
large generated SDK surface, and only about forty of its methods are used.

Two calls bypass `oc()` and touch the endpoint directly:

```
src/prompt.ts:264-270     const client = bot.opencode.endpoint?.client; void client.session.shell(...)
src/sessions.ts:271,274   endpoint.client.integration.list / plugin.list inside createPluginWait
src/event-loop.ts:87,104  connection.client (set in onConnect) -> model.list
```

Everything else is `oc(bot, '<op>', (client) => client.<group>.<method>(...))`.

### 1.2 Operations the bot performs, with call sites

Grouped by what the bot is trying to accomplish. "Needs" is what the bot does with the
result, because that is what an adapter must preserve or refuse.

**Session lifecycle**

| Operation | Call sites | Needs |
|---|---|---|
| create session (title, directory, model, agent, permission rules, metadata) | `src/sessions.ts:496-505` (startSession), `src/sessions.ts:580-589` (startCoordinator) | the returned `session.id`, plus the side effect of applying permissions and metadata |
| get session (directory, title, agent, parentID, revert, metadata) | `src/bot.ts:110`, `sessions.ts:188,323,349,756,807,838`, `event-loop.ts:214,254,335`, `prompt.ts:278,478`, `commands/preference-commands.ts:145,199`, `commands/thread-commands.ts:267`, `commands/session-commands.ts:186` | `location.directory` (cwd, project match, worktree check), `title`, `parentID` (subagent routing), `agent`, `revert.messageID`, `metadata.kimaki` |
| update session (title, metadata, permissions) | `sessions.ts:337,358,678,922`, `ingress.ts:332`, `lock-routes.ts:551` | rename threads, keep the kimaki marker current, move a fork's permissions |
| remove session | `sessions.ts:820,915` | discard a fork after a failed adopt |
| fork session | `sessions.ts:817,904` | `/fork`, `/fork-subagent`, `/btw` |
| move session (new cwd / worktree) | `sessions.ts:107,834` | `/cwd`, worktree forks |
| wait for idle | `prompt.ts:475`, `sessions.ts:836` | `/undo` needs an idle session; worktree move confirmation |
| active sessions map | `sessions.ts:345`, `event-loop.ts:311`, `session-events.ts:316,422`, `coordinator.ts:96`, `scheduler.ts:298`, `commands/worktree-commands.ts:102`, `commands/thread-commands.ts:271` | busy state, hydration after reconnect, "worktree in use" refusal, scheduler skip |
| list sessions | `session-events.ts:377`, `commands/session-commands.ts:150,213` | `/resume` picker, transcript sync |
| mark viewed | `main.ts:147` | clears the Discord unread/footer state |
| compact | `commands/thread-commands.ts:193`, `lock-routes.ts:590` | `/compact`, queued compaction |
| revert stage / clear | `prompt.ts:500,514,519` | `/undo`, `/redo` |
| synthetic message | `coordinator.ts:144` | wake a coordinator without a user prompt |

**Prompting and steering**

| Operation | Call sites | Needs |
|---|---|---|
| prompt (text, files, skills, delivery steer/queue, prompt id, discord metadata) | `prompt.ts:110-118` | the whole turn pipeline: attachment policy, echoes, idempotent prompt ids, `steer` vs `queue` |
| command (`/name args`) | `prompt.ts:322-331` | runs an OpenCode command in the session |
| interrupt (resume: false) | `prompt.ts:164` | replaces the running turn |
| inbox list / cancel | `prompt.ts:194,205`, `lock-routes.ts:645`, `event-loop.ts:360` | the visible queue, `kimaki clear-queue`, `/abort` |
| shell (`!cmd`) | `prompt.ts:266` | native shells that survive aborts |
| shell list / remove | `prompt.ts:281,285` | `/abort` kills running user shells |

**Event stream** (the largest contract, and not an RPC)

| Operation | Call sites | Needs |
|---|---|---|
| one `/api/event` subscription, `server.connected` handshake, keepalive watchdog | `opencode-server.ts:350-480` | every Discord render |
| fold `V2Event` into a thread view | `event-loop.ts:466-470` (`onEvent`), `thread-reducer.ts:389-620` | see the vocabulary below |
| second, independent subscription for `kimaki session wait` | `session-events.ts:404-436` | status of a run on demand |

The reducer consumes these event types and nothing else: `session.execution.started`
`session.execution.succeeded` `session.execution.failed` `session.execution.interrupted`
`session.step.started` `session.step.ended` `session.text.ended` `session.retry.scheduled`
`session.tool.input.started` `session.tool.called` `session.tool.progress`
`session.tool.success` `session.tool.failed` `session.shell.started` `session.shell.ended`
`session.compaction.ended` `session.compaction.failed` `session.inbox.enqueued`
`session.inbox.delivered` `session.inbox.cancelled` `session.inbox.delivery.changed`
`session.moved` `session.model.selected` `session.agent.selected` `form.created`
`form.replied` `form.cancelled` `permission.asked` `permission.replied`
(`thread-reducer.ts:389-620`), plus the `kimaki.*` internal events the bot dispatches
itself (`event-loop.ts:466-470`).

**Catalog, models, agents, providers**

| Operation | Call sites | Needs |
|---|---|---|
| model.list (+ context window per model) | `event-loop.ts:104`, `commands/thread-commands.ts:269`, `commands/preference-commands.ts:218` | the `/model` picker and the context-percent footer (`Prefs.models`) |
| model.default | `commands/preference-commands.ts:159,180,243` | "OpenCode default" label in `/model` |
| provider.list | `commands/preference-commands.ts:219` | `/model` grouping |
| switchModel (providerID + id + variant) | `sessions.ts:193`, `commands/preference-commands.ts:69` | `/model per thread`, `--model`, agent model |
| agent.list | `sessions.ts:138`, `slash-commands.ts:172`, `commands/session-commands.ts:231` | `/agent`, `--agent`, instruction text |
| switchAgent | `sessions.ts:199` | `/agent`, agent-per-route |
| skill.list | `slash-commands.ts:174,189`, `voice-call.ts:153` | dynamic `/<skill>` routes |
| command.list | `slash-commands.ts:173,193`, `prompt.ts:306`, `commands/thread-commands.ts:146` | dynamic `/<command>` routes |
| integration.list (+ `plugin.list`) | `sessions.ts:129,271` | `waitForPlugin`, the catalog-readiness barrier |
| integration / credential / oauth | `commands/login-commands.ts:43,65,75,76,99,106,111,117,121,196,230,285,318,328` | `kimaki login`, `/login` |
| location.get | `commands/session-commands.ts:210` | `/resume` project id |
| file.find | `commands/session-commands.ts:245` | file autocomplete |

**Permissions, questions, history, instructions**

| Operation | Call sites | Needs |
|---|---|---|
| permission.list | `event-loop.ts:362`, `session-events.ts:425` | the approval cards |
| permission.reply (decision) | `permissions.ts:114`, `prompt.ts:155` | buttons, and "reject everything" on a new message |
| form.list / cancel / reply | `event-loop.ts:361`, `session-events.ts:424`, `prompt.ts:152`, `questions.ts:277` | the question UI |
| message.list (paged, typed: user/assistant/tool/compaction, with `tokens` and `time`) | `session-events.ts:370`, `sessions.ts:691`, `prompt.ts:481`, `coordinator.ts:37`, `commands/session-commands.ts:121`, `commands/thread-commands.ts:268,270` | history replay on `/resume`, `/undo` boundaries, `session read`, coordinator run boundary, critique |
| instructions.entry.put | `sessions.ts:247` | **the agent's entire operating contract for the session** (`system-prompt.ts` + `baseInstructions`) |

### 1.3 Coupling that is not an API call but is part of the contract

1. **The plugin.** `main.ts:168` installs `plugins/kimaki/index.js` into OpenCode's config
   dir and `sessions.ts:321` blocks every new session until `plugin.list` reports it
   active. The plugin renders `<discord-user>` context per request, owns the question
   buttons, the coordinator behaviour and the prompt-cache warmup. ACP has no plugin
   system. This is not "one more method", it is a second codebase that lives inside the
   runtime process.
2. **`metadata.kimaki`.** `readMarker`/`ensureSessionMarker` (`bot.ts:174-190`,
   `sessions.ts:305-340`) store `dataDir`, `lockPort`, `threadId`, `parentSessionId`,
   `task` on the *session object*. `kimaki sleep`, the scheduler and the agent's own
   `kimaki send` read it back. jcode has no session metadata channel.
3. **`OPENCODE_SESSION_ID`.** `cli/shared.ts:22,57-59`, `lock-routes.ts:88` and
   `system-prompt.ts` tell the agent which session it is in so it can call
   `kimaki send --session`. There is no ACP equivalent.
4. **Usage.** `sessionUsage` (`session-events.ts:153-172`) reads per-message `tokens`
   (`input/output/reasoning/cache.read/cache.write`). Context-percent comes from
   `model.list().limit.context`. Neither exists on the ACP surface.
5. **One event stream per runtime.** The bot assumes a single subscription sees *every*
   session, including sessions a user is driving in the jcode TUI.

---

## 2. Verdict per operation

Legend: **provided** = a real, exercised ACP/hub primitive that preserves the semantics
the bot needs. **partial** = a primitive exists but loses a field, a direction, or a
delivery guarantee the bot relies on. **absent** = no primitive at all.

### 2.1 What the ACP transport actually exposes today

`src/backend/acp/contracts.ts:98-158` (`AcpClient`) is the whole surface:

```
initialize()                                   client.ts:272-297
newSession({ cwd })                            client.ts:299-310     -> session/new
setModel({ sessionId, model })                 client.ts:312-335     -> session/set_config_option {configId:'model'}
loadSession({ sessionId, cwd })                client.ts:337-362     -> session/load, replays history in notifications
prompt({ sessionId, text, onChunk, timeoutMs }) client.ts:364-405    -> session/prompt
cancel({ sessionId })                          client.ts:407-419     -> session/cancel (notification, no ack)
close()                                        client.ts:421-...
```

Routing is single-prompt: `routeUpdate` (`client.ts:130-190`) only accepts
`session/update` for the prompt that is currently `active` (`client.ts:131-137`), and only
handles `user_message_chunk`, `agent_message_chunk` and (undeclared by jcode) a retraction
kind.

### 2.2 What the hub adds

`src/backend/hub.ts` + `hub-server.ts` + `hub-client.ts`: one writer, ordered events with
a monotonic `seq`, in-memory replay buffer plus optional JSONL log, per-client cursors and
acks, an advisory writer lease. Its event vocabulary is its own, not `V2Event`:

```
session.started / prompt.started / prompt.chunk / prompt.finished / prompt.failed
hub.ts:27-33
```

HTTP surface: `GET /state`, `POST /prompt`, `POST /cancel`, `POST /ack`,
`GET /events?cursor=N&client=<id>` (`hub-server.ts:1-12,60-160`).

The hub is a *fan-out* layer, not a capability layer. It does not add model listing,
permissions, history paging or session lifecycle.

### 2.3 Verdict table

| Bot operation | ACP | Hub | Verdict |
|---|---|---|---|
| create session | `session/new` | `session.started` (echo) | **partial**: no title, agent, permission rules, metadata or model at create time (model needs a second call) |
| get session (directory/title/agent/parent/revert/metadata) | none | none | **absent** |
| update session (title, metadata, permissions) | none | none | **absent** |
| remove session | none | none | **absent** |
| fork session | none | none | **absent** |
| move session / worktree relocation | none | none | **absent** |
| wait for idle | `session/prompt` result marks the end of *one* turn | `prompt.finished` | **partial**: only for a turn this process started |
| active sessions | none | `snapshot().busy` per hub | **absent** across sessions |
| list sessions | none (only `ops discover` polling of `sessions/session_*.json`) | none | **absent** for the bot |
| mark viewed | none | none | **absent** |
| compact | none | none | **absent** |
| revert stage/clear (undo/redo) | none | none | **absent** |
| synthetic message | none | none | **absent** |
| prompt (text) | `session/prompt` | `POST /prompt` | **partial**: text only, one in flight, no `delivery`, no files, no skills, no prompt id, no metadata |
| command (`/name args`) | none (would be plain text) | none | **absent** |
| interrupt | `session/cancel` | `POST /cancel` | **partial**: fire-and-forget notification, no `resume:false` semantics, no confirmation |
| inbox list/cancel (queue) | none | none | **absent** |
| shell (`!cmd`) | none | none | **absent** |
| shell list/remove | none | none | **absent** |
| event stream, all sessions | `session/update` for the active prompt only (`client.ts:131-137`) | ordered stream per hub | **partial**: no cross-session stream, no events from a run another client is driving |
| stream vocabulary (steps, tools, retries, compaction, inbox, tokens) | text chunks only (`agent_message_chunk`/`user_message_chunk`) | five hub event kinds | **absent** |
| model.list (+ context window) | `configOptions` in `setModel`/`loadSession` responses only | none | **partial**: current value only, no catalog, no context size |
| model.default | none | none | **absent** |
| provider.list | none | none | **absent** |
| switchModel (provider + id + variant) | `session/set_config_option` with one string | none | **partial**: one opaque model string, no provider/variant split |
| agent.list / switchAgent | none | none | **absent** |
| skill.list / command.list | none | none | **absent** |
| integration.* / credential.* / oauth.* / plugin.list | none | none | **absent** |
| location.get / file.find | none | none | **absent** |
| permission.list / permission.reply | none (agent→client requests are dropped, `client.ts:222`) | none | **absent** |
| form.list / reply / cancel | none | none | **absent** |
| message.list (history, typed, tokens) | `session/load` replays `{role:'user'|'agent', text}` only (`contracts.ts:82-97`) | none | **partial**: text only, no ids, no timestamps, no tool parts, no tokens, one load per connection |
| instructions.entry.put | none | none | **absent** |
| usage / cost accounting | `usage {inputTokens, outputTokens, totalTokens}` on the prompt result (`client.ts:396-402`) | none | **partial**: per prompt, no cache, no cost, no per-message attribution |

Tally over the 34 rows above: **provided 0, partial 9, absent 25**. The zero is not
rhetoric: two primitives genuinely exist (`session/new`, `session/prompt`) and they are the
only reason this path is worth designing at all, but no *bot operation* survives whole,
because each one also carries a field, a rule or a delivery guarantee that ACP does not
have. That is the honest starting point, and it is why the rest of this document is a
bottleneck analysis, not a transport swap.

---

## 3. Adapter design

### 3.1 Keep the seam, change the implementation

Do not introduce a second interface for the bot to learn. `oc()` already converts "no
endpoint" and "rejection" into error values, and every caller already handles the error
union. So the adapter should satisfy the *same property names* the bot reads today:

```
src/backend/jcode-connection.ts       new module (the adapter)
  export function createJcodeConnection(options): JcodeConnection

  JcodeConnection satisfies OpencodeConnection (opencode-server.ts:327-354)
    connected, endpoint: { client: JcodeRuntimeClient, url, version }, ready, subscribe, stop
```

`JcodeRuntimeClient` is a hand-written object with the same method paths the bot calls
(`session.create`, `session.get`, `session.update`, `message.list`, `model.list`,
`permission.reply`, ...). Each is one of three things:

1. **implemented over ACP** (section 3.2),
2. **synthesized from kimaki's own SQLite** (documented in 3.3 as "fake"),
3. **refused** with a new tagged error `UnsupportedRuntimeError`
   (`src/errors.ts`, next to `OpenCodeError`), which `oc()` passes through unchanged.

Type safety comes for free: extract the client type the bot depends on instead of importing
the SDK type. Add to `src/bot.ts`:

```
export type RuntimeClient = Pick<OpenCodeClient,
  'session' | 'message' | 'model' | 'agent' | 'command' | 'skill' | 'permission'
  | 'session.form' | ... >   // the exact groups listed in 1.2
```

and change `oc()` / `OpencodeConnection` to `RuntimeClient`. `tsc --noEmit` then lists every
gap mechanically. This is step 0.2 of `docs/opencode-removal.md` and should be done first,
with OpenCode still the only implementation.

### 3.2 Mapping each operation to ACP

Implemented (real ACP calls, real jcode):

| Bot operation | Adapter implementation |
|---|---|
| `session.create({title, location, model, agent, permissions, metadata})` | `createAcpClient(...)` once per connection; `initialize()`; `newSession({cwd: location.directory})`; if `model` is present, `setModel({sessionId, model})`. Title/agent/permissions/metadata go to kimaki's SQLite (3.3). Return `{ id: sessionId }`. File: `src/backend/jcode-acp-session.ts` (new), reusing `src/backend/acp/client.ts`. |
| `session.prompt({sessionID, text, files, skills, delivery, metadata})` | `prompt({sessionId, text, onChunk})`. `delivery: 'steer'` becomes `cancel()` then `prompt()`, which is the ACP equivalent of `interrupt` + prompt. `delivery: 'queue'` is **refused** (no inbox). `files`/`skills` are concatenated into the prompt text only if a bounded inline format is acceptable; otherwise refused. |
| `session.interrupt` | `cancel({sessionId})`. Returns `undefined` (no ack exists). |
| `session.get` | synthesized (3.3): `location.directory` from kimaki's binding record, `title` from the thread name, `agent`/`model` from the last `setModel` reply, `parentID` from `thread_sessions.parent_session_id`, `metadata.kimaki` from the marker table. |
| `message.list` (history) | `loadSession({sessionId, cwd})` on a fresh client, mapping `AcpHistoryMessage[]` to assistant/user `Message` objects with synthetic ids (`index`-derived) and `time.created = 0`. Refused fields: `tokens`, `finish`, tool parts, `compaction`. Pagination is client-side. |
| `model.list` | refused, or reduced to a one-element list built from the session's `configOptions.currentValue` (see 3.4 on naming). |
| `session.active` | synthesized: the set of sessions this process currently has a prompt in flight for. Sessions another client is driving are invisible, and the adapter must say so rather than report "idle". |
| `session.wait` | implemented as "await the in-flight `prompt()` promise for this session", refusing when no prompt is in flight. |
| `session.remove` | refused. The jcode store has a `sessions/session_*.json` file; deleting it is a destructive write with no ACP method, and the bot has no business doing it. |
| everything else in 1.2 | refused with `UnsupportedRuntimeError` naming the operation and the reason. |

`src/backend/jcode.ts` needs one addition before the adapter can be built cleanly: today
`start()` only ever calls `newSession` (`jcode.ts:132-196`), so there is no way to attach an
existing jcode session. Add `attach({sessionId, cwd})` that calls
`loadSession({sessionId, cwd})` and records it as `started`, with `sessionId()` returning
it. `ops jcode history` (`src/cli/ops.ts:1012-1045`) already proves `loadSession` works
against the real binary.

### 3.3 What it must fake, and where the fake lives

| Fake | Source | Why it is honest |
|---|---|---|
| session title | `thread_sessions.last_synced_name` / the Discord thread name | it is what Discord shows anyway |
| session directory | new `thread_sessions.directory` column, written at bind time from `channel_directories.directory` or the worktree checkout | the bot already knows the cwd; it just used to ask OpenCode |
| `metadata.kimaki` | new table `session_markers(session_id PK, data_dir, lock_port, thread_id, channel_id, parent_session_id, task_json)` | the marker is kimaki state that happened to be stored on a foreign object |
| permissions on create | `session_markers` + the adapter's own allow/deny check before `prompt` | ACP has no rule language; see 5.2, this is the weakest fake |
| busy state | in-process prompt table | never claim "idle" for a session this process does not own |

Migration: one additive SQL migration adding `thread_sessions.directory`,
`thread_sessions.runtime` (default `'opencode'`) and the `session_markers` table. That
column is also the only safe way to route a thread: inferring the runtime from the id
format is exactly the kind of guess that corrupts a binding.

### 3.4 Event translation

New module `src/backend/jcode-events.ts`:

```
translateAcpUpdate({sessionId, update}) -> V2Event | null      // client.ts:130-184 feeds this
translateHubEvent({sessionId, event})  -> V2Event | null      // hub.ts:27-33
```

It can emit exactly four shapes the reducer understands:

* `session.execution.started` when a `prompt()` call begins,
* `session.text.ended` from the concatenated `agent_message_chunk` text at `prompt` resolution,
* `session.execution.succeeded` / `session.execution.failed` from the prompt result or error,
* `session.model.selected` when `setModel` confirms.

It cannot emit `session.step.*`, `session.tool.*`, `session.retry.scheduled`,
`session.compaction.*`, `session.inbox.*`, `form.*` or `permission.*`. Emitting invented
shapes for those is worse than emitting nothing: the reducer's typing, footer and
queue logic would show confident nonsense.

`thread-reducer.ts` therefore needs a documented degraded mode, or the Discord surface
loses tool calls, step progress, retries, compaction notices and the queue.

### 3.5 Session identity: `thread_sessions.session_id`, resume, and the import path

`thread_sessions.thread_id -> session_id` is the bot's only durable link
(`schema.ts:95-105`; also `scheduled_tasks.session_id`, `session_sleeps.session_id`). The
jcode session id is simply stored in the same column, with `runtime='jcode'`:

```
bind:     thread_sessions(thread_id, session_id=<acp sessionId>, runtime='jcode', directory=<cwd>)
resume:   roots[threadId] -> session_id -> attach({sessionId, cwd: row.directory})
          (jcode.ts:attach -> acp loadSession, which replays history for kimaki.replay)
new:      create -> session/new -> bind as above
```

This is where the existing import work plugs in, and it is already half built:

* `ops discover --source jcode` (`cli/ops.ts:323-374`) enumerates native
  `sessions/session_*.json` records with id and title, and refuses torn records rather than
  reporting them (`ops/runtime/jcode.ts`, `readConsistent`).
* `ops jcode history --session <id>` (`cli/ops.ts:1012-1045`) replays the native history
  over ACP.
* `kimaki discord-view bind` (`cli/bot.ts:458-484`) already mirrors one native session into
  a channel from the hub.

So an imported thread is: a `thread_sessions` row whose `session_id` is a native jcode id
and whose `runtime` is `'jcode'`, plus `kimaki.replay` events built from `loadSession`.
Nothing needs to be rewritten, because the id is already native.

Two identity facts to verify before relying on them (not yet proven in the repo):

1. the ACP `sessionId` equals the `session_<id>.json` id, so discovery and ACP name the
   same object;
2. `session/load` history is stable across two loads (the `ops jcode watch` comment at
   `cli/ops.ts:800-805` says a second load on the same connection returns the first load's
   history, which is a different claim).

For OpenCode sessions that predate the cutover, do not rewrite ids: keep
`runtime='opencode'` rows resolved through the legacy connection (Phase 1) or export and
accept a *new* jcode session id, updating `thread_sessions`, `scheduled_tasks.session_id`
and `session_sleeps.session_id` in one transaction. A silent rewrite is a data-loss bug.

### 3.6 Process model

Recommendation for Phase 1: **do not put the hub on the bot's critical path.** Use one
`createAcpClient` child per *live Discord session*, spawned lazily on the first prompt and
closed after an idle timeout. Reasons, all from the code as it stands:

* ACP routes `session/update` only to the active prompt (`client.ts:130-137`), so a shared
  child serializes turns; Discord threads must run concurrently.
* The hub refuses a second prompt while busy (`hub.ts:submit`, `A prompt is already running
  in this session`), which is the right rule for a session and the wrong rule for a bot
  serving forty threads.
* The hub's value is fan-out to other clients, which is what `ops jcode serve` and
  `discord-view bind` already do. The bot is the single writer of its own sessions.

Use the hub where the bot is *not* the writer: imported/attached sessions that a native
jcode client may also drive. There, `openHubStream` gives cursors and replay, and
`ops jcode watch` (polling `session/load`) is the only mechanism that can see another
client's turn (`cli/ops.ts:800-833`).

---

## 4. Migration seam

### 4.1 Where the switch lives

Exactly four edits, in this order. Each is independent enough to review alone.

```
1. src/cli/bot.ts:184
     const opencodeCheck = await ensureOpencode({...})
   becomes conditional:
     if (backend === 'opencode') { const check = await ensureOpencode({...}); ... }
     else { const check = await ensureJcode({ profile }); ... }
   where `backend` comes from a new --backend option or KIMAKI_BACKEND, resolved once by a
   new exported const (do not duplicate the default in three places).

2. src/cli/bot.ts:214-222
   the options object passed to startBot gains `backend`, and stops hard-passing
   `ensureOpencode: true` / `opencodeServiceFile` when backend is jcode.

3. src/main.ts:170-177
     const opencode = watchOpencode({ ... })
   becomes
     const runtime = options.backend === 'jcode'
       ? createJcodeConnection({ ... })      // src/backend/jcode-connection.ts
       : watchOpencode({ ... })
   `runtime` keeps the name `opencode` on the Bot object for this phase (Bot.opencode,
   bot.ts:53), or rename the field to `runtime` in the same commit and let tsc find the
   call sites. The second is cleaner and mechanical.

4. src/main.ts:168
     const plugin = await installPluginShim({ configDir: options.opencodeConfigDir })
   is skipped when backend is jcode (there is no plugin host). The bot must then log, at
   startup, which of the plugin-owned behaviours (question buttons, per-turn Discord
   context, coordinator, warmup) are unavailable.
```

`src/main.ts:147` (`session.view`) and `:113-116` (`channelDefaults`) need no edit if the
fake in 3.3 is in place; they go through `oc()` and get a synthesized answer or an explicit
refusal.

### 4.2 Fallback rule: fail closed, with one visible exception

* If `--backend jcode` is selected and the binary, profile handshake or `session/new`
  fails, the bot **fails startup** (`failStartup`), exactly like a missing OpenCode today
  (`cli/bot.ts:185-188`). It must never fall back to OpenCode: a fallback would create
  session ids in a second id space under one `thread_sessions` row and deliver prompts to a
  runtime the operator believes is gone.
* If an individual operation is unsupported (`session.compact`, `permission.reply`,
  `inbox.list`, ...), the adapter returns `UnsupportedRuntimeError`, the caller surfaces it
  to the user as "not supported on this runtime", and the action is **not retried on
  OpenCode**. Silent downgrade is how a runtime cutover becomes a data incident.
* The one non-fallback exception: threads whose `runtime='opencode'` row still exists keep
  routing to the legacy connection until they are exported. That is explicit legacy
  routing, it must appear in `kimaki status` (`lock-routes.ts:313` already prints
  `opencode: {connected, url, version}`; make it print `runtime: jcode` and the count of
  legacy-bound threads), and it is removed only after the export in
  `docs/opencode-removal.md` Phase 1.2 runs.

Default in Phase 1 stays `opencode`, so no existing user is touched. Phase 2 flips the
default and deletes `watchOpencode` only after the jcode path has run in production.

### 4.3 What must land before the flag is worth flipping

1. The `session_markers` + `directory` + `runtime` migration (3.3).
2. `attach()` on `src/backend/jcode.ts` (3.2).
3. `src/backend/jcode-connection.ts` with every operation exercised by a scripted ACP peer
   (the pattern in `src/backend/acp/client.test.ts`), asserting *refusal messages*, not
   just absence of crash.
4. A start-to-first-prompt acceptance run against the real binary, gated the way
   `ops-jcode-acp.e2e.test.ts:12` is gated. Without it, nothing above is evidence.

---

## 5. Risks, ordered by what breaks first in production

### 5.1 The first new thread dies at `instructions.entry.put` (before any prompt)

`startSession` does, in order: `session.create` (`sessions.ts:496`), then
`putInstructions` -> `client.session.instructions.entry.put` (`sessions.ts:247`), then
`bindThread` (`sessions.ts:520`), then the first prompt. `session/create` maps fine to
`session/new`; the instructions entry has no ACP counterpart. So the very first thing a
user does after enabling jcode fails, and it fails *after* the jcode session was created
and *after* the Discord thread was created. Note that only a failure inside `setup`
deletes the thread (`sessions.ts:480-483`); a failure after `session.create` leaves an
orphan thread plus an orphan jcode session.

There is no clean fix: ACP has no per-session system instruction. Options, all with costs:
prepend to every prompt (changes the prompt cache and the agent's view of the task),
write a project `AGENTS.md` (mutates the user's repo, unacceptable), or ask jcode to grow an
instruction channel. **Blocking.**

### 5.2 Permissions and approvals have no transport at all

The bot's approval UI is built from `permission.asked` events and answered with
`permission.reply` (`permissions.ts:114`, `prompt.ts:152-155`). On ACP, the direction is
inverted: the agent sends a `session/request_permission` *request* to the client, and the
client must answer. `src/backend/acp/client.ts:222` drops every inbound frame that carries
a `method`, and the initialize handshake advertises empty `clientCapabilities`
(`client.ts:273`). Consequences:

* a jcode turn that needs approval gets no answer and stalls until its timeout, and
  `jcode acp --tool-profile full` is the mode most likely to ask;
* the bot's own rules (`NO_QUESTION_TOOL`, `disabledSkillRules`, `--permission`) cannot be
  expressed, because they are OpenCode permission rules stored on the session
  (`sessions.ts:49,501,585,678`);
* `cancelPendingUi` (`prompt.ts:150-160`) has nothing to cancel.

Mitigation requires a new ACP client capability handler plus a decision policy, and it is
strictly larger than "map a method". **Blocking for any tool-using deployment.**

### 5.3 No event stream the bot can rely on

Two independent breaks:

1. `routeUpdate` only delivers to the prompt that is `active` on *this* connection
   (`client.ts:131-137`). The bot's architecture is the opposite: one stream, every
   session, including runs started by `kimaki send` from an agent shell, the scheduler, or
   a user typing in the jcode TUI.
2. jcode does not stream another client's turn into an attached ACP session, observed and
   documented at `cli/ops.ts:800-805` ("zero updates while `jcode run --resume` wrote to the
   same session"). The only workaround in the repo is `ops jcode watch`, which polls
   `session/load` every N ms and diffs history (`cli/ops.ts:296-344`).

So Discord would show text only for turns this process started, arriving at turn end
rather than streaming, and would show nothing at all for TUI input. Polling `session/load`
is a usable degraded mode (it is what `discord-view` already does), but it changes the
product: no live typing indicator, no tool progress, latency of one poll interval.

### 5.4 The reducer's vocabulary is missing, and it is not cosmetic

`session.step.started/ended`, `session.tool.*`, `session.retry.scheduled`,
`session.compaction.*`, `session.inbox.*` (`thread-reducer.ts:428-620`) drive tool-call
rendering, the step footer, retry warnings, the queue and the compaction notice. ACP's
`session/update` carries text chunks and nothing else in the shipped client. Losing the
tool events means a Discord thread stops being an auditable log of what the agent did,
which is most of kimaki's value.

`session.text.ended` is also the only place the reducer sees the *complete* text, so a
translation that only streams `agent_message_chunk` must still emit one `session.text.ended`
per turn or the markdown renderer will show partial blocks.

### 5.5 Model and provider naming diverge

Kimaki stores `providerID + id + variant` (`bot.ts:38` for the type,
`bot.ts:208-217` for the parser), and
`channel_models`/`global_models` persist `"provider/model"` plus a variant string
(`schema.ts`, `commands/preference-commands.ts`). ACP takes one opaque string
(`session/set_config_option {configId:'model', value}`, `client.ts:317-334`) and returns
`configOptions[].currentValue`. So:

* every stored model selection becomes unparseable by the new runtime;
* variants (reasoning effort) have no channel;
* `model.list`/`model.default`/`provider.list` are gone, so `/model` has no picker;
* nothing verifies that the string jcode accepts corresponds to the model the user chose.

### 5.6 Usage accounting and cost quietly go to zero

`sessionUsage` (`session-events.ts:153-172`) and the context footer need per-message
`tokens` with cache read/write, and `model.list().limit.context`. Neither exists. ACP's
`usage` (`client.ts:396-402`) is per prompt, without cache or cost, and jcode 0.99.1 is not
proven to send it at all. Analytics `observe` (`event-loop.ts:179`) will simply stop
recording, which is silent: no error, just empty dashboards.

### 5.7 Operations the bot needs that jcode cannot do at all

Plainly, with no smoothing:

* session metadata (`metadata.kimaki`) and per-session instructions;
* permission and question surfaces in the direction the bot needs them;
* `session.active`, `session.list`, `session.get`, `session.update`, `session.remove`;
* fork, move, compact, revert (undo/redo), synthetic messages;
* inbox (queue) and user shells (`!cmd`);
* agent catalog and agent switching;
* model catalog, provider list, default model;
* slash commands and skills as catalog objects;
* provider login / credentials (`kimaki login`, `/login`);
* cost accounting;
* the OpenCode plugin's behaviours (per-turn Discord context, question buttons,
  coordinator, prompt-cache warmup), which are a second codebase inside the runtime, not an
  API.

### 5.8 Recovery and restart

`watchOpencode` retries with backoff and rehydrates from `session.active` + snapshots
(`opencode-server.ts:440-480`, `event-loop.ts:299-362`). On jcode, a bot restart mid-run
loses the rest of that turn (no events are replayed to a fresh connection), and there is no
`session.active` to rehydrate from, so `kimaki.snapshot` cannot be built. `kimaki restart`
(`cli/bot.ts:391`) promises "Sessions keep running in OpenCode": that promise is not
currently keepable on jcode without a polling resync.

---

## 6. Sequence a human should approve

1. **Phase 0a**: extract `RuntimeClient` from the bot's OpenCode usage, `tsc --noEmit`
   clean, no behaviour change. This is the only step that is pure refactor.
2. **Phase 0b**: add `session_markers`/`directory`/`runtime` migration and
   `attach()` on `src/backend/jcode.ts`.
3. **Phase 0c**: `src/backend/jcode-connection.ts` + `src/backend/jcode-events.ts`, honest
   refusals, scripted-peer tests.
4. **Phase 0d**: `KIMAKI_BACKEND=jcode` behind a flag, default unchanged, `kimaki status`
   reports the runtime and the legacy-thread count.
5. Stop. Do not delete anything until 5.1 and 5.2 have an answer from the jcode side, or
   until the product accepts a Discord surface without instructions, permissions, tools,
   queue, undo or model pickers. That acceptance is a product decision, not an engineering
   one, and it should be written down before anyone deletes `watchOpencode`.
