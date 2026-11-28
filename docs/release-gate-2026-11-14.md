# Release gate baseline: 2026-11-14

Scope: `kimaki` on `feat/passive-session-bindings` at `6dedf83d`. These numbers come
from real runs on this Windows host, not estimates.

## Results

| Run | Result |
| --- | --- |
| `vitest run` (everything) | 40 files failed, 47 passed, 1 skipped; 58 tests failed, 405 passed, 8 skipped, 21 snapshots failed |
| `vitest run --exclude "**/*.e2e.test.ts"` (unit only) | 6 files failed, 32 passed, 1 skipped; 11 tests failed, others passed |

The unit run is the useful gate. Every failure there is either a Windows portability
defect or a line-ending assumption, and none of them is in the agent-ops surface this
work added (`src/ops`, `src/backend`, `src/cli/ops.ts`), which passes.

## Unit failures and causes

| Test | Observed failure | Cause |
| --- | --- | --- |
| `db.test.ts` (4 tests) | `EBUSY: resource busy or locked, rename ... kimaki.db.import -> kimaki.db` | Windows cannot rename over an open SQLite handle. Real portability defect in `src/migrations.ts` `prepareDbFile` |
| `worktrees.test.ts` (3 tests) | merged file reads `feature\r\n`, the assertion expects `feature\n` | Line endings. The repository stores CRLF blobs and `core.autocrlf=true` keeps them CRLF, so a text comparison that assumes LF fails |
| `builtin-skills.test.ts` | `Filesystem parse skills\kimaki-debug\SKILL.md: missing frontmatter description` | The description is present; the frontmatter parser expects LF and meets CRLF |
| `file-edit-log.test.ts` | snapshot mismatch | Patch text carries CRLF |
| `opencode-server.test.ts` | snapshot mismatch | Rendered paths and line endings differ on Windows |
| `voice.test.ts` | `EPERM ... kimaki-data-...` | Windows refuses the directory removal the test performs |

## What this means

- The failures are pre-existing: none of these files is touched by the agent-ops work,
  and `git status` was clean at the measurement point.
- The repository commits CRLF blobs. An LF normalization of the working tree was tried
  and reverted because it makes 501 tracked files differ from `HEAD`, which would have
  produced an unrelated mass diff.
- Closing this gate needs three separate decisions, in order:
  1. A Windows-safe rename in `prepareDbFile` (copy-then-replace with retry, or unlink
     the target first while no handle is open).
  2. A repository-wide renormalization to LF, in its own branch and commit, so the
     tests that assume LF can pass and future checkouts stop drifting.
  3. A Windows-safe temp-directory teardown where `EPERM` is expected.
- The e2e failures (34 files) need live services, model credentials and a Discord
  environment; they are not evidence about the agent-ops surface and were not triaged
  individually here.
