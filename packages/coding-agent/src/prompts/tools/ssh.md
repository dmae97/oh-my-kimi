Runs commands on remote hosts.

<commands>
**linux/bash, linux/zsh, macos/bash, macos/zsh** — Unix-like:
- Files: `ls`, `cat`, `head`, `tail`, `grep`, `find`
- System: `ps`, `top`, `df`, `uname` (all), `free` (Linux only)
- Navigation: `cd`, `pwd`
**windows/bash, windows/sh** — Windows Unix layer (WSL, Cygwin, Git Bash):
- Files/System/Navigation: same as Unix-like above, minus `free`
**windows/powershell** — PowerShell:
- Files: `Get-ChildItem`, `Get-Content`, `Select-String`
- System: `Get-Process`, `Get-ComputerInfo`
- Navigation: `Set-Location`, `Get-Location`
**windows/cmd** — Command Prompt:
- Files: `dir`, `type`, `findstr`, `where`
- System: `tasklist`, `systeminfo`
- Navigation: `cd`, `echo %CD%`
</commands>

<critical>
You MUST verify the shell type from "Available hosts" and use matching commands.
</critical>
