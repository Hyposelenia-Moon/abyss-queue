' Manual starter: free the port, run the scheduled task "AbyssQueueEditor", wait for
' the port, then open the signed URL the launcher wrote (editor-url.txt, NEXT TO THIS FILE).
'
' Opening a bare http://127.0.0.1:7788/ would land on the read-only guest view: the
' identity only exists inside the link (the launcher signs the owner identity there,
' and a pure-ASCII .vbs cannot sign anything itself).
'
' It stays pure ASCII + CRLF (cscript reads .vbs as ANSI when there is no BOM).
' Usage: double-click, or via the desktop shortcut.
Option Explicit

Const TASK = "AbyssQueueEditor"
Const PORT = 7788
Const URL = "http://127.0.0.1:7788"

Dim sh, fso, i, dir, URLFILE, LOGFILE
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
URLFILE = dir & "\editor-url.txt"
LOGFILE = dir & "\editor.log"

On Error Resume Next
sh.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr LISTENING ^| findstr :" & PORT & "') do taskkill /f /pid %a >nul 2>&1", 0, True
Err.Clear
On Error GoTo 0

On Error Resume Next
sh.Run "schtasks /run /tn " & TASK, 0, True
Err.Clear
On Error GoTo 0

For i = 1 To 40
  If PortOpen() Then
    sh.Run PageUrl(), 1, False
    WScript.Quit
  End If
  WScript.Sleep 500
Next

MsgBox "The editor did not start (port " & PORT & " not answering)." & vbCrLf & vbCrLf & _
       "Check the scheduled task " & TASK & " and the log:" & vbCrLf & LOGFILE & vbCrLf & vbCrLf & _
       "Log tail:" & vbCrLf & Tail(12), 48, "Queue Editor"

Function PageUrl()
  Dim f, line
  PageUrl = URL
  On Error Resume Next
  If fso.FileExists(URLFILE) Then
    Set f = fso.OpenTextFile(URLFILE, 1)
    line = Trim(f.ReadLine)
    f.Close
    If Len(line) > 8 And Left(line, 4) = "http" Then PageUrl = line
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function PortOpen()
  Dim r
  PortOpen = False
  On Error Resume Next
  Set r = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    PortOpen = True
    Exit Function
  End If
  r.SetTimeouts 500, 500, 500, 500
  r.Open "GET", URL & "/healthz", False
  r.Send
  If Err.Number = 0 Then PortOpen = True
  Err.Clear
  On Error GoTo 0
End Function

Function Tail(n)
  Dim f, all, lines, start, k, out
  Tail = "(cannot read log)"
  On Error Resume Next
  If Not fso.FileExists(LOGFILE) Then
    Tail = "(no log yet)"
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  Set f = fso.OpenTextFile(LOGFILE, 1)
  all = f.ReadAll
  f.Close
  lines = Split(Replace(all, vbCrLf, vbLf), vbLf)
  start = UBound(lines) - n + 1
  If start < 0 Then start = 0
  For k = start To UBound(lines)
    If Len(Trim(lines(k))) > 0 Then out = out & lines(k) & vbCrLf
  Next
  If Len(out) > 0 Then Tail = out
  Err.Clear
  On Error GoTo 0
End Function
