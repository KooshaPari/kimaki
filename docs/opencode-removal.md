# Removing OpenCode from kimaki: reference map and phased plan

Status: planning document for Phases 0 and 2-3; **Phase 1.2 (the export) is implemented and
exercised** on 2026-11-17. All line numbers are from the working tree at
`E:\koosh\CodeProjects\kimaki` (package `kimaki/`), recorded 2026-11-16.

Phase 1.2 landed as `src/ops/export-opencode.ts` plus `src/cli/export.ts`
(`kimaki export opencode --out <dir>` and `kimaki export verify --dir <dir>`), with
`src/export-opencode.e2e.test.ts` (4 cases). Measured on the real OpenCode database of this host,
`C:\Users\koosh\AppData\Local\opencode\opencode.db`: 3 sessions, 4 messages, 7 parts, 0 credentials
exported, `export verify` re-checked every digest, and the source file's SHA-256 was byte-identical
before and after (`5ac313c6…`), so the read-only attach is real and not a claim. Credentials are
metadata only: `credential.value` is never selected, and the manifest lists that redaction. A drifted
schema (for example a `part` table without `data`) is refused before anything is written.

Direction checks run the same day, because "do not install OpenCode 2" is only sound if the jcode
path actually stands on its own:

| Check | Observed |
| --- | --- |
| Unknown backend is refused, not defaulted | `kimaki --backend nonexistent` prints `Unknown --backend "nonexistent". Use one of: jcode (default), opencode` |
| The flag's own help states the direction | `--backend <name>` is documented as `Bot backend: jcode (default) or opencode. jcode drives a native Jcode session and needs no OpenCode install; opencode keeps the existing OpenCode path` |
| A jcode-backed start does not need the binary | `kimaki --backend jcode --data-dir <temp>` prints no OpenCode version error; it proceeds into startup and its log stays empty while it waits on onboarding/gateway, whereas the opencode-backed start dies immediately at the version gate |
| jcode already holds credentials | `jcode auth status` reports `openai available` (OAuth, account `openai-otter`, automatic refresh) and `opencode-go available`; `jcode login`, `auth status`, `auth doctor`, `auth-test` and `provider` all exist, so Phase 2.4 is a kimaki wiring task, not a capability gap |
| Packaging: the shipped build carries the export | `npx tsc` builds clean and `node dist/cli.js export verify --help` resolves the command from `dist`, not only from `src` |

One gap the checks found: step 0.1 asked for `KIMAKI_BACKEND` as well as the flag. Correction
(2026-11-23): the env half does exist, `KIMAKI_BACKEND` is defined at `kimaki/src/cli/bot.ts:30`, so
the earlier statement that `rg KIMAKI_BACKEND src` was empty is stale.

Phase 1 default landed 2026-11-24: a start with neither `--backend` nor `KIMAKI_BACKEND` resolves to
`jcode` (`DEFAULT_BOT_BACKEND` in `src/backend-selection.ts`), the help and refusal text name it as
the default, and the autostart script now always pins `--backend <resolved>` so an opencode bot is
not restarted as jcode. `--backend opencode` and `KIMAKI_BACKEND=opencode` still select OpenCode,
legacy `thread_sessions` rows keep their per-row `backend` default of `opencode`, and any stored
legacy thread still forces the OpenCode preflight under a jcode start.

Step 1.1 landed 2026-11-24: the `backend` column is now read at runtime. `src/thread-backend.ts`
is the only resolver (per-thread, named errors, no fallback), `dispatch` resolves a thread before
its first OpenCode call, a jcode start also starts the OpenCode connection when any row says
`opencode` and starts none when no row does, and new bindings record the configured backend.
See "Step 1.1 landed" under Phase 1 for proof, the two open product decisions, and the test.

Status measured 2026-11-28 (branch `feat/passive-session-bindings`, HEAD `e7f75d38`):

| Plan item | State | Evidence |
| --- | --- | --- |
| 1.2 export tool | **Landed** | `kimaki/src/cli/export.ts` + `src/ops/export-opencode.ts`, commit `26a7875a`; `kimaki export opencode --out <dir>` requires an explicit destination and `export verify` re-reads the manifest |
| 1.3 `thread_sessions.backend` | **Landed** | `src/schema.ts:99` (default `'opencode'`), `src/migrations.ts:217` guarded on `table_info` so a second start is a no-op, `DB_VERSION` stays 1; commit `cfad02a9` |
| 1.5 onboarding preference | **Landed** | `shouldCheckOpencode({backend, legacyThreadCount})` in `src/backend-selection.ts`; the preflight runs only for the OpenCode backend or when a legacy thread exists; commit `4456393` |
| Surfaces a jcode thread cannot serve | **Landed** | `src/jcode-surfaces.ts` + 24 unit cases: `/model`, `/compact`, queue, shell and command refuse by name (a `JcodeSurfaceUnavailable` naming the surface) instead of the generic "OpenCode service not reachable"; abort is routed through `session/cancel`; commit `e8ccf439` |
| 1.1 residual: fresh install | **Landed** | A `--backend jcode` start on an empty data dir + empty jcode home now defers instead of refusing: `jcodeStartupFollow` (`src/main.ts:152`) chooses `follow: 'defer'` for the cold case, and `createJcodeBotBackend` (`src/backend/jcode-bot-backend.ts:480`) starts no binary, session, poller or OpenCode connection. The deferred bot reports "no persisted session; the first thread creates its own session when it binds" in startup/status, and `JcodeSessionDeferredError` names every session-needing call. Five cases in `src/jcode-deferred-start.e2e.test.ts`, plus the 4-file suite, are green; `tsc --noEmit` has 0 errors. |
| 1.4 credential handoff | **Landed** | `kimaki auth import-codex [--db <path>]` (`src/cli/auth.ts`, entry point `importCodexCredential` in `src/credential-handoff.ts`) copies the Codex OAuth row once into kimaki's own `codex_credentials` table (`src/schema.ts`, additive, `DB_VERSION` stays 1) and never writes to or refreshes the OpenCode db. Voice reads the imported row first (`src/voice.ts`), then `bot_api_keys`, then the OpenCode row as a last resort while an OpenCode db exists, and an imported token that has since expired degrades to the next route instead of throwing. Four cases in `src/credential-handoff.e2e.test.ts`, including a byte-identical fingerprint of the source db before and after; commit `e7f75d38`. What this does not settle: rotation. The copied token expires with the OpenCode one, so a fresh import is required each time OpenCode refreshes it. |
| Instructions for a jcode session | **In progress** | the OpenCode path writes kimaki's instruction with `putInstructions` (`src/sessions.ts:197-248`); the jcode path had no equivalent, so a jcode thread received no kimaki instruction at all. `src/backend/instructions.ts` + `src/backend/jcode-bot-prompt.ts` already implement a digest-guarded prompt-prefix channel for jcode (jcode's ACP requests carry no system-prompt field; see `docs/jcode-system-instructions.md`), but no caller passes `instruction`. Wiring it is the current lane. |
| Phase 2 (2.1-2.6) | **Unblocked by 1.4, not started** | Data-side precondition met: threads, exports and the voice credential all have a non-OpenCode home. What still gates the deletions is a deliberate decision rather than a dependency: deleting `ensureOpencode` removes the last automatic install path, so every existing OpenCode thread must be migrated or explicitly abandoned first. Code side unchanged: `ensureOpencode` still called from `src/cli/bot.ts:189`; `@opencode/client`, `@opencode/plugin` and `@opencode/cli` still in `package.json:28,29,58`; `OPENCODE_SESSION_ID` still read at `src/prompt.ts:63`. |

Host caveat measured 2026-11-28 (does not affect Linux CI, does affect local runs on this node):
four unit tests cannot pass here because the bundled `@opencode/cli/bin/opencode.exe` is a Windows
binary that Linux refuses to execute, so `spawn` fails `ENOENT` and the OpenCode test server never
starts (`src/ingest-injection.test.ts`, `src/observe-restart-witness.test.ts` "AC35",
`src/opencode-server.test.ts` "supported binary wins over OpenCode 1"). A fourth,
`src/ops/runtime/codex-app-server.test.ts` "streams a completed turn", is a timing flake: it passes
in isolation and failed in a full-suite run. Baseline proof: a detached worktree of `0f188987` with
none of the six surface files present fails the same four.


## 0. Method and measured facts

Counts were produced with ripgrep, case-insensitive, from `kimaki/`:

```
rg -i --count-matches "opencode" src          # 1302 occurrences
rg -il "opencode" src | rg -v "\.test\.ts"   # 56 non-test files, 795 occurrences
rg -i -l "opencode" src --glob "*.test.ts"    # 64 test files, 507 occurrences
rg -l "startOpencodeTestServer" src           # 47 suites boot a real OpenCode server
rg -il "opencode" kimaki/src kimaki/scripts kimaki/skills \
  kimaki/README.md kimaki/package.json        # 123 files (src + scripting + docs surface)
```

Notes on the brief's numbers: 646 non-test references is the count of matching *lines*
(`rg -i -c`, which dedupes multiple hits per line); occurrences are 795. File counts agree
with the brief (56 non-test source files, ~122 files including tests).

Outside `kimaki/src` the reference surface is: `kimaki/package.json` (deps, below),
`kimaki/scripts/tool-usage-report.ts` (3), `kimaki/skills/kimaki-debug/SKILL.md` (8),
`kimaki/CHANGELOG.md` (212, purely historical), `docs/opencode-v2-events/` (16 fixture
files, 16 v2 doc files), and sibling workspace packages (`opencode-deterministic-provider`,
`opencode-kimaki-plugin`, `opencode-auto-mode`, …) which are *upstream of* kimaki and not in
scope for a kimaki-side removal.

### Buckets

| Tag | Bucket | Meaning |
|---|---|---|
| **R** | RUNTIME COUPLING | starts, connects to, or speaks to an OpenCode server/process: binary discovery, `serve` spawn, HTTP/SSE client, health/version checks, session IDs sourced from its store |
| **P** | PROVIDER / CREDENTIAL NAMING | provider strings, auth keys, `OPENCODE_*` env vars, login flows assuming OpenCode's provider set |
| **D** | PERSISTED DATA | paths/formats holding user state in OpenCode's own storage (`$XDG_DATA_HOME/opencode`, `$XDG_CONFIG_HOME/opencode`, project `.opencode/`) incl. session/thread/summary records |
| **T** | TEST SUBSTRATE | fixtures, stubs, replay, harness boot existing only because tests drive an OpenCode server |
| **C** | COSMETIC | prose, comments, command help, log text, branch names |

Every reference is in exactly one bucket. Where a line is a comment *describing* runtime
behaviour it is **C** (it is only text); where a line *is* the runtime coupling (import,
call, path, env key) it is **R/P/D**. Lines that carry both a string and behaviour are
classified by what the code does.

---

## 1. Per-file classification

### 1.1 `src/opencode-server.ts` — 127 refs, the whole module is R plus D

The single file that owns the OpenCode connection. Everything here is
**R**, except the two storage-path helpers and the install command.

| Lines | Bucket | Why |
|---|---|---|
| 1-10 (module doc) | C | describes discovery/subscription strategy |
| 27-28 `@opencode/client`, `@opencode/client/service` | R | the SDK that speaks HTTP/SSE |
| 32, 37, 39 | R | error types, logger tag `OPENCODE`, `MIN_OPENCODE_VERSION = '2.0.19'` |
| 52-104 `parseVersion`, `opencodeVersion()` | R | spawns `<binary> --version` to decide compatibility |
| 75 `OPENCODE_INSTALL_COMMAND` | R | install recipe for the runtime (also P: it is the "install the provider platform" string surfaced by onboarding) |
| 78-79 `installedOpencodeBinary()` | D | `~/.opencode/bin/opencode[.exe]`: a path into OpenCode's own install |
| 108-135 `findOpencodeBinary`, `resolveOpencodeBinary`, `checkOpencode` | R | PATH/`OPENCODE_PATH`/install-dir probing, `serve` readiness |
| 138-149 plugin registration doc | C | |
| 150-155 `opencodeConfigDir()` | D | `$OPENCODE_CONFIG_DIR` else `$XDG_CONFIG_HOME/opencode` — OpenCode's global config dir |
| 158-160 `opencodeDbFile()` | D | `$XDG_DATA_HOME/opencode/opencode.db`, `$OPENCODE_DB` — OpenCode's SQLite store |
| 164-185 package-root resolution for the shim | R | locating kimaki's own `dist/` so OpenCode can import the plugin |
| 187-278 `configuredPluginTargets`, `installShim`, `removeShim` | D | writes `<config>/opencode/plugins/kimaki/index.js` and reads `opencode.json`/`opencode.jsonc` |
| 281-320 `OpencodeEndpoint`, `resolveOpencode` | R | service-file discovery, `serve --service` spawn (303), version gate (313-316) |
| 322-348 `OpencodeConnection`, stream-closed event, keepalive | R | SSE lifecycle |
| 350-480 `watchOpencode` | R | the single `/api/event` subscription, reconnect, `server.connected` handshake |

### 1.2 `src/test/harness.ts` — 53 refs, all **T**

| Lines | Bucket | Why |
|---|---|---|
| 1-5 (doc) | T | "each test file gets its own OpenCode service" |
| 20-29 imports | T | `@opencode/client`, `Service`, `opencode-deterministic-provider` |
| 60-65 `opencodeBinary()` | T | resolves `@opencode/cli`'s `bin/opencode.exe` |
| 74-108 deterministic provider wiring | T | answers the model request in-process |
| 109-125 `OpencodeTestServer` type | T | config dir, DB file, client factory |
| 126-231 `startOpencodeTestServer` | T | spawns the real binary with `OPENCODE_*` env, service file under `state/opencode/service.json`, retries twice |
| 245-255 endpoint + `configDir`/`dbFile` | T | |
| 269-271 `warmUp` | T | pays OpenCode cold start once |
| 563-619 `startBot` wiring (`opencodeDbFile`, `opencodeServiceFile`, `opencodeConfigDir`, `ensureOpencode: false`) | T | |
| 650-672 child bot env `KIMAKI_OPENCODE_SERVICE_FILE` | T | |
| 850-851 `writeOpencodeCredential` | T | seeds OpenCode's `credential` table |

There is **no jcode equivalent of this harness** (`rg "startJcode|JcodeTestServer"` → no
matches). This is the single largest test-side gap.

### 1.3 `src/sessions.ts` — 51 refs: mostly R, some C, a little D

| Lines | Bucket | Why |
|---|---|---|
| 8, 30, 33, 44 | R | `SessionMetadata`/`OpenCodeClient` types, OpenCode error classes, permission-rule type |
| 72 | C | comment on ID provenance |
| 127-135 `catalogReady`, `primaryAgents(bot.opencode)` | R | `agent.list` over the client |
| 143-165 `channelDefaults(bot.opencode)` | R | reads OpenCode's default agent/model |
| 224, 252-295 `PluginWait`, `createPluginWait` | R | polls `integration.list`/`plugin.list` on the live endpoint; error text names `opencode service restart` / `opencode plugin list` (291, 295) |
| 320, 411, 611, 651, 658, 795, 856 | C | comments about fork titles and parent sessions |
| 890 | R | same error-union shape |

### 1.4 `src/ops/runtime/opencode.ts` — 41 refs, all **R** (metadata reader over the V2 API)

1-6 (read-only boundary + SDK imports), 7 (version gate import), 11-26 types,
29-51 observer construction, 69-83 `session.list/get`, `message.list`, 97-160
`event.subscribe` loop and `server.connected` handshake, 153-168 shutdown/done.
No storage paths: it reads through the HTTP client only, so it is pure R, not D.

### 1.5 `src/cli/ops.ts` — 37 refs: R for the opencode source, C for help text

| Lines | Bucket | Why |
|---|---|---|
| 187-189, 289-295, 323-325, 422, 1157 | C | command descriptions/options mentioning OpenCode |
| 202-204 | R | **default `--source` is `'opencode'`** for `ops follow` |
| 258-264, 402-419 | R | dynamic import of `opencode-server.ts` + `ops/runtime/opencode.ts`, endpoint resolution, `createOpenCodeObserver` |
| 303-313 | R | `ops publish` requires a live OpenCode observed event |
| 517-534 `ops jcode run`, 558-587 `ops jcode serve`, 623 `attach`, 765 `watch`, 1012-1028 `history`, 785-811 ACP client | (not OpenCode, listed for contrast) | jcode-side equivalents already present |

### 1.6 `src/main.ts` — 36 refs, **R** wiring plus one D path

| Lines | Bucket | Why |
|---|---|---|
| 1 | C | boot-order comment |
| 22 | R | imports `installPluginShim`, `watchOpencode` |
| 47-56 | R/D | options: `opencodeServiceFile`, `ensureOpencode`, `opencodeConfigDir` (D), `opencodeDbFile` (D) |
| 145-155 | R | `session.view`, `channelDefaults`, voice calls with config dir, transcript sync on run end |
| 168-177 | R | `installPluginShim`, `watchOpencode({ensure})`, `cleanup.defer(stop)` |
| 181-197, 206, 224-246 | R | `createAgentUi`, bot construction, `opencode.ready` settle, `registerSlashCommands(globalDirectory = opencode config dir)` |

### 1.7 `src/session-events.ts` — 32 refs, **R** (transcript mirror), with D output paths

| Lines | Bucket | Why |
|---|---|---|
| 2, 12, 37-62 | D | kimaki's *own* store `<dataDir>/session-events/<threadId>.jsonl` (Mirror of OpenCode events; not OpenCode storage) |
| 5, 11, 17 | C/R | "OpenCode 2.0.19 keeps no event history"; import of the client type |
| 110-111, 177, 239, 248-255, 278-298 | R | `message.list`/`session.get` reads, markdown rendering |
| 311-320, 354-374, 396-427 | R | `session.active`, paginated `allSessions`/`allMessages`, live `event.subscribe` wait |

### 1.8 `src/event-loop.ts` — 28 refs, **R** (the consumer of the event stream)

1 (doc), 22-24 (error types + `ConnectContext/OpenCodeClient/V2Event`), 46, 87,
104 (`model.list`), 213-221 (`session.get`), 247-254, 293-362 (`session.active`,
`session.inbox.list`, `session.form.list`, `permission.list`), 443-465 (fold + dispatch).

### 1.9 `src/prompt.ts` — 29 refs, **R** with one P-adjacent constant

38 (error types), 60 (`OPENCODE_SESSION_ID` read), 99, 105, 124-128
(`OPENCODE_MAX_ATTACHMENT_BYTES = 20MB`, OpenCode's attachment limits), 138,
147-148, 163, 183-202, 264-268 (`session.shell`), 277, 290, 304, 467, 486
(revert/undo semantics tied to `snapshot.restore`).

### 1.10 `src/cli/bot.ts` — 27 refs, **R** (startup gate, status, help)

| Lines | Bucket | Why |
|---|---|---|
| 100, 105 | C | `--no-autostart` help, env-inheritance comment |
| 111-115, 124 | R | dynamic imports of `onboarding.ts`/`opencode-server.ts` |
| 183-187 | R | **hard gate**: `ensureOpencode(...)` → `failStartup` |
| 221-224 | R | options passed to `startBot`: service file, `ensureOpencode: true`, config dir, db file |
| 285-300 | P | `login <provider>` / `login credential` are OpenCode integration credentials |
| 359-373 | R | `status` prints `opencode: {connected,url,version}` |
| 391 | C | restart help text |

### 1.11 `src/onboarding.ts` — 31 refs, **R** (installer) with P naming

24 (error types), 27 (imports `checkOpencode`, `findOpencodeBinary`,
`installedOpencodeBinary`, `OPENCODE_INSTALL_COMMAND`), 82-98 (`ensureOpencode`,
prompt "Kimaki requires OpenCode 2", `OPENCODE_PATH`), 101-114 (spawns
`/bin/bash -c <install script>`, re-checks the binary). This is the code that
*installs OpenCode for the user* — the definition of runtime coupling.

### 1.12 `src/voice.ts` — 22 refs, **P** + **D** (reads OpenCode's DB for a token)

| Lines | Bucket | Why |
|---|---|---|
| 8 | C | precedence comment |
| 83 | C | user-facing error text |
| 498-503 | D | doc: the ChatGPT OAuth token lives in OpenCode's database |
| 517-540 `chatGPTCredential` | D | `ATTACH DATABASE ? AS opencode`, `SELECT value FROM opencode.credential WHERE integration_id='openai'` on `opencodeDbFile` |
| 659-700 `transcribers`, options | P/D | precedence: OpenAI key → ChatGPT (OpenCode) → Gemini → Whisper |

### 1.13 `src/plugin/anthropic/index.ts` — 20 refs, **P** (provider login) + R (plugin API)

1-25 (module doc, `@opencode/plugin` imports), 36-49 (OAuth flow, `user-agent:
opencode/...` 429 note), 68, 158-172 (`OPENCODE_ENV_BLOCK` rewrite so Anthropic does not
bill "third-party"). This file *is* the Anthropic subscription login for the OpenCode
provider set: it cannot exist in a jcode-only world without being rewritten as a jcode
provider/credential plugin.

### 1.14 `src/system-prompt.ts` — 17 refs, all **C** (prompt text shipped to agents)

18, 113, 147, 244, 298, 344-346, 409, 442, 534, 722, 752, 815, 895, 901, 952, 1008.
Every one is prose telling the agent it is inside an OpenCode session (`OPENCODE_SESSION_ID`
is referenced as an env var name at 113/534 — still only text here; the *definitions* are
in `cli/shared.ts`, `lock-routes.ts`, `prompt.ts`).

### 1.15 `src/bot.ts` — 23 refs, **R** (the Bot type and the `oc()` helper)

6-9 (doc, client types), 17-19 (error + connection types), 53 (`opencode: OpencodeConnection`),
68-69 (`opencodeDbFile` on the bot), 88-96 (`oc()` wrapper), 109-121
(`sessionDirectory`, `rootSession`).

### 1.16 `src/errors.ts` — 23 refs, **R** tag definitions (message text is C)

5-28: `OpenCodeError`, `OpenCodeUnavailableError`, `OpenCodeMissingError`,
`OpenCodeV1Error`, `OpenCodeVersionError`. These are the vocabulary every caller in
`sessions/prompt/queue/lock-routes/cli` returns. 17 and 23 contain install instructions
("Install it with …"), which also makes them user-facing P text.

### 1.17 `src/autostart.ts` — 15 refs, **R** (start-up-on-OpenCode hook) + D (writes a command file)

1-15 (doc/diagram: the Kimaki OpenCode plugin opens `autostart.command`),
67-79 (generated shell script text), 96, 112-113, 126-128 (once-per-OpenCode-process
semantics). The mechanism only exists because OpenCode is the process the user has open.

### 1.18 `src/slash-commands.ts` — 14 refs, **R** (catalog over the client) + C

13-28 (doc), 166-176 `readCatalog` (`agent.list`/`command.list`/`skill.list`),
200, 276, 383-397 (`globalDirectory` is the OpenCode global config dir — D-adjacent),
496, 528-531 (`bot.opencode.subscribe`).

### 1.19 `src/thread-reducer.ts` — 11 refs: **R** (event shapes) + C

1-2, 30 (types from `@opencode/client` — the reducer consumes V2 event shapes: the core
contract), 129-181, 295, 361-652 (fold logic; 361 `applyOpencode`). Note: the *fold* is
pure, so the file is only coupled through the event type and the command/snapshot
semantics, not through I/O.

### 1.20 `src/plugin/coordinator.ts` — 11 refs, **R** (plugin API) + C

1-4, 25-26, 32-41, 162, 204-205, 278. Runs *inside* the OpenCode process.

### 1.21 `src/ops/discord/publication.ts` — 11 refs, **R** metadata pipeline

10, 18 (`MetadataBackend = 'opencode' | 'jcode'`), 27, 38-43 (`KCode` cannot publish as
opencode), 123-144 (type guard on `observed.source.backendKind`).

### 1.22 Remaining files with ≥5 refs

| File | Refs | Buckets | Evidence |
|---|---|---|---|
| `src/voice-call.ts` | 12 | P, D, C | 87 (needs ChatGPT-in-OpenCode login), 114-122 (reads token from `opencodeDbFile`), 148-161 (global AGENTS.md/skills from OpenCode config dir — D), 318-319, 412, 585 |
| `src/cli/shared.ts` | 11 | R, P | 11-18, 84-85 (`resolveOpencode({ensure:false})` → the read path behind every `kimaki session *`), 22/57-59 (`OPENCODE_SESSION_ID` default) |
| `src/cli/session.ts` | 10 | R, P, C | 1-12, 62/142-146 (`OPENCODE_SESSION_ID`, `session.get`), 206-254 |
| `src/commands/thread-commands.ts` | 9 | R, C | 39, 60 (`opencode <dir> --session <id>` hint), 135/376-381 (queue an OpenCode command), 223, 407 |
| `src/plugin/index.ts` | 8 | R | 1-2 (`@opencode/plugin` `Plugin`, `Skill`), 38-104 (skill transform, system-prompt injection, `OpenCode session ID` text) |
| `src/lock-routes.ts` | 8 | R | 20, 88 (`OPENCODE_SESSION_ID`), 191-199, 306-313 (status payload `{connected,url,version}`) |
| `src/ingress.ts` | 7 | R | 6, 85, 160 (`opencodeDbFile`), 346-348 (waits `bot.opencode.ready`) |
| `src/commands/preference-commands.ts` | 7 | R, P | 2, 162-166 (`'OpenCode default'` model scope), 185, 222, 389 (`opencode auth login` hint), 612 |
| `src/ops/projection.ts` | 7 | R | 2, 29-47 (`backendKind !== 'opencode'` identity checks) |
| `src/questions.ts` | 6 | R | 2-6, 27 (`@opencode/client` types), 161, 195 |
| `src/analytics.ts` | 5 | R | 6, 37 (`V2Event`), 58, 186, 226 |
| `src/commands/login-commands.ts` | 5 | P | 2, 24, 35, 185, 346 — credentials "stored by OpenCode" |

Files at 1-4 refs (for completeness, not classified per line): `worktrees.ts:1,103`
(C branch name `opencode/kimaki-*`), `permissions.ts:11,90`, `format-parts.ts:7,125,393`,
`builtin-skills.ts:4,48,107`, `sleeps.ts:164`, `effects.ts:270`, `scheduler.ts:391`,
`file-edit-log.ts:27,48`, `coordinator.ts:10,117-118,164`, `routes.ts:8`,
`queue.ts:1,20,174,212`, `agent-ui.ts:96`, `cli/discord.ts:17,114`, `cli/schedule.ts:59`,
`commands/session-commands.ts:2`, `backend/jcode.ts:2`, `backend/acp/contracts.ts:131`
(both C: "mirroring the OpenCode backend").
`worktrees.ts:103` is the only place a *user-visible artifact* (branch name) is derived
from the word.

Test files with ≥5 refs, all **T**: `src/cli-lock.e2e.test.ts` 48 (mostly help-text
snapshots, C-in-T), `opencode-server.test.ts` 27, `ops/runtime/opencode.test.ts` 23,
`commands.e2e.test.ts` 25, `ops-opencode.e2e.test.ts` 19, `harness.e2e.test.ts` 18,
`ops/projection.test.ts` 11, `renderer.e2e.test.ts` 12, `plugin.e2e.test.ts` 15,
`voice-openai.e2e.test.ts` 15, `ingest-injection.test.ts` 11, `voice-call.e2e.test.ts` 14,
`session-ops.e2e.test.ts` 9, `working-directory.e2e.test.ts` 9, `questions.e2e.test.ts` 9,
`catalog-refresh.e2e.test.ts` 9, `coordinator-warmup.e2e.test.ts` 8,
`ops/projection.test.ts` 11, `thread-reducer.test.ts` 7, `voice-attachments.e2e.test.ts` 7,
`preference-commands.e2e.test.ts` 7, `scheduler.e2e.test.ts` 7, `login.e2e.test.ts` 7,
`hello-thread.e2e.test.ts` 7, `ops-lifecycle.e2e.test.ts` 7, `cli-read.e2e.test.ts` 6,
`queue.e2e.test.ts` 6, `shell.e2e.test.ts` 6, `sleep.e2e.test.ts` 6,
`onboarding-cli.e2e.test.ts` 6, `permissions.e2e.test.ts` 6, `coordinator-idle.e2e.test.ts` 6,
`session-commands.e2e.test.ts` 6, `observe-restart-witness.test.ts` 6, and 12 more at ≤5.

---

## 2. Answers

### 2.1 What is the default backend for a bot start, and where is the default chosen?

**OpenCode, and it is not a default at all — it is hard-wired. There is no backend switch
for `kimaki bot`/`kimaki` start.**

- `src/cli/bot.ts:184` — `const opencodeCheck = await ensureOpencode({ serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })`; `:185-187` `if (opencodeCheck instanceof Error) { opened.close(); failStartup(opencodeCheck) }`. Startup cannot proceed without OpenCode.
- `src/cli/bot.ts:221-224` — `opencodeServiceFile`, `ensureOpencode: true`, `opencodeConfigDir: opencodeConfigDir()`, `opencodeDbFile: opencodeDbFile()` are passed to `startBot`.
- `src/main.ts:170-177` — `watchOpencode({ serviceFile, ensure: options.ensureOpencode, … })` is the *only* connection created; there is no alternative branch.
- `src/opencode-server.ts:301-305` — when nothing is running, `resolveOpencode` spawns `` `${binary} serve --service --hostname 127.0.0.1` ``. That spawn *is* the backend selection.
- The only existing "backend" choice anywhere in the CLI is `src/cli/ops.ts:188` (`--source <kind>`, "opencode (default) or jcode", resolved at `:202`), which governs the metadata *observer*, not the bot.

So Phase 0 is not "flip an existing switch for the bot"; it is "introduce the switch, using
`ops --source` as the precedent". `rg "KIMAKI_BACKEND|KIMAKI_RUNTIME"` → no matches, so no
env var exists to hijack either.

### 2.2 Which paths break immediately without an `opencode` binary, and which degrade?

**Break (hard error at startup or on use):**

1. Bot start — `src/cli/bot.ts:184-188` (`ensureOpencode` → `OpenCodeMissingError` from
   `src/errors.ts:15-18`), and `src/main.ts:170` with `ensure: true` →
   `src/opencode-server.ts:123-125`. On Windows the installer is skipped by design
   (`src/onboarding.ts:95-96`), so it fails rather than installing.
2. Every read command that goes through `readClient` — `src/cli/shared.ts:84-85`
   (`resolveOpencode({ ensure: false })`) → `OpenCodeUnavailableError`
   (`src/errors.ts:10-13`). This covers `kimaki session *`, `session read/events/sync`
   (`src/cli/session.ts:1-12,142-146,237-254`), `kimaki send` target resolution
   (`src/lock-routes.ts:191-199`).
3. Voice calls — `src/voice-call.ts:87,114-122` require a ChatGPT credential stored in
   OpenCode's DB.
4. `ops follow`/`ops publish`/`ops discover` with the default or explicit `opencode`
   source — `src/cli/ops.ts:202,258-264,303-313,402-419`.

**Degrade gracefully (no crash, feature missing):**

- Voice *transcription*: `src/voice.ts:659-680` continues past a missing credential and
  falls back to `bot_api_keys` → Gemini → hosted Whisper (`src/voice.ts:8`);
  `src/voice.ts:700` only warns.
- Dynamic slash commands: `src/slash-commands.ts:496-505` logs `global catalog` and keeps
  the built-in registry; no dynamic `/agent`, `/command`, `/skill` entries.
- Plugin shim install: `src/opencode-server.ts:245-247` `mkdir -p` succeeds without
  OpenCode; it just writes a file nothing loads (`src/main.ts:168`).
- Auto-start-on-OpenCode: `src/autostart.ts:1-15,126-128` is inert (it is the *plugin*
  that opens the file).
- Discord surface tied to events (`agent-ui`, `queue`, `questions`, `analytics` folds,
  `thread-reducer`) produce nothing because no events arrive, but do not throw.
- `ops discover --source jcode|codex|herdr`, `ops jcode run|serve|attach|watch|history`
  are independent of the OpenCode binary.

### 2.3 What jcode-side equivalents already exist, and which are proven against the real binary?

| Capability | File | Real-binary proof |
|---|---|---|
| ACP stdio transport (initialize / session/new / session/prompt / session/load) | `src/backend/acp/client.ts:1-10,83`; contracts at `src/backend/acp/contracts.ts` | `src/backend/acp/client.test.ts` uses a synthetic child, **not** the real binary (`:9,193,446`) |
| Backend state + one-session ownership | `src/backend/jcode.ts:1-19,60,92,145` | `src/backend/hub.real-launch.test.ts:22-35,72-119` launches the **actual `jcode.exe`** (resolved from `JCODE_BIN` / `%LOCALAPPDATA%\jcode\bin\jcode.exe`), skips if absent |
| Multi-client hub (one writer, cursors, JSONL log, lease) | `src/backend/hub.ts:1-21,27-74,168`, `hub-server.ts`, `hub-client.ts`, `hub-launch-fence.test.ts` | `src/backend/hub.real-launch.test.ts` (real binary); `src/backend/hub.test.ts:6,828-831` uses a node script double |
| `ops jcode serve` (hub over loopback) | `src/cli/ops.ts:558-623` | `src/ops-jcode-hub.e2e.test.ts:15,92-140,147,207` — real turns, gated by `KIMAKI_JCODE_HUB_E2E=1` |
| `ops jcode run` | `src/cli/ops.ts:517-534` | `src/ops-jcode-acp.e2e.test.ts:1-4,12,99-159` — real `jcode acp`, gated by `KIMAKI_JCODE_ACP_E2E=1` (dormant assertion at `:155-159`) |
| `ops jcode watch` | `src/cli/ops.ts:765` | no e2e file references `ops jcode watch` |
| `ops jcode history` | `src/cli/ops.ts:1012-1028` | exercised indirectly through the hub/attach e2e; no dedicated suite |
| `ops discover --source jcode` (read-only metadata observer) | `src/ops/runtime/jcode.ts` (whole file), `src/cli/ops.ts:323-422` | `src/ops-jcode.e2e.test.ts:10-49` reads a **real** `KIMAKI_JCODE_HOME` |
| Profiles / identity separation (jcode vs kcode) | `src/ops/runtime/jcode.ts:38-67`, `src/backend/jcode.ts:19-36` | unit tests only |

**Gap:** there is no bot-facing jcode backend anywhere in `main.ts`/`bot.ts` — the jcode
work is entirely on the `ops` metadata/hub surface. The bot's `Bot` type carries
`opencode: OpencodeConnection` (`src/bot.ts:53`) with no union alternative.

### 2.4 Data migration: what lives in OpenCode storage that a user loses on a hard cut?

What is in OpenCode's storage today, and who reads it:

| Data | Location | Existing reader in kimaki |
|---|---|---|
| Session records, messages, titles | OpenCode's SQLite (`src/opencode-server.ts:158-160`) behind its HTTP API | `src/session-events.ts:110-374` (via API, not store), `src/cli/session.ts:146,237-254` |
| Provider credentials (incl. ChatGPT/Codex OAuth) | `credential` table in the same DB | `src/voice.ts:522-540` — **read-only `ATTACH` reader, the only direct store reader that exists** |
| Anthropic subscription OAuth | stored by OpenCode via the plugin | `src/plugin/anthropic/index.ts:1-25,36-68` (writer, not a reader) |
| Kimaki plugin registration | `<config>/opencode/plugins/kimaki/index.js` + `opencode.json` | `src/opencode-server.ts:187-278` (writer/remover) |
| Kimaki's own Discord↔session map | kimaki SQLite `thread_sessions.session_id` (`src/schema.ts:97-105`), `scheduled_tasks.session_id` (`:216`), `session_sleeps.session_id` (`:227`) | kimaki itself — these are **foreign keys into OpenCode's ID space** |
| Kimaki-mirrored history | `<dataDir>/session-events/<threadId>.jsonl` (`src/session-events.ts:37-42`) and `<dataDir>/transcripts/<sessionId>.md` (`:271-278`) | kimaki itself — readable without OpenCode |

Consequences of a hard cut:

- **Recoverable without OpenCode** (kimaki-owned mirrors): transcripts and per-thread
  event JSONL for threads that ran through Discord. `session read` could be re-pointed at
  these.
- **Lost unless imported**: (a) sessions that only ever existed in the OpenCode TUI —
  there is no reader and no importer; (b) all provider credentials and OAuth refresh
  tokens; (c) message bodies for threads never synced (`session sync` is opt-in,
  `src/system-prompt.ts:442`); (d) the mapping `thread_id ↔ session_id` for *old* threads,
  which becomes a dangling ID; (e) the Anthropic subscription login.
- No destructive migration is proposed anywhere in this plan. Each item is either
  *exported from the OpenCode store before cutover* or *explicitly abandoned and recorded*.

### 2.5 Test substrate: how many files, and does a jcode harness cover the behaviour?

- 47 suites call `startOpencodeTestServer` (list: `agent-ui`, `analytics`, `btw`,
  `catalog-refresh`, `cli-discord`, `cli-lock`, `cli-read`, `cli-sessions`, `commands`,
  `coordinator-agents`, `coordinator-idle`, `coordinator-queue`, `coordinator-warmup`,
  `coordinator`, `gateway-replay`, `harness`, `hello-thread`, `ingest-injection`,
  `interrupt`, `legacy`, `login`, `observe-restart-witness`, `onboarding-cli`, `onboarding`,
  `ops-follow`, `ops-lifecycle`, `ops-opencode`, `permissions`, `plugin`,
  `preference-commands`, `questions`, `queue-sources`, `queue`, `remote-send`, `renderer`,
  `restart`, `routines`, `scheduler`, `session-commands`, `session-ops`, `shell`, `sleep`,
  `voice-attachments`, `voice-call`, `voice-openai`, `working-directory`, plus
  `opencode-server.test.ts` which boots the service directly).
- 64 test files mention OpenCode; 17 more do so incidentally (help-text snapshots,
  `cli-lock.e2e.test.ts` is 48 of those).
- **No jcode harness exists.** There is no `startJcodeTestServer`, no deterministic jcode
  provider, no fake ACP peer shared across suites. The jcode proofs that exist are
  *opt-in acceptance suites against the real binary* with the flags
  `KIMAKI_JCODE_ACP_E2E`, `KIMAKI_JCODE_HUB_E2E`, `KIMAKI_JCODE_HOME`
  (`src/ops-jcode-acp.e2e.test.ts:12`, `src/ops-jcode-hub.e2e.test.ts:15`,
  `src/ops-jcode.e2e.test.ts:10`) — they prove plausibility, not parity. Behavioural
  parity for the bot (streaming text, tool parts, permission prompts, forms, queue/inbox,
  revert/undo, compaction, attachments) is currently unproven on jcode.

---

## 3. Phased plan

Constraint honoured throughout: no phase deletes a user-visible record. Phases 2 and 3 are
gated on the export in Phase 1.

### Phase 0 — Introduce the backend seam, change no behaviour

Goal: `kimaki bot` can be told to use jcode, but still defaults to OpenCode; no user sees a
difference.

| Step | Files | Risk | Proof |
|---|---|---|---|
| 0.1 Add `KIMAKI_BACKEND=opencode|jcode` (env) and `--backend` on `kimaki bot`, defaulting to `opencode` | `src/cli/bot.ts:183-224`, `src/main.ts:47-56,170-177` | Low: a new option, existing path untouched. Risk of two sources of truth if the default is duplicated (put it in one exported const, e.g. next to `src/opencode-server.ts:39`) | `kimaki bot --help` snapshot + a new `src/backend-selection.test.ts` asserting the default is `opencode` |
| 0.2 Introduce a `Backend` interface that `watchOpencode` already satisfies (`connect/ready/subscribe/stop`) and make `Bot.opencode` a discriminated union `{kind:'opencode'|'jcode'}` | `src/bot.ts:53`, `src/main.ts:170-206` | Medium: touches every `bot.opencode.endpoint.client` call site (`src/prompt.ts:264`, `src/lock-routes.ts:191,306`, `src/bot.ts:94`, `src/sessions.ts:262-277`). Compile errors are the safety net; do not widen types with `any` | `tsc --noEmit` clean, all existing e2e green (no behaviour changed) |
| 0.3 Add a `createJcodeConnection()` adapter implementing that interface over `src/backend/jcode.ts` + `src/backend/acp/client.ts`, gated so it is only constructed when `KIMAKI_BACKEND=jcode` | `src/backend/jcode.ts`, `src/main.ts` | Medium: ACP has no `session.view`, `model.list`, `session.active`, `permission.list`, `session.inbox.list` equivalents; the adapter must report unsupported explicitly, not silently no-op | new `src/backend/jcode-connection.test.ts` against a scripted ACP peer (`src/backend/acp/client.test.ts` pattern) |
| 0.4 Move kimaki's mirror reads off the OpenCode API where possible: make `session read` able to answer from `<dataDir>/session-events` | `src/session-events.ts:37-62,271-298`, `src/cli/session.ts` | Low: additive read path | new test asserting the same output from the JSONL mirror and from the live client for one thread |

**0.4 correction (measured 2026-11-19).** The stated proof is not satisfiable. The live `session read` path returns `message.list` variants (`kimaki/src/cli/session.ts:249-267`; `kimaki/src/session-events.ts:110,241-263,366-372`). Assistant variants carry `id` and `time.streamed`/`time.completed` (`kimaki/node_modules/@opencode/client/dist/promise/generated/types.d.ts:3276-3302`), which the JSONL mirror does not store as message variants; IDs would have to be reconstructed from raw events. The mirror writes `{ at, event }` lines (`kimaki/src/session-events.ts:37-43,73-79`) but omits `session.text.delta`, `session.reasoning.delta`, `session.tool.input.delta`, and `session.step.streamed` (`:26-32`) and truncates strings over 10,000 characters with a length marker (`:33,45-48`). A mirror-backed read can therefore only be a partial view whose omissions are named, not a byte-identical replacement. Re-scope or drop 0.4 rather than implement it as written.

Exit criteria: `KIMAKI_BACKEND=opencode` behaves exactly as today (full e2e suite green);
`KIMAKI_BACKEND=jcode` starts a bot that connects over ACP and can run one prompt in a
throwaway thread, with unsupported features reported as such.

### Phase 1 — Make jcode the default for new sessions, and export the old data

| Step | Files | Risk | Proof |
|---|---|---|---|
| 1.1 Default `KIMAKI_BACKEND` to `jcode` for **new** threads only; existing `thread_sessions` rows keep resolving through the OpenCode connection | `src/cli/bot.ts` default const, `src/sessions.ts:143-165`, `src/schema.ts:97-105` | High: split-brain — two live backends per bot. Mitigate by keeping `watchOpencode` alive read-only when any thread has an OpenCode id | new `src/backend-default.e2e.test.ts`: start with a seeded OpenCode thread + a new thread, assert each routes to its backend |
| 1.2 Add the export tool: `kimaki export opencode --out <dir>` reading OpenCode's SQLite (`session`, `message`, `part`, `credential` metadata-only) through the existing `ATTACH` pattern from `src/voice.ts:527` | new `src/cli/export.ts`, reuse `src/opencode-server.ts:158-160` | Medium: reading a foreign schema; must tolerate schema drift by failing loudly, never partially | new `src/export-opencode.e2e.test.ts` against the harness DB (`src/test/harness.ts:850-851` seeds a real table) |
| 1.3 Write a `thread_sessions.backend` column (default `'opencode'` for existing rows) and use it to resolve old vs new | `src/schema.ts:97-105`, `src/migrations.ts` | Medium: an additive migration; must backfill, not guess | migration test in `src/db.test.ts` |
| 1.4 Credential handoff: read the ChatGPT/Codex OAuth row out of `opencode.db` and store it in kimaki's own `bot_api_keys`/a new table so voice and voice-calls keep working | `src/voice.ts:522-540` (reader exists), `src/voice-call.ts:117-122` | High: refresh tokens rotate; copying without refreshing keeps them valid only until expiry. Do **not** refresh — read-only copy, fall back to API keys | `src/voice-openai.e2e.test.ts` + a new assertion that a copied token still transcribes and that a missing one degrades per `src/voice.ts:659` |
| 1.5 Onboarding: prefer jcode, demote `ensureOpencode` to a legacy check that runs only when an OpenCode thread is present | `src/onboarding.ts:82-114`, `src/cli/bot.ts:183-188` | Medium: users mid-migration must not be pushed into installing OpenCode | `src/onboarding.e2e.test.ts`, `src/onboarding-cli.e2e.test.ts` updated |

Exit criteria: fresh install needs no OpenCode binary; a user with existing threads still
sees them, because their `backend` column says `opencode` and the export ran.

**Cannot be done without losing user data:** deleting or rewriting OpenCode session rows,
or dropping `thread_sessions.session_id` values. Abandoning TUI-only sessions is a
conscious loss and must be recorded in the release notes, not silently performed.

#### Step 1.1 landed 2026-11-24: per-thread resolution, measured

The routing decision is no longer one-per-bot. Before this change `main.ts` picked a single
connection (`startBotConnection`), every `oc(bot, ...)` call read `bot.opencode.endpoint`, and a
jcode backend's endpoint is null: an OpenCode thread under a jcode bot was simply **not served**
(`OpenCodeUnavailableError: OpenCode service not reachable (not connected)`).

Now:

| Piece | Where |
| --- | --- |
| The only resolution rule (row -> backend, named errors, no fallback) | new `src/thread-backend.ts` |
| Rows loaded into memory, kept as recorded so an unknown value stays visible | `src/eventLoop.ts` `load()`, `store.ts` `threadBackends` |
| A new binding records the configured backend | `src/sessions.ts` `bindThread` (insert + `eventLoop.bind`) |
| Both connections started when a row needs OpenCode, none when no row does | `src/main.ts` `startBotConnections` + `backendPlan` |
| Every thread input resolved before its first OpenCode call | `src/prompt.ts` `dispatch` |
| The OpenCode preflight counts only OpenCode rows | `src/cli/bot.ts` |

Proof: `src/backend-default.e2e.test.ts` (5 cases). Real: the row/plan/resolution path, a real
SQLite database (legacy row -> `opencode`, bound row -> `jcode`), and the jcode half against the
real binary. Structural, and named as such in the test titles: the OpenCode twin cannot start on
this host, so a recording fake connection proves which connection a legacy thread routes to and
that its call arrives there, not that a real OpenCode service answers.

Two items this step does **not** settle, left to a product decision rather than guessed:

1. **`watchOpencode` "read-only" vs serving.** The step says keep it "alive read-only"; the same
   connection also carries `session.prompt`. This implementation serves legacy threads (the
   exit criteria require them to be reachable) and isolates the choice in one exported constant,
   `LEGACY_OPENCODE_THREADS_ACCEPT_INPUT` in `src/thread-backend.ts`. Flipping it to `false`
   makes legacy threads view-only with every input refused by name.
2. **"New threads use jcode" is not yet achievable end to end.** `createJcodeBotBackend` follows
   exactly one persisted session and creates none (`resolveSession` refuses an empty store), and
   `startSession` creates sessions through `oc(...)`, i.e. OpenCode. A jcode bot can therefore
   follow a seeded session but cannot create the "new thread" this step assumes. That gap is a
   jcode session-creation path (Phase 0.3 scope), not a routing rule.

   **Narrowed 2026-11-24 (creation on bind).** The creation half now exists:
   `src/jcode-thread.ts` `bindJcodeSession` mints a session with the seam's `follow: 'create'`
   (the thread's working directory as cwd, the user's first message as `createPrompt`) and
   writes the row through `src/bind-thread.ts` `bindThread`, the same writer the OpenCode path
   uses. `startSession` and `startCoordinator` take the jcode branch only when
   `bot.backendKind === 'jcode'`; the OpenCode path is untouched. A row that already names a
   session is returned unchanged (`reused: true`) and never re-created; a refusal writes no
   row and is posted on the thread it was for. Proof: `src/jcode-thread.e2e.test.ts` (3 cases,
   empty database + real binary: record on disk, row records id and `jcode`, second bind
   reuses with no second record, coordinator binds the channel id, empty primer writes
   nothing).

   What this still does **not** settle, and is the next step:
   - **Serving turns.** The created connection is stopped once its record settles: the bot has
     one jcode connection chosen at start (`thread-backend.ts`), and `prompt.ts` reaches
     backends only through `oc(...)`, whose jcode endpoint is null. A created thread therefore
     has a real session and no replies yet (`startJcodeThread` says so in the thread).
   - **A bot start still needs one persisted session.** `resolveSession` refuses an empty store,
     so on a cold home `startBotConnections` fails before any thread can be created. Creation
     on bind is reachable today only once the bot has started; a per-thread connection registry
     (or an "observe nothing yet" start) is the prerequisite for a truly fresh install.
   - **No worktree of its own for the coordinator**, and **no instructions entry** for either
     path: `putInstructions` is an OpenCode call, so a jcode session currently has no kimaki
     instructions/system-prompt entry.

### Phase 2 — Remove the OpenCode runtime from shipped paths

Only after every existing thread is either migrated or explicitly abandoned.

| Step | Files | Risk | Proof |
|---|---|---|---|
| 2.1 Delete the startup gate and `ensureOpencode` | `src/cli/bot.ts:183-188`, `src/onboarding.ts:82-114` | Medium: removes the last automatic install path | `kimaki bot` starts on a machine with no `opencode` in PATH (CI job with a scrubbed PATH) |
| 2.2 Delete `resolveOpencode`/`watchOpencode`/`serve` spawn and the service-file options | `src/opencode-server.ts:281-480`, `src/main.ts:47-56,170-177` | High: the biggest single deletion; keep the version/`PATH` helpers only if the read-only legacy path needs them | full e2e on jcode harness; a `rg opencode src --glob '!*.test.ts'` count of near-zero |
| 2.3 Delete the plugin shim installer/remover and the anthropic plugin | `src/opencode-server.ts:138-278`, `src/plugin/**`, `src/sessions.ts:252-295` | Medium: `plugin/anthropic` also holds the Anthropic subscription login — replace with a jcode credential path first (see 2.4) or accept its loss explicitly | `src/plugin.e2e.test.ts` deleted with it; new `src/credentials-jcode.e2e.test.ts` if replaced |
| 2.4 Replace provider login with a jcode-native path | `src/commands/login-commands.ts`, `src/cli/bot.ts:285-300`, `src/plugin/anthropic/index.ts` | High: this is the only way users authenticate. **Blocking, but not on capability** — corrected 2026-11-17: jcode already ships the whole surface (`jcode login` for OAuth/API key/local credentials, `jcode auth status`, `auth doctor`, `auth-test`, `provider`, and ~40 providers), and on this host `jcode auth status` reports `openai available` (OAuth, account `openai-otter`, automatic refresh) and `opencode-go available`. The gap is kimaki's wiring: nothing in kimaki calls or reads that surface yet | login e2e for the chosen jcode mechanism, plus a negative case where jcode holds no credential |
| 2.5 Drop `@opencode/client`, `@opencode/plugin`, `@opencode/cli` deps | `kimaki/package.json:28,29,58` | Low once code is gone | `pnpm install && tsc --noEmit` |
| 2.6 Rewrite `system-prompt.ts` prose and the `OPENCODE_SESSION_ID` env var (rename to `KIMAKI_SESSION_ID`, keep reading the old name for one release) | `src/system-prompt.ts:18,113,344,534,722,815,901`, `src/cli/shared.ts:22,57-59`, `src/lock-routes.ts:88`, `src/prompt.ts:60`, `src/cli/session.ts:62,142` | Medium: agents quoting the old name; dual-read avoids breakage | grep test asserting no `OPENCODE_` in shipped strings, plus agent-shell test |

### Phase 3 — Delete dead substrate

| Step | Files | Risk | Proof |
|---|---|---|---|
| 3.1 Delete `src/ops/runtime/opencode.ts` + its test, `src/ops-opencode.e2e.test.ts`, `src/opencode-server.test.ts` | 41 + 23 + 19 + 27 refs | Low | suite green without them |
| 3.2 Delete the `opencode` value of `--source` and `MetadataBackend` | `src/cli/ops.ts:188-208,323-325,402-419,289-313`, `src/ops/discord/publication.ts:18-43,123-144`, `src/ops/projection.ts:2,34-47` | Medium: persisted bindings (`ops.bindings`) may hold `backend_kind='opencode'` rows. Keep the *read* path for those rows, delete only the writer | `src/ops/registry.test.ts`, `src/ops/bindings.test.ts`, `src/ops-cutover-consumers.e2e.test.ts` |
| 3.3 Delete `src/test/replay.ts` and `docs/opencode-v2-events/` (16 fixtures) | `src/test/replay.ts:1,6,12`, `docs/opencode-v2-events/*` | Low | `thread-reducer.fixtures.test.ts` is removed with them; the reducer either goes or is re-pointed at jcode event shapes |
| 3.4 Remove the deterministic provider from the workspace and the harness | `src/test/harness.ts:20-29,60-231`, `kimaki/package.json:64`, `opencode-deterministic-provider/` | Medium: 47 suites depend on it — this is the last step, after the jcode harness replaces it | new `src/test/jcode-harness.ts` used by the same 47 suites |
| 3.5 Remove OpenCode from docs, skills, branch names | `kimaki/skills/kimaki-debug/SKILL.md`, `src/worktrees.ts:103`, `README`, `scripts/tool-usage-report.ts` | Low | `rg -i opencode` returns only CHANGELOG |

**Cannot be done without losing user data:** 3.1-3.5 must not run before Phase 1.2 export
has been executed for every install that has OpenCode history. Deleting `opencode.db`, the
`~/.opencode/bin` install, or `<config>/opencode/plugins/kimaki/` is an *uninstaller*
concern that needs the user's explicit action; kimaki must never do it on their behalf.

---

## 4. Open questions a reader will hit immediately

1. `session.view`, `model.list`, `session.active`, `permission.list`, `session.inbox.list`,
   `session.form.list`, `snapshot.restore` (`src/event-loop.ts:104,311,360-362`,
   `src/prompt.ts:486`) have no jcode ACP counterpart today. Either jcode grows them or the
   Discord UI loses read-state, model pickers, busy indicators, permissions, queue and undo.
   This is the real scope of Phase 0.3 and is larger than "swap the transport".
2. The reducer (`src/thread-reducer.ts`) is a fold over **V2 event shapes**. jcode's ACP
   `session/update` notifications are a different vocabulary; `src/backend/acp/contracts.ts`
   is where the mapping would live.
3. Anthropic subscription login (`src/plugin/anthropic/index.ts`) is a *provider*
   capability, not an OpenCode one, but it is implemented as an OpenCode plugin. It needs a
   jcode-side home before Phase 2.4 can ship.

### Type-check failure in fresh worktrees (corrected 2026-11-20)

The earlier junction/NodeNext explanation was wrong. A full unfiltered
`pnpm install --frozen-lockfile --prefer-offline` (no junction) still produced 3,234 diagnostics.
The real cause: `errore` is a git submodule (`.gitmodules` ->
https://github.com/remorses/errore.git, pinned cbe571937d2c188d5a79ae52ee3b7a6ec5ed3c6e) left
uninitialized in the fresh worktree, so it resolved to an empty directory.
`kimaki/src/errors.ts(3,25) TS2307 Cannot find module 'errore'` cascaded through every
`ConfigError`-derived error (TS2322/TS2554/TS2739/TS2345) into all 3,234 diagnostics. After
`git submodule update --init -- errore` and building its `dist/` with the workspace TypeScript
(36 files emitted), the same check dropped to 3 errors: pre-existing `TS2307 Cannot find module
'./generated/client.js'` in `discord-digital-twin/src/{db,serializers,server}.ts` (an ungenerated
Prisma client in a sibling workspace package, not our code). `--listFilesOnly` confirmed all six
files under review compile and none appear in the final log. Rules: initialize submodules and
build their `dist/` before type checking; run `tsc -p kimaki --noEmit` detached with ~25 minute
patience (~22 minutes on this loaded host), since a blocking 10-minute call gets killed and
misread as a hang.
