# Agent operations research checkpoint

2026-11-11. Fork created: `KooshaPari/kimaki`. Checkout: `E:\koosh\CodeProjects\kimaki`.

## Recommendation

Use Kimaki as the first Discord service bridge, not the owner of every agent. Establish a small shared operations boundary for runtime adapters IN, services OUT, herdr discovery, dynamic surface bindings and observability. Keep native sessions authoritative. Integrate Paperclip as a policy/task control plane and federate existing projects before deciding on physical repository consolidation.

## Read in order

1. [Architecture and ownership design](../superpowers/specs/2026-11-11-unified-agent-ops-design.md)
2. [Staged implementation plan](../superpowers/plans/2026-11-11-unified-agent-ops.md)
3. [Backend adapter investigation](2026-11-11-backend-adapters.md)
4. [herdr discovery and dynamic binding](2026-11-11-herdr-session-binding.md)
5. [Paperclip integration](2026-11-11-paperclip-integration.md)
6. [Existing project consolidation inventory](2026-11-11-existing-projects.md)
7. [Real public-interface observations and acceptance blockers](2026-11-11-real-interface-observations.md)

## Key correction

Current Kimaki is native OpenCode V2, not an existing generic ACP layer. It can resume external OpenCode sessions, but current adoption mutates metadata, permission rules and instructions and replaces older thread bindings. The proposed passive observe path must not do any of those things. An `external_poll` schema value alone does not establish active all-agent discovery.

## Main findings

- **Dynamic binding:** herdr has actual metadata list/get and event subscription APIs, but covers its managed panes, not every OS process. Combine it with native runtime registries. Multiple observers, explicit control, and detach-without-stop are design requirements.
- **Jcode:** bundled harness documentation and installed CLI disagree about `api --stdio`. Windows passive attach and ownership behavior require qualification before claiming compatibility.
- **Codex:** app-server is the proposed rich backend. Stored thread read/resume is not proof of joining an independent live CLI session.
- **Paperclip:** the pinned source favors native Runner integration, with legacy adapters as compatibility. Runner close stops provider work and is not service detach.
- **Consolidation:** PhenoBot has useful routing/intake and org workflows but a strict freeze. AgentAPI++ declares itself folded into Substrate. Some requested local paths are residual/incomplete, so locate coordinated complete checkouts before choosing dependencies. Federate first, do not bulk-merge.

## Validation boundary

Four worker deliverables were reviewed and synthesized by the coordinator. Initial structural checks covered seven documents and eight local links. The follow-up [real-interface observations](2026-11-11-real-interface-observations.md) exercised hosted GitHub/Git, installed Jcode/herdr CLIs, installed Codex schema generation, and two actual isolated Codex stdio initialize probes. Schema generation passed, but both initialize probes timed out, so live Codex connectivity is not qualified. The panel is registered, but visual rendering/navigation was not inspectable. No product build or complete external-agent -> Discord -> detach workflow passed. Backend support remains unimplemented and the overall product acceptance loop is blocked, not closed.

## Approval and qualification

This is a research-stage design and task map. No backend implementation, live bot restart, external session takeover, production Paperclip change, or repository merge has been performed. Live attachment and control capabilities require qualification against the actual installed backend and transport. Historical resume and screen visibility do not establish safe live control.

The recommended first slice is identity + passive herdr discovery + one external session observe/bind/detach workflow. Explicit control comes later. Support status is unimplemented, not validated by the existence of these documents.

Local documentation may describe private project topology. It is committed locally only, not automatically published to the public fork. Source-level investigations are bounded, not a complete audit of every repository or running service.
