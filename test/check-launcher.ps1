# 启动器静态自检（**不执行任何东西**）
#
# 为什么必须静态：VBScript 没法"只解析不运行"，而执行启动器会真的去拉起/关闭服务。
# 之前一版自检为了验证语法就在副本上跑了一次，结果探针里的 LaunchAll 弹出了
# "echo PROBE_*" 窗口、CloseService 还动过服务。所以这里只做文本层面的检查：
#   - 编码/行尾（cscript 按 ANSI 解析 .vbs，非 ASCII 与 LF 都会让脚本失效）
#   - 真实文件里必须是真正的启动命令（防"被探测内容替换"这类事故）
#   - 关键常量存在
#   - 每个 Sub/Function 都有对应 End，防止漏写导致的解析错误
#
# 用法：powershell -File check-launcher.ps1 [启动器路径]
param(
  [string]$Launcher = 'E:\Apps\启动云崽与QQ.vbs'
)

$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$fail = @()

if (-not (Test-Path $Launcher)) { Write-Output "FAIL: 找不到 $Launcher"; exit 1 }
Write-Output "文件: $Launcher"

# ---- 1) 编码与行尾 ----
$bytes = [System.IO.File]::ReadAllBytes($Launcher)
$cr = ($bytes | Where-Object { $_ -eq 13 }).Count
$lf = ($bytes | Where-Object { $_ -eq 10 }).Count
$nonAscii = ($bytes | Where-Object { $_ -gt 127 }).Count
Write-Output "  字节=$($bytes.Length) CR=$cr LF=$lf 非ASCII=$nonAscii"
if ($nonAscii -gt 0) { $fail += '含非 ASCII 字符（cscript 按 ANSI 解析，会破坏字符串字面量）' }
if ($cr -ne $lf) { $fail += '行尾不是 CRLF' }

$lines = [System.IO.File]::ReadAllLines($Launcher)

# ---- 2) 必须是真正的启动命令 ----
$runLines = $lines | Where-Object { $_ -match 'sh\.Run' }
$joined = $runLines -join "`n"
if ($joined -notmatch 'node\.exe \./index\.js') { $fail += '找不到 NapCat 真启动命令 node.exe ./index.js' }
if ($joined -notmatch 'node \."""') { $fail += '找不到 Yunzai 真启动命令 node .' }
if ($joined -match 'echo\s+PROBE') { $fail += '启动命令被探测内容替换过（echo PROBE_*）' }
Write-Output "  启动命令:"
$runLines | ForEach-Object { Write-Output "    $($_.Trim())" }

# ---- 3) 关键常量 ----
$need = @('QQ', 'YZ_DIR', 'NAPCAT_DIR', 'FLAG', 'LOGFILE', 'MIN_LIFE', 'WAIT_LIMIT', 'RECOVER_WAIT')
foreach ($n in $need) {
  if (-not ($lines | Where-Object { $_ -match "^\s*Const\s+$n\s*=" })) { $fail += "缺少常量 $n" }
}
Write-Output "  常量检查: $(if ($fail -match '缺少常量') { 'FAIL' } else { 'OK' })"

# ---- 4) Sub/Function 配对 ----
$openSub = ($lines | Where-Object { $_ -match '^\s*Sub\s+\w' }).Count
$endSub = ($lines | Where-Object { $_ -match '^\s*End Sub' }).Count
$openFn = ($lines | Where-Object { $_ -match '^\s*Function\s+\w' }).Count
$endFn = ($lines | Where-Object { $_ -match '^\s*End Function' }).Count
Write-Output "  Sub: $openSub/$endSub   Function: $openFn/$endFn"
if ($openSub -ne $endSub) { $fail += "Sub 与 End Sub 数量不匹配（$openSub/$endSub）" }
if ($openFn -ne $endFn) { $fail += "Function 与 End Function 数量不匹配（$openFn/$endFn）" }

# ---- 5) 双引号成对（VBScript 最常见的解析失败原因）----
# 注释与 WMI 查询里都会出现单引号，没法可靠剥离注释，
# 因此只按"整行双引号个数为偶数"判断——对正常代码成立，能挡住漏引号。
$odd = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
  $line = $lines[$i]
  if ($line.Trim().StartsWith("'")) { continue }
  if ((($line.ToCharArray() | Where-Object { $_ -eq '"' }).Count % 2) -ne 0) {
    $odd++
    Write-Output "    双引号不成对 @ 第 $($i+1) 行: $($line.Trim())"
  }
}
if ($odd -gt 0) { $fail += "有 $odd 行双引号不成对" }

# ---- 结论 ----
Write-Output ''
if ($fail.Count) {
  Write-Output '❌ 静态检查未通过：'
  $fail | ForEach-Object { Write-Output "  - $_" }
  exit 1
}
Write-Output '✅ 静态检查通过（未执行任何命令，服务不受影响）'
