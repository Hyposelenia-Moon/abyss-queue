# abyss-queue editor - one-click deploy (Windows Server, GUI friendly)
#
# Why this file is ASCII-only: Windows PowerShell 5.1 reads a UTF-8 file WITHOUT BOM
# as GBK, so Chinese text in a .ps1 turns into mojibake. Keep it ASCII and safe.
#
# What it does (idempotent - safe to run again):
#   1. checks node / nginx
#   2. creates the data dir and copies the empty template (resources\*.xlsx) -> <data>\queue.xlsx  (never overwrites)
#   3. fills remote.token / remote.sign_key in the plugin config when empty (random hex)
#   4. sets remote.url and remote.autostart (editor follows the bot - no Windows service needed)
#   5. writes <data>\editor.cmd (the launcher the bot will start)
#   6. prints the nginx snippet to paste into the server block that already has the cert
#   7. health-checks the public URL
#
# Usage (or just right-click -> Run with PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools\deploy-windows.ps1
#   ... -BotDir "D:\Program Files\Yunzai\Yunzai" -DataDir "D:\Program Files\Yunzai\abyss-queue-data" -Url "https://yunzai.axiu.uno/queue"

param(
  [string]$BotDir = "D:\Program Files\Yunzai\Yunzai",
  [string]$DataDir = "D:\Program Files\Yunzai\abyss-queue-data",
  [string]$Url = "https://yunzai.axiu.uno/queue",
  [string]$BotQq = "970464854",
  [string]$Port = "7788",
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "  $m" }
function Head($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Ask($q, $def) {
  if ($Yes) { return $def }
  $v = Read-Host "$q [$def]"
  if ([string]::IsNullOrWhiteSpace($v)) { return $def }
  return $v.Trim()
}

Head "1/7  locations"
$BotDir = Ask "Yunzai root (has plugins\abyss-queue)" $BotDir
$DataDir = Ask "data dir (queue.xlsx / logs / versions)" $DataDir
$Url = Ask "public URL" $Url
$BotQq = Ask "bot QQ (roster pushes are only accepted from it)" $BotQq
$Port = Ask "local port behind nginx" $Port

$plugin = Join-Path $BotDir "plugins\abyss-queue"
$cfg = Join-Path $plugin "config\config.yaml"
$editor = Join-Path $plugin "editor\editor.mjs"
foreach ($p in @($plugin, $cfg, $editor)) {
  if (-not (Test-Path $p)) { throw "not found: $p`n(check the Yunzai root, and run '#update abyss' first)" }
}

Head "2/7  node / nginx"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found in PATH (install Node 20+ )" }
Say "node: $node  $(& node -v)"
$nginx = (Get-Command nginx -ErrorAction SilentlyContinue).Source
if (-not $nginx) {
  foreach ($c in @("C:\nginx\nginx.exe", "D:\nginx\nginx.exe")) { if (Test-Path $c) { $nginx = $c; break } }
}
if ($nginx) { Say "nginx: $nginx" } else { Say "WARN nginx not found in PATH - paste the snippet manually (step 6)" }

Head "3/7  data dir + empty template"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$xlsx = Join-Path $DataDir "queue.xlsx"
if (Test-Path $xlsx) {
  Say "keep existing table: $xlsx"
} else {
  # filename is Chinese ("empty template") -> take it by wildcard: this script stays ASCII-only
  $tpl = Get-ChildItem (Join-Path $plugin "resources") -Filter "*.xlsx" | Select-Object -First 1
  if (-not $tpl) { throw "no template xlsx under $plugin\resources" }
  Copy-Item $tpl.FullName $xlsx
  Say "created empty table: $xlsx"
}

Head "4/7  plugin config (url / autostart / secrets)"
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
$launcher = Join-Path $DataDir "editor.cmd"
$need = @(
  @{ k = 'url'; v = $Url },
  @{ k = 'autostart'; v = ($launcher -replace '\\', '/') }
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

Head "5/7  editor launcher (started by the bot, no Windows service)"
$lines = @(
  '@echo off',
  'rem abyss-queue editor - started by the bot (remote.autostart). Logs go to editor.log.',
  "set ABYSS_EDITOR_TOKEN=$token",
  "set ABYSS_EDITOR_SIGN_KEY=$signKey",
  "set ABYSS_EDITOR_ROSTER_QQ=$BotQq",
  "`"$node`" `"$editor`" --file `"$xlsx`" --port $Port --bind 127.0.0.1 --mount /queue --log `"$(Join-Path $DataDir 'editor.log')`""
)
Set-Content -Path $launcher -Value $lines -Encoding ASCII
Say "wrote $launcher"
Say "note: --bind 127.0.0.1 = only reachable through nginx (recommended)"

Head "6/7  nginx (paste inside the server block that already has your wildcard cert)"
$snippet = @"
  # --- abyss-queue editor ---
  client_max_body_size 32m;
  location /queue {
    proxy_pass http://127.0.0.1:$Port;
    proxy_http_version 1.1;
    proxy_set_header Host `$host;
    proxy_set_header X-Real-IP `$remote_addr;
    proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto `$scheme;
    proxy_read_timeout 120s;
  }
"@
Write-Host $snippet -ForegroundColor Yellow
Say "then: nginx -t  and  nginx -s reload"

Head "7/7  health check"
try {
  $h = Invoke-RestMethod -Uri "$($Url.TrimEnd('/'))/healthz?k=$token" -TimeoutSec 10
  Say "OK  version=$($h.version)  auth=$($h.auth)  roster=$($h.roster)  mount=$($h.mount)"
} catch {
  Say "not reachable yet: $($_.Exception.Message)"
  Say "expected before nginx reload / before the bot starts the editor"
}

Head "done"
Say "next:"
Say "  1) put your QQ into $DataDir\abyss-editor-admins.json  -> {""owner"":[""<your qq>""],""admins"":[""<your qq>""]}"
Say "  2) restart the bot (the editor starts with it) and send #queue in the group"
Say "  token=$token"
