# Host disk instability (E:)
Date: 2026-11-21. Measured incident record; containment only, no repair performed.

## Scope
E: hosts the primary kimaki checkout; C: is the healthy volume work has moved to; H: is not an accepted destination.

## Hardware
| Disk | Model | Bus | Size | Mount |
| --- | --- | --- | --- | --- |
| 0 | HGST HUS726040ALE610 | SATA HDD | 3726 GB | E: (NTFS, `Data`) |
| 1 | Samsung SSD 960 | NVMe | 465.8 GB | H: (NTFS, `Secondary`) |
| 2 | Samsung SSD 980 PRO 2TB | NVMe | 1863 GB | C: (NTFS) |
| 3 | Samsung Flash Drive | USB | 29.9 GB | D: (RAW filesystem) |

## Event evidence
Source `Disk`, Event ID 7 ("has a bad block"), 30-day window, by device:

| Device | Events (30 d) |
| --- | --- |
| Harddisk0 (HGST, E:) | 1,230 |
| Harddisk1 (Samsung 960, H:) | 5,379 |
| Harddisk2 (Samsung 980 PRO, C:) | 0 |
| Harddisk3 (USB, D:) | 0 |

Total 6,609. Source `Ntfs`, Event ID 55: 21 events in 30 days, 25 retained. The provider must be `Ntfs`; `Microsoft-Windows-Ntfs` returns 0 and is the wrong provider. Retained System log records start 2026-10-15T14:36:07 (an earlier note recorded 2026-10-14); the Ntfs 55 span is 2026-10-17T21:45:06 to 2026-11-08T23:56:34.

Five distinct paths, all volume E:, all `$I30:$INDEX_ALLOCATION`:

1. `E:\koosh-overflow\anaconda3\pkgs\pyjwt-2.8.0-py312haa95532_0\info\test\tests\keys`
2. `E:\phenocompose-target-slice1-verify\debug\build`
3. `E:\cargo-home\registry\src\index.crates.io-1949cf8c6b5b557f\regex-automata-0.4.14\src\dfa`
4. `E:\koosh-overflow\.serena\language_servers\static\CSharpLanguageServer\roslyn-language-server.win-x64.5.5.0-2.26078.4\cs`
5. `E:\Unity\Hub\Editor\2022.3.70f1\Editor\Data\Tools`

All five return Test-Path False with parent trees absent: DATA LOSS (UNVERIFIED whether the content was moved elsewhere).

## Containment
None of the five is under `E:\koosh\CodeProjects` or `E:\koosh\Agents`. Events before the earliest retained record are unrecoverable, so the kimaki object store is UNVERIFIED, not clean.

## Measured consequence (incident measurement pass)
- Recursive walk: C: pnpm tree reached 40,155 files; E: reached 1,930 then timed out.
- Copy of 200 small files: C: 200/200 in 3.17 s (~63/s); E: 62/200 in 91 s (~0.68/s).
- `vitest`: no output past 150 s from E:; 18/18 passed in 5.9 s from C:.
- `git worktree add` onto C: took 598 s because repo metadata lives on E:.

## Reporting gap
`Get-Volume` reports E: HealthStatus Healthy with 3,237.7 GB (3.2 TB) free. SMART needs elevation: `Get-StorageReliabilityCounter` returned "Access to a CIM resource was not available to the client" and wear fields are empty. Reallocated and pending-sector counts are UNAUTHORISED, not zero.

## Operational rules adopted
- E: is read-mostly: no builds, test runs or large writes there.
- Nothing critical may rely on E: as its only copy.
- Copy-out precedes any `chkdsk /f`.
- H: is not an accepted destination either.

## Recovery posture
Committed kimaki work exists in three independent places: origin, a verified C: clone at the 5818ef93-era tip, and the E: working trees. The E: working trees also hold another agent's uncommitted changes, which must not be moved or discarded by anyone else.

## Provenance
Disk/partition tables, volume health, Event 7 counts, Ntfs 55 counts/messages and the wrong-provider check were re-run on this host on 2026-11-21; E: was not accessed during that verification. Walk, copy, `vitest` and `git worktree` timings come from the incident measurement pass.
