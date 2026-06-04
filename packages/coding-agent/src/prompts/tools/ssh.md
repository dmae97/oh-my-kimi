Runs commands on remote hosts.

<instruction>
MUST build commands from reference below
</instruction>

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
MUST verify shell type from "Available hosts" and use matching commands.
</critical>

<examples>
# List files: Linux
Host: server1 (10.0.0.1) | linux/bash. Run `ls -la /home/user`
# Show running processes: Windows cmd
Host: winbox (192.168.1.5) | windows/cmd. Run `tasklist /v`
# Get system info: macOS
Host: macbook (10.0.0.20) | macos/zsh. Run `uname -a && sw_vers`
</examples>
