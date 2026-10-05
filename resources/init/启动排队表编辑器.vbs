' Manual starter: if the editor is not already answering, run the scheduled task
' "AbyssQueueEditor", wait for the port, then open the signed URL the launcher wrote
' (editor-url.txt, NEXT TO THIS FILE).
'
' Why it does NOT free the port: the editor launcher (editor-launch.mjs, started by
' the task) reports a port conflict and stops, so if the port is taken by some OTHER
' program, killing that program from here would hit a process this plugin does not own.
' So: nothing is killed; the operator decides.
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

Dim sh, fso, i, dir, URLFILE, LOGFILE, LAUNCHLOG
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
URLFILE = dir & "\editor-url.txt"
LOGFILE = dir & "\editor.log"
LAUNCHLOG = dir & "\editor-launch.log"

' "Port answering" means OUR editor replied 200 to /healthz: if some other program
' holds the port, /healthz will not answer and the launcher reports the conflict.
If PortOpen() Then
  sh.Run PageUrl(), 1, False
  WScript.Quit
End If

On Error Resume Next
sh.Run "schtasks /run /tn " & TASK, 0, True
Err.Clear
On Error GoTo 0

' If the next healthz probe fails, the launcher's own log is the only place that says why
' (port taken by another program / snapshot rejected). Hold a baseline size, and show the
' new lines afterwards instead of just the generic message.
Dim sizeBefore, reason
sizeBefore = 0
On Error Resume Next
If fso.FileExists(LAUNCHLOG) Then sizeBefore = fso.GetFile(LAUNCHLOG).Size
Err.Clear
On Error GoTo 0

For i = 1 To 40
  If PortOpen() Then
    sh.Run PageUrl(), 1, False
    WScript.Quit
  End If
  WScript.Sleep 500
Next

reason = NewLaunchLog()
If Len(reason) = 0 Then _
  reason = "The launcher wrote nothing new to " & LAUNCHLOG & "." & vbCrLf & _
           "(It may still be starting; open " & LOGFILE & " if the editor never answers.)"

MsgBox "The editor did not start (nothing answered http://127.0.0.1:" & PORT & "/healthz)." & vbCrLf & vbCrLf & _
       "If port " & PORT & " is held by another program, the launcher refuses to kill it." & vbCrLf & _
       "Check the scheduled task " & TASK & " and the log:" & vbCrLf & LOGFILE & vbCrLf & vbCrLf & _
       "Launcher log (editor-launch.log):" & vbCrLf & OneLine(reason, 900), 48, "Queue Editor"

' Lines the launcher appended to editor-launch.log this run (the launcher rewrites that
' file each run, so "from the old size on" is enough; if the file got shorter, take it all).
' The launcher writes that log as UTF-8 while this script reads it as ANSI, so the Chinese
' text in the preview can look garbled; the file path below the preview is exact either way.
Function NewLaunchLog()
  Dim f, all, from
  NewLaunchLog = ""
  On Error Resume Next
  If Not fso.FileExists(LAUNCHLOG) Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  Set f = fso.OpenTextFile(LAUNCHLOG, 1)
  all = f.ReadAll
  f.Close
  If Len(all) < 1 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  from = sizeBefore + 1
  If from < 1 Then from = 1
  If from > Len(all) Then from = 1
  NewLaunchLog = Trim(Mid(all, from))
  Err.Clear
  On Error GoTo 0
End Function

' Keep the dialog readable: one line, with the tail cut off if it is long.
Function OneLine(text, maxLen)
  Dim one
  one = Replace(Replace(Trim(text), vbCrLf, " | "), vbLf, " | ")
  If Len(one) <= maxLen Then
    OneLine = one
  Else
    OneLine = Left(one, maxLen) & " ..."
  End If
End Function

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
  ' "port open" must mean OUR editor answered /healthz with 200: another program
  ' holding the port (or any non-200 answer) is a conflict, not a running editor.
  If Err.Number = 0 Then If r.Status = 200 Then PortOpen = True
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
