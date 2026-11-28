# Jcode caller mapping for the `oc()` surface

Scope: every non-test caller of the OpenCode client (`oc(bot, ...)` or a direct
`OpenCodeClient` read) and the jcode surface that exists for it today. Read-only
analysis; no source was edited. Input inventory:
`C:\Users\koosh\Agents\scratch\swarm\opencode-removal-inventory.md`.

Method: read each call site, then verified every named surface by reading code or
running the binary. Tags:

- **[ACP]** verified in `kimaki/src/backend/acp/contracts.ts` (and its tests).
- **[CLI]** verified by running `jcode <sub> --help` and, where stated, the command.
- **[JSON]** verified by inspecting a real record under `~/.jcode/sessions/` or the
  fields `src/ops/runtime/jcode.ts` reads.
- **[IN-REPO]** verified by reading `src/backend/jcode.ts`, `hub.ts`,
  `instructions.ts`, or `src/ops/runtime/jcode.ts`.
- **UNVERIFIED** means the name exists but its payload/behaviour was not proven.

## Surfaces that exist today (the whole vocabulary)

| surface | kind | verified evidence |
|---|---|---|
| `session/new {cwd}` -> `{sessionId}` | [ACP] | `contracts.ts`; `backend/jcode.ts:161` |
| `session/load {sessionId, cwd}` -> replayed history + `configOptions` | [ACP] | `contracts.ts`; `ops jcode history`; probe returned model/thought_level options |
| `session/prompt {sessionId, text}` -> stopReason/text/updateCount/usage | [ACP] | `contracts.ts`; `backend/jcode.ts:191`; seam write path |
| `session/cancel {sessionId}` | [ACP] | `contracts.ts`; `backend/jcode.ts:207` |
| `session/set_config_option {configId:'model', value}` | [ACP] | `contracts.ts`; `backend/jcode.ts:168` |
| `session/request_permission` -> `answerServerRequest` | [ACP] | `contracts.ts`; `acp/approvals.ts` + tests |
| `session/update`: `user_message_chunk`, `agent_message_chunk`, `agent_message_retraction` | [ACP] | `acp/client.ts` routeUpdate |
| `jcode run [--json|--ndjson] [--resume <id>] <message>` | [CLI] | `jcode run --help` |
| `jcode session rename <session> [name] [--clear] [--json]` | [CLI] | `jcode session rename --help` |
| `jcode debug sessions` -> JSON array | [CLI] | ran it; keys `session_id, friendly_name, model, provider, status, is_processing, working_dir, token_usage, swarm_id` |
| `jcode debug state -S <id>` -> JSON | [CLI] | ran it; keys `session_id, messages, model, provider, is_canary, server_version, upstream_provider` |
| `jcode debug history -S <id>` -> JSON array of `{role, content}` | [CLI] | ran it; roles include `system,user,tool` (assistant observed in earlier runs) |
| `jcode debug message <text> -S <id> [-w]` | [CLI] | flags in `jcode debug --help`; send behaviour UNVERIFIED |
| `jcode model list` | [CLI] | ran it; one model id per line |
| `jcode provider list` / `jcode provider current` | [CLI] | subcommands in help; output UNVERIFIED (`current` hung on the live daemon) |
| `jcode login`, `jcode provider add` | [CLI] | help; interactive, not scriptable |
| durable JSON: `id, parent_id, title, custom_title, created_at, updated_at, messages[], model, provider_key, reasoning_effort, working_dir, short_name, status, last_pid, last_active_at, saved, is_canary, env_snapshots, model_usage_turn_id` | [JSON] | real `~/.jcode/sessions/session_*.json` |
| durable message: `{id, role: user\|assistant, display_role?, timestamp, token_usage?, tool_duration_ms?, content:[{type,text}]}`; content types `text, reasoning, reasoning_trace, open_a_i_reasoning, tool_use, tool_result, image` | [JSON] | 60 real sessions |
| `readConsistentRecord`, `discover`, `readSnapshot`, `observe` (title + message count only) | [IN-REPO] | `src/ops/runtime/jcode.ts` |
| `SessionHub` events `prompt.chunk/prompt.finished/prompt.failed`, `submit`, `cancel` | [IN-REPO] | `src/backend/hub.ts` |

## Caller mapping

Verdict is per row: **PORT** (an equivalent exists), **BUILD** (must be built),
**DROP** (Discord-only UX or no jcode meaning).

| caller | `oc()` calls (method -> need) | jcode surface today | verdict |
|---|---|---|---|
| `bot.ts` | `session.get` -> `location.directory` | [JSON] `working_dir`; [CLI] `debug sessions` `working_dir` | PORT |
| `coordinator.ts` | `message.list` (desc pages) -> last run messages; `session.active` -> busy map; `session.get` -> title; `session.synthetic` -> note an item without a model turn | [CLI] `debug history -S`; `debug sessions` `is_processing`; `session.get` as above. Synthetic: ABSENT | BUILD (last three PORT, synthetic DROP) |
| `commands/login-commands.ts` | `integration.list/get`, `integration.connect.key`, `integration.oauth.connect/complete/status/cancel`, `credential.update/activate/remove` -> Discord OAuth/key wizard | ABSENT programmatically. `jcode login`/`jcode provider add` are interactive [CLI] | BUILD (bridge) or DROP the wizard; no ACP/JSON OAuth surface |
| `commands/session-commands.ts` | `message.list` (user prompts); `session.list` (children, project); `session.get`; `location.get` -> project id; `agent.list`; `file.find` | `message.list` PORT [CLI/JSON]; `session.list` PORT [CLI] with `parentID` filtering done in kimaki from `parent_id`; `session.get` PORT; `location.get` ABSENT (derive from `working_dir`); `agent.list` ABSENT (`config.toml [agents]` exists, schema UNVERIFIED); `file.find` ABSENT | BUILD |
| `commands/preference-commands.ts` | `session.switchModel`; `session.get` (agent/model); `model.default`; `model.list`; `provider.list` | switchModel PORT [ACP set_config_option]; session.get PORT [JSON]; `model.default` ABSENT (no default endpoint); model.list PORT [CLI]; provider.list PORT [CLI], output UNVERIFIED | PORT (default BUILD) |
| `commands/thread-commands.ts` | `command.list`; `session.compact`; `session.get`; `message.list`; `model.list`; `session.active` | `command.list` ABSENT; compact ABSENT; the rest PORT | BUILD |
| `commands/worktree-commands.ts` | `session.active` -> "is a session busy here" | [CLI] `debug sessions` `is_processing` + `working_dir` | PORT |
| `ingress.ts` | `session.update {title}` on thread rename; also `bot.opencode.ready`, `opencodeDbFile` | rename PORT [CLI] `jcode session rename` / [JSON] `custom_title`; ready ABSENT (replace with seam readiness); `opencodeDbFile` ABSENT | PORT (rename) |
| `lock-routes.ts` | `session.update {title}`; `session.compact`; `session.inbox.list`; status: `endpoint.url/version/connected` | rename PORT; compact ABSENT; inbox ABSENT; endpoint status replaced by seam health [IN-REPO] | BUILD |
| `main.ts` | `session.view` (mark viewed/idle); `syncSessionTranscript` -> `message.list` | view ABSENT; transcript PORT [CLI/JSON] | PORT-partial (view DROP) |
| `permissions.ts` | `permission.reply {requestID, decision}` | [ACP] `answerServerRequest` on a held `session/request_permission` (live turn only) | PORT |
| `prompt.ts` | `session.prompt {text, files, skills, delivery, metadata.discord}`; `session.form.cancel`; `permission.reply`; `session.interrupt`; `session.inbox.cancel/list`; `session.get`; `shell.list/remove`; `command.list`; `session.command`; `session.wait`; `message.list`; `session.revert.stage/clear` | prompt text PORT [ACP session/prompt]; interrupt PORT [ACP cancel]; permission PORT [ACP]; session.get/message.list/wait PORT [JSON/CLI/prompt resolution]; attachments BUILD (ACP declares image/embeddedContext capabilities, but `AcpClient.prompt` accepts only `text`); delivery/inbox BUILD kimaki-side queue or DROP; forms/shell/command.list/revert ABSENT; session.command ABSENT (sending `/name` as prompt text is UNVERIFIED) | BUILD (core prompt PORT) |
| `questions.ts` | `session.form.reply` | ABSENT (no form surface in ACP, CLI or JSON) | DROP |
| `scheduler.ts` | `session.active` | [CLI] `debug sessions` `is_processing` | PORT |
| `sessions.ts` | `session.move`; `integration.list`; `agent.list`; `session.get`; `session.switchModel`; `session.switchAgent`; `instructions.entry.put`; `session.update {metadata, permissions, title}`; `session.active`; `session.create {title, location, model, agent, permissions, metadata}`; `message.list`; `session.fork`; `session.remove`; `session.wait`; direct `endpoint.client.integration.list` | create PORT = [ACP] `session/new` + [ACP] set model + [CLI] rename (title); get/active/messages PORT; switchModel PORT; instructions PORT via `instructions.ts` prompt prefix [IN-REPO]; move/fork/remove/metadata/permissions/switchAgent ABSENT; wait PORT (prompt resolution / `is_processing` poll) | BUILD |
| `slash-commands.ts` | `agent.list`; `command.list`; `skill.list`; `bot.opencode.subscribe` | skill.list PORT-partial: `~/.jcode/skills/<name>` exists [verified listing], descriptions need `SKILL.md` frontmatter (UNVERIFIED fields); agent.list BUILD (config `[agents]`); command.list ABSENT; catalog subscribe ABSENT (polling only) | BUILD |
| `voice.ts` | reads the ChatGPT credential from `opencodeDbFile` (no `oc()`) | ABSENT. `~/.jcode/openai-auth.json` exists but its schema is UNVERIFIED and must not be read as a guess | BUILD |
| `voice-call.ts` | `skill.list`; same `opencodeDbFile` credential | skill.list PORT-partial as above; credential ABSENT | BUILD |
| `event-loop.ts` | `session.get`; `session.active`; `session.inbox.list`; `session.form.list` (snapshot hydration) | get/active PORT; inbox/forms ABSENT, so the hydrated snapshot loses those panels | PORT-partial |
| `session-events.ts` | `message.list`; `session.get`; `session.active`; `session.list`; `session.form.list` | all but forms PORT [CLI/JSON] | PORT |
| `sleeps.ts` / `queue.ts` | queue/inbox delivery semantics around `session.prompt delivery` (no direct `oc()` in sleeps) | inbox ABSENT; a kimaki-side queue is the honest replacement | BUILD |
| `agent-ui.ts` | no direct `oc()`; calls `send` in `prompt.ts` | inherits prompt.ts | PORT (inherits) |
| `cli/shared.ts` | `readClient()` -> `resolveOpencode` (no `oc()`) | ABSENT; a jcode reader = `debug sessions` / `debug history` | BUILD |
| `cli/session.ts` | uses `readClient()` and `session-events.ts` reads | same as session-events | BUILD |
| `main.ts` `markViewed` only | `session.view` | ABSENT | DROP |

## ABSENT, and what would have to be built

- **Session fork / remove / move.** jcode records `parent_id` and `working_dir`
  but exposes no fork, delete or move method (no ACP frame, no CLI, no flag). Build:
  a jcode-side control (new ACP method or a CLI), or a kimaki copy/delete of the
  session JSON with a fresh id. A raw copy is unsafe while the daemon holds the file.
- **Metadata and permission rules on a session.** The durable JSON has no metadata
  or permissions field. Build: a kimaki sidecar keyed by session id (already the
  pattern for the cursor dir), or a jcode-side field.
- **Inbox / queue / delivery modes (`queue`, `steer`).** Build a kimaki-side queue
  that holds prompts until `is_processing` flips false, then sends one ACP prompt.
- **Forms and questions.** No surface anywhere. Either DROP the Discord question UI
  and keep tool approvals, or build a jcode-side question transport.
- **Compaction.** `config.toml` has a `[compaction]` section, but there is no
  command or ACP frame to trigger it. Build or DROP the `/compact` command.
- **Revert / shell list / shell remove / file find / location project id.** All
  absent. File find can be rebuilt in kimaki (filesystem walk); the rest are
  DROP unless jcode grows them.
- **Agent catalog and agent switching.** `config.toml [agents]` exists but no
  documented read shape and no switch method. Build a config reader + policy.
- **OAuth / integrations / credentials.** Only interactive `jcode login` and
  `jcode provider add`. Build a bridge or drop the Discord wizard.
- **Prompt attachments, skills and Discord metadata.** ACP declares image and
  embedded-context prompt capabilities, but `AcpClient.prompt` only sends text.
  Build content-block support (images/resources) and keep Discord context as a
  prompt prefix (the `instructions.ts` pattern), not as per-prompt metadata.
- **`session.view` (mark viewed / idle).** No jcode equivalent; DROP.

## Five callers to port first, ranked

1. **`prompt.ts` core (`session.prompt`, `session.interrupt`, `session.get`,
   `message.list`).** Every Discord user message and every stop goes through it,
   and the surfaces already exist (`session/prompt`, `session/cancel`, durable
   JSON). Porting the text path alone makes the bot able to answer at all; queue,
   forms, shell and revert can stay DROP/BUILD behind it.
2. **`sessions.ts` create/get/bind (`session.new`, title, model, active).**
   Without it the bot cannot start a thread on jcode; it is the other half of a
   working conversation and uses only ACP `session/new`, `set_config_option`, and
   the rename CLI.
3. **`event-loop.ts` + `session-events.ts` hydration (`session.get`,
   `session.active`, `message.list`).** This is what makes Discord mirror the
   thread. All three have JSON/CLI equivalents today; dropping inbox/forms from
   the snapshot is a known, small regression.
4. **`commands/preference-commands.ts` + `slash-commands.ts` model/provider/skill
   lists.** High user-visible value for a small surface: `jcode model list`,
   `jcode provider list`, the `skills/` directory, and `session/set_config_option`.
   The command and agent catalogs are the only BUILD-heavy parts.
5. **`scheduler.ts` + `commands/worktree-commands.ts` busy checks
   (`session.active`).** Cheap to port from `jcode debug sessions.is_processing`,
   and they prevent duplicate scheduled/worktree runs, which is a correctness win
   per line of work.
