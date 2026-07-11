Debugger access.

<instruction>
- You SHOULD prefer this over bash for program state, breakpoints, stepping, thread inspection, or interrupting a running process.
- `action: "launch"` starts a session; `program` required, `adapter` optional. Python: `program` = target `.py`, interpreter/script flags in `args`. Go: `program` = package directory, `.go` file, or compiled binary.
- `action: "attach"` connects to a running process: `pid` (local), `port` (remote), `adapter` forces a specific debugger.
- **Breakpoints**: `set_breakpoint`/`remove_breakpoint` with source (`file`+`line`) or function (`function`); optional `condition`.
- **Flow control**: `continue` (resume), `step_over`/`step_in`/`step_out` (single-step), `pause` (interrupt a running program).
- **Inspect**: `threads`, `stack_trace` (current stopped thread), `scopes` (needs `frame_id` or current stopped frame), `variables` (needs `variable_ref` or `scope_id`), `evaluate` (needs `expression`; `context: "repl"` for raw debugger commands), `output` (stdout/stderr/console), `sessions`, `terminate`.
</instruction>

<caution>
- Only one active debug session at a time.
- `adapter` is a configured id: `gdb`, `lldb-dap`, `debugpy`, `dlv`, `rdbg`, or any `dap.json` entry; its command must be installed.
- `program` is a target path, not a shell command. Directories require a directory-capable adapter such as `dlv`.
- Python requires `debugpy` (`pip install debugpy`); Go requires Delve (`go install github.com/go-delve/delve/cmd/dlv@latest`); Ruby requires `rdbg` (`gem install debug`).
</caution>
