# Paperclip pilot environment: blocker and decision

Updated: 2026-11-12. Status: blocked, not implemented. This note records why milestones M5 and M6 cannot be closed yet and what decision unblocks them. It is not evidence that any Paperclip integration works.

## What M5 and M6 require

M5 (external observation) closes only when an independently started native session is projected into Paperclip as a plugin-owned external-session entity, with proof that no task or run is invented and that detaching or restarting the observer does not take ownership of the native session.

M6 (managed execution) closes only when an explicitly authorized Paperclip task creates exactly one attributable managed native attempt, with idempotent retry, identity correlation, lifecycle evidence and supported cancellation or approval, including failure and restart paths.

Both require a running Paperclip instance, a real transport, and credentials scoped to a single isolated company or issue. Fixtures, copied implementations, or local unit tests cannot satisfy either gate.

## What exists today

- `kimaki/src/ops/paperclip/index.ts` correlates explicit Paperclip ownership metadata and compares it against the pinned Runner `NativeRunIdentity` fields, fail-closed. It performs no network access.
- `paperclipCapabilities` declares transport, dispatch, approval, cancellation and progress publication as unavailable.
- The Paperclip source pin and connector research exist upstream of this note, but the recorded connector comparison is still open (see the initiative closure ledger).

## What is missing

1. An isolated Paperclip instance (local or staging) with a dedicated company and issue, plus credentials that cannot reach production data.
2. A qualified transport for the plugin-facing entity and run APIs, including how identity is carried on the wire.
3. An agreed definition of "plugin-owned external-session entity" in Paperclip terms, so the pilot asserts the correct object rather than a convenient stand-in.

## Decision needed

Choose one:

- **Provide an isolated Paperclip instance and scoped credentials.** Then M5 can proceed as designed, and M6 can follow with an authorized test task.
- **Accept a documented scope change.** Record that Paperclip pilots are out of scope for this initiative, keep the local correlation boundary as the delivered surface, and stop representing M5/M6 as pending work.

Until one of those is chosen, no further Paperclip code should be presented as integration progress. The existing boundary stays as-is and continues to fail closed.
