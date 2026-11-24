# Building and testing on NixOS

Date: 2026-11-23. Measured on the NixOS host. Nothing here is carried over from the Windows desk
host; where a fact was not measured it is marked UNKNOWN.

## Host

| Item | Value |
| --- | --- |
| OS | Linux, NixOS |
| Cores | 16 |
| RAM | 31 GB |
| Free disk | 129 GB at the time of writing |
| Node | v24.22.2, from the nix profile |
| git, gh | authenticated |
| pnpm | absent from PATH |

## pnpm

`pnpm` is not on PATH. `corepack enable` fails with EROFS because `/nix/store` is read-only, so the
working route is the prepare step, which writes into corepack's own cache outside the store:

```
corepack prepare pnpm@9.15.9 --activate
```

pnpm 9.15.9 verified.

## Install

`pnpm install` must be run with `--ignore-scripts` on this host. It took 14 minutes and produced
3.5 GB of `node_modules`.

The consequence matters for the rest of this document: the native build scripts (libsql,
`@discordjs/opus`) are NOT compiled by default under `--ignore-scripts`. That is why the package
manager step is listed separately from the test step. A suite that needs one of those native
binaries is a different procedure and is not covered here.

## Submodules

Four submodules: `errore`, `traforo`, `gateway-proxy`, `opencode-injection-guard`.

```
git submodule update --init --recursive
```

Each workspace dependency must be built before type checking:

```
pnpm --filter errore build
pnpm --filter traforo build
pnpm --filter opencode-injection-guard build
```

Without the `errore` build, `tsc` reports about 3,250 errors that are all unresolved workspace
types. With it, the count drops to the real number.

## gateway-proxy (known limitation)

`gateway-proxy` does not build on this host. It has no package name (it is a private Rust crate),
its build script calls `doppler`, which is absent, and its `.cargo` config requires nightly
(`-Z mir-opt-level=3`). Treat it as a known limitation rather than a task; nothing in the TypeScript
build or the test suite depends on it being built.

## Prisma

The client is Prisma 7.4.2. The schema uses `provider = "prisma-client"`, so generation emits
TypeScript at `src/generated/client.ts`, NOT `client.js`. Read the generated file by that name.

`prisma generate` normally fails because NixOS does not ship the Prisma engines by default. The
working recipe pins the engines through `nix shell`:

```
nix shell nixpkgs#prisma-engines_7-7.10.1 --command bash -lc '
  export PRISMA_SCHEMA_ENGINE_BINARY="$(dirname "$(command -v schema-engine)")/schema-engine"
  export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
  cd discord-digital-twin && pnpm exec prisma generate'
```

This succeeded in 117 ms with engine 7.10.1 against CLI 7.4.2.

## openssl

The voice test spawns `openssl`, which is absent by default. Run the tests inside a shell that
provides it:

```
nix shell nixpkgs#openssl --command bash -lc 'pnpm vitest run'
```

With openssl present, `discord-digital-twin` passes 52/52.

## Test scratch directories

e2e tests no longer hardcode a Windows drive path (commit 948933cd). They call `scratchDir()` from
`kimaki/src/test/cleanup.ts`, which honours `KIMAKI_TEST_SCRATCH` when set and otherwise uses the
per-OS temp directory.

## OpenCode bootstrap

kimaki's installer path spawns `/bin/bash`, which does not exist on NixOS, so `no-opencode-start.e2e`
fails on that alone. It is a Phase 2.1 deletion target and is not to be worked around. The failure is
expected on this host and is not a regression in the host environment.

## Suite runtime

About 108 seconds for the full run on this host, against minutes on the Windows desk host. The wall
time is dominated by nothing in particular, so there is no single slow test to optimise.

## Reproduce

In order, from a clean clone:

```
git clone <kimaki-remote> kimaki && cd kimaki

corepack prepare pnpm@9.15.9 --activate

pnpm install --ignore-scripts

git submodule update --init --recursive
pnpm --filter errore build
pnpm --filter traforo build
pnpm --filter opencode-injection-guard build

nix shell nixpkgs#prisma-engines_7-7.10.1 --command bash -lc '
  export PRISMA_SCHEMA_ENGINE_BINARY="$(dirname "$(command -v schema-engine)")/schema-engine"
  export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
  cd discord-digital-twin && pnpm exec prisma generate'

nix shell nixpkgs#openssl --command bash -lc 'pnpm vitest run'
```

Do not fold the prisma step into the install step: install runs with `--ignore-scripts`, and
generation needs the engines that `nix shell` provides. Do not expect `gateway-proxy` to build.
