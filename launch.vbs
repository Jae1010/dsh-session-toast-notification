' Launcher for a click on the toast. Windows runs the registered URL handler
' from Explorer, and starting a console program from there pops a black
' PowerShell window before the script can hide itself. wscript is a GUI
' process, so it can start PowerShell with a hidden window and no flash at all.
Option Explicit

Dim shell, fso, base, handler, url, command

If WScript.Arguments.Count = 0 Then WScript.Quit 1

url = WScript.Arguments(0)
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
handler = base & "\jump.ps1"

If Not fso.FileExists(handler) Then WScript.Quit 2

command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden" & _
          " -ExecutionPolicy Bypass -File """ & handler & """ """ & url & """"

Set shell = CreateObject("WScript.Shell")
' 0 = hidden window, False = do not wait for it
shell.Run command, 0, False
