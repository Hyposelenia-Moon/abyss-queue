' Hidden shim used by the scheduled task "AbyssQueueEditor": start the editor through
' editor-launch.mjs sitting NEXT TO THIS FILE, with no visible window.
'
' Why a scheduled task instead of a direct launch: processes started from a shell
' session live inside that session's job object and get killed when the shell goes
' away.  The Task Scheduler starts them outside any such job, which is also how the
' Yunzai watchdog keeps the bot alive.
'
' Pure ASCII + CRLF (cscript reads .vbs as ANSI without a BOM).
Option Explicit

Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node.exe """ & dir & "\editor-launch.mjs""", 0, True
