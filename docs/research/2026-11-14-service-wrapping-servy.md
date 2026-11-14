# Service wrapping for kimaki and agent daemons: Servy and alternatives

Date: 2026-11-14 (Pacific). Scope: how to run kimaki, herdr-adjacent helpers and agent daemons as supervised services on Windows, and what the equivalent is inside WSL or a Linux host.

Status of evidence: "verified here" means I ran the official artifact or inspected the host. "Documented" means it comes from the project's own docs and I did not execute it. Nothing was installed as a service and no service was started, stopped or removed.

## Servy 10.8, verified here

Source: `https://github.com/aelassas/servy/releases/tag/v10.8`, released 2026-11-07. MIT licensed, signed binaries, SBOM published.

Verified by downloading `servy-10.8-net48-x64-portable.7z` (2.1 MB) into scratch and running the CLI:

- `servy-cli.exe version` reports `Servy.CLI 10.8.0.0`.
- Verbs: `install`, `uninstall`, `start`, `stop`, `status`, `restart`, `export`, `import`, `show`, `help`, `version`.
- `show` refuses to run unelevated: "Access Denied. Please restart your shell as Administrator". Listing services needs an elevated shell.
- `install` flags include `--name`, `--displayName`, `--description`, `--path`, `--startupDir`, `--params`, `--startupType`, `--priority`, `--cpuAffinity`, `--startTimeout`, `--stopTimeout`, `--stdout`, `--stderr`, `--enableSizeRotation`, `--rotationSize`, `--enableDateRotation`, `--maxRotations`, `--useLocalTimeForRotation`, `--enableHealth`, `--debug`.
- The CLI itself warns that `--params` exposes values in OS process listings and points at the `SERVY_PROCESS_PARAMETERS` environment variable instead. It also warns that `--debug` records environment variables and parameters into the service log.
- The net48 SBOM lists 27 components.

Documented in its README: working directory, startup type, priority, CPU affinity, logging with size or date rotation, health checks with heartbeat pings, recovery policy, pre/post launch and pre/post stop hooks, environment variable expansion, dependencies, LocalSystem or local/domain/gMSA accounts, clean stop with Ctrl+C or close-window and process-tree termination, per-service isolation with authenticated encryption since 10.2, Windows 10/11/Server 2016+ with a .NET Framework 4.8 build for Windows 7 and Server 2008 R2.

Assessment for this host: the strongest Windows candidate. It is maintained, signed, ships an SBOM, and covers exactly the operational gaps a bare `sc create` leaves: stdout capture with rotation, restart policy, process-tree termination, and hooks. The elevation requirement for listing is a mild annoyance for agent-driven checks.

## Windows alternatives

| Option | Model | Strengths | Limits | Evidence |
| --- | --- | --- | --- | --- |
| Servy 10.8 | Signed service wrapper with CLI, GUI, PowerShell | maintained, health checks, hooks, rotation, isolation | needs elevation for `show`, .NET runtime | verified here |
| WinSW | XML-configured service wrapper | Apache-2.0, mature, single exe, widely deployed | fewer operational features than Servy, no health-check and hook surface of the same depth | documented, not installed |
| NSSM | GUI plus CLI wrapper | simple, public domain | last stable release is old, unsigned, no rotation or health checks beyond SCM recovery | documented, not installed |
| `sc.exe` plus `srvany` | raw SCM with a legacy shim | built in, no dependency | no stdout capture, no restart policy beyond SCM, srvany is ancient and unsigned | documented |
| Task Scheduler | scheduled task, not a service | no install rights needed, runs at logon | not a service, no SCM semantics, no dependency ordering, survives poorly across sessions | documented |
| `pm2` / `node-windows` | Node-specific process manager | fast to adopt for Node apps | own daemon and resurrect model, sidesteps SCM, weaker isolation | documented, not installed |

## Linux and WSL

- systemd is the right answer where it is available, including WSL 2 with `systemd=true`. Restart policy, journald capture, dependency ordering and sandboxing come for free.
- If systemd is not enabled in the distro, use supervisord or s6-rc rather than a Windows-side wrapper.
- Wrapping a distro from a Windows service is possible (`wsl.exe -d <distro> -- <command>`) but the distro lifecycle is user-scoped and stops are not always clean, so it is a fallback, not the primary design.
- On this host WSL is currently stopped (verified with `wsl.exe -l -v`: FedoraLinux-Desk and docker-desktop, both Stopped), so no systemd behaviour was executed. Under the standing coordination rule I did not start it.

## Concrete shape for kimaki

Windows, using verified flags only:

```
servy-cli install --name=kimaki --displayName="Kimaki" `
  --path="C:\Program Files\nodejs\node.exe" `
  --startupDir="E:\koosh\CodeProjects\kimaki\kimaki" `
  --params="dist/cli.js" `
  --startupType=AutomaticDelayedStart --startTimeout=60 --stopTimeout=30 `
  --stdout="E:\koosh\Agents\logs\kimaki.out.log" `
  --stderr="E:\koosh\Agents\logs\kimaki.err.log" `
  --enableSizeRotation --rotationSize=50 --maxRotations=10 `
  --enableHealth
```

Secrets rule: put `KIMAKI_BOT_TOKEN` and provider keys in the service environment, never in `--params`, because parameters are readable in process listings and `--debug` logs them.

Linux, for later use under systemd:

```
[Unit]
Description=Kimaki
After=network-online.target
[Service]
Type=simple
WorkingDirectory=/home/koosh/CodeProjects/kimaki/kimaki
EnvironmentFile=/etc/kimaki.env
ExecStart=/usr/bin/node dist/cli.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
```

## Recommendation

1. Windows: Servy. Fall back to WinSW only if a dependency-free single exe is required and health checks or hooks are not needed. Keep NSSM only for existing deployments.
2. WSL or Linux: systemd unit inside the distro. Use supervisord when systemd is unavailable.
3. Do not use Task Scheduler for always-on daemons.
4. Install nothing automatically. Creating a real service changes the host, needs elevation, and should be an explicit, reviewed step.

## Not verified

- Actual service installation, start and recovery behaviour on this host.
- WinSW, NSSM, srvany, pm2 and node-windows behaviour. Their rows come from their documentation.
- Any systemd or supervisor behaviour in the WSL distro, because it was stopped.
- Whether Servy's environment-variable configuration is fully reachable from the CLI; only expansion and the `SERVY_PROCESS_PARAMETERS` note were verified.
