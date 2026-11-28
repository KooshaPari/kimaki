# Runtime traps

Three measured behaviours that mislead. Each entry records the symptom, the verbatim message, the
misleading downstream symptom, and the workaround in use. Nothing here is inferred beyond the
recorded measurements.

## 1. jcode rejects a model its endpoint advertises

**Symptom.** A loopback OpenAI-compatible mock lists `mock-model` from `/v1/models`, and jcode still
refuses to run with it.

**Message.**

```
Failed to select model 'mock-model': Unsupported OpenAI model 'mock-model'. Use /model to choose from the models available to your account.
```

**Why it misleads.** jcode validates `-m <id>` against its own model catalog before it sends any
request. An endpoint that advertises a model proves nothing about whether jcode will accept it, so a
mock that is correct on the wire still looks like a broken mock.

**Workaround in use.** Omit `-m` and let the binary use its configured default. `JCODE_MODEL` is the
override. Both are implemented in `kimaki/src/test/jcode-seed.ts`. Evidence:
`kimaki/src/backend/jcode-observe.test.ts:58`, `kimaki/src/backend/jcode-bot-backend.test.ts:374`,
`kimaki/src/analytics.e2e.test.ts:407`.

## 2. jcode persists no session record without credentials

**Symptom.** `jcode run` in a fresh `JCODE_HOME` exits 1 and writes nothing under `<home>/sessions`.

**Message.**

```
Error: No credentials configured for provider auto-detection; automatic login/bootstrap is disabled during validation.
```

**Why it misleads.** Naming a model does not help (measured with `-m gpt-5.5`), and neither does
copying a `config.toml` that names a default provider and model: the missing piece is credentials, not
a model id. Downstream, the absent record surfaces as `ENOENT: scandir <home>/sessions`, which names
neither the exit code nor the message a cold machine produces.

**Workaround in use.** Run with `-p openai-api` pointed at a loopback Responses-API SSE server. jcode
then has a provider it can authenticate to, so it persists a real record itself: no paid call, no
network beyond `127.0.0.1`. Implemented in `kimaki/src/test/jcode-seed.ts`, which also fails fast on
the binary's own exit code and stderr rather than degrading to the ENOENT.

## 3. Pinned @opencode/cli 2.0.29 cannot execute on NixOS

**Symptom.** `spawn` of the pinned `@opencode/cli` (2.0.29) fails on NixOS.

**Message.** `spawn` returns `ENOENT`; 44 e2e files die in `beforeAll` with:

```
OpenCode test server failed to start
```

**Why it misleads.** The package bin is a musl ELF whose interpreter `/lib/ld-musl-x86_64.so.1` is
absent. The glibc platform variant wants `/lib64/ld-linux-x86-64.so.2`, which NixOS refuses to run. So
the true cause is an unrunnable interpreter, while the visible failure is a test-server start error
inside `beforeAll`, and the cases are skipped, not failed. This is the legacy backend, not jcode.

**Workaround.** None, and none is wanted: the suites disappear when Phase 2 removes OpenCode. A host
with a runnable Linux opencode binary can run them. Evidence: `kimaki/src/test/harness.ts:231`;
environment facts in `docs/nixos-environment.md` ("OpenCode e2e suites cannot start here") and
`docs/opencode-removal.md`.
