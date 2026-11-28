# OpenCode test substrate

How much of the `kimaki` test suite is green only because an OpenCode server boots, what
`src/test/harness.ts` actually does, what jcode-backed substrate already exists, and the order in
which each file can move to jcode.

Scope: `kimaki/src/**/*.test.ts` at the time of writing. Read-only audit: no test was modified and
no suite was run; counts come from measured declaration sites.

Measurement: every count below is `Select-String` over `^\s*(test|it)(\.\w+)?\(` in each file. That
counts declaration sites, which equals executed tests for these files: no `.each(` or `for` loop
test generation exists anywhere in the audited set (the only four `test.each` uses in the package
are `src/worktrees.test.ts:64`, `src/ops/registry.test.ts:43,83,156`, none of them substrate files).
`test.skipIf(...)` declarations are counted as tests because they are real assertions of either the
behaviour or the dormancy contract.

---

## 1. Files on OpenCode substrate

53 files, 215 tests. Breakdown:

| Tier | Files | Tests | What the OpenCode server is for |
| --- | --- | --- | --- |
| Starts an OpenCode server (`startOpencodeTestServer`) | 46 | 176 | booted real service; the model answers over HTTP |
| Imports `src/test/harness.ts` but no server | 4 | 4 | `startTwin`, `tempDataDir`, `freePort`, `opencodeBinary()` |
| Imports `src/test/replay.ts` only | 3 | 35 | recorded OpenCode V2 event fixtures, no process |
| **Total** | **53** | **215** | |

### 1a. Starts an OpenCode server (46 files, 176 tests)

`S` = OpenCode server is essential to what the test asserts (the assertion is about OpenCode's own
behaviour: service discovery, catalog, credentials, plugin loading, permission protocol, session
API). `T` = structural: asserts bot behaviour over a live native session; the substrate is
replaceable if jcode can serve one session per thread. `I` = incidental: the server exists only to
produce one deterministic turn.

| File | Tests | Class | Evidence of the OpenCode dependency |
| --- | --- | --- | --- |
| `src/agent-ui.e2e.test.ts` | 3 | S | `:8` harness import, `:31` server; asserts the agent shim, upload modal and `session.view` semantics |
| `src/analytics.e2e.test.ts` | 1 | I | `:17` harness, `:58` server; asserts funnel events from one Discord turn |
| `src/btw.e2e.test.ts` | 2 | S | `:38` server; asserts OpenCode fork semantics (`. btw`, `/btw`) |
| `src/catalog-refresh.e2e.test.ts` | 2 | S | `:36` server; `:119` asserts `skill.updated` from OpenCode's file scan |
| `src/cli-discord.e2e.test.ts` | 1 | T | `:17` server; CLI lists threads/users |
| `src/cli-lock.e2e.test.ts` | 7 | T | `:17` server; `:36` `KIMAKI_OPENCODE_SERVICE_FILE`; session continues through the bot API |
| `src/cli-read.e2e.test.ts` | 2 | T | `:17` server; `:29` service file; reads real session history |
| `src/cli-sessions.e2e.test.ts` | 4 | T | `:28` server; diff/editors read the OpenCode session folder |
| `src/commands.e2e.test.ts` | 5 | S | `:49` server; asserts the OpenCode catalog (`/<agent>-agent`, `/<cmd>-cmd`, `/<skill>-skill`) |
| `src/coordinator-agents.e2e.test.ts` | 4 | S | `:54` server; coordinator agent/model kept across sessions |
| `src/coordinator-idle.e2e.test.ts` | 2 | S | `:37` server; `:40` "OpenCode rejects a summary without the template headings" |
| `src/coordinator-queue.e2e.test.ts` | 7 | S | `:57` server; queue + coordinator turns |
| `src/coordinator-warmup.e2e.test.ts` | 2 | S | `:91` server; warmup + compaction (`:95` same summary rule) |
| `src/coordinator.e2e.test.ts` | 13 | S | `:66` server; 13 tests over worker/coordinator sessions incl. restart survival |
| `src/gateway-replay.e2e.test.ts` | 2 | I | `:29` server; asserts Discord gateway replay/401 recovery |
| `src/harness.e2e.test.ts` | 4 | S | `:37` server; `:52-68` asserts service connect/reconnect on a new port |
| `src/hello-thread.e2e.test.ts` | 6 | T | `:39` server; thread creation, footer, `/session-id`, follow-up continues the session |
| `src/ingest-injection.test.ts` | 4 | T | `:128` server; whole ingress path with a real turn |
| `src/interrupt.e2e.test.ts` | 3 | T | `:47` server; interrupt/abort/queue |
| `src/legacy.e2e.test.ts` | 1 | I | `:36` server; V1 DB import then one reply |
| `src/login.e2e.test.ts` | 3 | S | `:15` server with `src/test/auth-plugin`; asserts OpenCode credential store and `/model` catalog |
| `src/observe-restart-witness.test.ts` | 2 | T | `:253` server for the restart half; `:143` the AC02 half already uses a real `jcode.exe` |
| `src/onboarding-cli.e2e.test.ts` | 2 | I | `:47` server; install/onboard/ready |
| `src/onboarding.e2e.test.ts` | 2 | I | `:70` server; onboarding thread adds a project channel |
| `src/ops-follow.e2e.test.ts` | 3 | T | `:12` server; follows an OpenCode service file |
| `src/ops-lifecycle.e2e.test.ts` | 2 | T | `:7` server; external session observed, not controlled |
| `src/ops-opencode.e2e.test.ts` | 1 | S | `:5` `resolveOpencode`, `:8` server; native external session discover/read/observe/detach |
| `src/permissions.e2e.test.ts` | 3 | S | `:64` server with `effect: 'ask'`; asserts OpenCode's tool-permission protocol (Accept/Deny/subagent) |
| `src/plugin.e2e.test.ts` | 2 | S | `:34` server; `:1-5` asserts OpenCode loads `plugins/kimaki` from its config dir |
| `src/preference-commands.e2e.test.ts` | 8 | S | `:47` server; `/agent`, `/model`, `/model-variant` against the OpenCode catalog |
| `src/questions.e2e.test.ts` | 7 | S | `:72` server; OpenCode question tool and forms |
| `src/queue-sources.e2e.test.ts` | 5 | T | `:77` server; queue sources (CLI/TUI/plain) |
| `src/queue.e2e.test.ts` | 4 | T | `:47` server; queue ack/delete/edit |
| `src/remote-send.e2e.test.ts` | 3 | I | `:18` server; remote envelope routing |
| `src/renderer.e2e.test.ts` | 6 | S | `:121` server; asserts rendering of OpenCode tool parts (shell/edit/read, Code Mode, subagent) |
| `src/restart.e2e.test.ts` | 2 | T | `:28` server; bot restart continues a session |
| `src/routines.e2e.test.ts` | 3 | T | `:46` server; routine rows drive sessions |
| `src/scheduler.e2e.test.ts` | 6 | T | `:40` server; one-shot/cron routines start threads |
| `src/session-commands.e2e.test.ts` | 6 | S | `:71` server; `/new-session`, `/resume`, `/fork`, `/fork-subagent` |
| `src/session-ops.e2e.test.ts` | 5 | S | `:66` server; `/undo`, `/redo`, `/compact`, context usage |
| `src/shell.e2e.test.ts` | 4 | T | `:67` server; `!cmd` output reaches the model, `/command` |
| `src/sleep.e2e.test.ts` | 2 | I | `:68` server with `generate-log-plugin`; sleep wake |
| `src/voice-attachments.e2e.test.ts` | 6 | T | `:72` server plus `startFakeGemini`; transcription plus one turn |
| `src/voice-call.e2e.test.ts` | 5 | T | `:75` server plus `startFakeLive`; realtime call transcript plus turns (2 tests skip without a POSIX shell, `:117`, `:224`) |
| `src/voice-openai.e2e.test.ts` | 4 | T | `:66` server; transcription routing, and the ChatGPT credential is read **from the OpenCode DB** |
| `src/working-directory.e2e.test.ts` | 5 | S | `:24` server; native session cwd moves and worktrees |

### 1b. Imports harness but never boots a server (4 files, 4 tests)

| File | Tests | What it borrows |
| --- | --- | --- |
| `src/ops-cutover-consumers.e2e.test.ts` | 1 | `startTwin`, `tempDataDir` (`:24`); hub is a fake `HubBackend` (`:45-50`) |
| `src/opencode-server.test.ts` | 1 | `opencodeBinary()` (`:10`), asserts `findOpencodeBinary` (`:9`, `:23-26`) |
| `src/tts.test.ts` | 1 | `freePort()` (`:7`) |
| `src/voice.test.ts` | 1 | `tempDataDir()` (`:6`) |

### 1c. Imports `src/test/replay.ts` (3 files, 35 tests)

| File | Tests | Substrate |
| --- | --- | --- |
| `src/analytics.test.ts` | 6 | `:9` `loadFixture`; folds recorded OpenCode event streams |
| `src/thread-reducer.fixtures.test.ts` | 14 | `:8` `replay`; recorded fixtures |
| `src/thread-reducer.test.ts` | 15 | `:8` `replay`; recorded fixtures plus hand-built events |

No process is spawned. The dependency is the fixture corpus
`docs/opencode-v2-events` (path resolved at `src/test/replay.ts:12`): 35 tests would keep passing
mechanically after a runtime change while silently testing an event vocabulary the product no
longer receives.

### 1d. OpenCode-typed but server-free (annex, outside the 53)

`src/ops/runtime/opencode.test.ts` (16), `src/ops/discord/publication.test.ts` (13),
`src/ops/projection.test.ts` (9), `src/format-parts.test.ts` (2), `src/db.test.ts` (9) only use
OpenCode *types* or strings. They need a type rename, not a substrate.

---

## 2. What `src/test/harness.ts` actually does

One file, 1000+ lines, three responsibilities: boot an OpenCode service, fake every external
provider, and start the bot in-process.

### Boot sequence of `startOpencodeTestServer` (`:126-268`)

1. `:149` `fs.realpathSync(fs.mkdtempSync(os.tmpdir()/kimaki-e2e-))` — a private root per file.
2. `:150-152` `project/` with `git init -q -b main` — the session working directory.
3. `:153` `state/opencode/service.json` — the registration file the bot discovers, same shape as a
   user's service.
4. `:154` `startTestModel` (`:81-107`) — an in-process HTTP server that OpenCode's provider POSTs
   every prompt to. `resolveResponse` from `opencode-deterministic-provider` answers; matchers can
   be pushed per test; `model.requests` records what the model saw.
5. `:155-163` config from `buildDeterministicOpencode2Config`, allow-all shell/edit permissions,
   caller-supplied extra permissions.
6. `:164-200` environment isolation: inherit `process.env` minus `OPENCODE_*` and `*_API_KEY`, then
   `HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
   `OPENCODE_CONFIG_CONTENT` (commands, agents, models, mcp, plugins), `OPENCODE_DISABLE_*`.
   `~/.agents/skills` is created so OpenCode watches a real skill dir.
7. `:207-209` `spawn(opencodeBinary(), ['serve','--service','--port',<fresh>,'--hostname','127.0.0.1'])`.
   `opencodeBinary()` (`:62-66`) resolves `@opencode/cli/bin/opencode.exe` through
   `createRequire`, bypassing the `.bin` sh wrapper that orphans on SIGTERM.
8. `:220-231` poll `Service.discover({ file: serviceFile })` every 100 ms until the URL ends with
   this port, 60 s deadline, one retry (`:203-233`), then `kill()` on failure.
9. `:244-247` `client()` re-discovers and returns `OpenCode.make({ baseUrl, headers })`.
10. `:253-262` returns `{ root, model, serviceFile, configDir, dbFile, projectDirectory,
    skillsDirectory, client, kill, start, stop }`.

### Other behaviours the harness substitutes

- `warmUp` (`:271-277`): create session, prompt, wait, remove — pays OpenCode's cold start before
  the first Discord wait.
- `startTestBot` (`:556-636`): starts the lock server, then `startBot` with
  `opencodeServiceFile: server.serviceFile`, `opencodeConfigDir: server.configDir`,
  `opencodeDbFile`, `ensureOpencode: false` (`:616-619`). The bot is the real `src/cli.ts` under
  `tsx`, in-process.
- `startTwin` (`:485-528`): `discord-digital-twin` with a per-twin file DB, three channels and two
  users; optional gateway-proxy mode and a voice server. Backend-agnostic.
- `seedProjectChannel` (`:530-554`): inserts `channel_directories` and verbosity rows directly.
- `startFakeLive` (`:323-483`): GPT-Live over real WebRTC on loopback (werift + opusscript),
  scripted transcripts and audio. Backend-agnostic.
- `startFakeGemini` (`:716`), `startFakeOpenAI` (`:761`), `startFakeChatGPT` (`:817`):
  transcription endpoints. Backend-agnostic except `writeOpencodeCredential` (`:851`), which writes
  the ChatGPT access token **into the OpenCode SQLite file**.
- `schedulingKit` (`:649-698`): lock-route POSTs and a real CLI child whose env carries
  `KIMAKI_OPENCODE_SERVICE_FILE` (`:672`).
- `manualClock` (`:638`), `waitFor` (`:865`), `waitForFooter` (`:891`), select/media matchers
  (`:940-1030`). Backend-agnostic.

### What a jcode equivalent would need

| Harness behaviour | jcode counterpart needed |
| --- | --- |
| `:207-231` spawn `serve --service --port` + `Service.discover` | jcode has no `service.json`. `ops jcode serve` prints a loopback URL (`src/cli/ops.ts:558`); the harness would own that URL instead of discovering a file. ACP-only tests need a stdio child instead. |
| `:81-107` HTTP provider responder | No jcode provider HTTP surface. The substitute must sit at the ACP boundary: a temp Node script that speaks ACP, exactly as `src/backend/acp/client.test.ts:13` already does, or a `--model`-selected deterministic jcode profile. |
| `:155-200` config injection (commands, agents, mcp, permissions, plugins) | jcode has no per-test config dir. Tool exposure is a CLI flag (`jcode acp --tool-profile none|minimal|full`, `src/backend/jcode.ts:19`); catalog/agents/plugins have no equivalent. |
| `:62-66` binary resolution | Same shape: `JCODE_BIN` then `%LOCALAPPDATA%\jcode\bin\jcode.exe` (already implemented in `src/backend/hub.real-launch.test.ts:23-35` and `src/observe-restart-witness.test.ts:48-58`). |
| `:616-619` bot wiring | `startBot` has **no** backend option: `src/main.ts:22` imports `watchOpencode`, `:170-177` constructs it, and options are `opencodeServiceFile`/`ensureOpencode`/`opencodeConfigDir`/`opencodeDbFile` (`:47-56`). A jcode-backed bot needs a new event source plus a hub adapter; nothing wires `JcodeBackend`/`SessionHub` into `startBot` today. |
| `:851` credential write | jcode has its own credential store; the voice-openai chain (`OPENAI key -> OpenCode ChatGPT credential -> KIMAKI_WHISPER_URL`) is OpenCode-specific. |
| `:485-528`, `:530-554`, `:323-483`, `:638-1030` | Reusable unchanged. |

---

## 3. Existing jcode test substrate

| File | Tests | Real binary? | Skips when absent? | Notes |
| --- | --- | --- | --- | --- |
| `src/backend/hub.real-launch.test.ts` | 2 | yes, `jcode.exe` | yes: `:23-35` `findJcode()`, `:73-75` `ctx.skip(true, 'real jcode binary not found ... (set JCODE_BIN instead)')` | Wraps the real spawn (`:58-68`), kills mid-handshake, asserts the AC15 pre-ACK launch bound. Second test is a synthetic launch-fence refusal. |
| `src/backend/hub.test.ts` | 38 | no | n/a | Fake `HubBackend`; one test (`:828-831`) runs a Node crash script through `createAcpClient`, not jcode. |
| `src/backend/hub-server.test.ts` | 9 | no | n/a | Loopback SSE surface over the hub. |
| `src/backend/hub-client.test.ts` | 5 | no | n/a | Client/cursor. |
| `src/backend/hub-launch-fence.test.ts` | 3 | no | n/a | Fence unit tests. |
| `src/backend/acp/client.test.ts` | 24 | no | n/a | `:1-2` "No real jcode binary: a temp Node script speaks the protocol with the frame shapes observed from jcode 0.99.1"; script built at `:13`, capabilities at `:27-40`. |
| `src/backend/jcode.test.ts` | 22 | no | n/a | Fake `AcpClient` (`:1`); asserts `jcode acp --tool-profile none` default (`:98-101`) and profile identity refusal. |
| `src/ops/runtime/jcode.test.ts` | 17 | no | n/a | Synthetic Jcode home on disk; `:314-460` real concurrent-write consistency against temp files. |
| `src/ops-jcode.e2e.test.ts` | 2 | real CLI, explicit home | yes: `:10` `test.skipIf(!process.env['KIMAKI_JCODE_HOME'])` | Metadata-only discovery; second test asserts the refusal without a home. |
| `src/ops-jcode-acp.e2e.test.ts` | 3 | yes: CLI child spawns real `jcode acp` (`:32`, `:65-70`) | yes: `:12` `ENABLED`, `:99`/`:135` `skipIf(!ENABLED)`, `:155` asserts dormancy | Opt-in `KIMAKI_JCODE_ACP_E2E=1`; one real turn JSON, one streamed. |
| `src/ops-jcode-hub.e2e.test.ts` | 4 | yes (`:94-96` `ops jcode serve`) | yes: `:15`, `:92`/`:147`/`:207` `skipIf(!ENABLED)`, `:140` dormancy | `kills`: fans one turn to two clients; refuses a second hub; resumes after hub restart. |
| `src/observe-restart-witness.test.ts` | 2 | jcode for AC02 only | yes: `:138-143` `test.skipIf(skipJcode)` | AC35 restart half still needs the OpenCode server (`:253`). |
| `src/ops/discord/view.test.ts` | 23 | no | n/a | Real `createSessionHub` + `startHubServer`, fake `HubBackend` (`:20-24`); proves the Discord view is backend-agnostic. |
| `src/ops/discord/view-supervision.test.ts` | 6 | no | n/a | Same shape. |
| `src/ops/discord/echo.test.ts` | 6 | no | n/a | Same shape. |
| `src/ops/discord/watch.test.ts` | 3 | no | n/a | Same shape. |
| `src/ops-rebind-live.test.ts` | 2 | no | n/a | Real hub + loopback relay; the backend is a double (`:1-20`). |
| `src/ops-cutover-consumers.e2e.test.ts` | 1 | no | n/a | Real hub, real CLI processes, fake backend. |

Production wiring, for contrast: `JcodeBackend` (`src/backend/jcode.ts:54`) satisfies `HubBackend`
(`src/backend/hub.ts:36-41`), and `ops jcode run|serve|attach|watch|history` exist at
`src/cli/ops.ts:517,558,623,765,1012`. So the jcode substrate exists as **ops/backend surface**, not
as the bot's runtime.

---

## 4. Gap analysis by behaviour group

| Behaviour group | jcode-backed coverage today | Verdict |
| --- | --- | --- |
| **Multi-client attach** | `src/ops-jcode-hub.e2e.test.ts:92` fans one real jcode turn to two clients; `src/backend/hub.test.ts` (38) + `hub-server.test.ts` (9) + `hub-client.test.ts` (5) cover cursors/fan-out on a fake backend; `src/ops/discord/view.test.ts` (23) proves the Discord view consumes any `HubBackend`. | Covered, but opt-in (`KIMAKI_JCODE_HUB_E2E=1`) and never exercised inside the bot process. No gap in code, gap in default CI. |
| **Hub restart** | `src/ops-jcode-hub.e2e.test.ts:207` resumes the same stream after the hub restarts (opt-in); `src/observe-restart-witness.test.ts:143` real jcode for passive observe. | Hub restart: covered. **Bot restart: OpenCode only** (`src/restart.e2e.test.ts`, `src/coordinator.e2e.test.ts:13th test`, `src/observe-restart-witness.test.ts:253` half). |
| **Discord view** | `src/ops/discord/view.test.ts` (23), `view-supervision.test.ts` (6), `echo.test.ts` (6), `watch.test.ts` (3), `src/ops-rebind-live.test.ts` (2), `src/ops-cutover-consumers.e2e.test.ts` (1): all run on the real hub with a fake backend, no OpenCode server. | **Already substrate-independent.** Nothing here needs to migrate. |
| **Scheduler / routines** | `src/scheduler.test.ts` (3) is pure unit; there is no jcode-backed bot. | **Coverage exists ONLY through OpenCode** (`src/scheduler.e2e.test.ts` 6, `src/routines.e2e.test.ts` 3), because `startTestBot` requires an `OpencodeTestServer` (`harness.ts:575,616`). |
| **Voice** | `src/tts.test.ts` (1) and `src/voice.test.ts` (1) are unit; the fake WebRTC/transcriber servers are backend-agnostic, but every end-to-end test needs a bot turn. | **Only through OpenCode** (`voice-attachments` 6, `voice-call` 5, `voice-openai` 4). Extra coupling: `writeOpencodeCredential` (`harness.ts:851`) stores the ChatGPT token in the OpenCode DB. |
| **Auth / login** | none. `src/credentials.ts` is Discord credentials; OpenCode provider credentials have no jcode path. | **Only through OpenCode** (`src/login.e2e.test.ts` 3 + `src/test/auth-plugin`). |
| **Session listing** | `src/ops/runtime/jcode.test.ts` (17) covers passive jcode discovery/pagination/snapshot; `src/ops-jcode.e2e.test.ts:10` covers real-home discovery (opt-in). `src/hello-thread.e2e.test.ts` `/session-id` is bot-level. | Split: **passive listing has jcode parity**, but the bot's session list/read/sync/events/diff (`cli-read` 2, `cli-sessions` 4, `session-commands` 6) read the OpenCode session store and have **no** jcode path. |

---

## 5. Ordering by cost to rewrite

Tiers are ordered by how much of the test's assertion depends on OpenCode rather than on "a session
exists and answered". Within a tier, files are ordered cheapest first.

### Tier 0 — no OpenCode process today (7 files, 39 tests)

| File | Tests | Why cheap |
| --- | --- | --- |
| `src/ops-cutover-consumers.e2e.test.ts` | 1 | fake `HubBackend` already; only `startTwin` is reused |
| `src/tts.test.ts` | 1 | `freePort()` only |
| `src/voice.test.ts` | 1 | `tempDataDir()` only |
| `src/opencode-server.test.ts` | 1 | tests OpenCode binary resolution; retires with the runtime, not migrated |
| `src/analytics.test.ts` | 6 | pure fold over recorded events; needs a jcode fixture corpus |
| `src/thread-reducer.fixtures.test.ts` | 14 | replay only; same fixture issue |
| `src/thread-reducer.test.ts` | 15 | replay only; same fixture issue |

The three replay files cost little to *run* on jcode but lose meaning without new fixtures. They are
cheap to migrate only if the event vocabulary is mapped first.

### Tier 1 — turns only, no OpenCode API asserted (13 files, 35 tests)

`analytics.e2e` 1, `gateway-replay.e2e` 2, `legacy.e2e` 1, `remote-send.e2e` 3, `onboarding.e2e` 2,
`onboarding-cli.e2e` 2, `restart.e2e` 2, `interrupt.e2e` 3, `queue.e2e` 4, `queue-sources.e2e` 5,
`sleep.e2e` 2, `ingest-injection` 4, `shell.e2e` 4.

Assertions are about routing, threads, queueing, DB import, restart and gateway recovery. None
reads an OpenCode API. `shell.e2e` is at the top of this tier because `!cmd` output must reach the
model, which needs a real tool round trip.

### Tier 2 — bot behaviour over a live session (19 files, 83 tests)

`cli-discord` 1, `cli-lock` 7, `cli-read` 2, `cli-sessions` 4, `session-commands` 6, `session-ops` 5,
`scheduler.e2e` 6, `routines.e2e` 3, `voice-attachments` 6, `voice-call` 5, `voice-openai` 4,
`questions` 7, `agent-ui` 3, `working-directory` 5, `renderer` 6, `ops-follow` 3, `ops-lifecycle` 2,
`observe-restart-witness` 2, `hello-thread.e2e` 6.

These need one durable session per thread (fork, resume, cwd move, queue, restart, timer-driven
start). A jcode-backed bot could serve them, but `startBot` has no backend seam and the CLI paths
carry `KIMAKI_OPENCODE_SERVICE_FILE`. `session-commands`/`session-ops` sit at the expensive end
because `/fork`, `/undo` and `/compact` are OpenCode session operations.

### Tier 3 — OpenCode semantics are the subject (14 files, 58 tests)

`btw` 2, `catalog-refresh` 2, `commands` 5, `coordinator-agents` 4, `coordinator-idle` 2,
`coordinator-queue` 7, `coordinator-warmup` 2, `coordinator` 13, `harness.e2e` 4, `login` 3,
`ops-opencode` 1, `permissions` 3, `plugin` 2, `preference-commands` 8.

What puts a file here: the assertion names an OpenCode mechanism, not a bot outcome. `plugin.e2e`
asserts that OpenCode loads `plugins/kimaki/` from its global config dir and that a restart does not
rewrite it (`src/plugin.e2e.test.ts:1-5`). `catalog-refresh.e2e` asserts OpenCode's lazy scan
publishes `skill.updated` (`src/catalog-refresh.e2e.test.ts:119`). `commands`/`preference-commands`
assert the catalog itself. `coordinator*` asserts OpenCode compaction and summary-heading rules
(`src/coordinator-idle.e2e.test.ts:40`). `harness.e2e` asserts service discovery and reconnect on a
new port (`src/harness.e2e.test.ts:52-68`). None of these has a jcode mechanism to move onto today.

### Migrate first (3)

1. **`src/analytics.e2e.test.ts`** (1 test). The only assertion is that a Discord turn emits funnel
events with anonymous identity props (`:58` boots the server, the test never touches an OpenCode
API). Cheapest possible jcode proof point: one thread, one reply, events captured.
2. **`src/gateway-replay.e2e.test.ts`** (2 tests). Asserts Discord gateway replay after the bot is
offline and recovery after repeated 401 (`:29` only needs a server that answers). Nothing about the
agent is asserted, so a scripted backend is sufficient.
3. **`src/legacy.e2e.test.ts`** (1 test). Asserts a V1 database import and one reply in an old thread.
The session identity comes from the imported row; the agent only has to answer once.

All three assert an outcome the bot reaches before the agent matters, so they prove the jcode seam
(a bot that answers at all through jcode) with the least rewriting risk.

### Stay on OpenCode longest (3)

1. **`src/plugin.e2e.test.ts`** (2 tests). It asserts OpenCode's plugin loader reads
   `plugins/kimaki/` from the global config dir, that a restart does not rewrite the shim, and that
   a plugin listed in `opencode.json` loads once and is removed. jcode has no plugin/config-dir
   surface: there is nothing to migrate the assertion onto without building one.
2. **`src/login.e2e.test.ts`** (3 tests). It asserts an OpenCode credential store and the resulting
   `/model` provider catalog (plus the test-only `src/test/auth-plugin`). The bot has no jcode
   credential bridge; `writeOpencodeCredential` (`harness.ts:851`) writes into OpenCode's SQLite.
3. **`src/catalog-refresh.e2e.test.ts`** (2 tests). It asserts OpenCode's lazy agent/skill scan and
   `skill.updated` publication (`:119`), including that an unchanged catalog writes nothing to
   Discord. That is OpenCode file-watching semantics, not a bot behaviour.

Runner-up, for a different reason: **`src/opencode-server.test.ts`** (1 test) should never be
migrated. It asserts `findOpencodeBinary` version gating (`:23-26`). It retires when the runtime is
deleted, and it is the file that tells you the runtime is still required.

### Ordering summary

| Order | Files | Tests | Rationale |
| --- | --- | --- | --- |
| 1 | Tier 1 low-coupling (`analytics.e2e`, `gateway-replay`, `legacy`) | 4 | bot outcome only, no OpenCode API |
| 2 | Rest of Tier 0 and Tier 1 (`39` + `31`) | 70 | helper-only or turn-only scaffolding |
| 3 | Tier 2 | 83 | needs a durable session seam in `startBot` |
| 4 | Tier 3 | 58 | needs OpenCode mechanisms that jcode does not have |

No test is proposed for deletion. The last column that matters is substrate: 176 tests boot an
OpenCode server today; 39 need no process at all; 83 could run on either runtime once `startBot`
accepts a backend; 58 assert OpenCode itself. (176 + 39 + 58 = 273; the 83 overlap with the 176,
as they are server-backed tests that could move.)
