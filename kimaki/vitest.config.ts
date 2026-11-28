// Vitest config for kimaki. KIMAKI_VITEST=1 silences the logger unless
// KIMAKI_TEST_LOGS=1. E2E files spawn their own isolated OpenCode server, so
// files can run in parallel forks without sharing any state.
//
// Why the worker cap is 2 and not one-per-CPU:
//
// A single e2e file peaks at 3 node processes (fork worker + OpenCode server +
// bot/discord twin) holding ~740 MB of working set, and its server cold start
// is CPU-heavy (measured on src/renderer.e2e.test.ts at 0acd9a38: 3 procs,
// 744 MB peak, 21.2 s of tests in a 28.3 s file). The host has 8 physical / 16
// logical cores, so a cap of 5 (the old floor(cores/3)) meant 15 node processes
// and 5 concurrent cold starts on 8 real cores. Any outside load (another
// agent's suite, a game, the antivirus) then pushes individual awaits past the
// 30 s testTimeout, which shows up as `Test timed out in 30000ms`, transport
// resets and reordered inline snapshots in files that pass alone. Waiters time
// out on a starved machine, not on slow code.
//
// A per-project worker bound would be the precise fix, but vitest 3.2.6 does
// not support one: `maxWorkers`/`minWorkers`/`fileParallelism` are non-project
// options in `ProjectConfig`, and a run builds a single Tinypool for every
// project (`createPool` is owned by the Vitest instance, sized from the root
// config). So the cap is global and set low enough for the e2e files, which
// dominate the wall time anyway (~25 s median per file; unit files are
// sub-second). KIMAKI_TEST_WORKERS overrides it for a single-file bisect.
// testTimeout stays above the 10s waitFor clamp so a slow wait fails with its
// own label.
//
// Why e2e files get their own (larger) timeouts:
//
// Teardown of one e2e file stops a bot, a Discord twin and an OpenCode server.
// On an idle host that takes seconds; on a saturated one the same shutdowns
// together overrun the 60 s default and fail an `afterAll` whose tests already
// passed (measured: a full-suite run under outside load reported 5 failures -
// `Hook timed out in 60000ms` in agent-ui/legacy/queue-sources/routines and one
// reordered snapshot - and every one of those files passed on a serial re-run).
// The budget therefore is 120 s per test and 180 s per hook for e2e files only.
// It stays finite, so a hook that genuinely hangs still fails; retries are not
// used to hide anything. Unit files keep the root budget so a slow unit test
// still fails fast.
//
// Projects are the only way to scope options per file set in vitest; each one
// extends the root config, so pool/env/worker options above still apply.

import { configDefaults, defineConfig } from 'vitest/config'

const workers = Number(process.env['KIMAKI_TEST_WORKERS']) || 2

const E2E_TEST_TIMEOUT = 120_000
const E2E_HOOK_TIMEOUT = 180_000

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      KIMAKI_VITEST: '1',
    },
    pool: 'forks',
    // libSQL native statements can retain Windows file handles until GC finalizes them.
    poolOptions: { forks: { execArgv: process.platform === 'win32' ? ['--expose-gc'] : [] } },
    maxWorkers: workers,
    minWorkers: 1,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'src/**/*.e2e.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/*.e2e.test.ts'],
          testTimeout: E2E_TEST_TIMEOUT,
          hookTimeout: E2E_HOOK_TIMEOUT,
        },
      },
    ],
  },
})
