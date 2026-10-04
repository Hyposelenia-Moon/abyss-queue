# abyss-queue editor - one-click deploy (Windows, GUI friendly)
#
# Why this file is ASCII-only: Windows PowerShell 5.1 reads a BOM-less UTF-8 file as GBK,
# so non-ASCII text in a .ps1 turns into mojibake. Keep this file ASCII.
#
# Scope - who owns what:
#   * this script prepares and checks the APPLICATION only: plugin config, data dir,
#     editor launcher, local health probe
#   * network / certificates / reverse proxy / firewall / DNS / publishing belong to the
#     server owner (Axiu). This script does NOT write, test or reload the proxy, does not
#     look for it on this machine, and does not derive any public entry point.
#
# What it does (idempotent - safe to run again):
#   1. locate the plugin from $PSScriptRoot and verify the Yunzai host root
#      (deploy layout: <Yunzai>\plugins\abyss-queue\tools) - no hardcoded path, no questions
#   2. check node: executable + version >= 20.11 (editor.mjs uses import.meta.dirname)
#   3. create the data dir and copy the empty template (resources\*.xlsx) -> <data>\queue.xlsx
#   4. fill remote.token / remote.sign_key / remote.url / remote.autostart in the plugin config
#   5. write <data>\editor-launch.mjs - the launcher the bot starts (remote.autostart)
#   6. probe the local /healthz and print the application handover info
#
# Usage (or just right-click -> Run with PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools\deploy-windows.ps1
#   ... -Port 7788 -Mount /queue -Url "https://example.com/queue" -DataDir "D:\data" -Yes

param(
  [string]$DataDir = "",
  [string]$Url = "",
  [string]$BotQq = "970464854",
  [string]$Port = "7788",
  [string]$Mount = "/queue",
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$NodeMin = "20.11"
function Say($m) { Write-Host "  $m" }
function Head($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Ask($q, $def) {
  if ($Yes) { return $def }
  $v = Read-Host "$q [$def]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $def }
  return $v.Trim()
}

# ---------------------------------------------------------------- 1/6
Head "1/6  plugin + host root (derived from this script's own location)"

# This script always lives in <Yunzai>\plugins\abyss-queue\tools, so the host root is
# two levels up. Never ask for it and never use a maintainer path: a wrong root would
# silently configure and start *another* installation.
$PluginDir = Split-Path -Parent $PSScriptRoot
$PluginsDir = Split-Path -Parent $PluginDir
$HostDir = Split-Path -Parent $PluginsDir

if ((Split-Path -Leaf $PluginsDir) -ne "plugins") {
  throw "NOT APPLICABLE: this script must sit in <Yunzai>\plugins\<plugin>\tools (found: $PSScriptRoot)"
}
if (-not (Test-Path (Join-Path $HostDir "package.json")) -or -not (Test-Path (Join-Path $HostDir "plugins"))) {
  throw "NOT APPLICABLE: $HostDir is not a Yunzai root (need package.json and plugins\) - refusing to guess another install"
}
$hostName = ""
try { $hostName = (Get-Content -Raw -Encoding UTF8 (Join-Path $HostDir "package.json") | ConvertFrom-Json).name } catch { $hostName = "" }
if ($hostName -notmatch "yunzai") { Say "WARN host package.json name is '$hostName' - expected something like trss-yunzai (continuing)" }
Say "plugin: $PluginDir"
Say "host:   $HostDir"

$cfg = Join-Path $PluginDir "config\config.yaml"
$editor = Join-Path $PluginDir "editor\editor.mjs"
foreach ($p in @($cfg, $editor)) {
  if (-not (Test-Path $p)) { throw "not found: $p (sync the plugin into <Yunzai>\plugins\abyss-queue first)" }
}

# ---------------------------------------------------------------- 2/6
Head "2/6  options"
if (-not $DataDir) {
  # Default data dir: a sibling of the host root, so runtime files stay outside both the
  # bot tree and the plugin repo. Derived from the host root we just verified.
  $parent = Split-Path -Parent $HostDir
  if (-not $parent) { $parent = $HostDir }
  $DataDir = Join-Path $parent "abyss-queue-data"
}
$DataDir = Ask "data dir (queue.xlsx / editor-launch.mjs / editor.log)" $DataDir
$Port = Ask "local port the editor listens on" $Port
$Mount = Ask "mount path (empty = site root)" $Mount
$Url = Ask "public URL of the editor (empty = keep the configured one / local address)" $Url
$BotQq = Ask "bot QQ (roster pushes are accepted from it only)" $BotQq

$Mount = "$Mount".Trim().TrimEnd("/")
$localUrl = "http://127.0.0.1:$Port$Mount"
$curUrl = [regex]::Match((Get-Content -Raw -Encoding UTF8 $cfg), '(?m)^\s*url:\s*"?([^"\r\n]*)"?').Groups[1].Value.Trim()
if (-not $Url) {
  # Never derive the public entry point here (that is the server owner's call): keep what the
  # config already has, and only fall back to the local app address on a fresh config.
  $Url = if ($curUrl) { $curUrl } else { $localUrl }
  if ($curUrl) { Say "keeping configured remote.url: $Url" } else { Say "remote.url not configured yet: using the local app address $Url" }
}
$Url = "$Url".TrimEnd("/")

# ---------------------------------------------------------------- 3/6
Head "3/6  node (application runtime only)"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found in PATH (install Node $NodeMin or newer)" }
$nodeVer = (& $node -v).Trim()
$parsed = $null
try { $parsed = [version]($nodeVer -replace "^v", "") } catch { $parsed = $null }
if (-not $parsed -or $parsed -lt [version]$NodeMin) { throw "node $nodeVer is too old: the editor needs >= $NodeMin (import.meta.dirname)" }
Say "node: $node  $nodeVer  (>= $NodeMin OK)"

# The application's own startup prerequisites (dependencies are not a network concern).
$deps = Join-Path $PluginDir "node_modules"
if (-not (Test-Path (Join-Path $deps "jszip")) -or -not (Test-Path (Join-Path $deps "yaml"))) {
  Say "WARN dependencies missing under $deps"
  Say "     run: cd `"$PluginDir`" ; npm i --omit=dev"
}

# ---------------------------------------------------------------- 4/6
Head "4/6  data dir + empty template"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$xlsx = Join-Path $DataDir "queue.xlsx"
if (Test-Path $xlsx) {
  Say "keep existing table: $xlsx"
} else {
  # filename is Chinese ("empty template") -> take it by wildcard: this script stays ASCII-only
  $tpl = Get-ChildItem (Join-Path $PluginDir "resources") -Filter "*.xlsx" | Select-Object -First 1
  if (-not $tpl) { throw "no template xlsx under $PluginDir\resources" }
  Copy-Item $tpl.FullName $xlsx
  Say "created empty table: $xlsx"
}

# ---------------------------------------------------------------- 5/6
Head "5/6  plugin config + editor launcher"
$cfgText = Get-Content -Raw -Encoding UTF8 $cfg
function NewSecret($bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString("x2") }) -join "")
}
$token = [regex]::Match($cfgText, '(?m)^\s*token:\s*"?([^"\r\n]*)"?').Groups[1].Value.Trim()
$signKey = [regex]::Match($cfgText, '(?m)^\s*sign_key:\s*"?([^"\r\n]*)"?').Groups[1].Value.Trim()
if (-not $token) {
  $token = NewSecret 16
  $cfgText = [regex]::Replace($cfgText, '(?m)^(\s*token:\s*).*$', "`${1}`"$token`"")
  Say "generated remote.token"
}
if (-not $signKey) {
  $signKey = NewSecret 24
  $cfgText = [regex]::Replace($cfgText, '(?m)^(\s*sign_key:\s*).*$', "`${1}`"$signKey`"")
  Say "generated remote.sign_key"
}

# The launcher the bot starts. Keep it .mjs: model/remote.js runs .mjs launchers with the
# same node that runs the bot. A .cmd launcher used to be generated here, which the autostart
# then handed to node as JavaScript (@echo off -> syntax error). If you ever change the
# extension, change the dispatcher in model/remote.js at the same time.
$launcher = Join-Path $DataDir "editor-launch.mjs"
$need = @(
  @{ k = "url"; v = $Url },
  @{ k = "autostart"; v = ($launcher -replace "\\", "/") }
)
foreach ($n in $need) {
  if ($cfgText -match "(?m)^\s*$($n.k):") {
    $cfgText = [regex]::Replace($cfgText, "(?m)^(\s*$($n.k):\s*).*$", "`${1}`"$($n.v)`"")
  } else {
    Say "WARN config.yaml has no remote.$($n.k) - add it manually: $($n.k): `"$($n.v)`""
  }
}
Set-Content -Path $cfg -Value $cfgText -Encoding UTF8 -NoNewline
Say "config written: $cfg"

$launchCfg = [ordered]@{
  editor   = $editor
  file     = $xlsx
  port     = [int]$Port
  bind     = "127.0.0.1"
  mount    = $Mount
  log      = (Join-Path $DataDir "editor.log")
  pidFile  = (Join-Path $DataDir "editor.pid")
  token    = $token
  signKey  = $signKey
  rosterQq = $BotQq
}
$cfgJson = $launchCfg | ConvertTo-Json -Compress

$L = @()
$L += '// abyss-queue editor launcher - generated by tools/deploy-windows.ps1'
$L += '//'
$L += '// The bot starts this file (config.yaml -> remote.autostart); model/remote.js runs .mjs'
$L += '// launchers with the same node that runs the bot. It starts the editor detached,'
$L += '// records its pid and exits right away - the bot must not be blocked by the editor.'
$L += 'import { spawn } from "node:child_process"'
$L += 'import fs from "node:fs"'
$L += 'import path from "node:path"'
$L += ''
$L += "const cfg = $cfgJson"
$L += ''
$L += 'fs.mkdirSync(path.dirname(cfg.log), { recursive: true })'
$L += 'const out = fs.openSync(cfg.log, "a")'
$L += 'const args = [cfg.editor, "--file", cfg.file, "--port", String(cfg.port), "--bind", cfg.bind, "--mount", cfg.mount, "--log", cfg.log]'
$L += 'const child = spawn(process.execPath, args, {'
$L += '  detached: true,'
$L += '  stdio: ["ignore", out, out],'
$L += '  windowsHide: true,'
$L += '  env: { ...process.env, ABYSS_EDITOR_TOKEN: cfg.token, ABYSS_EDITOR_SIGN_KEY: cfg.signKey, ABYSS_EDITOR_ROSTER_QQ: cfg.rosterQq },'
$L += '})'
$L += 'child.unref()'
$L += 'fs.writeFileSync(cfg.pidFile, String(child.pid))'
$L += 'console.log(`[abyss-queue] editor started pid=${child.pid} port=${cfg.port}${cfg.mount}`)'
$launcherText = (($L -join "`n") + "`n")
[System.IO.File]::WriteAllText($launcher, $launcherText, (New-Object System.Text.UTF8Encoding($false)))
Say "wrote $launcher (started by the bot via remote.autostart)"

# ---------------------------------------------------------------- 6/6
Head "6/6  app health + handover (application only)"
$base = "http://127.0.0.1:$Port$Mount"
$healthUrl = "$base/healthz?k=$token"
try {
  $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  Say "app healthz OK: version=$($h.version) port=$($h.port) mount=$($h.mount) auth=$($h.auth) sign_key=$($h.sign_key) roster=$($h.roster)"
} catch {
  Say "app not listening at $healthUrl yet"
  Say "it starts with the bot (remote.autostart); restart the bot, or run: node `"$launcher`""
}

Head "handover (network / TLS / proxy / publishing: server owner Axiu)"
Say "listen      : 127.0.0.1:$Port   (loopback only)"
Say "mount       : $Mount"
Say "upload cap  : 32m   (whole-table upload limit enforced by the app; the proxy must allow at least this)"
Say "health      : $healthUrl   (GET, token only, booleans and counts)"
Say "app url     : $Url"
Say "launcher    : $launcher"
Say "data dir    : $DataDir   (queue.xlsx / editor.log / editor.pid)"
Say "token       : $token"

Head "done"
Say "next:"
Say "  1) put your QQ into $DataDir\abyss-editor-admins.json  -> {""owner"":[""<your qq>""],""admins"":[""<your qq>""]}"
Say "  2) restart the bot (the editor starts with it) and send #queue in the group"
