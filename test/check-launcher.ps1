# 启动器静态自检（不执行任何东西）
#
# 背景：启动器曾是 VBScript，自检为了验证语法在副本上真跑了一次，结果探针里的
# LaunchAll 弹出了 "echo PROBE_*" 窗口、CloseService 还动过服务。现在启动器是
# PowerShell（launcher.ps1）+ 极简 VBS 壳，自检只做静态检查：
#   - VBS 壳必须纯 ASCII + CRLF，且指向 launcher.ps1
#   - 看门狗必须能被 PowerShell Parser 解析（只解析，不执行）
#   - 判活必须走端口（Get-NetTCPConnection），不得再用会卡死的 WMI 命令行匹配
#
# 用法：powershell -File check-launcher.ps1
param(
  [string]$Shim = 'E:\Apps\启动云崽与QQ.vbs',
  [string]$Script = 'E:\Apps\launcher.ps1'
)

$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$fail = @()

if (-not (Test-Path $Shim)) {
  $fail += "找不到 VBS 壳：$Shim"
} else {
  $bytes = [System.IO.File]::ReadAllBytes($Shim)
  $nonAscii = ($bytes | Where-Object { $_ -gt 127 }).Count
  $cr = ($bytes | Where-Object { $_ -eq 13 }).Count
  $lf = ($bytes | Where-Object { $_ -eq 10 }).Count
  Write-Output "壳: $Shim"
  Write-Output "  字节=$($bytes.Length) CR=$cr LF=$lf 非ASCII=$nonAscii"
  if ($nonAscii -gt 0) { $fail += 'VBS 壳含非 ASCII 字符（cscript 按 ANSI 解析会失败）' }
  if ($cr -ne $lf) { $fail += 'VBS 壳行尾不是 CRLF' }
  if ([System.IO.File]::ReadAllText($Shim) -notmatch 'launcher\.ps1') { $fail += 'VBS 壳没有指向 launcher.ps1' }
}

if (-not (Test-Path $Script)) {
  $fail += "找不到看门狗脚本：$Script"
} else {
  $psText = [System.IO.File]::ReadAllText($Script)
  Write-Output "脚本: $Script"
  foreach ($need in @('NapPort', 'YzPort', 'Test-Up', 'Test-Ready', 'Confirm-Down', 'Start-NapCat', 'Start-Yunzai', 'Remove-Flag')) {
    if ($psText -notmatch [regex]::Escape($need)) { $fail += "看门狗缺少 $need" }
  }
  if ($psText -notmatch 'Get-NetTCPConnection') { $fail += '看门狗没有用 Get-NetTCPConnection 判活' }
  if ($psText -match 'GetObject\("winmgmts') { $fail += '看门狗里仍有 WMI 命令行匹配（会卡住，应用端口判活）' }
  Write-Output '  关键函数检查: OK'

  $err = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$err)
  if ($err -and $err.Count) {
    foreach ($e in ($err | Select-Object -First 5)) { $fail += "PS 语法错误 行 $($e.Extent.StartLineNumber): $($e.Message)" }
  } else {
    Write-Output '  PowerShell 语法: OK'
  }
}

Write-Output ''
if ($fail.Count) {
  Write-Output '未通过：'
  $fail | ForEach-Object { Write-Output "  - $_" }
  exit 1
}
Write-Output '静态检查通过（未执行任何命令，服务不受影响）'