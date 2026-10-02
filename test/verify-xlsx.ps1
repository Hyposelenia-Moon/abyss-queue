# Independent verification of the generated xlsx using .NET XML/ZIP parsers
# (a completely different implementation from the plugin's jszip + hand-written parser)
# Usage: powershell -File test/verify-xlsx.ps1 -Modified <file> -Original <file> [-Sheet 2 -Row 27]
param(
  [Parameter(Mandatory = $true)][string]$Modified,
  [Parameter(Mandatory = $true)][string]$Original,
  # 被写入的 sheet 序号（1 起，对应 xl/worksheets/sheetN.xml）与行号
  [int]$Sheet = 1,
  [int]$Row = 18
)

$tmp = Join-Path $env:TEMP "abyss-verify"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item $Modified (Join-Path $tmp 'm.zip')
Copy-Item $Original (Join-Path $tmp 'o.zip')
Expand-Archive (Join-Path $tmp 'm.zip') -DestinationPath (Join-Path $tmp 'm') -Force
Expand-Archive (Join-Path $tmp 'o.zip') -DestinationPath (Join-Path $tmp 'o') -Force

$mdir = Join-Path $tmp 'm'
$odir = Join-Path $tmp 'o'
$prefix = $mdir.Length + 1

Write-Output '=== 1. .NET unzip ==='
$entries = Get-ChildItem $mdir -Recurse -File
Write-Output ("  entries: {0}" -f $entries.Count)

Write-Output '=== 2. parse every XML with System.Xml.XmlDocument ==='
$fail = 0
$entries | Where-Object { $_.Extension -eq '.xml' -or $_.Extension -eq '.rels' } | ForEach-Object {
  $file = $_
  $rel = $file.FullName.Substring($prefix)
  try {
    $doc = New-Object System.Xml.XmlDocument
    $doc.Load($file.FullName)
    Write-Output ("  OK   {0}" -f $rel)
  } catch {
    $fail++
    Write-Output ("  FAIL {0} -> {1}" -f $rel, $_.Exception.Message)
  }
}
Write-Output ("  parse failures: {0}" -f $fail)

Write-Output ("=== 3. read back written cells via .NET (sheet{0} row {1}) ===" -f $Sheet, $Row)
$doc = New-Object System.Xml.XmlDocument
$doc.Load((Join-Path $mdir "xl\worksheets\sheet$Sheet.xml"))
$ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
$ns.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
foreach ($col in 'B', 'C', 'D', 'E', 'F', 'G', 'H') {
  $ref = "${col}${Row}"
  $node = $doc.SelectSingleNode("//m:c[@r='$ref']", $ns)
  if ($node) {
    $t = $node.SelectSingleNode('.//m:t', $ns)
    Write-Output ("  {0} = [{1}]   (t={2})" -f $ref, $t.InnerText, $node.GetAttribute('t'))
  } else {
    Write-Output ("  {0} MISSING" -f $ref)
  }
}

Write-Output '=== 4. structural tag counts original -> modified (must be equal) ==='
$tags = @('dataValidation', 'conditionalFormatting', 'mergeCell', 'hyperlink', '<f>', '<row ', '<sheetFormatPr', '<pane ')
foreach ($n in 1..3) {
  $mo = Get-Content (Join-Path $mdir "xl\worksheets\sheet$n.xml") -Raw -Encoding UTF8
  $oo = Get-Content (Join-Path $odir "xl\worksheets\sheet$n.xml") -Raw -Encoding UTF8
  $diffs = @()
  foreach ($t in $tags) {
    $a = ([regex]::Matches($oo, [regex]::Escape($t))).Count
    $b = ([regex]::Matches($mo, [regex]::Escape($t))).Count
    if ($a -ne $b) { $diffs += ("{0} {1}->{2}" -f $t, $a, $b) }
  }
  if ($diffs.Count -eq 0) { Write-Output ("  sheet{0}: identical" -f $n) }
  else { Write-Output ("  sheet{0}: DIFF {1}" -f $n, ($diffs -join ', ')) }
}

Write-Output '=== 5. untouched parts identical? ==='
foreach ($f in 'xl\sharedStrings.xml', 'xl\styles.xml', 'xl\_rels\workbook.xml.rels') {
  $a = (Get-FileHash (Join-Path $odir $f)).Hash
  $b = (Get-FileHash (Join-Path $mdir $f)).Hash
  Write-Output ("  {0} identical: {1}" -f $f, ($a -eq $b))
}

Write-Output '=== 6. unmodified worksheets byte-identical? ==='
foreach ($n in 2, 3) {
  $a = (Get-FileHash (Join-Path $odir "xl\worksheets\sheet$n.xml")).Hash
  $b = (Get-FileHash (Join-Path $mdir "xl\worksheets\sheet$n.xml")).Hash
  Write-Output ("  sheet{0} identical: {1}" -f $n, ($a -eq $b))
}

Write-Output '=== 7. original file hash (read-only check) ==='
Get-FileHash $Original | Select-Object -ExpandProperty Hash

Remove-Item $tmp -Recurse -Force
