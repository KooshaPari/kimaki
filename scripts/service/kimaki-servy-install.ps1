# Install kimaki as a Windows service through Servy.
#
# Default is a dry run: it validates everything and prints the command it would
# run. Pass -Apply to actually create the service, which requires an elevated
# PowerShell. Nothing here touches Discord credentials; set those in the service
# environment (or let kimaki use its saved credentials in <dataDir>).
[CmdletBinding()]
param(
  [string]$ServiceName = 'kimaki',
  [string]$NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source,
  [string]$ServyCli = '',
  [string]$DataDir = "$env:USERPROFILE\.kimaki",
  [string]$LogDir = "$env:ProgramData\kimaki\logs",
  [int]$RotationSizeMb = 50,
  [int]$MaxRotations = 10,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# This repository keeps the package one level down; accept either layout.
$cliCandidates = @(
  (Join-Path $repoRoot 'kimaki\dist\cli.js'),
  (Join-Path $repoRoot 'dist\cli.js')
)
$cli = $cliCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cli) { $cli = $cliCandidates[0] }
$repo = Split-Path -Parent (Split-Path -Parent $cli)
$step = 0
function Say([string]$message) { Write-Host "  $message" }
function Fail([string]$message) { Write-Host "FAIL $message" -ForegroundColor Red; exit 1 }
function Pass([string]$message) { Write-Host "PASS $message" -ForegroundColor Green }

Write-Host "kimaki service preflight"
Write-Host "  repo: $repo"

$step++
if (-not (Test-Path $cli)) { Fail "missing $cli. Run 'corepack pnpm build' first." }
Pass "compiled entrypoint present: $cli"

$step++
if (-not $NodePath -or -not (Test-Path $NodePath)) { Fail 'node.exe not found. Pass -NodePath.' }
Pass "node: $NodePath ($(& $NodePath --version))"

$step++
if (-not $ServyCli) {
  $candidates = @(
    "$env:ProgramFiles\Servy\servy-cli.exe",
    "$env:LOCALAPPDATA\Servy\servy-cli.exe",
    (Join-Path $repo '..\..\Agents\scratch\servy-probe\extract\servy-10.8-net48-x64-portable\servy-cli.exe')
  )
  $ServyCli = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ServyCli -or -not (Test-Path $ServyCli)) {
  Fail 'servy-cli.exe not found. Install Servy 10.8 or pass -ServyCli.'
}
Pass "servy: $ServyCli ($((& $ServyCli version | Select-Object -First 1)))"

$step++
# `status` works unelevated; only `show` requires an administrator shell.
$existing = & $ServyCli status --name=$ServiceName 2>&1
$existingText = ($existing | Out-String).Trim()
if ($existingText -match 'Access Denied') { Fail 'servy status needs an elevated shell on this build. Re-run as Administrator.' }
if ($existingText -notmatch 'NotInstalled') { Fail "service '$ServiceName' already exists ($existingText). Uninstall it first." }
Pass "no existing service named $ServiceName"

$step++
if (-not (Test-Path $LogDir)) {
  if ($Apply) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  Say "log directory will be created: $LogDir"
} else {
  Pass "log directory exists: $LogDir"
}

$stdout = Join-Path $LogDir 'kimaki.stdout.log'
$stderr = Join-Path $LogDir 'kimaki.stderr.log'
$installArgs = @(
  'install',
  "--name=$ServiceName",
  '--displayName=Kimaki',
  '--description=Kimaki agent operations bot',
  "--path=$NodePath",
  "--startupDir=$repo",
  '--params=dist/cli.js',
  '--startupType=AutomaticDelayedStart',
  '--startTimeout=120',
  '--stopTimeout=30',
  "--stdout=$stdout",
  "--stderr=$stderr",
  '--enableSizeRotation',
  "--rotationSize=$RotationSizeMb",
  "--maxRotations=$MaxRotations",
  '--enableHealth'
)

Write-Host ''
Write-Host 'Planned service'
Say "name        : $ServiceName"
Say "runner      : $NodePath dist/cli.js"
Say "workdir     : $repo"
Say "data dir    : $DataDir (default for the bot; set KIMAKI_DATA_DIR to change)"
Say "logs        : $stdout"
Say "rotation    : ${RotationSizeMb} MB x $MaxRotations"

Write-Host ''
Write-Host 'Secrets'
Say 'Set KIMAKI_BOT_TOKEN (and any provider keys) in the service environment, not on the command line.'
Say 'Parameters are visible in process listings, and Servy warns that --debug logs them.'
Say 'If the bot already ran interactively on this host, its saved credentials in the data dir may be enough.'

Write-Host ''
Write-Host 'Command'
$rendered = "$ServyCli " + ($installArgs -join ' ')
Say $rendered

if (-not $Apply) {
  Write-Host ''
  Write-Host 'Dry run only. Re-run in an elevated PowerShell with -Apply to create the service.' -ForegroundColor Yellow
  exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'elevation required: relaunch PowerShell as Administrator.'
}

Write-Host ''
Write-Host 'Installing'
& $ServyCli @installArgs
if ($LASTEXITCODE -ne 0) { Fail "servy install exited $LASTEXITCODE" }
Pass 'service installed'
Say "start it with: $ServyCli start --name=$ServiceName"
Say "check it with: $ServyCli status --name=$ServiceName"
