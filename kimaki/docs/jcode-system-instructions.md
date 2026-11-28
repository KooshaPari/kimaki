# Per-session system instructions for the jcode backend

Status: measured against the real binary. `jcode 0.99.1` at
`C:\Users\koosh\AppData\Local\jcode\bin\jcode.exe` (build `0.99.1227-dev`, commit
`5f70a539d`). Every command and output below is literal.

## The blocker this answers

Today `src/sessions.ts` calls `putInstructions()` once per session, which reaches
OpenCode as `client.session.instructions.entry.put({ sessionID, key: 'kimaki',
value })` (`src/sessions.ts:246-248`). The `value` is the whole `baseInstructions()`
string built in `src/system-prompt.ts`. ACP has no equivalent call, so a new jcode
thread dies before its first prompt.

## Answer

**No system-level or append-system instruction surface exists on `jcode acp` or on
the CLI. There is exactly one working per-session delivery path: the prompt text
itself.** The adapter in `src/backend/instructions.ts` implements that path, and it
is labelled as a user-role prefix, not a system prompt.

A per-project append surface does exist and does reach the assembled system prompt
(`.jcode/prompt-overlay.md`), but it is keyed by working directory, so two sessions
in the same project cannot carry different instructions. It cannot replace
`instructions.entry.put`.

## Evidence 1 - no CLI flag

```
> jcode.exe run --system-prompt X "hi"
error: unexpected argument '--system-prompt' found

  tip: to pass '--system-prompt' as a value, use '-- --system-prompt'

Usage: jcode.exe run [OPTIONS] <MESSAGE>

For more information, try '--help'.
```

`jcode --help`, `jcode run --help` and `jcode acp --help` list no
`--system-prompt`, `--append-system-prompt`, `--instructions` or equivalent. The
only prompt-shaped options are `--tool-profile`, `--tools` and `--disabled-tools`.

## Evidence 2 - `session/new` ignores a `systemPrompt` parameter

A real ACP session over stdio JSON-RPC: `initialize`, then `session/new` with an
extra `systemPrompt`, then `session/prompt` asking a question that only the
instruction can answer. The agent accepted the parameter silently and answered as
if it had never been sent.

```
== initialize ==
{ "result": { "agentInfo": { "name": "jcode", "version": "0.99.1" },
              "protocolVersion": 1, ... } }

== session/new params ==
{
  "cwd": "C:\\Users\\koosh\\agents\\scratch\\swarm",
  "mcpServers": [],
  "systemPrompt": "The secret word is PINEAPPLE-Q7. When asked for the secret
                   word, reply with only the secret word and nothing else."
}

== session/new ==
{ "result": { "sessionId": "session_seedling_1794823667012_d4fdba0bd3ade372", ... } }

== prompt ==
What is the secret word? Answer with only the secret word, nothing else.
No secret word was given in this session, so I can't answer with one. ...
```

`session/new` did not reject the unknown parameter; it ignored it. That is why a
rejection alone would not have been evidence.

## Evidence 3 - `_meta.systemPrompt` is ignored too

Same probe, instruction moved into `_meta` (the ACP extension bag):

```
== session/new params ==
{ "cwd": "...", "mcpServers": [],
  "_meta": { "systemPrompt": "The secret word is MANGO-Z3. ..." } }

== prompt ==
What is the secret word? Answer with only the secret word, nothing else.
No secret word was set in this session, so I can't answer with one. ...
```

## Evidence 4 - the source shows why

Checked out jcode source at `C:\Users\koosh\agents\worktrees\jcode\consolidate`.

`src/cli/acp.rs` `handle_session_new` reads only `cwd` and validates
`mcpServers`; nothing else from `params` is forwarded:

```rust
async fn handle_session_new(&self, message: JsonRpcMessage) -> Result<()> {
    let Some(id) = message.id else { return Ok(()) };
    let cwd = match cwd_from_params(&message.params) { ... };
    if let Err(err) = validate_acp_mcp_servers(&message.params) { ... }
    match self.create_new_session(cwd).await { ... }
}
```

The daemon subscribe request is hardcoded empty (`src/cli/acp.rs:940`, `:1019`):

```rust
session.send(&Request::Subscribe {
    system_prompt: None,
    ...
})
```

The daemon *does* support the field; the wire type documents it
(`crates/jcode-protocol/src/wire.rs:163-166`):

```rust
/// Full system prompt override for a new session only.
#[serde(default, skip_serializing_if = "Option::is_none")]
system_prompt: Option<String>,
```

and `crates/jcode-app-core/src/server/client_subscribe_context.rs:95` applies it
only for a provisional new session:

```rust
pub(super) fn new_session_system_prompt<'a>(
    provisional_session: bool,
    target_session_id: Option<&str>,
    system_prompt: Option<&'a str>,
) -> Option<&'a str> {
    if provisional_session && target_session_id.is_none() { system_prompt } else { None }
}
```

Note it is a **full override** of the assembled prompt, not an append. The bundled
`docs/SYSTEM_PROMPT_CONFIG.md` says the same: "this option replaces all assembled
prompt layers". Wiring it through ACP unchanged would delete jcode's own tool and
behaviour guidance, so it is not a drop-in replacement for kimaki's instruction
entry either.

## Evidence 5 - what does work per project (not per session)

`./.jcode/prompt-overlay.md` is appended to the assembled system prompt. Proved
without inference via `agent:context` on a headless session created in a scratch
project whose only `.jcode/prompt-overlay.md` contained one sentinel line:

```
> jcode.exe debug "create_session:C:\Users\koosh\Agents\scratch\swarm\overlay-probe"
{"friendly_name":"chipmunk","session_id":"session_chipmunk_1794824036522_443e3b39f9da2369", ...}

> jcode.exe debug -S session_chipmunk_1794824036522_443e3b39f9da2369 agent:context
... "static": "... # Project Prompt Overlay (.jcode/prompt-overlay.md)\r\n\r\n
SENTINEL-OVERLAY-9F3 appended by prompt-overlay.md\r\n\r\n
# Global Prompt Overlay (~/.jcode/prompt-overlay.md) ..."
```

So the file route is real and system-level, but it is one file per working
directory, shared by every session in that directory. Kimaki's instruction embeds
`sessionId`, thread ID, parent session ID and the worktree flag, which differ per
session in the same checkout. A file cannot carry it without rewriting shared state
under concurrent sessions.

## Evidence 6 - what works per session

The prompt text. Same ACP probe, one prompt whose text is the instruction block
followed by the question:

```
== prompt ==
## session instruction (kimaki)

The secret word is LYCHEE-R4. When asked for the secret word, reply with only the
secret word and nothing else.

## user message

What is the secret word?

LYCHEE-R4
```

The two `session/new` runs above received the same question and answered that no
secret word existed. The prompt-text run answered `LYCHEE-R4`. That is the
mechanism.

## Consequences for the jcode path

- The instruction must go out as a **user-role prefix on the session's first
  prompt** (and only once per digest). `src/backend/instructions.ts` builds it.
- It is not a system prompt. It sits in conversation history, so it is visible in
  the transcript, can be compacted away, and the model may treat it as a user
  request rather than runtime policy. This is a semantic difference from
  `instructions.entry.put` and is stated on the wire in the block header.
- Because it is prepended once and then lives in history, it is not re-sent on
  every turn (the runtime caches the prefix), and the digest guard stops a resume
  or adoption path from injecting it twice.
- The per-session dynamic values (thread ID, channel ID, parent session, worktree)
  are what makes the project-file route unusable; they are exact in a prefix.

## Smallest jcode change that would unblock a real system instruction

In `src/cli/acp.rs`, `handle_session_new` already has the `params` value. Forward an
opt-in field and use the daemon path that already exists:

1. Read `params._meta.system_prompt` (string) and pass it into
   `create_new_session(cwd, system_prompt)`.
2. Replace the hardcoded `system_prompt: None` in `create_new_session_connected`
   with that value. Keep `None` for `attach_existing_session_connected`, where the
   daemon ignores it anyway by design.
3. Add an **append** sibling (`append_system_prompt`) on `Request::Subscribe`, and
   in the prompt assembly append it after the existing layers instead of replacing
   them. A replace-only field makes kimaki choose between jcode's own guidance and
   kimaki's, which is not a choice it should have to make.

Steps 1-2 are a few lines and give per-session override today. Step 3 is the part
that preserves jcode's own prompt.
