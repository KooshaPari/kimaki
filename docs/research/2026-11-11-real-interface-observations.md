# Real-interface acceptance observations

Date: 2026-11-11 (Pacific), follow-up to local research commit `168dbc82`.

## Implementation-stage update, November 11

The sections below preserve the earlier research checkpoint, not the current checkout state. Dependencies and the production TypeScript build now succeed. A fresh Node stdio client drove the same installed Codex 0.167.1 executable using an empty isolated `CODEX_HOME` on E:. Actual `initialize` returned its platform and user agent, and `thread/list` returned an empty list. A repeat at 09:13 UTC succeeded with zero stderr bytes, zero model calls and confirmed owned-child exit 0. The script is `E:\koosh\Agents\kimaki-research-20261111\codex-node-canary.mjs`.

This narrows the earlier PowerShell timeout to that probe path rather than a universal Codex initialization blocker. It does not qualify independently running TUI session attachment, streaming, controls or Jcode transport. The new metadata-only association CLI has real subprocess/database acceptance coverage, but no runtime adapter or Discord publication is enabled. See `2026-11-11-passive-slice-implementation.md` for current validation and remaining gates.

## What was exercised

These checks used the actual hosted fork and installed command-line programs. The PowerShell client probe drove the real Codex executable, not a mock, copied server, synthetic backend or protocol fixture. This is a narrower integration qualification than the desired end-to-end product workflow.

| Requirement/boundary | Actual action | Observed outcome | What it establishes |
| --- | --- | --- | --- |
| Requested fork | `gh repo view KooshaPari/kimaki --json nameWithOwner,isFork,parent,defaultBranchRef,visibility` | `isFork: true`, parent `remorses/kimaki`, default `main`, visibility public | Remote fork exists with the correct parent |
| Fork provenance and publication | `git ls-remote https://github.com/KooshaPari/kimaki.git HEAD`; local status/log | Remote HEAD `fdbe1541d03d27c5174b3d1067f5e6f9cb9634f1`; local research commit `168dbc82`; clean status before this follow-up | Requested fork is reachable through actual Git transport. Local research was not published remotely |
| Review delivery | Native `panel list` | Registered linked-file panel `panel-26f8b1fd-e6e9-41b1-9da9-b8e7f57769a9` points at the research index | Real review entrypoint exists. Does not establish visual rendering or user navigation, because panel API has no rendered-content/click inspection |
| Jcode harness entrypoint | Installed `jcode api --help` | Exit 2, unrecognized subcommand `api` | Reproduces the documented-entrypoint mismatch on actual `jcode v0.99.1 (7206efd0c)` |
| herdr discovery parser | Installed `herdr agent list --help` | Success, `Usage: herdr agent list`; installed `herdr 0.9.3` | Discovery command parser exists. Does not establish daemon discovery, named-pipe connectivity or actual external-agent coverage |
| Codex app-server tooling | Installed `codex app-server --help` | Success, documented stdio/unix/WS transports and schema-generator command | Local installed binary exposes the proposed native integration entrypoint |
| Installed Codex protocol schema | `codex app-server generate-json-schema --out E:\koosh\Agents\kimaki-research-20261111\codex-0.167.1-schema` | Exit 0, 322 generated schema files. `ClientRequest.json` includes `thread/list`, `thread/read`, `thread/resume`, `turn/start`, `turn/interrupt`, `turn/steer` | These planned methods exist in actual `codex-cli 0.167.1` schema, not merely floating upstream documentation |
| Real Codex initialize/list path | Started an owned `codex.exe app-server --listen stdio://` process with a new empty `CODEX_HOME` and cwd on E:, then sent `initialize` | No matching initialize response within the initial 5-second read deadline. Probe terminated its owned process, which reported exited | First cold-start/protocol canary failed, not a compatibility pass |
| Bounded retry removing client ambiguity | Retried in another isolated home with explicit stdin AutoFlush and 30-second read deadline | Again timed out awaiting response ID 1. Owned process exited. `thread/list` was never reached | Initialize responsiveness remains blocked/unexplained under this canary. Does not prove the protocol or all installed app-server deployments are broken |
| Kimaki runnable checkout | Tested paths for root `node_modules` and `kimaki/dist/cli.js` | Both absent | The fork currently has no installed/built CLI to exercise. No real Discord end-to-end acceptance is available from this checkout yet |

## Exact probe and cleanup boundary

The Codex client script is `E:\koosh\Agents\kimaki-research-20261111\codex-protocol-canary.ps1`. It uses `C:\Users\koosh\.bun\bin\codex.exe`, an isolated new home, no copied credentials/config/transcripts, and the real public stdio protocol. Intended calls were initialize, initialized, then an empty `thread/list`. Both runs stopped at initialize. No thread start/resume, turn start, prompt, approval, model inference, or user-session attach was sent. Cleanup was restricted to each child process the probe created, not a shared daemon. The isolated canary directories and generated schemas remain in the scratch directory as evidence.

The first foreground tool delivery misleadingly wrapped the failed PowerShell probe in a completed task status. Its inner output explicitly reported exit 1 and the initialize timeout. The retry background task directly reported failed/exit 1. The evidence is failure in both cases, not the outer wrapper's first status.

## Is the outcome better?

The research is more actionable than the original source-inspection-only checkpoint in three concrete ways:

1. Backend assumptions now have installed-version observations. Jcode's missing API entrypoint is reproduced, Codex's methods are generated from the installed executable, and herdr's discovery parser is exercised.
2. An actual Codex initialization attempt exposed an additional blocker before implementation could rely on a paper-only contract. Even after explicit flushing and a longer deadline, initialization did not complete. The plan must qualify and diagnose that before adapter rollout.
3. Hosted fork provenance and local-only publication were exercised through GitHub and Git, and review-panel registration was checked through its native API.

This does **not** establish that Jcode/Codex/Paperclip/herdr integrations, external discovery, passive bind/detach or unified bots work. None is implemented in this documentation-only checkpoint. There is no before/after runtime improvement claim.

## Acceptance still blocked

The user's intended product acceptance path is: start an agent outside Kimaki, discover it through native/herdr metadata, bind an authorized Discord observer, receive only post-bind events, optionally transfer safe control, detach, and continue using the original native session. That path was not exercised because the proposed integration modules do not exist, the checkout has no installed/built Kimaki executable, backend initialization/attachment remains unqualified, and product implementation/live service changes await design approval. Paperclip and Discord production state were not touched merely to force a check through.

The code plan now includes these actual blockers. The correct goal assessment is **research checkpoint delivered, product acceptance blocked**, with representative real-interface evidence and incomplete end-to-end coverage. Do not label the overall product feedback loop closed or all integrations supported.

## Next bounded qualification after approval

Diagnose the isolated Codex initialize timeout using safe startup diagnostics, resolve the Jcode native entrypoint/transport mismatch, qualify herdr metadata transport without publishing private inventory, then implement the passive external-session vertical slice. Run its real native UI -> registry -> Discord -> detach workflow before claiming supported backends or consolidation parity. Structural Markdown checks remain supplemental evidence, never a substitute for that path.
