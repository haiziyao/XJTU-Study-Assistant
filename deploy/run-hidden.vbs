' Hidden launcher for the scheduled task.
'
' Why this exists:
'   Pointing the scheduled task straight at powershell.exe (even with
'   -WindowStyle Hidden) still flashes a console window every run, because
'   Windows creates the console first and PowerShell hides it afterwards.
'   That produced a visible popup every 5 minutes.
'
'   WScript.Shell.Run with windowStyle = 0 (SW_HIDE) never creates a visible
'   window at all, so the task stays completely silent.
'
' Keep this file ASCII-only: wscript.exe reads .vbs in the ANSI code page,
' and non-ASCII bytes in a UTF-8 file would garble the path.
'
' Used by: scheduled task "XJTU-Study-Assistant"
' Related: deploy/start-study-assistant.ps1

Option Explicit

Dim shell, scriptPath, command
Set shell = CreateObject("WScript.Shell")

scriptPath = "E:\WHYidea\XJTU-Study-Assistant\deploy\start-study-assistant.ps1"

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"

' 0 = hidden, False = do not wait for it to finish
shell.Run command, 0, False
