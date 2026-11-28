# Decision: authority boundaries for the agent-ops layer

Date: 2026-11-14 (Pacific). Status: accepted, recorded from the operator. Source: operator rulings in the SSOT critique session, restated as constraints for this repository.

## Rulings

1. Paperclip is the presentation SSOT. It is where agents and their work are viewed and driven by a human, not a second work authority.
2. Discord is the comms SSOT. Messages and channel routing belong there.
3. Tracera and AgilePlus are the product management SSOT. They own the "what" and the acceptance of work.
4. Plane is projection only. It is a board view, never an authority for org or personal commitments. The operator explicitly retracted an agent recommendation that would have made Plane a commitment authority, and that walk-back stands.
5. Continuous integration for these repositories runs on the self-hosted desk runner only, never on paid GitHub-hosted runners.
6. AgilePlus pull request #1126 stays draft until its acceptance gate passes, and is not merged by an agent on its own initiative.

## What this means for kimaki

- Kimaki is an operations and observability layer plus an outward bridge. It is not the system of record for tasks, commitments or messages.
- `ops bind` and the hub write metadata and stream state. They never create a task, an issue, a commitment or a Discord message on their own authority.
- Publication is consent-gated and at-most-once. A published notice is presentation, not a record of work.
- Adding a work-queue, task tracker or "second board" inside kimaki would violate ruling 4. Do not build one.
- Work that must be recorded as a commitment goes to AgilePlus or Tracera, and is only projected elsewhere.

## Known open conflict

AgilePlus decision 0003 and issue #1117 disagree about where a work item is recorded. It is recorded as an open reconciliation item, not resolved here, and no code in this repository depends on either side yet.

## Consequences already visible in this repository

- The consolidation matrix treats candidate services as coexist, migrate or reverse-merge, and never retires one without an owner decision.
- The Paperclip pilot reads runs as metadata only. It does not create tasks, and it does not project entities into Paperclip.
- The hub's event log and acknowledgement store are operational state for streaming, not a work ledger.
